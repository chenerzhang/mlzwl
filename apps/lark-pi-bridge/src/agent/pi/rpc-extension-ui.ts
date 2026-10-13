import type { AgentExtensionUIRequest, AgentExtensionUIResponse } from '../types.js';

const MAX_ID_CHARS = 256;
const MAX_TITLE_CHARS = 512;
const MAX_MESSAGE_CHARS = 8_192;
const MAX_INPUT_CHARS = 8_192;
const MAX_STATUS_KEY_CHARS = 128;
const MAX_STATUS_TEXT_CHARS = 1_024;
const MAX_WIDGET_KEY_CHARS = 128;
const MAX_WIDGET_LINES = 64;
const MAX_WIDGET_LINE_CHARS = 1_024;
const MAX_SELECT_OPTIONS = 64;
const MAX_SELECT_OPTION_CHARS = 512;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;

export interface RpcExtensionUIRequestEnvelope {
  id: string;
  request: AgentExtensionUIRequest;
  expectsResponse: boolean;
}

export interface RpcUIPromptLifecycleEvent {
  type: 'ui_prompt_start' | 'ui_prompt_end';
  reason: 'ui_prompt';
  kind: 'select' | 'confirm' | 'input' | 'editor' | 'custom';
  title?: string;
}

export function parseRpcExtensionUIRequest(raw: unknown): RpcExtensionUIRequestEnvelope {
  enforceBytes(raw, MAX_REQUEST_BYTES, 'Pi RPC extension UI request');
  const value = exactRecord(raw, 'Pi RPC extension UI request');
  requiredLiteral(value, 'type', 'extension_ui_request');
  const id = requiredString(value, 'id', MAX_ID_CHARS);
  const method = requiredString(value, 'method', 64);
  let request: AgentExtensionUIRequest;
  switch (method) {
    case 'select':
      onlyKeys(value, ['type', 'id', 'method', 'title', 'options', 'timeout']);
      request = {
        method,
        title: requiredString(value, 'title', MAX_TITLE_CHARS),
        options: uniqueStrings(
          requiredStringArray(value, 'options', MAX_SELECT_OPTIONS, MAX_SELECT_OPTION_CHARS),
          'options',
        ),
        ...optionalTimeout(value.timeout),
      };
      break;
    case 'confirm':
      onlyKeys(value, ['type', 'id', 'method', 'title', 'message', 'timeout']);
      request = {
        method,
        title: requiredString(value, 'title', MAX_TITLE_CHARS),
        message: requiredString(value, 'message', MAX_MESSAGE_CHARS, true),
        ...optionalTimeout(value.timeout),
      };
      break;
    case 'input':
      onlyKeys(value, ['type', 'id', 'method', 'title', 'placeholder', 'timeout']);
      request = {
        method,
        title: requiredString(value, 'title', MAX_TITLE_CHARS),
        ...optionalStringProperty(value, 'placeholder', MAX_TITLE_CHARS),
        ...optionalTimeout(value.timeout),
      };
      break;
    case 'editor':
      onlyKeys(value, ['type', 'id', 'method', 'title', 'prefill']);
      request = {
        method,
        title: requiredString(value, 'title', MAX_TITLE_CHARS),
        ...optionalStringProperty(value, 'prefill', MAX_INPUT_CHARS, true),
      };
      break;
    case 'notify': {
      onlyKeys(value, ['type', 'id', 'method', 'message', 'notifyType']);
      const notifyType = value.notifyType ?? 'info';
      if (notifyType !== 'info' && notifyType !== 'warning' && notifyType !== 'error') {
        throw new Error('Pi RPC extension UI notifyType is invalid');
      }
      request = {
        method,
        message: requiredString(value, 'message', MAX_MESSAGE_CHARS, true),
        notifyType,
      };
      break;
    }
    case 'setStatus':
      onlyKeys(value, ['type', 'id', 'method', 'statusKey', 'statusText']);
      request = {
        method,
        statusKey: requiredString(value, 'statusKey', MAX_STATUS_KEY_CHARS),
        ...optionalStringProperty(value, 'statusText', MAX_STATUS_TEXT_CHARS, true),
      };
      break;
    case 'setWidget': {
      onlyKeys(value, ['type', 'id', 'method', 'widgetKey', 'widgetLines', 'widgetPlacement']);
      const placement = value.widgetPlacement ?? 'aboveEditor';
      if (placement !== 'aboveEditor' && placement !== 'belowEditor') {
        throw new Error('Pi RPC extension UI widgetPlacement is invalid');
      }
      request = {
        method,
        widgetKey: requiredString(value, 'widgetKey', MAX_WIDGET_KEY_CHARS),
        ...(value.widgetLines === undefined
          ? {}
          : {
              widgetLines: requiredStringArray(
                value,
                'widgetLines',
                MAX_WIDGET_LINES,
                MAX_WIDGET_LINE_CHARS,
                true,
                true,
              ),
            }),
        widgetPlacement: placement,
      };
      break;
    }
    case 'setTitle':
      onlyKeys(value, ['type', 'id', 'method', 'title']);
      request = { method, title: requiredString(value, 'title', MAX_TITLE_CHARS, true) };
      break;
    case 'set_editor_text':
      onlyKeys(value, ['type', 'id', 'method', 'text']);
      request = { method, text: requiredString(value, 'text', MAX_INPUT_CHARS, true) };
      break;
    default:
      throw new Error(`Unknown Pi RPC extension UI method: ${method}`);
  }
  return { id, request, expectsResponse: isDialogRequest(request) };
}

