import crypto from 'node:crypto';
import { CanonicalTool, CanonicalToolChoice } from '../protocol/canonical.js';
import { ToolNameMapper, applyToolChoice } from '../protocol/tools.js';

const DIAGNOSTIC_SCHEMA_KEYWORDS = new Set([
  '$defs',
  '$ref',
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'contentSchema',
  'default',
  'definitions',
  'dependencies',
  'dependentSchemas',
  'deprecated',
  'else',
  'enum',
  'examples',
  'if',
  'items',
  'not',
  'oneOf',
  'patternProperties',
  'prefixItems',
  'propertyNames',
  'readOnly',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
  'writeOnly',
]);
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const MAX_DIAGNOSTIC_TOOLS = 64;
const SCHEMA_FINGERPRINT_KEY = crypto.randomBytes(32);

type AdditionalPropertiesProfile = {
  boolean_true: number;
  boolean_false: number;
  schema_object: number;
  other: number;
};

type ToolSchemaProfile = {
  schema_fingerprint: string;
  schema_bytes: number;
  schema_nodes: number;
  max_depth: number;
  keyword_counts: Record<string, number>;
  additional_properties: AdditionalPropertiesProfile;
};

function emptyAdditionalPropertiesProfile(): AdditionalPropertiesProfile {
  return { boolean_true: 0, boolean_false: 0, schema_object: 0, other: 0 };
}

function increment(target: Record<string, number>, key: string, count = 1): void {
  target[key] = (target[key] ?? 0) + count;
}

