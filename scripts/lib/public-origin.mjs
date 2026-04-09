/**
 * Rules for bookmarklet app origins that must never ship in public GitHub Pages config.
 */

const FORBIDDEN_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /\.local$/i
];

export function isForbiddenAppHost(hostname) {
  const host = String(hostname || "").trim();
  if (!host) return { forbidden: true, reason: "empty host" };
  for (const re of FORBIDDEN_HOST_PATTERNS) {
    if (re.test(host)) {
      return { forbidden: true, reason: `forbidden host: ${host}` };
    }
  }
  return { forbidden: false, reason: "" };
}

/**
 * Origins allowed in committed GitHub Pages config (production/staging).
 * Must be https and not loopback / local-only hosts.
 */
export function isForbiddenPublicAppOrigin(origin) {
  const raw = String(origin || "").trim();
  if (!raw) return { forbidden: true, reason: "empty origin" };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { forbidden: true, reason: "not a valid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { forbidden: true, reason: "public bookmarklet origin must use https://" };
  }

  return isForbiddenAppHost(parsed.hostname);
}

/**
 * When generating docs/config.js for APP_ENV=local, allow http://localhost:PORT only.
 */
export function assertAllowedLocalDocsOrigin(origin) {
  const raw = String(origin || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Local app origin must be a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(`Local bookmarklet origin must use http:// (got ${parsed.protocol})`);
  }
  const host = parsed.hostname;
  const isLocal =
    /^localhost$/i.test(host) ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === "[::1]" ||
    host === "::1";
  if (!isLocal) {
    throw new Error(`Local app origin host must be localhost or 127.0.0.1, got: ${host}`);
  }
}

export function assertAllowedPublicAppOrigin(origin, label = "BOOKMARKLET_APP_ORIGIN") {
  const { forbidden, reason } = isForbiddenPublicAppOrigin(origin);
  if (forbidden) {
    throw new Error(`${label} is not allowed for public docs: ${reason}`);
  }
}
