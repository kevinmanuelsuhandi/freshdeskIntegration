// tenants.mjs — shared tenant config resolver
// Copy this snippet into each Lambda, or use Lambda Layers / inline package.

let cached = null;

function loadConfigs() {
  if (cached) return cached;

  const raw = process.env.TENANT_CONFIGS;
  if (!raw) {
    throw new Error("TENANT_CONFIGS env var not set");
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("TENANT_CONFIGS is not a JSON object");
    }
    cached = parsed;
    return cached;
  } catch (err) {
    throw new Error("TENANT_CONFIGS is invalid JSON: " + err.message);
  }
}

/**
 * Look up tenant config for a Freshdesk domain.
 * Returns { endpoint, token, callEndpoint } or throws.
 * The shape of each tenant entry:
 *   {
 *     "endpoint": "https://portal.hoiio.net/.../register",
 *     "callEndpoint": "https://portal.hoiio.net/.../call",
 *     "token": "..."
 *   }
 */
export function getTenantConfig(freshdeskDomain) {
  if (!freshdeskDomain || typeof freshdeskDomain !== "string") {
    throw new Error("freshdeskDomain is required");
  }

  // Normalize: lowercase, trim whitespace, strip protocol if any
  const normalized = freshdeskDomain
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const configs = loadConfigs();
  const config = configs[normalized];

  if (!config) {
    throw new Error("Unknown tenant: " + normalized);
  }

  if (!config.token || !config.endpoint) {
    throw new Error("Tenant config incomplete for: " + normalized);
  }

  return config;
}
