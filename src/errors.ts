/**
 * Error classification & resilience standards (SRS section 9 & Review recommendations)
 * Collapsed into 4 clear error classes for reliability and simplicity.
 */

export enum ErrorClass {
  TF_UNREACHABLE = 'TF_UNREACHABLE',
  MODEL_FAIL = 'MODEL_FAIL',
  STREAM_ERROR = 'STREAM_ERROR',
  EDIT_ERROR = 'EDIT_ERROR',
}

export class ForgeError extends Error {
  constructor(
    public readonly errorClass: ErrorClass,
    public readonly code: string,
    message: string,
    public readonly hint?: string
  ) {
    super(message);
    this.name = 'ForgeError';
  }
}

export function formatErrorMessage(err: unknown): string {
  if (err instanceof ForgeError) {
    return `[${err.code}] ${err.message}${err.hint ? ` (${err.hint})` : ''}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Clean user-facing notifications for specific scenarios
 */
export const UserMessages = {
  TF_NOT_RUNNING: 'TrueForge is not running. Start it with: npx @truefoundry/trueforge@latest',
  MODEL_UNREACHABLE: (model: string) => `Model ${model} is unreachable. Attempting fallback...`,
  MODEL_NO_EDIT: 'Model returned no edits. Click retry to run again.',
  RUN_CANCELLED: (appliedCount: number) =>
    `Run cancelled. ${appliedCount} change(s) were applied before cancel.`,
  FALLBACK_NOTICE: (primary: string, fallback: string) =>
    `Primary agent (${primary}) failed. Switched automatically to fallback agent (${fallback}).`,
};
