import { CanonicalRequest } from '../../protocol/canonical.js';
import { doubaoToolBoundaryError } from './local-runtime-capability.js';

const unsupportedTools = doubaoToolBoundaryError;

function hasToolTranscript(request: CanonicalRequest): boolean {
  return request.messages.some(
    (message) => message.role === 'tool' || Boolean(message.tool_call_id) || Boolean(message.tool_calls?.length),
  );
}

function requiresToolCall(request: CanonicalRequest): boolean {
  return (
    request.tool_choice === 'required' || (request.tool_choice !== undefined && typeof request.tool_choice === 'object')
  );
}

/**
 * Doubao Work has no verified native tool transport. Clients such as Pi still
 * attach their optional tool catalog to ordinary text turns, so discard only
 * that capability advertisement. Never discard an actual tool transcript or a
 * choice that requires a tool call, because doing so would change turn
 * semantics and could feed tool output to the model as ordinary user text.
 */
export function prepareDoubaoRequest(request: CanonicalRequest): CanonicalRequest {
  if (hasToolTranscript(request)) {
    throw unsupportedTools(
      'Doubao Work cannot continue tool-call or tool-result history; start a new text-only conversation.',
    );
  }
  if (requiresToolCall(request)) {
    throw unsupportedTools('Doubao Work does not support required or explicitly selected tool calls.');
  }
  if (request.tools === undefined && request.tool_choice === undefined) {
    return request;
  }

  const textOnly = { ...request };
  delete textOnly.tools;
  delete textOnly.tool_choice;
  return textOnly;
}
