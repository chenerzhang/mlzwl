import { CanonicalRequest } from '../../protocol/canonical.js';
import { assertDoubaoToolRequest } from './upstream/tools.js';

/**
 * Preserve real client tools and their transcript for the Doubao local runtime.
 * Only an explicitly disabled optional catalog is removed. Hosted tools are
 * rejected by common validation before this adapter runs.
 */
export function prepareDoubaoRequest(request: CanonicalRequest): CanonicalRequest {
  assertDoubaoToolRequest(request);
  // `tool_choice: none` disables the catalog, so the bridge must not advertise
  // tools the model is forbidden to call. The schema is also never compiled in
  // this branch, because `toolsEnabled` is false.
  if (request.tool_choice !== 'none') {
    return request;
  }
  const withoutTools = { ...request };
  delete withoutTools.tools;
  delete withoutTools.tool_choice;
  return withoutTools;
}
