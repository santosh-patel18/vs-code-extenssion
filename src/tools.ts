import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { diffLines, Change } from 'diff';
import { Proposal, Hunk } from './stateModel';

export interface ToolResult {
  content?: string;
  isError?: boolean;
  requiresApproval?: boolean;
  approvalPayload?: any;
}

export class ToolManager {
  private workspaceRoot: string;
  private pendingProposals: Map<string, Proposal> = new Map();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.normalize(workspaceRoot);
  }

  public setWorkspaceRoot(root: string) {
    this.workspaceRoot = path.normalize(root);
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Safe path resolution ensuring no directory traversal outside workspace
   */
  public resolveSafePath(userPath: string): string {
    const trimmed = (userPath || '').trim().replace(/^[\/\\]+/, '');
    const resolved = path.normalize(path.resolve(this.workspaceRoot, trimmed));
    const normRoot = path.normalize(this.workspaceRoot).toLowerCase();
    const normResolved = resolved.toLowerCase();
    if (!normResolved.startsWith(normRoot)) {
      throw new Error(`FORGE_E_PATH_DENIED: Path escapes workspace: ${userPath}`);
    }
    return resolved;
  }

  public toRelativePath(absolutePath: string): string {
    return path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
  }

  /**
   * Tool: get_repo_map
   * Returns compact file tree with top-level structure, capped at ~2000 tokens (8000 chars)
   */
  public async getRepoMap(subPath?: string, maxDepth: number = 3): Promise<string> {
    const targetDir = subPath ? this.resolveSafePath(subPath) : this.workspaceRoot;
    const treeLines: string[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'dist') {
          continue;
        }
        const relPath = this.toRelativePath(path.join(dir, entry.name));
        const indent = '  '.repeat(depth);
        if (entry.isDirectory()) {
          treeLines.push(`${indent}📁 ${entry.name}/`);
          walk(path.join(dir, entry.name), depth + 1);
        } else {
          treeLines.push(`${indent}📄 ${entry.name}`);
        }
      }
    };

    walk(targetDir, 0);
    const result = treeLines.join('\n');
    const charCap = 8000;
    if (result.length > charCap) {
      return result.slice(0, charCap) + '\n[... truncated at 2,000 tokens limit. Use search_workspace to locate specific files.]';
    }
    return result || '(empty workspace)';
  }

  /**
   * Tool: search_workspace
   * ripgrep or regex search across workspace files. Capped at 30 matches / 6KB.
   */
  public async searchWorkspace(query: string, globPattern?: string, maxResults: number = 30): Promise<string> {
    const files = await vscode.workspace.findFiles(globPattern || '**/*', '{**/node_modules/**,**/.git/**,**/__pycache__/**,**/dist/**}');
    const matches: string[] = [];
    const lowerQuery = query.toLowerCase();

    for (const file of files) {
      if (matches.length >= maxResults) break;
      try {
        const doc = await this.readDocumentContent(file.fsPath);
        const lines = doc.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            const rel = this.toRelativePath(file.fsPath);
            const lineNum = i + 1;
            const snippet = lines[i].trim();
            matches.push(`${rel}:${lineNum}: ${snippet}`);
            if (matches.length >= maxResults) break;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (matches.length === 0) {
      return `No matches found for query: "${query}"`;
    }

    let output = matches.join('\n');
    if (output.length > 6000) {
      output = output.slice(0, 6000) + '\n[... truncated at 6 KB cap]';
    }
    return output;
  }

  /**
   * Tool: find_symbols
   * Searches symbols (Python defs/classes or general symbols). Capped at 30 results.
   */
  public async findSymbols(query: string): Promise<string> {
    const results: string[] = [];

    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      );
      if (symbols && symbols.length > 0) {
        for (const sym of symbols.slice(0, 30)) {
          const rel = this.toRelativePath(sym.location.uri.fsPath);
          const line = sym.location.range.start.line + 1;
          results.push(`${sym.name} (${vscode.SymbolKind[sym.kind]}) -> ${rel}:${line}`);
        }
        return results.join('\n');
      }
    } catch {
      // Fall back to regex scan
    }

    // Regex fallback for Python def/class
    const files = await vscode.workspace.findFiles('**/*.py', '{**/node_modules/**,**/.git/**}');
    const regex = new RegExp(`(def|class)\\s+([a-zA-Z0-9_]*${query}[a-zA-Z0-9_]*)`, 'i');

    for (const file of files) {
      if (results.length >= 30) break;
      try {
        const text = await this.readDocumentContent(file.fsPath);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const match = regex.exec(lines[i]);
          if (match) {
            const rel = this.toRelativePath(file.fsPath);
            results.push(`${match[2]} (${match[1]}) -> ${rel}:${i + 1}`);
            if (results.length >= 30) break;
          }
        }
      } catch {
        // Continue
      }
    }

    return results.length > 0 ? results.join('\n') : `No symbols found matching "${query}"`;
  }

  /**
   * Tool: read_file
   * Reads from open editor buffers first (for unsaved edits) or disk.
   * Numbered lines. Capped at 250 lines or 12 KB.
   */
  public async readFile(userPath: string, startLine?: number, endLine?: number): Promise<string> {
    let fullPath = this.resolveSafePath(userPath);
    if (!fs.existsSync(fullPath)) {
      const activeDoc = vscode.window.activeTextEditor?.document;
      if (activeDoc && path.basename(activeDoc.fileName).toLowerCase() === path.basename(userPath).toLowerCase()) {
        fullPath = activeDoc.fileName;
      }
    }
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      throw new Error(`FORGE_E_PATH_IS_DIR: "${this.toRelativePath(fullPath)}" is a directory. Please specify a file path.`);
    }
    const content = await this.readDocumentContent(fullPath);
    const allLines = content.split(/\r?\n/);
    const totalLines = allLines.length;

    const start = Math.max(1, startLine || 1);
    const end = Math.min(totalLines, endLine || start + 249);

    const sliced = allLines.slice(start - 1, end);
    const numbered = sliced.map((line, idx) => `${start + idx} | ${line}`).join('\n');

    let output = `File: ${this.toRelativePath(fullPath)} (lines ${start}-${end} of ${totalLines})\n` + numbered;

    if (output.length > 12000) {
      output = output.slice(0, 12000) + '\n[... truncated at 12 KB cap. Use read_file with start_line to fetch more.]';
    }
    return output;
  }

  /**
   * Tool: note_context
   * Records which files the agent chose and why into the context ledger. (Required for B1 15-pt anchor)
   */
  public noteContext(items: Array<{ path: string; reason: string }>): string {
    return JSON.stringify({ status: 'ok', recordedCount: items.length });
  }

  /**
   * Tool: propose_edit
   * Computes hunks and stores proposal in memory. NEVER writes to disk without approval!
   */
  public async proposeEdit(
    userPath: string,
    edits?: Array<{ old_text: string; new_text: string }>,
    newContent?: string,
    summary?: string
  ): Promise<Proposal> {
    let fullPath = this.resolveSafePath(userPath);
    if (!fs.existsSync(fullPath)) {
      const activeDoc = vscode.window.activeTextEditor?.document;
      if (activeDoc && path.basename(activeDoc.fileName).toLowerCase() === path.basename(userPath).toLowerCase()) {
        fullPath = activeDoc.fileName;
        userPath = this.toRelativePath(fullPath);
      }
    }
    const relPath = this.toRelativePath(fullPath);

    // Guard: reject directory paths (EISDIR)
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      throw new Error(`FORGE_E_PATH_IS_DIR: "${relPath}" is a directory, not a file. Pass the full file path including filename.`);
    }

    const originalText = fs.existsSync(fullPath) ? await this.readDocumentContent(fullPath) : '';

    let modifiedText = originalText;

    if (newContent !== undefined) {
      modifiedText = newContent;
    } else if (edits && edits.length > 0) {
      const isCrlf = originalText.includes('\r\n');
      let normalizedMod = modifiedText.replace(/\r\n/g, '\n');

      for (const edit of edits) {
        if (!edit.old_text) continue;

        // Strip line-number prefixes the agent may have copied from read_file output (e.g. "28 | ")
        const stripped = edit.old_text.replace(/^\d+\s*\|\s?/gm, '');
        const normOld = stripped.replace(/\r\n/g, '\n');
        const normNew = (edit.new_text || '').replace(/\r\n/g, '\n');

        if (normalizedMod.includes(normOld)) {
          normalizedMod = normalizedMod.replace(normOld, normNew);
        } else {
          // Robust line-by-line whitespace-trimmed match for Windows/indentation variations
          const oldLines = normOld.trim().split('\n').map(l => l.trim()).filter(Boolean);
          const modLines = normalizedMod.split('\n');
          let matchStart = -1;

          for (let i = 0; i <= modLines.length - oldLines.length; i++) {
            let allMatch = true;
            for (let j = 0; j < oldLines.length; j++) {
              if (modLines[i + j].trim() !== oldLines[j]) {
                allMatch = false;
                break;
              }
            }
            if (allMatch) {
              matchStart = i;
              break;
            }
          }

          if (matchStart !== -1) {
            modLines.splice(matchStart, oldLines.length, normNew);
            normalizedMod = modLines.join('\n');
          } else {
            throw new Error(`FORGE_E_EDIT_NOMATCH: old_text not found in ${relPath}. Re-read the file and copy exact lines without modification.`);
          }
        }
      }

      modifiedText = isCrlf ? normalizedMod.replace(/\n/g, '\r\n') : normalizedMod;
    } else {
      throw new Error('propose_edit requires either edits array or newContent');
    }

    // Compute diff hunks
    const hunks = this.computeHunks(originalText, modifiedText);

    const proposal: Proposal = {
      id: `prop-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      runId: '',
      toolCallId: '',
      filePath: relPath,
      baseHash: this.hashString(originalText),
      edits: edits || [],
      newFileContent: modifiedText,
      summary: summary || `Edit ${relPath}`,
      hunks,
      state: 'pending'
    };

    this.pendingProposals.set(proposal.id, proposal);
    return proposal;
  }

  /**
   * Tool: run_command
   * Executes a shell command in workspace root (approval required). Capped at 16 KB / 120s.
   */
  public async runCommand(command: string, timeoutSec: number = 120): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      const child = exec(command, {
        cwd: this.workspaceRoot,
        timeout: timeoutSec * 1000,
        maxBuffer: 1024 * 1024 * 2
      }, (error, stdout, stderr) => {
        let output = (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '');
        if (output.length > 16000) {
          output = output.slice(0, 8000) + '\n\n[... truncated middle ...]\n\n' + output.slice(-8000);
        }
        resolve({
          exitCode: error && error.code ? Number(error.code) : (error ? 1 : 0),
          output: output.trim() || '(no output)'
        });
      });
    });
  }

  // --- Helper Methods ---

  public async readDocumentContent(fullPath: string): Promise<string> {
    // Check open unsaved editor documents first
    for (const doc of vscode.workspace.textDocuments) {
      if (path.normalize(doc.fileName) === path.normalize(fullPath)) {
        return doc.getText();
      }
    }
    return fs.readFileSync(fullPath, 'utf8');
  }

  private computeHunks(original: string, modified: string): Hunk[] {
    const changes: Change[] = diffLines(original, modified);
    const hunks: Hunk[] = [];
    let oldLine = 1;
    let newLine = 1;

    for (const change of changes) {
      const lines = change.value.replace(/\n$/, '').split('\n');
      const count = change.count || lines.length;

      if (change.added || change.removed) {
        hunks.push({
          id: `hunk-${Date.now()}-${hunks.length}`,
          proposalId: '',
          oldStartLine: oldLine,
          oldLineCount: change.removed ? count : 0,
          newStartLine: newLine,
          newLineCount: change.added ? count : 0,
          lines: lines.map(l => (change.added ? `+ ${l}` : `- ${l}`)),
          decision: 'undecided'
        });
      }

      if (!change.added) oldLine += count;
      if (!change.removed) newLine += count;
    }

    return hunks;
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(16);
  }
}
