/**
 * State model entities for Forge (SRS section 7).
 * All state lives in memory and extension storage.
 * Nothing is written to the workspace during staging.
 */

export type RunKind = 'inline' | 'agent';
export type RunState = 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';
export type ProposalState = 'pending' | 'applied' | 'partially_applied' | 'rejected' | 'stale' | 'cancelled';
export type HunkDecision = 'accept' | 'reject' | 'undecided';

export interface Hunk {
  id: string;
  proposalId: string;
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
  lines: string[];
  decision: HunkDecision;
  outsideSelection?: boolean;
}

export interface Proposal {
  id: string;
  runId: string;
  toolCallId: string;
  filePath: string; // Workspace-relative POSIX path
  baseHash: string;
  edits: Array<{ old_text?: string; new_text?: string }>;
  newFileContent?: string;
  summary?: string;
  hunks: Hunk[];
  state: ProposalState;
}

export interface Checkpoint {
  id: string;
  proposalId: string;
  filePath: string;
  preImage: string;
  preHash: string;
  postHash: string;
  appliedAt: number;
}

export interface LedgerEntry {
  runId: string;
  pathOrSymbol: string;
  source: 'mention' | 'auto' | 'agent_read';
  estTokens: number;
  reason: string;
  ts: number;
}

export interface ToolCallTimelineEntry {
  id: string;
  name: string;
  argSummary: string;
  resultSize?: string;
  durationMs?: number;
  status: 'running' | 'complete' | 'failed' | 'awaiting_approval';
  requiresApproval?: boolean;
}

export interface Run {
  id: string;
  kind: RunKind;
  sessionId?: string;
  turnId?: string;
  agentName: string;
  state: RunState;
  startedAt: number;
  proposals: Proposal[];
  checkpoints: Checkpoint[];
  ledger: LedgerEntry[];
  timeline: ToolCallTimelineEntry[];
  stopReason?: string;
}
