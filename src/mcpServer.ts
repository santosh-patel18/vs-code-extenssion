import * as http from 'http';
import { ToolManager } from './tools';
import { DiffReviewManager } from './diffReview';
import { LedgerEntry } from './stateModel';
import * as vscode from 'vscode';

export const FORGE_AUTH_TOKEN = 'forge-local-token-2026';

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
    this.bearerToken = FORGE_AUTH_TOKEN;
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
        const authHeader = req.headers['authorization'];
        const url = req.url || '';

        // CORS / pre-flight
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-session-id'
          });
          res.end();
          return;
        }

        // Allow requests from localhost
        if (authHeader && authHeader !== `Bearer ${this.bearerToken}`) {
          // If a token was provided but mismatch, check if from localhost
          console.log('[MCP Auth Header]:', authHeader);
        }

        let bodyStr = '';
        req.on('data', chunk => { bodyStr += chunk; });
        req.on('end', async () => {
          let body: any = {};
          if (bodyStr) {
            try { body = JSON.parse(bodyStr); } catch { /* ignore */ }
          }

          try {
            // Standard MCP Streamable HTTP / JSON-RPC Handler
            const method = body.method;

            if (method === 'initialize') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: {
                    tools: {}
                  },
                  serverInfo: {
                    name: 'forge-tools',
                    version: '1.0.0'
                  }
                }
              }));
            } else if (method === 'notifications/initialized') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', result: {} }));
            } else if (method === 'tools/list' || url === '/tools/list' || url === '/mcp/tools') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id !== undefined ? body.id : 1,
                result: { tools: this.getToolDefinitions() }
              }));
            } else if (method === 'tools/call' || url === '/tools/call' || url === '/mcp/call') {
              const name = body.params?.name || body.name || body.tool;
              const args = body.params?.arguments || body.arguments || body.args || {};
              const callResult = await this.executeTool(name, args);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id !== undefined ? body.id : 1,
                result: { content: [{ type: 'text', text: callResult }] }
              }));
            } else {
              // Generic fallback for list/ping
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id !== undefined ? body.id : 1,
                result: { tools: this.getToolDefinitions() }
              }));
            }
          } catch (err: any) {
            console.error('MCP Tool error:', err);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              error: {
                code: -32603,
                message: err.message || 'Tool execution error'
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

  private async executeTool(name: string, args: any): Promise<string> {
    console.log(`[MCP CALL] ${name}`, args);
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

        vscode.window.showInformationMessage(
          `Forge: Edit proposed for ${proposal.filePath} (${proposal.hunks.length} hunks). Review in editor.`,
          'Accept All',
          'Reject All'
        ).then(choice => {
          if (choice === 'Accept All') this.diffManager.acceptAll(proposal.id);
          if (choice === 'Reject All') this.diffManager.rejectAll(proposal.id);
        });

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
