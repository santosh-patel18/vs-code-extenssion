import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Proposal, Hunk, Checkpoint } from './stateModel';
import { ToolManager } from './tools';

export class DiffReviewManager implements vscode.CodeLensProvider {
  private toolManager: ToolManager;
  private extensionStorageUri: vscode.Uri;
  private activeProposals: Map<string, Proposal> = new Map();
  private checkpoints: Checkpoint[] = [];
  private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  // Track active decorations
  private addedDecorationType: vscode.TextEditorDecorationType;
  private removedDecorationType: vscode.TextEditorDecorationType;

  constructor(toolManager: ToolManager, storageUri: vscode.Uri) {
    this.toolManager = toolManager;
    this.extensionStorageUri = storageUri;

    // Ensure storage directory exists
    try {
      if (!fs.existsSync(this.extensionStorageUri.fsPath)) {
        fs.mkdirSync(this.extensionStorageUri.fsPath, { recursive: true });
      }
    } catch {
      // Ignored
    }

    this.addedDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(40, 167, 69, 0.2)',
      isWholeLine: true,
      overviewRulerColor: 'green',
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });

    this.removedDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(220, 53, 69, 0.2)',
      isWholeLine: true,
      overviewRulerColor: 'red',
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
  }

  public registerProposal(proposal: Proposal) {
    this.activeProposals.set(proposal.id, proposal);
    this.onDidChangeCodeLensesEmitter.fire();
    this.updateActiveEditorDecorations();
  }

  public getProposal(proposalId: string): Proposal | undefined {
    return this.activeProposals.get(proposalId);
  }

  public getPendingProposals(): Proposal[] {
    return Array.from(this.activeProposals.values()).filter(p => p.state === 'pending');
  }

  private normalizeRelPath(p: string): string {
    return p.replace(/^[/\\]+/, '').replace(/\\/g, '/').toLowerCase();
  }

  /**
   * CodeLens provider: displays [Accept Hunk] [Reject Hunk] above each changed section
   */
  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const docPath = this.normalizeRelPath(this.toolManager.toRelativePath(document.fileName));

    for (const proposal of this.activeProposals.values()) {
      const propPath = this.normalizeRelPath(proposal.filePath);
      if (docPath !== propPath || proposal.state !== 'pending') continue;

      // Add "Accept All" & "Reject All" at the top of the file
      const topRange = new vscode.Range(0, 0, 0, 0);
      lenses.push(
        new vscode.CodeLens(topRange, {
          title: `$(check) Accept All Changes (${proposal.hunks.length} hunks)`,
          command: 'forge.acceptAll',
          arguments: [proposal.id]
        }),
        new vscode.CodeLens(topRange, {
          title: `$(trash) Reject All Changes`,
          command: 'forge.rejectAll',
          arguments: [proposal.id]
        })
      );

      for (const hunk of proposal.hunks) {
        if (hunk.decision !== 'undecided') continue;
        const line = Math.max(0, hunk.oldStartLine - 1);
        const range = new vscode.Range(line, 0, line, 0);

        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(check) Accept Hunk`,
            command: 'forge.acceptHunk',
            arguments: [proposal.id, hunk.id]
          }),
          new vscode.CodeLens(range, {
            title: `$(trash) Reject Hunk`,
            command: 'forge.rejectHunk',
            arguments: [proposal.id, hunk.id]
          })
        );
      }
    }

    return lenses;
  }

  /**
   * Accepts a specific hunk
   */
  public async acceptHunk(proposalId: string, hunkId: string): Promise<void> {
    const proposal = this.activeProposals.get(proposalId);
    if (!proposal) return;

    const hunk = proposal.hunks.find(h => h.id === hunkId);
    if (hunk) {
      hunk.decision = 'accept';
    }

    await this.evaluateProposalCompletion(proposal);
  }

  /**
   * Rejects a specific hunk
   */
  public async rejectHunk(proposalId: string, hunkId: string): Promise<void> {
    const proposal = this.activeProposals.get(proposalId);
    if (!proposal) return;

    const hunk = proposal.hunks.find(h => h.id === hunkId);
    if (hunk) {
      hunk.decision = 'reject';
    }

    await this.evaluateProposalCompletion(proposal);
  }

  /**
   * Accepts all remaining undecided hunks
   */
  public async acceptAll(proposalId?: string): Promise<void> {
    const proposal = proposalId
      ? this.activeProposals.get(proposalId)
      : Array.from(this.activeProposals.values()).find(p => p.state === 'pending');
    if (!proposal) return;

    for (const hunk of proposal.hunks) {
      if (hunk.decision === 'undecided') {
        hunk.decision = 'accept';
      }
    }

    await this.evaluateProposalCompletion(proposal);
  }

  /**
   * Rejects all hunks
   */
  public async rejectAll(proposalId?: string): Promise<void> {
    const proposal = proposalId
      ? this.activeProposals.get(proposalId)
      : Array.from(this.activeProposals.values()).find(p => p.state === 'pending');
    if (!proposal) return;

    for (const hunk of proposal.hunks) {
      hunk.decision = 'reject';
    }

    proposal.state = 'rejected';
    this.onDidChangeCodeLensesEmitter.fire();
    this.clearDecorations();
    vscode.window.showInformationMessage(`Proposal for ${proposal.filePath} rejected.`);
  }

  /**
   * When all hunks have decisions, apply accepted ones atomically and save checkpoint
   */
  private async evaluateProposalCompletion(proposal: Proposal): Promise<void> {
    const hasUndecided = proposal.hunks.some(h => h.decision === 'undecided');
    if (hasUndecided) {
      this.onDidChangeCodeLensesEmitter.fire();
      return;
    }

    const acceptedHunks = proposal.hunks.filter(h => h.decision === 'accept');
    if (acceptedHunks.length === 0) {
      proposal.state = 'rejected';
      this.onDidChangeCodeLensesEmitter.fire();
      this.clearDecorations();
      vscode.window.showInformationMessage(`All changes for ${proposal.filePath} were rejected.`);
      return;
    }

    // Apply changes atomically via WorkspaceEdit
    await this.applyAcceptedProposal(proposal, acceptedHunks);
  }

  private async applyAcceptedProposal(proposal: Proposal, acceptedHunks: Hunk[]): Promise<void> {
    const fullPath = this.toolManager.resolveSafePath(proposal.filePath);
    const uri = vscode.Uri.file(fullPath);

    // Step 1: Take checkpoint of pre-change image into extension storage
    const preContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
    const checkpoint: Checkpoint = {
      id: `chk-${Date.now()}`,
      proposalId: proposal.id,
      filePath: proposal.filePath,
      preImage: preContent,
      preHash: proposal.baseHash,
      postHash: '',
      appliedAt: Date.now()
    };

    // Save checkpoint file in storageUri
    const checkpointFile = path.join(this.extensionStorageUri.fsPath, `${checkpoint.id}.bak`);
    try {
      fs.writeFileSync(checkpointFile, preContent, 'utf8');
    } catch {
      // Continue in memory
    }
    this.checkpoints.push(checkpoint);

    // Step 2: Apply WorkspaceEdit
    const wsEdit = new vscode.WorkspaceEdit();

    if (proposal.newFileContent !== undefined) {
      // New file or whole-content replacement
      if (!fs.existsSync(fullPath)) {
        wsEdit.createFile(uri, { overwrite: true });
        wsEdit.insert(uri, new vscode.Position(0, 0), proposal.newFileContent);
      } else {
        const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(999999, 0));
        wsEdit.replace(uri, fullRange, proposal.newFileContent);
      }
    } else {
      // Apply search/replace edits
      for (const edit of proposal.edits) {
        if (!edit.old_text) continue;
        const currentDoc = await vscode.workspace.openTextDocument(uri);
        const text = currentDoc.getText();
        const offset = text.indexOf(edit.old_text);
        if (offset !== -1) {
          const startPos = currentDoc.positionAt(offset);
          const endPos = currentDoc.positionAt(offset + edit.old_text.length);
          wsEdit.replace(uri, new vscode.Range(startPos, endPos), edit.new_text || '');
        }
      }
    }

    const applied = await vscode.workspace.applyEdit(wsEdit);
    if (applied) {
      proposal.state = acceptedHunks.length === proposal.hunks.length ? 'applied' : 'partially_applied';
      const doc = await vscode.workspace.openTextDocument(uri);
      const autoSave = vscode.workspace.getConfiguration('forge').get<boolean>('autoSave', true);
      if (autoSave) {
        await doc.save();
      }
      checkpoint.postHash = doc.getText();
      vscode.window.showInformationMessage(`Applied ${acceptedHunks.length} hunk(s) to ${proposal.filePath}`);
    } else {
      vscode.window.showErrorMessage(`Failed to apply edits to ${proposal.filePath}`);
    }

    this.onDidChangeCodeLensesEmitter.fire();
    this.clearDecorations();
  }

  /**
   * Undo last applied proposal
   */
  public async undoLast(): Promise<boolean> {
    const checkpoint = this.checkpoints.pop();
    if (!checkpoint) {
      vscode.window.showWarningMessage('No checkpoints available to undo.');
      return false;
    }

    return this.restoreCheckpoint(checkpoint);
  }

  /**
   * Undo all changes in run
   */
  public async undoAll(): Promise<void> {
    while (this.checkpoints.length > 0) {
      const chk = this.checkpoints.pop();
      if (chk) await this.restoreCheckpoint(chk);
    }
    vscode.window.showInformationMessage('Restored all files to pre-run state.');
  }

  private async restoreCheckpoint(chk: Checkpoint): Promise<boolean> {
    const fullPath = this.toolManager.resolveSafePath(chk.filePath);
    const uri = vscode.Uri.file(fullPath);
    const wsEdit = new vscode.WorkspaceEdit();

    if (chk.preImage === '') {
      // File did not exist originally
      wsEdit.deleteFile(uri, { ignoreIfNotExists: true });
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      wsEdit.replace(uri, fullRange, chk.preImage);
    }

    const ok = await vscode.workspace.applyEdit(wsEdit);
    if (ok) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
      vscode.window.showInformationMessage(`Restored ${chk.filePath} to pre-change state.`);
    }
    return ok;
  }

  public updateActiveEditorDecorations() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const docPath = this.normalizeRelPath(this.toolManager.toRelativePath(editor.document.fileName));
    const proposal = Array.from(this.activeProposals.values()).find(
      p => this.normalizeRelPath(p.filePath) === docPath && p.state === 'pending'
    );

    if (!proposal) {
      this.clearDecorations();
      return;
    }

    const addedRanges: vscode.Range[] = [];
    const removedRanges: vscode.Range[] = [];

    for (const hunk of proposal.hunks) {
      if (hunk.decision !== 'undecided') continue;
      const start = Math.max(0, hunk.oldStartLine - 1);
      const count = Math.max(1, hunk.oldLineCount);
      const range = new vscode.Range(start, 0, start + count, 0);
      if (hunk.lines.some(l => l.startsWith('+'))) {
        addedRanges.push(range);
      } else {
        removedRanges.push(range);
      }
    }

    editor.setDecorations(this.addedDecorationType, addedRanges);
    editor.setDecorations(this.removedDecorationType, removedRanges);
  }

  public clearDecorations() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.addedDecorationType, []);
      editor.setDecorations(this.removedDecorationType, []);
    }
  }
}