function schemaProfile(schema: Record<string, unknown>): ToolSchemaProfile {
  const serialized = JSON.stringify(schema);
  const keywordCounts: Record<string, number> = {};
  const additionalProperties = emptyAdditionalPropertiesProfile();
  let schemaNodes = 0;
  let maxDepth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];

  while (stack.length) {
    const current = stack.pop()!;
    const value = current.value;
    if (typeof value === 'boolean') {
      maxDepth = Math.max(maxDepth, current.depth);
      schemaNodes += 1;
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    maxDepth = Math.max(maxDepth, current.depth);
    schemaNodes += 1;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (DIAGNOSTIC_SCHEMA_KEYWORDS.has(key)) {
        increment(keywordCounts, key);
      }
      if (key === 'additionalProperties') {
        if (child === true) {
          additionalProperties.boolean_true += 1;
        } else if (child === false) {
          additionalProperties.boolean_false += 1;
        } else if (child && typeof child === 'object' && !Array.isArray(child)) {
          additionalProperties.schema_object += 1;
        } else {
          additionalProperties.other += 1;
        }
      }
      if (SCHEMA_MAP_KEYWORDS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const nested of Object.values(child as Record<string, unknown>)) {
          stack.push({ value: nested, depth: current.depth + 1 });
        }
      } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(child)) {
        for (const nested of child) {
          stack.push({ value: nested, depth: current.depth + 1 });
        }
      } else if (key === 'dependencies' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const nested of Object.values(child as Record<string, unknown>)) {
          if (!Array.isArray(nested)) {
            stack.push({ value: nested, depth: current.depth + 1 });
          }
        }
      } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        if (Array.isArray(child)) {
          for (const nested of child) {
            stack.push({ value: nested, depth: current.depth + 1 });
          }
        } else {
          stack.push({ value: child, depth: current.depth + 1 });
        }
      }
    }
  }

  return {
    schema_fingerprint: `hmac-sha256:${crypto
      .createHmac('sha256', SCHEMA_FINGERPRINT_KEY)
      .update(serialized)
      .digest('hex')
      .slice(0, 16)}`,
    schema_bytes: Buffer.byteLength(serialized, 'utf8'),
    schema_nodes: schemaNodes,
    max_depth: maxDepth,
    keyword_counts: Object.fromEntries(
      Object.entries(keywordCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    additional_properties: additionalProperties,
  };
}

function mergeProfile(
  keywordCounts: Record<string, number>,
  additionalProperties: AdditionalPropertiesProfile,
  profile: ToolSchemaProfile,
): void {
  for (const [key, count] of Object.entries(profile.keyword_counts)) {
    increment(keywordCounts, key, count);
  }
  additionalProperties.boolean_true += profile.additional_properties.boolean_true;
  additionalProperties.boolean_false += profile.additional_properties.boolean_false;
  additionalProperties.schema_object += profile.additional_properties.schema_object;
  additionalProperties.other += profile.additional_properties.other;
}

/**
 * Produces a bounded, value-free summary of the exact canonical tool schemas
 * selected for an upstream request. Property names, descriptions and literal
 * values are deliberately excluded from the log representation.
 */
export type ToolSchemaDiagnosticsOptions = {
  choice?: CanonicalToolChoice;
  focusUpstreamName?: string;
  applyChoice?: boolean;
  mapToolNames?: boolean;
};

export function toolSchemaDiagnostics(
  tools: CanonicalTool[] | undefined,
  options: ToolSchemaDiagnosticsOptions = {},
): Record<string, unknown> | undefined {
  const selected = options.applyChoice === false ? tools : applyToolChoice(tools, options.choice);
  if (!selected?.length) {
    return undefined;
  }
  try {
    const mapped = options.mapToolNames === false ? selected : (new ToolNameMapper().mapTools(selected) ?? []);
    const focusedIndex = options.focusUpstreamName
      ? mapped.findIndex(
          (tool, index) =>
            tool.function.name === options.focusUpstreamName ||
            selected[index]?.function.name === options.focusUpstreamName,
        )
      : -1;
    const includedIndexes = [...selected.keys()].slice(0, MAX_DIAGNOSTIC_TOOLS);
    if (focusedIndex >= MAX_DIAGNOSTIC_TOOLS && includedIndexes.length) {
      includedIndexes[includedIndexes.length - 1] = focusedIndex;
    }
    const uniqueIndexes = [...new Set(includedIndexes)].sort((left, right) => left - right);
    const keywordCounts: Record<string, number> = {};
    const additionalProperties = emptyAdditionalPropertiesProfile();
    let schemaBytes = 0;
    const summaries = uniqueIndexes.map((index) => {
      const tool = selected[index];
      const profile = schemaProfile(tool.function.parameters);
      schemaBytes += profile.schema_bytes;
      mergeProfile(keywordCounts, additionalProperties, profile);
      const upstreamName = mapped[index]?.function.name ?? tool.function.name;
      const originalDiagnosticName = safeIdentifier(tool.function.name) ?? '<nonstandard_tool_name>';
      const upstreamDiagnosticName = safeIdentifier(upstreamName) ?? '<nonstandard_tool_name>';
      return {
        index,
        name: originalDiagnosticName,
        ...(upstreamDiagnosticName === originalDiagnosticName ? {} : { upstream_name: upstreamDiagnosticName }),
        ...profile,
      };
    });
    return {
      version: 1,
      fingerprint_scope: 'daemon_process',
      tool_count: selected.length,
      summarized_tool_count: summaries.length,
      omitted_tool_count: Math.max(0, selected.length - summaries.length),
      summarized_schema_bytes: schemaBytes,
      keyword_counts: Object.fromEntries(
        Object.entries(keywordCounts).sort(([left], [right]) => left.localeCompare(right)),
      ),
      additional_properties: additionalProperties,
      tools: summaries,
    };
  } catch {
    return {
      version: 1,
      fingerprint_scope: 'daemon_process',
      tool_count: selected.length,
      diagnostics_error: 'summary_unavailable',
    };
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

function safeIdentifier(value: unknown, maxLength = 128): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const candidate = value.trim();
  return candidate && candidate.length <= maxLength && /^[A-Za-z0-9_.:-]+$/.test(candidate) ? candidate : undefined;
}

function upstreamCode(message: string): string | undefined {
  const explicit = /\bcode\s*[=:]\s*["']?([A-Za-z0-9_.-]{1,64})/i.exec(message)?.[1];
  if (explicit) {
    return safeIdentifier(explicit, 64)?.toLowerCase();
  }
  if (/\binvalid_function_parameters\b/i.test(message)) {
    return 'invalid_function_parameters';
  }
  return undefined;
}

function rejectedToolName(message: string): string | undefined {
  const quoted = /invalid schema for function\s+["']([^"']{1,128})["']/i.exec(message)?.[1];
  const labeled = /\btool name\s*:\s*([A-Za-z0-9_-]{1,64})/i.exec(message)?.[1];
  return safeIdentifier(quoted ?? labeled);
}

function expectedSchemaType(message: string): string | undefined {
  const expected = /is not of type\s+["'](boolean|object|array|string|number|integer|null)["']/i.exec(message)?.[1];
  return expected?.toLowerCase();
}

export type RequestErrorDiagnostics = {
  error_kind: string;
  failure_stage: string;
  error_cause_code?: string;
  upstream_error_code?: string;
  upstream_tool_name?: string;
  schema_expected_type?: string;
  abort_source?: string;
  configured_max_duration_ms?: number;
  configured_first_event_timeout_ms?: number;
  configured_idle_timeout_ms?: number;
  first_upstream_event_ms?: number;
  last_upstream_event_ms?: number;
  upstream_idle_ms?: number;
  upstream_sse_event_count?: number;
};

type TimeoutDiagnostics = {
  abort_source?: unknown;
  configured_max_duration_ms?: unknown;
  configured_first_event_timeout_ms?: unknown;
  configured_idle_timeout_ms?: unknown;
  first_upstream_event_ms?: unknown;
  last_upstream_event_ms?: unknown;
  upstream_idle_ms?: unknown;
  upstream_sse_event_count?: unknown;
};

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function timeoutDiagnostics(error: unknown): TimeoutDiagnostics | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const value = (error as { timeout_diagnostics?: unknown }).timeout_diagnostics;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as TimeoutDiagnostics) : undefined;
}

/** Classifies an upstream failure without copying its raw message into logs. */
export function requestErrorDiagnostics(error: unknown): RequestErrorDiagnostics {
  const message = errorMessage(error);
  const normalized = message.toLowerCase();
  const causeCode = safeIdentifier(
    error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined,
    64,
  );
  const upstreamErrorCode = upstreamCode(message);
  const invalidToolSchema =
    normalized.includes('invalid schema for function') ||
    normalized.includes('invalid tool schema') ||
    (/\bschema\b/.test(normalized) && normalized.includes('is not of type'));
  const timeout = timeoutDiagnostics(error);
  const abortSource = safeIdentifier(timeout?.abort_source, 64);

  let errorKind = 'unknown';
  let failureStage = 'upstream_request';
  if (
    abortSource === 'first_event_timeout' ||
    abortSource === 'idle_timeout' ||
    abortSource === 'max_duration_timeout'
  ) {
    errorKind = 'timeout';
    failureStage = abortSource;
  } else if (abortSource === 'client_abort') {
    errorKind = 'aborted';
    failureStage = 'client_abort';
  } else if (invalidToolSchema) {
    errorKind = 'invalid_tool_schema';
    failureStage = 'upstream_tool_schema_validation';
  } else if (upstreamErrorCode === 'invalid_function_parameters') {
    errorKind = 'invalid_function_parameters';
    failureStage = 'upstream_function_validation';
  } else if (normalized.includes('no tool output found')) {
    errorKind = 'tool_output_missing';
    failureStage = 'tool_continuation';
  } else if (normalized.includes('abort')) {
    errorKind = 'aborted';
    failureStage = 'client_or_timeout_abort';
  } else if (normalized.includes('rate limit') || normalized.includes('429')) {
    errorKind = 'rate_limited';
  } else if (normalized.includes('timeout') || normalized.includes('timed out')) {
    errorKind = 'timeout';
  } else if (normalized.includes('network') || normalized.includes('fetch failed') || normalized.includes('socket')) {
    errorKind = 'network';
  }

  return {
    error_kind: errorKind,
    failure_stage: failureStage,
    ...(causeCode ? { error_cause_code: causeCode } : {}),
    ...(upstreamErrorCode ? { upstream_error_code: upstreamErrorCode } : {}),
    ...(rejectedToolName(message) ? { upstream_tool_name: rejectedToolName(message) } : {}),
    ...(expectedSchemaType(message) ? { schema_expected_type: expectedSchemaType(message) } : {}),
    ...(abortSource ? { abort_source: abortSource } : {}),
    ...(safeNonNegativeInteger(timeout?.configured_max_duration_ms) !== undefined
      ? { configured_max_duration_ms: safeNonNegativeInteger(timeout?.configured_max_duration_ms) }
      : {}),
    ...(safeNonNegativeInteger(timeout?.configured_first_event_timeout_ms) !== undefined
      ? { configured_first_event_timeout_ms: safeNonNegativeInteger(timeout?.configured_first_event_timeout_ms) }
      : {}),
    ...(safeNonNegativeInteger(timeout?.configured_idle_timeout_ms) !== undefined
      ? { configured_idle_timeout_ms: safeNonNegativeInteger(timeout?.configured_idle_timeout_ms) }
      : {}),
    ...(safeNonNegativeInteger(timeout?.first_upstream_event_ms) !== undefined
      ? { first_upstream_event_ms: safeNonNegativeInteger(timeout?.first_upstream_event_ms) }
      : {}),
    ...(safeNonNegativeInteger(timeout?.last_upstream_event_ms) !== undefined
      ? { last_upstream_event_ms: safeNonNegativeInteger(timeout?.last_upstream_event_ms) }
      : {}),
    ...(safeNonNegativeInteger(timeout?.upstream_idle_ms) !== undefined
      ? { upstream_idle_ms: safeNonNegativeInteger(timeout?.upstream_idle_ms) }
      : {}),
    ...(safeNonNegativeInteger(timeout?.upstream_sse_event_count) !== undefined
      ? { upstream_sse_event_count: safeNonNegativeInteger(timeout?.upstream_sse_event_count) }
      : {}),
  };
}
