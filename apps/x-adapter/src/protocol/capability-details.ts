/**
 * Provider-declared capability details carried on an error object.
 *
 * A provider adapter may know exactly why a request was rejected (for example
 * "this provider has a local runtime, but it is gated behind the official
 * client"). That information must reach both the non-streaming JSON error body
 * and the streaming SSE error frame, and it must never leak to another provider
 * that happens to reuse the same error code.
 *
 * The details are stored under a symbol on the error instance, so:
 * - only errors deliberately marked by the provider carry them;
 * - the public error `code` stays the single source of truth for classification;
 * - no protocol module needs to import a provider module.
 */
export const CAPABILITY_DETAILS = Symbol('x-adapter.capability-details');

/** Attach provider-declared capability details to an error. */
export function attachCapabilityDetails<E extends Error>(error: E, details: Record<string, unknown>): E {
  Object.defineProperty(error, CAPABILITY_DETAILS, {
    value: details,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

/** Read provider-declared capability details, if this exact error was marked. */
export function capabilityDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const details = (error as Record<symbol, unknown>)[CAPABILITY_DETAILS];
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined;
}