export function parseRpcUIPromptLifecycleEvent(raw: unknown): RpcUIPromptLifecycleEvent {
  enforceBytes(raw, MAX_REQUEST_BYTES, 'Pi RPC UI prompt lifecycle event');
  const value = exactRecord(raw, 'Pi RPC UI prompt lifecycle event');
  const type = value.type;
  if (type !== 'ui_prompt_start' && type !== 'ui_prompt_end') {
    throw new Error('Pi RPC UI prompt lifecycle event type is invalid');
  }
  onlyKeys(value, ['type', 'reason', 'kind', 'title']);
  requiredLiteral(value, 'reason', 'ui_prompt');
  const kind = value.kind;
  if (kind !== 'select' && kind !== 'confirm' && kind !== 'input' && kind !== 'editor' && kind !== 'custom') {
    throw new Error('Pi RPC UI prompt lifecycle kind is invalid');
  }
  return {
    type,
    reason: 'ui_prompt',
    kind,
    ...optionalStringProperty(value, 'title', MAX_TITLE_CHARS),
  };
}

export function serializeRpcExtensionUIResponse(
  id: string,
  request: AgentExtensionUIRequest,
  response: AgentExtensionUIResponse,
): Buffer {
  boundedString(id, 'id', MAX_ID_CHARS);
  if (!isDialogMethod(request.method)) {
    throw new Error(`Pi RPC extension UI method ${request.method} does not accept a response`);
  }
  let body: Record<string, unknown>;
  if ('cancelled' in response) {
    body = { type: 'extension_ui_response', id, cancelled: true };
  } else if (request.method === 'confirm') {
    if (!('confirmed' in response) || typeof response.confirmed !== 'boolean') {
      throw new Error('Pi RPC confirm requires a boolean confirmation response');
    }
    body = { type: 'extension_ui_response', id, confirmed: response.confirmed };
  } else {
    if (!('value' in response)) {
      throw new Error(`Pi RPC ${request.method} requires a string value response`);
    }
    boundedString(
      response.value,
      'value',
      request.method === 'select' ? MAX_SELECT_OPTION_CHARS : MAX_INPUT_CHARS,
      request.method !== 'select',
    );
    if (request.method === 'select' && !request.options.includes(response.value)) {
      throw new Error('Pi RPC select response did not match a declared option');
    }
    body = { type: 'extension_ui_response', id, value: response.value };
  }
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  if (payload.length > MAX_REQUEST_BYTES) {
    throw new Error(`Pi RPC extension UI response exceeded ${MAX_REQUEST_BYTES} bytes`);
  }
  return payload;
}

export function isDialogRequest(
  request: AgentExtensionUIRequest,
): request is Extract<AgentExtensionUIRequest, { method: 'select' | 'confirm' | 'input' | 'editor' }> {
  return isDialogMethod(request.method);
}

function isDialogMethod(
  method: AgentExtensionUIRequest['method'],
): method is 'select' | 'confirm' | 'input' | 'editor' {
  return method === 'select' || method === 'confirm' || method === 'input' || method === 'editor';
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new Error(`Pi RPC extension UI request contains unexpected field: ${unexpected}`);
  }
}

function requiredLiteral(value: Record<string, unknown>, key: string, expected: string): void {
  if (value[key] !== expected) {
    throw new Error(`Pi RPC extension UI ${key} is invalid`);
  }
}

function requiredString(value: Record<string, unknown>, key: string, maxChars: number, allowEmpty = false): string {
  if (typeof value[key] !== 'string') {
    throw new Error(`Pi RPC extension UI ${key} must be a string`);
  }
  return boundedString(value[key], key, maxChars, allowEmpty);
}

function boundedString(value: string, key: string, maxChars: number, allowEmpty = false): string {
  if ((!allowEmpty && value.length === 0) || value.length > maxChars) {
    throw new Error(
      `Pi RPC extension UI ${key} must contain ${allowEmpty ? 'at most' : '1 to'} ${maxChars} characters`,
    );
  }
  return value;
}

function optionalStringProperty(
  value: Record<string, unknown>,
  key: string,
  maxChars: number,
  allowEmpty = false,
): Record<string, string> {
  if (value[key] === undefined) {
    return {};
  }
  if (typeof value[key] !== 'string') {
    throw new Error(`Pi RPC extension UI ${key} must be a string when present`);
  }
  return { [key]: boundedString(value[key], key, maxChars, allowEmpty) };
}

function requiredStringArray(
  value: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxChars: number,
  allowEmptyString = false,
  allowEmptyArray = false,
): string[] {
  const items = value[key];
  if (!Array.isArray(items) || (!allowEmptyArray && items.length === 0) || items.length > maxItems) {
    throw new Error(`Pi RPC extension UI ${key} must contain ${allowEmptyArray ? '0 to' : '1 to'} ${maxItems} items`);
  }
  return items.map((item) => {
    if (typeof item !== 'string') {
      throw new Error(`Pi RPC extension UI ${key} must contain only strings`);
    }
    return boundedString(item, key, maxChars, allowEmptyString);
  });
}

function optionalTimeout(value: unknown): { timeoutMs?: number } {
  if (value === undefined) {
    return {};
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TIMEOUT_MS) {
    throw new Error(`Pi RPC extension UI timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return { timeoutMs: value as number };
}

function uniqueStrings(values: string[], key: string): string[] {
  if (new Set(values).size !== values.length) {
    throw new Error(`Pi RPC extension UI ${key} must not contain duplicates`);
  }
  return values;
}

function enforceBytes(value: unknown, max: number, label: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > max) {
    throw new Error(`${label} exceeded ${max} bytes`);
  }
}
