import * as vscode from 'vscode';
import * as path from 'path';
import { TrueForgeClient } from './trueforge';
import { ToolManager } from './tools';
import { DiffReviewManager } from './diffReview';
import { ForgeMcpServer } from './mcpServer';
import { ForgeAgentViewProvider } from './panel';

let mcpServer: ForgeMcpServer | null = null;
let trueforgeClient: TrueForgeClient | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Activating Forge Extension...');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : process.cwd();

  // Load configurations
  const config = vscode.workspace.getConfiguration('forge');
  const tfBaseUrl = config.get<string>('trueforge.baseUrl', 'http://localhost:8790');
  const mcpPort = config.get<number>('mcp.port', 8899);

  // Initialize Core Services
  const toolManager = new ToolManager(workspaceRoot);
  const diffManager = new DiffReviewManager(toolManager, context.globalStorageUri);
  trueforgeClient = new TrueForgeClient(tfBaseUrl);

  // Register CodeLens Provider for diff hunks
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ pattern: '**/*' }, diffManager)
  );

  // Start MCP Tool Server
  mcpServer = new ForgeMcpServer(mcpPort, toolManager, diffManager);
  try {
    await mcpServer.start();
    // Register MCP server with TrueForge
    await trueforgeClient.registerMcpServer(mcpPort);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Forge MCP server failed to start: ${err.message}`);
  }

  // Register Webview Sidebar Provider
  const panelProvider = new ForgeAgentViewProvider(context.extensionUri, trueforgeClient, toolManager, diffManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ForgeAgentViewProvider.viewType, panelProvider)
  );

  // Connect MCP ledger events to the Webview's Context Ledger
  mcpServer.onLedgerEntry((entry) => {
    panelProvider.addLedgerEntry(entry);
  });

  // Startup ping check
  trueforgeClient.ping().then((isAlive) => {
    if (!isAlive) {
      vscode.window.showWarningMessage(
        'TrueForge is not running. Start it with: npx @truefoundry/trueforge@latest',
        'Learn More'
      );
    }
  });

  // Track active text editor changes to update diff decorations
  vscode.window.onDidChangeActiveTextEditor(() => {
    diffManager.updateActiveEditorDecorations();
  }, null, context.subscriptions);

  // Command: forge.inlineEdit (Capability #1, AT-A)
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active file open.');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const filePath = toolManager.toRelativePath(editor.document.fileName);

      const instruction = await vscode.window.showInputBox({
        prompt: `Forge Inline Edit: ${path.basename(filePath)}`,
        placeHolder: "e.g. Treat the values 'off' and 'n' as false as well, case-insensitively..."
      });

      if (!instruction) return;

      const inlineAgentName = config.get<string>('agent.inline', 'forge-inline');

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Forge: Generating inline edit...',
          cancellable: true
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            trueforgeClient?.cancel();
          });

          try {
            const prompt = `File: ${filePath}\n` +
              (selectedText ? `Selected text to edit:\n\`\`\`\n${selectedText}\n\`\`\`\n\n` : `Full file context:\n\`\`\`\n${editor.document.getText()}\n\`\`\`\n\n`) +
              `Instruction: ${instruction}\n\n` +
              `IMPORTANT: Call propose_edit tool with the exact old_text and replacement new_text. Do not output conversational text.`;

            const sessionId = await trueforgeClient!.createSession(inlineAgentName);
            await trueforgeClient!.sendTurn(sessionId, prompt, (evt) => {
              // Handled by tool call in mcpServer
            });
          } catch (err: any) {
            vscode.window.showErrorMessage(`Inline edit error: ${err.message}`);
          }
        }
      );
    })
  );

  // Command: forge.openAgent
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.openAgent', () => {
      vscode.commands.executeCommand('forge.agentView.focus');
    })
  );

  // Command: forge.cancel
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.cancel', () => {
      panelProvider.cancelRun();
    })
  );

  // Command: forge.acceptHunk
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.acceptHunk', (proposalId: string, hunkId: string) => {
      diffManager.acceptHunk(proposalId, hunkId);
    })
  );

  // Command: forge.rejectHunk
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.rejectHunk', (proposalId: string, hunkId: string) => {
      diffManager.rejectHunk(proposalId, hunkId);
    })
  );

  // Command: forge.acceptAll
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.acceptAll', (proposalId: string) => {
      diffManager.acceptAll(proposalId);
    })
  );

  // Command: forge.rejectAll
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.rejectAll', (proposalId: string) => {
      diffManager.rejectAll(proposalId);
    })
  );

  // Command: forge.undoLast
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.undoLast', () => {
      diffManager.undoLast();
    })
  );

  // Command: forge.undoRun
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.undoRun', () => {
      diffManager.undoAll();
    })
  );
}

export function deactivate() {
  if (mcpServer) {
    mcpServer.stop();
  }
}
