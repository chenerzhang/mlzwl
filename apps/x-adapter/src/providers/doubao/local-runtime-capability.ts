/**
 * Declared capability for the Doubao Work local connector bridge.
 *
 * The bridge uses private Doubao Work endpoints. x-adapter declares it as
 * experimental so clients do not mistake it for a public or stable API.
 */
export const DOUBAO_LOCAL_RUNTIME_CAPABILITY = {
  available: true,
  experimental: true,
  executor: 'client',
  authorization: 'private_connector_bridge',
  dispatch: true,
  signedEnvelope: false,
  resultUpload: true,
  cancellation: false,
  recovery: true,
  reason: 'experimental_private_api',
} as const;

export type DoubaoLocalRuntimeCapability = typeof DOUBAO_LOCAL_RUNTIME_CAPABILITY;

export function doubaoLocalRuntimeMetadata(): Record<string, unknown> {
  return {
    local_runtime: {
      ...DOUBAO_LOCAL_RUNTIME_CAPABILITY,
      transport: 'doubao_private_tool_local',
      connector: 'X Adapter Bridge',
    },
  };
}
