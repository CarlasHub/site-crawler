const RUNNING_POLL_DELAY_MS = 1000;
const QUEUED_POLL_DELAY_MS = 2000;
const RATE_LIMIT_POLL_DELAY_MS = 5000;
const RATE_LIMIT_POLL_MIN_DELAY_MS = 1000;

function normalizePhase(value) {
  return String(value || "").trim().toLowerCase();
}

export function getStatusPollDelayMs(status, progress = null) {
  const normalizedStatus = normalizePhase(status);
  const normalizedPhase = normalizePhase(progress?.phase);

  if (normalizedStatus === "completed" || normalizedStatus === "failed") {
    return 0;
  }

  if (normalizedStatus === "queued" || normalizedPhase === "queued" || normalizedPhase === "setup") {
    return QUEUED_POLL_DELAY_MS;
  }

  return RUNNING_POLL_DELAY_MS;
}

export function parseRetryAfterDelayMs(value, now = Date.now()) {
  const raw = String(value || "").trim();
  if (!raw) return 0;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) {
    return 0;
  }

  return Math.max(0, timestamp - now);
}

export function getRateLimitedPollDelayMs(response, json = null, now = Date.now()) {
  const headerDelayMs = parseRetryAfterDelayMs(response?.headers?.get?.("Retry-After"), now);
  const bodyDelayMs = Number(json?.details?.retryAfterMs || 0);
  const safeBodyDelayMs = Number.isFinite(bodyDelayMs) && bodyDelayMs > 0 ? bodyDelayMs : 0;

  return Math.max(RATE_LIMIT_POLL_MIN_DELAY_MS, headerDelayMs, safeBodyDelayMs, RATE_LIMIT_POLL_DELAY_MS);
}

export function isRetryableStatusPollResponse(response, json = null) {
  return Number(response?.status || 0) === 429 && String(json?.code || "") === "RATE_LIMIT_EXCEEDED";
}

