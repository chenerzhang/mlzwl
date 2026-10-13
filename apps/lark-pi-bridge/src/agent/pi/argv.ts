import type { AccessMode } from '../../config/permissions.js';

export interface BuildPiArgsInput {
  accessMode: AccessMode;
  sessionId?: string;
  sessionDir: string;
  model?: string;
  attachments?: string[];
  bridgeSystemPromptFile: string;
}

/** Pi JSON-mode invocation with the fixed unattended-resource policy. */
export function buildPiArgs(input: BuildPiArgsInput): string[] {
  if (!input.sessionDir.trim()) {
    throw new Error('Pi sessionDir is required');
  }
  if (!input.bridgeSystemPromptFile.trim()) {
    throw new Error('Pi bridge system prompt file is required');
  }
  const args = ['--mode', 'json', '--session-dir', input.sessionDir, '--no-approve'];
  if (input.sessionId) {
    args.push('--session', input.sessionId);
  }
  if (input.model) {
    args.push('--model', input.model);
  }
  args.push('--append-system-prompt', input.bridgeSystemPromptFile);
  if (input.accessMode === 'read-only') {
    args.push('--tools', 'read,grep,find,ls');
  }
  // Pi resolves @file inputs from argv. Paths must be profile-local validated media files.
  for (const attachment of input.attachments ?? []) {
    args.push(`@${attachment}`);
  }
  return args;
}
