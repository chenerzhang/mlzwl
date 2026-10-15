export const REASONING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export function normalizeReasoningEffort(value: unknown): ReasoningLevel | undefined {
  const effort =
    typeof value === 'string'
      ? value.trim().toLowerCase()
      : value && typeof value === 'object' && typeof (value as { effort?: unknown }).effort === 'string'
        ? (value as { effort: string }).effort.trim().toLowerCase()
        : '';
  if (!effort) {
    return undefined;
  }
  return (REASONING_LEVELS as readonly string[]).includes(effort) ? (effort as ReasoningLevel) : undefined;
}

export function resolveResponsesReasoningEffort(body: Record<string, unknown>): ReasoningLevel | undefined {
  const reasoning =
    body.reasoning && typeof body.reasoning === 'object' ? (body.reasoning as Record<string, unknown>) : {};
  return normalizeReasoningEffort(reasoning.effort) ?? normalizeReasoningEffort(body.reasoning_effort);
}

export function resolveAnthropicReasoningEffort(body: Record<string, unknown>): ReasoningLevel | undefined {
  const outputConfig =
    body.output_config && typeof body.output_config === 'object' ? (body.output_config as Record<string, unknown>) : {};
  const direct = normalizeReasoningEffort(outputConfig.effort) ?? normalizeReasoningEffort(body.reasoning_effort);
  if (direct) {
    return direct;
  }
  const thinking = body.thinking && typeof body.thinking === 'object' ? (body.thinking as Record<string, unknown>) : {};
  const thinkingType = typeof thinking.type === 'string' ? thinking.type : '';
  if (thinkingType === 'adaptive') {
    return 'xhigh';
  }
  if (thinkingType === 'enabled') {
    const budget = Number(thinking.budget_tokens);
    if (!Number.isFinite(budget) || budget <= 0) {
      return 'high';
    }
    if (budget < 4000) {
      return 'low';
    }
    if (budget < 16000) {
      return 'medium';
    }
    return 'high';
  }
  return undefined;
}

export type ReasoningProjectionMode = 'summary' | 'raw' | 'dual';

export function reasoningProjectionMode(
  value = process.env.X_ADAPTER_REASONING_PROJECTION ?? 'summary',
): ReasoningProjectionMode {
  const normalized = value.trim().toLowerCase();
  return normalized === 'raw' || normalized === 'dual' || normalized === 'summary' ? normalized : 'summary';
}

export function toReasoningEffort(effort: unknown): string | undefined {
  const normalized = normalizeReasoningEffort(effort);
  if (!normalized || normalized === 'none') {
    return normalized;
  }
  // Provider-compatible defensive mapping: clients may request max, while upstream
  // model configs commonly expose xhigh as the strongest stable level.
  if (normalized === 'max') {
    return 'xhigh';
  }
  return normalized;
}

export function shouldExposeRawReasoning(mode = reasoningProjectionMode()): boolean {
  return mode === 'raw' || mode === 'dual';
}

export function shouldExposeReasoningSummary(mode = reasoningProjectionMode()): boolean {
  return mode === 'summary' || mode === 'dual';
}
