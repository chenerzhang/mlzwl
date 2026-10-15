import { CanonicalTool, CanonicalToolCall, CanonicalToolChoice } from './canonical.js';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function stringifyJson(value: unknown, fallback = '{}'): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? {}, null, 0);
  } catch {
    return fallback;
  }
}

function simpleHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function pointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    return undefined;
  }
  let node = root;
  for (const rawToken of ref.slice(2).split('/')) {
    const token = pointerToken(rawToken);
    if (Array.isArray(node) && /^\d+$/.test(token)) {
      node = node[Number(token)];
    } else if (node && typeof node === 'object') {
      node = (node as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return node;
}

function refAlias(ref: string): string {
  const slug =
    ref
      .replace(/^#\//, '')
      .replace(/[^0-9A-Za-z_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'root';
  return `ref__${slug}__${simpleHash(ref)}`;
}

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

function cloneSchemaLiteral(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneSchemaLiteral);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneSchemaLiteral(child)]));
}

export function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (schema === true) {
    return {};
  }
  if (schema === false) {
    return { not: {} };
  }
  const root = asObject(schema);
  if (Object.keys(root).length === 0) {
    return { type: 'object', properties: {} };
  }

  const generatedDefs: Record<string, unknown> = {};
  const seenRefs = new Set<string>();
  const reserved = new Set<string>();
  for (const key of ['$defs', 'definitions']) {
    const defs = asObject(root[key]);
    for (const name of Object.keys(defs)) {
      reserved.add(name);
    }
  }

  const uniqueAlias = (ref: string) => {
    const base = refAlias(ref);
    let alias = base;
    let index = 2;
    while (reserved.has(alias)) {
      alias = `${base}_${index}`;
      index += 1;
    }
    reserved.add(alias);
    return alias;
  };

  const aliases = new Map<string, string>();
  const aliasFor = (ref: string) => {
    const existing = aliases.get(ref);
    if (existing) {
      return existing;
    }
    const alias = uniqueAlias(ref);
    aliases.set(ref, alias);
    return alias;
  };

  function normalizeSchemaMap(value: unknown): Record<string, unknown> {
    return Object.fromEntries(Object.entries(asObject(value)).map(([key, child]) => [key, normalizeNode(child)]));
  }

  function normalizeDependencies(value: unknown): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(asObject(value)).map(([key, child]) => [
        key,
        Array.isArray(child) ? cloneSchemaLiteral(child) : normalizeNode(child),
      ]),
    );
  }

  function normalizeNode(node: unknown): unknown {
    if (node === true) {
      return {};
    }
    if (node === false) {
      return { not: {} };
    }
    if (Array.isArray(node)) {
      return node.map(normalizeNode);
    }
    if (!node || typeof node !== 'object') {
      return node;
    }
    const input = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (SCHEMA_MAP_KEYWORDS.has(key)) {
        const targetKey = key === 'definitions' ? '$defs' : key;
        out[targetKey] = { ...asObject(out[targetKey]), ...normalizeSchemaMap(value) };
      } else if (key === '$ref' && typeof value === 'string') {
        if (value.startsWith('#/definitions/')) {
          out.$ref = value.replace('#/definitions/', '#/$defs/');
        } else if (value.startsWith('#/$defs/')) {
          out.$ref = value;
        } else if (value.startsWith('#/')) {
          const alias = aliasFor(value);
          const target = resolvePointer(root, value);
          if (target !== undefined && !seenRefs.has(value)) {
            seenRefs.add(value);
            generatedDefs[alias] = normalizeNode(target);
          }
          out.$ref = `#/$defs/${alias}`;
        } else {
          out.$ref = value;
        }
      } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
        out[key] = value.map(normalizeNode);
      } else if (key === 'dependencies') {
        out.dependencies = normalizeDependencies(value);
      } else if (key === 'additionalProperties' && value === true) {
        // Omitting `true` preserves its JSON Schema meaning and avoids restricted
        // function-schema validators that only accept a boolean for this keyword.
        continue;
      } else if (key === 'additionalProperties' && value === false) {
        out.additionalProperties = false;
      } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        out[key] = Array.isArray(value) ? value.map(normalizeNode) : normalizeNode(value);
      } else {
        // Keywords such as deprecated, readOnly, const, default and enum contain
        // literal values, not child schemas. Preserve those values byte-for-byte.
        out[key] = cloneSchemaLiteral(value);
      }
    }
    if (
      out.type === 'object' &&
      (out.properties === undefined ||
        out.properties === null ||
        typeof out.properties !== 'object' ||
        Array.isArray(out.properties))
    ) {
      out.properties = {};
    }
    return out;
  }

  const normalized = normalizeNode(root) as Record<string, unknown>;
  if (Object.keys(generatedDefs).length > 0) {
    normalized.$defs = { ...asObject(normalized.$defs), ...generatedDefs };
  }
  return normalized;
}

