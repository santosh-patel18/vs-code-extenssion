import * as http from 'http';
import { ToolManager } from './tools';
import { DiffReviewManager } from './diffReview';
import { LedgerEntry } from './stateModel';
import * as vscode from 'vscode';

export class ForgeMcpServer {
  private server: http.Server | null = null;
  private port: number;
  private bearerToken: string;
  private toolManager: ToolManager;
  private diffManager: DiffReviewManager;
  private onLedgerEntryEmitter = new vscode.EventEmitter<LedgerEntry>();
  public readonly onLedgerEntry = this.onLedgerEntryEmitter.event;

  constructor(port: number, toolManager: ToolManager, diffManager: DiffReviewManager) {
    this.port = port;
    this.bearerToken = `forge-token-${Math.random().toString(36).substring(2, 10)}`;
    this.toolManager = toolManager;
    this.diffManager = diffManager;
  }

  public getBearerToken(): string {
    return this.bearerToken;
  }

  public getPort(): number {
    return this.port;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Enforce 127.0.0.1 and Bearer token check
        const authHeader = req.headers['authorization'];
        const url = req.url || '';

        // CORS / pre-flight
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
          });
          res.end();
          return;
        }

        // Bearer token check
        if (authHeader !== `Bearer ${this.bearerToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Invalid bearer token' }));
          return;
        }

        // Parse body
        let bodyStr = '';
        req.on('data', chunk => { bodyStr += chunk; });
        req.on('end', async () => {
          let body: any = {};
          if (bodyStr) {
            try { body = JSON.parse(bodyStr); } catch { /* ignore */ }
          }

          try {
            if (url === '/mcp' || url === '/mcp/tools' || url === '/tools/list') {
              this.handleToolsList(res);
            } else if (url === '/mcp/call' || url === '/tools/call') {
              await this.handleToolCall(body, res);
            } else {
              // Standard MCP JSON-RPC handler
              if (body.method === 'tools/list') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  result: { tools: this.getToolDefinitions() }
                }));
              } else if (body.method === 'tools/call') {
                const callResult = await this.executeTool(body.params?.name, body.params?.arguments || {});
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  result: { content: [{ type: 'text', text: callResult }] }
                }));
              } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  result: { status: 'ok' }
                }));
              }
            }
          } catch (err: any) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                message: err.message || 'Tool execution error',
                hint: 'Check arguments and file paths'
              }
            }));
          }
        });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`Forge MCP Server listening on 127.0.0.1:${this.port}`);
        resolve();
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  public stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private handleToolsList(res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools: this.getToolDefinitions() }));
  }

  private async handleToolCall(body: any, res: http.ServerResponse) {
    const toolName = body.name || body.tool;
    const args = body.arguments || body.args || {};
    const textOutput = await this.executeTool(toolName, args);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: [{ type: 'text', text: textOutput }]
    }));
  }

  private async executeTool(name: string, args: any): Promise<string> {
    switch (name) {
      case 'get_repo_map': {
        return await this.toolManager.getRepoMap(args.path, args.depth ? Number(args.depth) : 3);
      }
      case 'search_workspace': {
        const query = args.query || '';
        return await this.toolManager.searchWorkspace(query, args.glob, args.max_results ? Number(args.max_results) : 30);
      }
      case 'find_symbols': {
        const query = args.query || '';
        return await this.toolManager.findSymbols(query);
      }
      case 'read_file': {
        const filePath = args.path || '';
        const start = args.start_line ? Number(args.start_line) : undefined;
        const end = args.end_line ? Number(args.end_line) : undefined;
        const result = await this.toolManager.readFile(filePath, start, end);

        // Record agent read in ledger
        this.onLedgerEntryEmitter.fire({
          runId: '',
          pathOrSymbol: filePath,
          source: 'agent_read',
          estTokens: Math.ceil(result.length / 4),
          reason: 'Inspected by agent',
          ts: Date.now()
        });
        return result;
      }
      case 'note_context': {
        const items = args.items || [];
        for (const item of items) {
          if (item.path) {
            this.onLedgerEntryEmitter.fire({
              runId: '',
              pathOrSymbol: item.path,
              source: 'auto',
              estTokens: 200,
              reason: item.reason || 'Chosen by agent for context',
              ts: Date.now()
            });
          }
        }
        return this.toolManager.noteContext(items);
      }
      case 'propose_edit': {
        const filePath = args.path || '';
        const edits = args.edits;
        const newContent = args.content;
        const summary = args.summary;

        const proposal = await this.toolManager.proposeEdit(filePath, edits, newContent, summary);
        this.diffManager.registerProposal(proposal);

        // Notify user in editor
        vscode.window.showInformationMessage(
          `Forge: Edit proposed for ${proposal.filePath} (${proposal.hunks.length} hunks). Review in editor.`,
          'Accept All',
          'Reject All'
        ).then(choice => {
          if (choice === 'Accept All') this.diffManager.acceptAll(proposal.id);
          if (choice === 'Reject All') this.diffManager.rejectAll(proposal.id);
        });

        // Open the document so the user immediately sees the CodeLens and diff decorations!
        const fullPath = this.toolManager.resolveSafePath(proposal.filePath);
        vscode.workspace.openTextDocument(vscode.Uri.file(fullPath)).then(doc => {
          vscode.window.showTextDocument(doc);
        });

        return JSON.stringify({
          status: 'approval_required',
          proposal_id: proposal.id,
          hunks_count: proposal.hunks.length,
          message: 'Changes staged in editor for user review. Awaiting per-hunk approval.'
        });
      }
      case 'run_command': {
        const cmd = args.command || '';
        // Human approval dialog
        const answer = await vscode.window.showWarningMessage(
          `Forge Agent requests to run command in terminal:\n\n${cmd}`,
          { modal: true },
          'Allow',
          'Deny'
        );

        if (answer !== 'Allow') {
          return JSON.stringify({ exit_code: -1, output: 'Command execution denied by user.' });
        }

        const res = await this.toolManager.runCommand(cmd, args.timeout_s ? Number(args.timeout_s) : 120);
        return JSON.stringify({ exit_code: res.exitCode, output: res.output });
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private getToolDefinitions() {
    return [
      {
        name: 'get_repo_map',
        description: 'Returns compact file tree with directory structure and symbols. Capped at 2,000 tokens.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Subdirectory path, or empty for workspace root' },
            depth: { type: 'number', description: 'Max depth (default 3)' }
          }
        }
      },
      {
        name: 'search_workspace',
        description: 'Searches workspace files for code matching a text or regex pattern.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term or pattern' },
            glob: { type: 'string', description: 'Optional glob filter (e.g. **/*.py)' },
            max_results: { type: 'number', description: 'Max matches to return (default 30)' }
          },
          required: ['query']
        }
      },
      {
        name: 'find_symbols',
        description: 'Searches symbols (functions, classes) across the workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Symbol name to search' }
          },
          required: ['query']
        }
      },
      {
        name: 'read_file',
        description: 'Reads numbered lines from a file in workspace. Always read before proposing edits.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path' },
            start_line: { type: 'number', description: 'Starting line number (1-based)' },
            end_line: { type: 'number', description: 'Ending line number' }
          },
          required: ['path']
        }
      },
      {
        name: 'note_context',
        description: 'Agent declares which files it chose and why for its solution context. Recorded in Context Ledger.',
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  reason: { type: 'string' }
                },
                required: ['path', 'reason']
              }
            }
          },
          required: ['items']
        }
      },
      {
        name: 'propose_edit',
        description: 'Proposes changes to a single file. Never writes directly to disk without user review and approval.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path' },
            edits: {
              type: 'array',
              description: 'Array of search/replace replacements',
              items: {
                type: 'object',
                properties: {
                  old_text: { type: 'string', description: 'Exact existing code snippet to replace' },
                  new_text: { type: 'string', description: 'New replacement code snippet' }
                },
                required: ['old_text', 'new_text']
              }
            },
            content: { type: 'string', description: 'Full new content (for creating new files)' },
            summary: { type: 'string', description: 'Summary of proposed change' }
          },
          required: ['path']
        }
      },
      {
        name: 'run_command',
        description: 'Executes a command in workspace root (e.g. pytest). Requires user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command string' },
            timeout_s: { type: 'number', description: 'Timeout in seconds (default 120)' }
          },
          required: ['command']
        }
      }
    ];
  }
}
