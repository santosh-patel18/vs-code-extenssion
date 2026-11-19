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
    this.activeLedger = []; // reset ledger for new run
    vscode.commands.executeCommand('setContext', 'forgeRunActive', true);

    const config = vscode.workspace.getConfiguration('forge');
    const primaryAgent = config.get<string>('agent.primary', 'forge-agent');
    const fallbackAgent = config.get<string>('agent.fallback', 'forge-fallback');

    // Context-engineering: prepend budgeted repo map to first turn
    let repoMap = '';
    try {
      repoMap = await this.toolManager.getRepoMap('', 1);
    } catch {
      repoMap = '(could not build repo map)';
    }

    const enrichedPrompt =
      `Project Workspace Overview:\n\`\`\`\n${repoMap}\n\`\`\`\n\n` +
      `Task:\n${userInstruction}`;

    // Post user message to panel immediately
    this.view?.webview.postMessage({ type: 'runStart' });

    try {
      await this.trueforge.executeWithFallback(
        primaryAgent,
        fallbackAgent,
        enrichedPrompt,
        (evt) => { this.handleTrueForgeEvent(evt); }
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Agent run failed: ${err.message}`);
      this.view?.webview.postMessage({
        type: 'agentError',
        message: err.message
      });
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

    // --- Token streaming ---
    if (type === 'model.message.delta' || type === 'model.message') {
      let chunk = '';
      // Plain string content (confirmed TrueForge format)
      if (typeof data.content === 'string' && data.content) {
        chunk = data.content;
      } else if (data.delta && typeof data.delta.text === 'string') {
        chunk = data.delta.text;
      } else if (Array.isArray(data.content) && data.content.length > 0) {
        chunk = data.content.map((c: any) => c.text || '').join('');
      }

      if (chunk) {
        this.view?.webview.postMessage({ type: 'tokenDelta', text: chunk });
      }
      return;
    }

    // --- Error events from TrueForge ---
    if (type === 'error' || type === 'turn.error' || type === 'model.error' || data.error || data.state?.status === 'error') {
      const errMsg = typeof data.error === 'string'
        ? data.error
        : (data.state?.message || data.error?.message || data.message || 'Model error occurred');
      this.view?.webview.postMessage({
        type: 'agentError',
        message: errMsg
      });
      return;
    }

    // --- Tool call started ---
    if (type === 'tool.call.start' || type === 'tool.execution_start' ||
        (type.includes('tool') && type.includes('call'))) {
      const name = data.tool_name || data.name || (data.tool && data.tool.name) || 'tool';
      const args = data.args || data.arguments || {};
      const argStr = typeof args === 'string' ? args.slice(0, 100) : JSON.stringify(args).slice(0, 100);
      this.view?.webview.postMessage({
        type: 'toolEvent',
        name: `⚡ ${name}`,
        details: argStr,
        phase: 'start'
      });
      return;
    }

    // --- Tool response ---
    if (type === 'tool.call.end' || type === 'tool.execution_end' ||
        (type.includes('tool') && type.includes('response'))) {
      const name = data.tool_name || data.name || '';
      const output = data.output || data.result || '';
      const preview = typeof output === 'string' ? output.slice(0, 100) : 'done';
      if (name) {
        this.view?.webview.postMessage({
          type: 'toolEvent',
          name: `✓ ${name}`,
          details: preview,
          phase: 'end'
        });
      }
      return;
    }

    // --- Turn complete ---
    if (type === 'turn.complete' || type === 'run.complete' || type === 'session.complete') {
      this.view?.webview.postMessage({ type: 'turnComplete' });
      return;
    }

    // --- Error events ---
    if (type === 'error' || type === 'model.error') {
      const msg = data.message || data.error || JSON.stringify(data);
      this.view?.webview.postMessage({ type: 'agentError', message: msg });
      return;
    }

    // Log unhandled events for debugging
    console.log('[Forge] Unhandled TF event:', type, JSON.stringify(data).slice(0, 200));
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