const HOSTED_WEB_SEARCH_TOOL_TYPES = new Set([
  'web_search',
  'tool_search',
  'web_search_20250305',
  'web_search_20260209',
  'web_search_preview',
  'web_search_preview_2025_03_11',
]);

function hostedSearchToolName(item: Record<string, unknown>): string {
  const type = typeof item.type === 'string' ? item.type : '';
  const name = typeof item.name === 'string' ? item.name : '';
  if (HOSTED_WEB_SEARCH_TOOL_TYPES.has(type)) {
    return type;
  }
  if (HOSTED_WEB_SEARCH_TOOL_TYPES.has(name)) {
    return name;
  }
  return '';
}

function hostedSearchCanonical(name: string): CanonicalTool {
  return {
    type: 'function',
    hosted: true,
    function: {
      name,
      description: 'Hosted web search tool.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  };
}

export function openAiToolsToCanonical(tools: unknown): CanonicalTool[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((tool) => {
    const item = asObject(tool);
    const hosted = hostedSearchToolName(item);
    if (hosted) {
      return [hostedSearchCanonical(hosted)];
    }
    const fn = asObject(item.function);
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (!name) {
      return [];
    }
    return [
      {
        type: 'function' as const,
        function: {
          name,
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: normalizeSchema(fn.parameters),
        },
      },
    ];
  });
}

export function anthropicToolsToCanonical(tools: unknown): CanonicalTool[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((tool) => {
    const item = asObject(tool);
    const hosted = hostedSearchToolName(item);
    if (hosted) {
      return [hostedSearchCanonical(hosted)];
    }
    const name = typeof item.name === 'string' ? item.name : '';
    if (!name) {
      return [];
    }
    return [
      {
        type: 'function' as const,
        function: {
          name,
          description: typeof item.description === 'string' ? item.description : '',
          parameters: normalizeSchema(item.input_schema),
        },
      },
    ];
  });
}

export function flattenToolName(namespace: string, name: string): string {
  const raw = `${namespace}__${name}`;
  const safe =
    raw
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'tool';
  if (safe.length <= 64) {
    return safe;
  }
  const suffix = `_${simpleHash(raw)}`;
  return `${safe.slice(0, 64 - suffix.length)}${suffix}`;
}

function safeToolName(name: string): string {
  const safe =
    name
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'tool';
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return name;
  }
  if (safe.length <= 55) {
    return `${safe}_${simpleHash(name)}`;
  }
  const suffix = `_${simpleHash(name)}`;
  return `${safe.slice(0, 64 - suffix.length)}${suffix}`;
}

export type CanonicalToolBinding = {
  clientName: string;
  canonicalName: string;
  upstreamName: string;
  clientType: 'function' | 'custom';
  namespace?: string;
};

export class ToolNameMapper {
  private originalToUpstream = new Map<string, string>();
  private upstreamToOriginal = new Map<string, string>();
  private bindingsByUpstream = new Map<string, CanonicalToolBinding>();

  toUpstream(original: string): string {
    const existing = this.originalToUpstream.get(original);
    if (existing) {
      return existing;
    }
    let candidate = safeToolName(original);
    if (this.upstreamToOriginal.has(candidate) && this.upstreamToOriginal.get(candidate) !== original) {
      const suffix = `_${simpleHash(original)}`;
      candidate = `${candidate.slice(0, 64 - suffix.length)}${suffix}`;
      let counter = 2;
      while (this.upstreamToOriginal.has(candidate) && this.upstreamToOriginal.get(candidate) !== original) {
        const countedSuffix = `_${simpleHash(`${original}:${counter}`)}`;
        candidate = `${safeToolName(original).slice(0, 64 - countedSuffix.length)}${countedSuffix}`;
        counter += 1;
      }
    }
    this.originalToUpstream.set(original, candidate);
    this.upstreamToOriginal.set(candidate, original);
    return candidate;
  }

  toOriginal(upstream: string): string {
    return this.upstreamToOriginal.get(upstream) ?? upstream;
  }

  mapTool(tool: CanonicalTool): CanonicalTool {
    if (tool.hosted) {
      return tool;
    }
    const upstreamName = this.toUpstream(tool.function.name);
    this.bindingsByUpstream.set(upstreamName, {
      clientName: tool.client_name ?? tool.function.name,
      canonicalName: tool.function.name,
      upstreamName,
      clientType: tool.client_type ?? 'function',
      namespace: tool.namespace,
    });
    return { ...tool, function: { ...tool.function, name: upstreamName } };
  }

  mapTools(tools: CanonicalTool[] | undefined): CanonicalTool[] | undefined {
    return tools?.map((tool) => this.mapTool(tool));
  }

  mapToolChoice(choice: CanonicalToolChoice | undefined): CanonicalToolChoice | undefined {
    if (!choice || typeof choice === 'string') {
      return choice;
    }
    return { type: 'function', function: { name: this.toUpstream(choice.function.name) } };
  }

  mapToolCall(toolCall: CanonicalToolCall): CanonicalToolCall {
    if (toolCall.function.name === 'web_search' || toolCall.namespace) {
      return toolCall;
    }
    return { ...toolCall, function: { ...toolCall.function, name: this.toUpstream(toolCall.function.name) } };
  }

  restoreToolCall(toolCall: CanonicalToolCall): CanonicalToolCall {
    if (toolCall.function.name === 'web_search') {
      return toolCall;
    }
    const binding = this.bindingsByUpstream.get(toolCall.function.name);
    const original = this.toOriginal(toolCall.function.name);
    return {
      ...toolCall,
      client_type: toolCall.client_type ?? binding?.clientType,
      namespace: toolCall.namespace ?? binding?.namespace,
      function: { ...toolCall.function, name: binding?.clientName ?? original },
    };
  }

  restoreToolCalls(toolCalls: CanonicalToolCall[]): CanonicalToolCall[] {
    return toolCalls.map((toolCall) => this.restoreToolCall(toolCall));
  }
}

/**
 * Attach the client-facing type information after an adapter generated a
 * canonical function call without retaining its per-request mapper. The
 * lookup is deliberately by the already validated canonical name; duplicate
 * canonical names are rejected before an adapter is invoked.
 */
export function bindCanonicalToolCalls(
  toolCalls: CanonicalToolCall[],
  tools: CanonicalTool[] | undefined,
): CanonicalToolCall[] {
  if (!tools?.length) {
    return toolCalls;
  }
  const bindings = new Map(tools.filter((tool) => !tool.hosted).map((tool) => [tool.function.name, tool]));
  return toolCalls.map((toolCall) => {
    const binding = bindings.get(toolCall.function.name);
    if (!binding) {
      return toolCall;
    }
    return {
      ...toolCall,
      client_type: toolCall.client_type ?? binding.client_type ?? 'function',
      namespace: toolCall.namespace ?? binding.namespace,
      function: { ...toolCall.function, name: binding.client_name ?? toolCall.function.name },
    };
  });
}

/** Custom tool input is raw text; tolerate a function-adapter JSON wrapper. */
export function customToolInput(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { input?: unknown }).input === 'string') {
      return (parsed as { input: string }).input;
    }
  } catch {
    // A provider may already return raw custom input.
  }
  return argumentsText;
}

