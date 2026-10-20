import type { AccessMode } from '../../config/permissions.js';

export interface BuildPiArgsInput {
  accessMode: AccessMode;
  handoff?: boolean;
  forkPath?: string;
  sessionId?: string;
  sessionDir: string;
  model?: string;
  thinkingLevel?: string;
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
  const args = ['--mode', 'json', '--session-dir', input.sessionDir, input.handoff ? '--approve' : '--no-approve'];
  if (input.forkPath) {
    args.push('--fork', input.forkPath);
  } else if (input.sessionId) {
    args.push('--session', input.sessionId);
  }
  if (input.model) {
    args.push('--model', input.model);
  }
  if (input.thinkingLevel) {
    args.push('--thinking', input.thinkingLevel);
  }
  args.push('--append-system-prompt', input.bridgeSystemPromptFile);
  if (!input.handoff && input.accessMode === 'read-only') {
    args.push('--tools', 'read,grep,find,ls');
  }
  // Pi resolves @file inputs from argv. Paths must be profile-local validated media files.
  for (const attachment of input.attachments ?? []) {
    args.push(`@${attachment}`);
  }
  return args;
}
