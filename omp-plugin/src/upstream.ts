/**
 * Request options for an upstream candidate generation.
 *
 * The host builds `options` for the provider being called — here the proxy —
 * so forwarding it verbatim hands the upstream the proxy's placeholder
 * credential and model id. That produced `401 Invalid credential` from the
 * upstream, so those provider-scoped fields are dropped and the upstream's own
 * credential is resolved instead.
 */

export const UPSTREAM_DROP: Record<string, true> = {
  apiKey: true,
  credentialId: true,
  oauthIdentity: true,
  providerSessionState: true,
  model: true,
};

export function upstreamOptions(options: unknown): unknown {
  if (!options || typeof options !== "object") return options;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!UPSTREAM_DROP[key]) out[key] = value;
  }
  return out;
}

/**
 * The host's `getApiKey` is bound to the provider being called, so it only
 * answers for that one; it is tried first and the credential store is the
 * fallback.
 */
export async function upstreamApiKey(options: unknown, provider: string): Promise<string | undefined> {
  if (!options || typeof options !== "object" || !("getApiKey" in options)) return undefined;
  const getter = options.getApiKey;
  if (typeof getter !== "function") return undefined;
  try {
    const key = await getter(provider);
    return typeof key === "string" && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}