function responseFunctionTool(item: Record<string, unknown>): CanonicalTool[] {
  const fn = asObject(item.function);
  const name = typeof fn.name === 'string' ? fn.name : typeof item.name === 'string' ? item.name : '';
  if (!name) {
    return [];
  }
  const description =
    typeof fn.description === 'string' ? fn.description : typeof item.description === 'string' ? item.description : '';
  const parameters = fn.parameters ?? item.parameters;
  return [{ type: 'function' as const, function: { name, description, parameters: normalizeSchema(parameters) } }];
}

export function responsesToolsToCanonical(tools: unknown): CanonicalTool[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const out: CanonicalTool[] = [];
  for (const raw of tools) {
    const item = asObject(raw);
    const hosted = hostedSearchToolName(item);
    if (hosted) {
      out.push(hostedSearchCanonical(hosted));
    } else if (item.type === 'function' || item.function) {
      out.push(...responseFunctionTool(item));
    } else if (item.type === 'custom') {
      const name = typeof item.name === 'string' ? item.name : '';
      if (name) {
        out.push({
          type: 'function',
          client_type: 'custom',
          function: {
            name,
            description: typeof item.description === 'string' ? item.description : '',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string', description: 'Raw custom tool input.' } },
              required: ['input'],
            },
          },
        });
      }
    } else if (item.type === 'namespace') {
      const namespace =
        typeof item.namespace === 'string' ? item.namespace : typeof item.name === 'string' ? item.name : '';
      const children = Array.isArray(item.tools) ? item.tools : [];
      for (const childRaw of children) {
        const child = asObject(childRaw);
        const childFn = asObject(child.function ?? child);
        const childName =
          typeof childFn.name === 'string' ? childFn.name : typeof child.name === 'string' ? child.name : '';
        if (!namespace || !childName) {
          continue;
        }
        out.push({
          type: 'function',
          client_type: child.type === 'custom' ? 'custom' : 'function',
          namespace,
          client_name: childName,
          function: {
            name: flattenToolName(namespace, childName),
            description:
              typeof childFn.description === 'string'
                ? childFn.description
                : typeof child.description === 'string'
                  ? child.description
                  : '',
            parameters:
              child.type === 'custom'
                ? {
                    type: 'object',
                    properties: { input: { type: 'string', description: 'Raw custom tool input.' } },
                    required: ['input'],
                  }
                : normalizeSchema(childFn.parameters ?? child.parameters),
          },
        });
      }
    }
  }
  return out;
}

