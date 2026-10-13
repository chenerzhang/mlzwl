import type { AccessMode } from '../../config/permissions.js';

export interface BuildPiRpcArgsInput {
  accessMode: AccessMode;
  sessionId?: string;
  sessionDir: string;
  model?: string;
  bridgeSystemPromptFile: string;
}

/** Pi RPC invocation with the same fixed unattended-resource policy as JSON mode. */
export function buildPiRpcArgs(input: BuildPiRpcArgsInput): string[] {
  if (!input.sessionDir.trim()) {
    throw new Error('Pi sessionDir is required');
  }
  if (!input.bridgeSystemPromptFile.trim()) {
    throw new Error('Pi bridge system prompt file is required');
  }
  const args = ['--mode', 'rpc', '--session-dir', input.sessionDir, '--no-approve'];
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
  return args;
}
