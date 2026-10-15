import { ProviderId } from './types.js';

const PREFIX_SEPARATOR = '-';

export function publicModelId(provider: ProviderId, upstreamId: string): string {
  const normalized = upstreamId.trim();
  if (!normalized) {
    throw new Error(`Cannot create public model ID for ${provider}: upstream ID is empty.`);
  }
  return `${provider}${PREFIX_SEPARATOR}${normalized}`;
}

export function parsePublicModelId(value: string): { provider: ProviderId; upstreamId: string } | undefined {
  const normalized = value.trim();
  for (const provider of ['trae', 'doubao'] as const) {
    const prefix = `${provider}${PREFIX_SEPARATOR}`;
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
      return { provider, upstreamId: normalized.slice(prefix.length) };
    }
  }
  return undefined;
}

/** Claude Code's discovery protocol wraps the underlying public ID. */
export function unwrapClaudeModelId(value: string): string {
  const normalized = value.trim();
  const match = /^claude-(.+?)(?:\[1m\])?$/.exec(normalized);
  return match?.[1] ?? normalized;
}

export function claudeModelId(model: { id: string }): string {
  return `claude-${model.id}[1m]`;
}