export function normalizeToolChoice(choice: unknown): CanonicalToolChoice | undefined {
  if (choice === 'auto' || choice === 'none' || choice === 'required') {
    return choice;
  }
  const item = asObject(choice);
  if (item.type === 'auto' || item.type === 'none' || item.type === 'required') {
    return item.type;
  }
  const fn = asObject(item.function);
  const name = typeof fn.name === 'string' ? fn.name : typeof item.name === 'string' ? item.name : '';
  if (item.type === 'function' && name) {
    return { type: 'function', function: { name } };
  }
  return undefined;
}

export function applyToolChoice(
  tools: CanonicalTool[] | undefined,
  choice: CanonicalToolChoice | undefined,
): CanonicalTool[] | undefined {
  if (!tools?.length) {
    return undefined;
  }
  if (choice === 'none') {
    return undefined;
  }
  if (choice && typeof choice === 'object') {
    const filtered = tools.filter((tool) => tool.function.name === choice.function.name);
    return filtered.length ? filtered : undefined;
  }
  return tools;
}

export function canonicalToolsToProvider(
  tools: CanonicalTool[] | undefined,
  mapper = new ToolNameMapper(),
): unknown[] | undefined {
  if (!tools?.length) {
    return undefined;
  }
  return tools
    .map((tool) => mapper.mapTool(tool))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: stringifyJson(tool.function.parameters),
      },
    }));
}

/** Trae use the same normalized upstream function-tool schema. */
export const canonicalToolsToTraeCompatible = canonicalToolsToProvider;
export const canonicalToolsToTrae = canonicalToolsToProvider;

export function normalizeToolCallChunks(toolCalls: unknown): CanonicalToolCall[] {
  return mergeToolCallDeltas([toolCalls]);
}

export function mergeToolCallDeltas(chunks: unknown[]): CanonicalToolCall[] {
  const merged = new Map<number, CanonicalToolCall>();
  for (const chunk of chunks) {
    const items = Array.isArray(chunk) ? chunk : [chunk];
    for (const raw of items) {
      const item = asObject(raw);
      if (!Object.keys(item).length) {
        continue;
      }
      const idx = Number.isInteger(Number(item.index)) ? Number(item.index) : merged.size;
      const fn = asObject(item.function_call ?? item.function);
      const current = merged.get(idx) ?? {
        id: typeof item.id === 'string' && item.id ? item.id : `call_${idx}`,
        type: 'function' as const,
        index: idx,
        function: { name: '', arguments: '' },
      };
      if (typeof item.id === 'string' && item.id) {
        current.id = item.id;
      }
      if (typeof fn.name === 'string' && fn.name) {
        current.function.name = fn.name;
      }
      if (fn.arguments !== undefined) {
        current.function.arguments += stringifyJson(fn.arguments, '');
      }
      merged.set(idx, current);
    }
  }
  return [...merged.keys()].sort((a, b) => a - b).map((key) => merged.get(key)!);
}
