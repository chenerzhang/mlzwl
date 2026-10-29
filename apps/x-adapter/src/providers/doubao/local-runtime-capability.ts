import { attachCapabilityDetails } from '../../protocol/capability-details.js';

/**
 * Declared capability boundary for Doubao Work's native "local computer" runtime.
 *
 * Doubao Work really does run a cloud-planned agent on this machine: the cloud
 * model plans, the server sends a signed tool call, the official client executes
 * it in a sandbox, uploads the result, and the cloud continues the turn. That
 * path is owned end to end by the official client.
 *
 * x-adapter does not have a supported entry point into it. Signing, user and
 * device identity, sandbox authorization, task ownership, and replay state all
 * live inside the client. Nothing in this repository may synthesize them, so the
 * capability stays unavailable here and the adapter keeps requests text-only.
 *
 * This declaration is deliberately data, not behaviour: it is attached to model
 * metadata and to `unsupported_tools` errors so clients can see the real reason
 * instead of guessing. It must never be flipped to available merely because a
 * private listener, an internal debug surface, or a device identifier happens to
 * be reachable.
 */
export const DOUBAO_LOCAL_RUNTIME_CAPABILITY = {
  /** x-adapter can dispatch a tool call into the native local runtime. */
  available: false,
  /** Executor that owns the runtime, for any client that needs to attribute work. */
  executor: 'official_client',
  /** What would be required for x-adapter to use the runtime. */
  authorization: 'official_client_bridge_required',
  /** Individual protocol steps, each owned by the official client today. */
  dispatch: false,
  signedEnvelope: false,
  resultUpload: false,
  cancellation: false,
  recovery: false,
  /** Stable reason code for clients and logs. */
  reason: 'official_client_bridge_unavailable',
} as const;

export type DoubaoLocalRuntimeCapability = typeof DOUBAO_LOCAL_RUNTIME_CAPABILITY;

/** Metadata attached to every Doubao model so the boundary travels with the catalog. */
export function doubaoLocalRuntimeMetadata(): Record<string, unknown> {
  return {
    local_runtime: {
      ...DOUBAO_LOCAL_RUNTIME_CAPABILITY,
      // The native runtime is reachable only through the official client's
      // authenticated, identity-bound, signed local protocol.
      transport: 'official_client_only',
    },
  };
}

/** Attach the local-runtime boundary to a `unsupported_tools` error from Doubao. */
export function doubaoToolBoundaryError(message: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = 'unsupported_tools';
  return attachCapabilityDetails(error, { local_runtime: { ...DOUBAO_LOCAL_RUNTIME_CAPABILITY } });
}
