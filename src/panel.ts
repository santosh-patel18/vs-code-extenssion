import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TrueForgeClient } from './trueforge';
import { ToolManager } from './tools';
import { DiffReviewManager } from './diffReview';
import { LedgerEntry } from './stateModel';

export class ForgeAgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forge.agentView';
  private view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  private trueforge: TrueForgeClient;
  private toolManager: ToolManager;
  private diffManager: DiffReviewManager;
  private activeLedger: LedgerEntry[] = [];
  private isRunning: boolean = false;

  constructor(
    extensionUri: vscode.Uri,
    trueforge: TrueForgeClient,
    toolManager: ToolManager,
    diffManager: DiffReviewManager
  ) {
    this.extensionUri = extensionUri;
    this.trueforge = trueforge;
    this.toolManager = toolManager;
    this.diffManager = diffManager;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    const htmlPath = path.join(this.extensionUri.fsPath, 'panel', 'index.html');
    webviewView.webview.html = fs.readFileSync(htmlPath, 'utf8');

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'submit':
          await this.startAgentRun(msg.text);
          break;

        case 'cancel':
          this.cancelRun();
          break;

        case 'revert':
          await this.diffManager.undoAll();
          vscode.window.showInformationMessage('Reverted all changes in this run.');
          break;

        case 'quickPickFile':
          await this.handleFileQuickPick();
          break;
      }
    });
  }

  public addLedgerEntry(entry: LedgerEntry) {
    this.activeLedger.push(entry);
    this.view?.webview.postMessage({
      type: 'updateLedger',
      entries: this.activeLedger
    });
  }

  private async handleFileQuickPick() {
    const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**}');
    const items = files.map(f => this.toolManager.toRelativePath(f.fsPath));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a file to attach to context'
    });

    if (selected) {
      try {
        const full = this.toolManager.resolveSafePath(selected);
        const content = await this.toolManager.readDocumentContent(full);
        this.addLedgerEntry({
          runId: '',
          pathOrSymbol: selected,
          source: 'mention',
          estTokens: Math.ceil(content.length / 4),
          reason: 'Explicitly attached by user via @file',
          ts: Date.now()
        });
        this.view?.webview.postMessage({
          type: 'insertFileMention',
          path: selected
        });
      } catch (err) {
        console.error(err);
      }
    }
  }

  private async startAgentRun(userInstruction: string) {
    if (this.isRunning) {
      vscode.window.showWarningMessage('A Forge run is already in progress. Please wait or cancel.');
      return;
    }

    this.isRunning = true;
    vscode.commands.executeCommand('setContext', 'forgeRunActive', true);

    const config = vscode.workspace.getConfiguration('forge');
    const primaryAgent = config.get<string>('agent.primary', 'forge-agent');
    const fallbackAgent = config.get<string>('agent.fallback', 'forge-fallback');

    // Context-engineering feature: automatically prepend budgeted repo map to first turn
    const repoMap = await this.toolManager.getRepoMap('', 2);
    const enrichedPrompt = `Project Workspace Overview:\n\`\`\`\n${repoMap}\n\`\`\`\n\nTask:\n${userInstruction}`;

    try {
      await this.trueforge.executeWithFallback(
        primaryAgent,
        fallbackAgent,
        enrichedPrompt,
        (evt) => {
          this.handleTrueForgeEvent(evt);
        }
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Agent run failed: ${err.message}`);
    } finally {
      this.isRunning = false;
      vscode.commands.executeCommand('setContext', 'forgeRunActive', false);
      this.view?.webview.postMessage({
        type: 'runDone',
        hasEdits: this.diffManager.getPendingProposals().length > 0
      });
    }
  }

  private handleTrueForgeEvent(evt: any) {
    const data = evt.data || {};
    const type = evt.type || data.type || '';

    // Model message streaming (model.message.delta or model.message)
    if (type.includes('model.message')) {
      let chunk = '';
      if (typeof data.content === 'string') {
        chunk = data.content;
      } else if (data.delta && typeof data.delta.text === 'string') {
        chunk = data.delta.text;
      } else if (Array.isArray(data.content) && data.content.length > 0) {
        chunk = data.content.map((c: any) => c.text || '').join('');
      }

      if (chunk) {
        this.view?.webview.postMessage({
          type: 'tokenDelta',
          text: chunk
        });
      }
    }
    // Tool call started
    else if (type.includes('tool.call') || type === 'tool.execution_start') {
      const name = data.tool_name || data.name || (data.tool && data.tool.name) || 'tool';
      const args = data.args || data.arguments || '';
      this.view?.webview.postMessage({
        type: 'toolEvent',
        name: `Calling ${name}`,
        details: typeof args === 'string' ? args.slice(0, 80) : JSON.stringify(args).slice(0, 80)
      });
    }
    // Tool response completed
    else if (type.includes('tool.response') || type === 'tool.execution_end') {
      const name = data.tool_name || data.name || '';
      if (name) {
        const output = data.output || data.result || 'done';
        this.view?.webview.postMessage({
          type: 'toolEvent',
          name: `${name}`,
          details: typeof output === 'string' ? output.slice(0, 80) : 'done'
        });
      }
    }
  }

  public cancelRun() {
    this.trueforge.cancel();
    this.isRunning = false;
    vscode.commands.executeCommand('setContext', 'forgeRunActive', false);
    this.view?.webview.postMessage({
      type: 'runDone',
      hasEdits: false
    });
    vscode.window.showInformationMessage('Forge: Active run cancelled.');
  }
}
