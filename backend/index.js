import express from "express";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import dns from "dns";
import net from "net";
import { Agent } from "undici";
import {
  createFileCrawlJobStore,
  createFirestoreCrawlJobStore
} from "./job-store.js";

function parseEnvString(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return String(raw).trim();
}

function parseEnvInt(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected integer between ${min} and ${max}`);
  }
  return value;
}

function parseEnvBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid ${name}: expected boolean`);
}

function parseEnvEnum(name, fallback, allowedValues) {
  const raw = parseEnvString(name, fallback);
  if (allowedValues.includes(raw)) return raw;
  throw new Error(`Invalid ${name}: expected one of ${allowedValues.join(", ")}`);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

const TRUST_PROXY_DISABLED_VALUES = new Set(["0", "false", "no", "off", "none", "direct"]);
const TRUST_PROXY_UNSAFE_VALUES = new Set(["1", "true", "yes", "on"]);
const TRUST_PROXY_PRESET_VALUES = new Set(["loopback", "linklocal", "uniquelocal"]);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isValidTrustProxyToken(token) {
  const normalized = String(token || "").trim().toLowerCase();
  if (!normalized) return false;
  if (TRUST_PROXY_PRESET_VALUES.has(normalized)) return true;
  if (net.isIP(normalized)) return true;

  const parts = normalized.split("/");
  if (parts.length !== 2) return false;

  const [address, prefixRaw] = parts;
  const family = net.isIP(address);
  const prefixLength = Number(prefixRaw);

  if (!family || !Number.isInteger(prefixLength)) return false;
  if (family === 4) return prefixLength >= 0 && prefixLength <= 32;
  if (family === 6) return prefixLength >= 0 && prefixLength <= 128;
  return false;
}

function resolveTrustProxySetting(rawValue, fallback = false) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallback;
  }

  const raw = String(rawValue).trim();
  const normalized = raw.toLowerCase();

  if (TRUST_PROXY_DISABLED_VALUES.has(normalized)) {
    return false;
  }

  if (TRUST_PROXY_UNSAFE_VALUES.has(normalized)) {
    throw new Error(
      "Invalid TRUST_PROXY: generic true is unsafe; use false, loopback, linklocal, uniquelocal, or a comma-separated list of trusted proxy IP/CIDR values"
    );
  }

  if (/^\d+$/.test(normalized)) {
    throw new Error(
      "Invalid TRUST_PROXY: hop-count trust values are not allowed; use explicit trusted proxy IP/CIDR values instead"
    );
  }

  const tokens = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!tokens.length) {
    return fallback;
  }

  for (const token of tokens) {
    if (TRUST_PROXY_DISABLED_VALUES.has(token)) {
      throw new Error("Invalid TRUST_PROXY: do not mix false with trusted proxy entries");
    }
    if (TRUST_PROXY_UNSAFE_VALUES.has(token)) {
      throw new Error(
        "Invalid TRUST_PROXY: generic true is unsafe; use false, loopback, linklocal, uniquelocal, or a comma-separated list of trusted proxy IP/CIDR values"
      );
    }
    if (/^\d+$/.test(token)) {
      throw new Error(
        "Invalid TRUST_PROXY: hop-count trust values are not allowed; use explicit trusted proxy IP/CIDR values instead"
      );
    }
    if (!isValidTrustProxyToken(token)) {
      throw new Error(
        `Invalid TRUST_PROXY entry: ${token}. Use loopback, linklocal, uniquelocal, or an IP/CIDR value`
      );
    }
  }

  return tokens;
}

function describeTrustProxySetting(setting) {
  if (setting === false) return "disabled";
  if (Array.isArray(setting)) return setting.join(",");
  return String(setting || "disabled");
}

const APP_ENV = parseEnvString("APP_ENV", parseEnvString("NODE_ENV", "development"));
const TRUST_PROXY_SETTING = resolveTrustProxySetting(process.env.TRUST_PROXY, false);
const DEFAULT_JOB_STATE_BACKEND = (APP_ENV === "production" || APP_ENV === "staging") ? "firestore" : "file";

const SERVER_CONFIG = {
  environment: APP_ENV,
  trustProxy: TRUST_PROXY_SETTING,
  trustProxyDescription: describeTrustProxySetting(TRUST_PROXY_SETTING),
  requestBodyLimitBytes: parseEnvInt("API_BODY_LIMIT_BYTES", 64 * 1024, { min: 1024, max: 10 * 1024 * 1024 }),
  observability: {
    serviceName: parseEnvString("SERVICE_NAME", "cat-crawler-backend"),
    logLevel: parseEnvEnum("LOG_LEVEL", APP_ENV === "production" ? "info" : "debug", ["debug", "info", "warn", "error", "fatal"]),
    logHealthChecks: parseEnvBoolean("LOG_HEALTHCHECKS", false),
    enableRequestLogging: parseEnvBoolean("ENABLE_REQUEST_LOGGING", true),
    exposeInternalErrors: parseEnvBoolean("EXPOSE_INTERNAL_ERRORS", false),
    exitOnUnhandledError: parseEnvBoolean("EXIT_ON_UNHANDLED_ERROR", true),
    gracefulShutdownTimeoutMs: parseEnvInt("GRACEFUL_SHUTDOWN_TIMEOUT_MS", 10000, { min: 1000, max: 120000 })
  },
  rateLimits: {
    crawlStartWindowMs: parseEnvInt("RATE_LIMIT_CRAWL_START_WINDOW_MS", 15 * 60 * 1000, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    crawlStartMax: parseEnvInt("RATE_LIMIT_CRAWL_START_MAX", 10, { min: 1, max: 10000 }),
    crawlStatusWindowMs: parseEnvInt("RATE_LIMIT_CRAWL_STATUS_WINDOW_MS", 60 * 1000, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    crawlStatusMax: parseEnvInt("RATE_LIMIT_CRAWL_STATUS_MAX", 120, { min: 1, max: 100000 }),
    crawlResultsWindowMs: parseEnvInt("RATE_LIMIT_CRAWL_RESULTS_WINDOW_MS", 60 * 1000, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    crawlResultsMax: parseEnvInt("RATE_LIMIT_CRAWL_RESULTS_MAX", 30, { min: 1, max: 100000 })
  },
  crawl: {
    defaultMaxPages: parseEnvInt("CRAWL_DEFAULT_MAX_PAGES", 300, { min: 1, max: 5000 }),
    maxPages: parseEnvInt("CRAWL_MAX_PAGES", 300, { min: 1, max: 5000 }),
    defaultConcurrency: parseEnvInt("CRAWL_DEFAULT_CONCURRENCY", 6, { min: 1, max: 64 }),
    maxConcurrency: parseEnvInt("CRAWL_MAX_CONCURRENCY", 6, { min: 1, max: 64 }),
    defaultTimeoutMs: parseEnvInt("CRAWL_DEFAULT_TIMEOUT_MS", 12000, { min: 1000, max: 120000 }),
    maxTimeoutMs: parseEnvInt("CRAWL_MAX_TIMEOUT_MS", 30000, { min: 1000, max: 120000 }),
    maxActiveJobs: parseEnvInt("CRAWL_MAX_ACTIVE_JOBS", 2, { min: 1, max: 100 }),
    maxQueuedJobs: parseEnvInt("CRAWL_MAX_QUEUED_JOBS", 20, { min: 0, max: 1000 }),
    maxRedirects: parseEnvInt("CRAWL_MAX_REDIRECTS", 10, { min: 1, max: 50 }),
    maxHtmlBytes: parseEnvInt("CRAWL_MAX_HTML_BYTES", 2 * 1024 * 1024, { min: 1024, max: 50 * 1024 * 1024 }),
    maxSitemapBytes: parseEnvInt("CRAWL_MAX_SITEMAP_BYTES", 5 * 1024 * 1024, { min: 1024, max: 50 * 1024 * 1024 }),
    maxRobotsBytes: parseEnvInt("CRAWL_MAX_ROBOTS_BYTES", 512 * 1024, { min: 1024, max: 10 * 1024 * 1024 })
  },
  jobs: {
    stateBackend: parseEnvEnum("JOB_STATE_BACKEND", DEFAULT_JOB_STATE_BACKEND, ["file", "firestore"]),
    stateFile: parseEnvString("JOB_STATE_FILE", path.join(__dirname, ".data", "crawl-jobs.json")),
    firestoreCollection: parseEnvString("FIRESTORE_CRAWL_JOBS_COLLECTION", "crawlJobs"),
    leaseMs: parseEnvInt("CRAWL_JOB_LEASE_MS", 30000, { min: 5000, max: 30 * 60 * 1000 }),
    heartbeatMs: parseEnvInt("CRAWL_JOB_HEARTBEAT_MS", 10000, { min: 1000, max: 5 * 60 * 1000 }),
    dispatchIntervalMs: parseEnvInt("CRAWL_JOB_DISPATCH_INTERVAL_MS", 5000, { min: 1000, max: 5 * 60 * 1000 }),
    ttlMs: parseEnvInt("CRAWL_JOB_TTL_MS", 30 * 60 * 1000, { min: 60 * 1000, max: 7 * 24 * 60 * 60 * 1000 })
  }
};

if (SERVER_CONFIG.crawl.defaultMaxPages > SERVER_CONFIG.crawl.maxPages) {
  throw new Error("CRAWL_DEFAULT_MAX_PAGES cannot exceed CRAWL_MAX_PAGES");
}
if (SERVER_CONFIG.crawl.defaultConcurrency > SERVER_CONFIG.crawl.maxConcurrency) {
  throw new Error("CRAWL_DEFAULT_CONCURRENCY cannot exceed CRAWL_MAX_CONCURRENCY");
}
if (SERVER_CONFIG.crawl.defaultTimeoutMs > SERVER_CONFIG.crawl.maxTimeoutMs) {
  throw new Error("CRAWL_DEFAULT_TIMEOUT_MS cannot exceed CRAWL_MAX_TIMEOUT_MS");
}
if (SERVER_CONFIG.jobs.heartbeatMs >= SERVER_CONFIG.jobs.leaseMs) {
  throw new Error("CRAWL_JOB_HEARTBEAT_MS must be lower than CRAWL_JOB_LEASE_MS");
}
if ((SERVER_CONFIG.environment === "production" || SERVER_CONFIG.environment === "staging") && SERVER_CONFIG.jobs.stateBackend !== "firestore") {
  throw new Error("JOB_STATE_BACKEND must be firestore in staging and production");
}

const app = express();
app.set("trust proxy", SERVER_CONFIG.trustProxy);
app.use(attachRequestContext);
app.use(requestLoggingMiddleware);
app.use(express.json({ limit: SERVER_CONFIG.requestBodyLimitBytes }));

const DEFAULTS = {
  maxPages: SERVER_CONFIG.crawl.defaultMaxPages,
  concurrency: SERVER_CONFIG.crawl.defaultConcurrency,
  timeoutMs: SERVER_CONFIG.crawl.defaultTimeoutMs,
  sameHostOnly: true,
  scopeToStartPath: true,
  includeQuery: true,
  ignoreHash: true,
  excludePaths: [],
  pathLimits: [],
  excludeExtensions: [
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico",
    ".pdf", ".zip", ".rar", ".7z",
    ".css", ".js", ".map",
    ".mp4", ".mp3", ".mov", ".avi",
    ".woff", ".woff2", ".ttf", ".eot"
  ],
  ignoreJobPages: true,
  brokenLinkCheck: false,
  parameterAudit: false,
  patternMatchFilter: ""
};

const PARAMETER_VARIATIONS = [
  { name: "test", value: "1" },
  { name: "page", value: "2" },
  { name: "filter", value: "value" }
];

const SOFT_FAILURE_ERROR_PATTERNS = [
  { label: "something went wrong", re: /\bsomething went wrong\b/i },
  { label: "unexpected error", re: /\b(unexpected error|an error occurred|application error)\b/i },
  { label: "temporarily unavailable", re: /\b(temporarily unavailable|service unavailable|try again later)\b/i },
  { label: "access denied", re: /\b(access denied|permission denied|forbidden)\b/i },
  { label: "server error", re: /\b(internal server error|bad gateway|gateway timeout)\b/i },
  { label: "page not found text on 200", re: /\b(page not found|404 not found|not found)\b/i }
];

const HTML_MIME_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const XML_MIME_TYPES = new Set(["application/xml", "text/xml"]);
const MAX_SITEMAP_FETCHES = 25;
const DEFAULT_LOOKUP = dns.promises.lookup.bind(dns.promises);
const BLOCKED_HOSTNAMES = new Map([
  ["localhost", "loopback hostname"],
  ["localhost.localdomain", "loopback hostname"],
  ["metadata", "cloud metadata hostname"],
  ["metadata.google.internal", "cloud metadata hostname"],
  ["metadata.azure.internal", "cloud metadata hostname"],
  ["instance-data", "cloud metadata hostname"],
  ["instance-data.ec2.internal", "cloud metadata hostname"]
]);
const BLOCKED_HOSTNAME_SUFFIXES = [
  { suffix: ".localhost", label: "loopback hostname" },
  { suffix: ".local", label: "link-local hostname" },
  { suffix: ".localdomain", label: "link-local hostname" },
  { suffix: ".internal", label: "internal hostname" },
  { suffix: ".home.arpa", label: "private network hostname" }
];
const BLOCKED_IPV4_RANGES = [
  { cidr: "0.0.0.0/8", label: "unspecified IPv4 range" },
  { cidr: "10.0.0.0/8", label: "private IPv4 range" },
  { cidr: "100.64.0.0/10", label: "carrier-grade NAT range" },
  { cidr: "127.0.0.0/8", label: "loopback IPv4 range" },
  { cidr: "169.254.0.0/16", label: "link-local IPv4 range" },
  { cidr: "172.16.0.0/12", label: "private IPv4 range" },
  { cidr: "192.168.0.0/16", label: "private IPv4 range" },
  { cidr: "198.18.0.0/15", label: "benchmarking IPv4 range" }
];
const BLOCKED_IPV6_RANGES = [
  { cidr: "::/128", label: "unspecified IPv6 address" },
  { cidr: "::1/128", label: "loopback IPv6 address" },
  { cidr: "fc00::/7", label: "private IPv6 range" },
  { cidr: "fe80::/10", label: "link-local IPv6 range" },
  { cidr: "ff00::/8", label: "multicast IPv6 range" }
];
const crawlExecutionState = {
  active: 0
};
const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
};
const runtimeState = {
  startedAt: Date.now(),
  shuttingDown: false,
  shutdownReason: "",
  server: null,
  handlersRegistered: false,
  runtimeServicesStarted: false,
  jobStore: null,
  durableDrainScheduled: false,
  durableDrainInFlight: false,
  durableDrainTimer: null,
  durableWorkerId: randomUUID(),
  jobMetricsWarningLogged: false
};

class ApiError extends Error {
  constructor(message, { statusCode = 400, code = "BAD_REQUEST", details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

class ResponseSizeLimitError extends Error {
  constructor(resourceLabel, limitBytes, receivedBytes = 0) {
    super(`${resourceLabel} exceeded the configured response size limit of ${limitBytes} bytes`);
    this.name = "ResponseSizeLimitError";
    this.statusCode = 413;
    this.code = "OUTBOUND_RESPONSE_TOO_LARGE";
    this.limitBytes = limitBytes;
    this.receivedBytes = receivedBytes;
  }
}

function getRoundedDurationMs(durationMs) {
  return Math.round(Number(durationMs || 0) * 1000) / 1000;
}

function getSanitizedRequestId(value) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.length > 128) return "";
  return /^[a-zA-Z0-9._:-]+$/.test(candidate) ? candidate : "";
}

function getRequestPathForLogs(req) {
  const raw = String(req?.originalUrl || req?.url || req?.path || "/");
  const [pathOnly = "/"] = raw.split("?");
  return pathOnly || "/";
}

function getRequestQueryKeys(req) {
  try {
    const currentUrl = new URL(String(req?.originalUrl || req?.url || "/"), "http://local");
    return Array.from(currentUrl.searchParams.keys()).sort();
  } catch {
    return [];
  }
}

function getRequestUserAgent(req) {
  const userAgent = String(req?.headers?.["user-agent"] || "").trim();
  return userAgent ? userAgent.slice(0, 256) : "";
}

function shouldLog(level) {
  return (LOG_LEVELS[level] || LOG_LEVELS.info) >= (LOG_LEVELS[SERVER_CONFIG.observability.logLevel] || LOG_LEVELS.info);
}

function serializeErrorForLog(error) {
  if (!error) return null;
  return {
    name: String(error.name || "Error"),
    message: String(error.message || "Unknown error"),
    code: error.code ? String(error.code) : "",
    statusCode: Number(error.statusCode || 0) || 0,
    details: error.details ?? null,
    stack: error.stack ? String(error.stack) : ""
  };
}

function logStructured(level, event, fields = {}) {
  if (!shouldLog(level)) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: SERVER_CONFIG.observability.serviceName,
    environment: SERVER_CONFIG.environment,
    pid: process.pid,
    ...fields
  };
  const line = JSON.stringify(entry);

  if (level === "error" || level === "fatal") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.info(line);
}

async function getServiceMetrics() {
  const fallback = {
    uptimeSec: Math.round(process.uptime()),
    activeCrawls: crawlExecutionState.active,
    queuedCrawls: 0,
    trackedJobs: 0
  };

  try {
    const jobStore = getConfiguredCrawlJobStore();
    const sharedMetrics = typeof jobStore?.getMetrics === "function"
      ? await jobStore.getMetrics()
      : null;

    return {
      uptimeSec: Math.round(process.uptime()),
      activeCrawls: Number(sharedMetrics?.runningCrawls ?? crawlExecutionState.active),
      queuedCrawls: Number(sharedMetrics?.queuedCrawls ?? 0),
      trackedJobs: Number(sharedMetrics?.trackedJobs ?? 0)
    };
  } catch (error) {
    if (!runtimeState.jobMetricsWarningLogged) {
      runtimeState.jobMetricsWarningLogged = true;
      logStructured("warn", "crawl.jobs.metrics_unavailable", {
        error: serializeErrorForLog(error)
      });
    }
    return fallback;
  }
}

async function buildHealthResponse() {
  return {
    status: "ok",
    service: SERVER_CONFIG.observability.serviceName,
    environment: SERVER_CONFIG.environment,
    trustProxy: SERVER_CONFIG.trustProxyDescription,
    timestamp: new Date().toISOString(),
    ...(await getServiceMetrics())
  };
}

async function buildReadinessResponse() {
  return {
    ready: !runtimeState.shuttingDown,
    service: SERVER_CONFIG.observability.serviceName,
    environment: SERVER_CONFIG.environment,
    trustProxy: SERVER_CONFIG.trustProxyDescription,
    timestamp: new Date().toISOString(),
    shuttingDown: runtimeState.shuttingDown,
    shutdownReason: runtimeState.shutdownReason || "",
    maxActiveCrawls: SERVER_CONFIG.crawl.maxActiveJobs,
    maxQueuedCrawls: SERVER_CONFIG.crawl.maxQueuedJobs,
    ...(await getServiceMetrics())
  };
}

function buildErrorResponse(error, requestId) {
  const isApiError = error instanceof ApiError;
  const statusCode = Number(error?.statusCode || 500) || 500;
  const defaultCode = statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED";
  const exposeMessage = isApiError || SERVER_CONFIG.observability.exposeInternalErrors;
  const code = exposeMessage
    ? String(error?.code || defaultCode)
    : defaultCode;
  const message = exposeMessage
    ? String(error?.message || "Request failed")
    : "Internal server error";
  const details = isApiError ? (error?.details ?? null) : null;

  return {
    statusCode,
    body: {
      error: message,
      code,
      details,
      requestId: String(requestId || "")
    }
  };
}

function getClientIp(req) {
  return getClientIpInfo(req).ip;
}

function getClientIpInfo(req) {
  const ip = String(req?.ip || req?.socket?.remoteAddress || "").trim() || "unknown";
  const forwardedChain = (Array.isArray(req?.ips) ? req.ips : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);

  return {
    ip,
    source: forwardedChain.length > 0 ? "forwarded" : "socket",
    forwardedChain
  };
}

function attachRequestContext(req, res, next) {
  const requestId = getSanitizedRequestId(req.headers["x-request-id"]) || randomUUID();
  req.requestId = requestId;
  res.set("X-Request-Id", requestId);
  next();
}

function requestLoggingMiddleware(req, res, next) {
  if (!SERVER_CONFIG.observability.enableRequestLogging) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  let logged = false;

  function writeRequestLog(event, statusCode, extra = {}) {
    if (logged) return;
    logged = true;

    const path = getRequestPathForLogs(req);
    if (!SERVER_CONFIG.observability.logHealthChecks && statusCode < 400 && (path === "/healthz" || path === "/readyz")) {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const level = statusCode >= 500 ? "error" : (statusCode >= 400 ? "warn" : "info");
    const responseSize = res.getHeader("content-length");
    const clientIp = getClientIpInfo(req);

    logStructured(level, event, {
      requestId: req.requestId,
      method: req.method,
      path,
      queryKeys: getRequestQueryKeys(req),
      statusCode,
      durationMs: getRoundedDurationMs(durationMs),
      ip: clientIp.ip,
      ipSource: clientIp.source,
      userAgent: getRequestUserAgent(req),
      requestBytes: Number(req.headers["content-length"] || 0) || 0,
      responseBytes: Number(responseSize || 0) || 0,
      ...extra
    });
  }

  res.on("finish", () => {
    writeRequestLog("http.request.completed", Number(res.statusCode || 0) || 0);
  });

  res.on("close", () => {
    if (logged || res.writableEnded) return;
    writeRequestLog("http.request.aborted", Number(res.statusCode || 499) || 499, {
      aborted: true
    });
  });

  next();
}

function createFixedWindowRateLimiter({ windowMs, maxRequests }) {
  const buckets = new Map();

  function prune(now) {
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }

  return {
    consume(key, now = Date.now()) {
      prune(now);
      const normalizedKey = String(key || "unknown");
      let bucket = buckets.get(normalizedKey);
      if (!bucket || bucket.resetAt <= now) {
        bucket = {
          count: 0,
          resetAt: now + windowMs
        };
        buckets.set(normalizedKey, bucket);
      }

      if (bucket.count >= maxRequests) {
        return {
          allowed: false,
          limit: maxRequests,
          remaining: 0,
          retryAfterMs: Math.max(0, bucket.resetAt - now),
          resetAt: bucket.resetAt
        };
      }

      bucket.count += 1;
      return {
        allowed: true,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - bucket.count),
        retryAfterMs: Math.max(0, bucket.resetAt - now),
        resetAt: bucket.resetAt
      };
    }
  };
}

const crawlStartRateLimiter = createFixedWindowRateLimiter({
  windowMs: SERVER_CONFIG.rateLimits.crawlStartWindowMs,
  maxRequests: SERVER_CONFIG.rateLimits.crawlStartMax
});

const crawlStatusRateLimiter = createFixedWindowRateLimiter({
  windowMs: SERVER_CONFIG.rateLimits.crawlStatusWindowMs,
  maxRequests: SERVER_CONFIG.rateLimits.crawlStatusMax
});

const crawlResultsRateLimiter = createFixedWindowRateLimiter({
  windowMs: SERVER_CONFIG.rateLimits.crawlResultsWindowMs,
  maxRequests: SERVER_CONFIG.rateLimits.crawlResultsMax
});

function applyRateLimitHeaders(res, result) {
  res.set("X-RateLimit-Limit", String(result.limit));
  res.set("X-RateLimit-Remaining", String(result.remaining));
  res.set("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
  if (!result.allowed) {
    res.set("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
  }
}

function consumeRateLimit(limiter, req, res, label) {
  const result = limiter.consume(getClientIp(req));
  applyRateLimitHeaders(res, result);
  if (!result.allowed) {
    throw new ApiError(`Rate limit exceeded for ${label}`, {
      statusCode: 429,
      code: "RATE_LIMIT_EXCEEDED",
      details: {
        bucket: label,
        retryAfterMs: result.retryAfterMs,
        limit: result.limit
      }
    });
  }
}

function createDefaultCrawlJobStore() {
  if (SERVER_CONFIG.jobs.stateBackend === "firestore") {
    return createFirestoreCrawlJobStore({
      collectionName: SERVER_CONFIG.jobs.firestoreCollection
    });
  }

  return createFileCrawlJobStore({
    filePath: SERVER_CONFIG.jobs.stateFile
  });
}

function getConfiguredCrawlJobStore() {
  if (app.locals?.jobStore) {
    return app.locals.jobStore;
  }

  if (!runtimeState.jobStore) {
    runtimeState.jobStore = createDefaultCrawlJobStore();
  }

  return runtimeState.jobStore;
}

async function pruneExpiredCrawlJobs() {
  const jobStore = getConfiguredCrawlJobStore();
  if (typeof jobStore?.pruneExpiredJobs !== "function") return 0;
  return jobStore.pruneExpiredJobs({
    ttlMs: SERVER_CONFIG.jobs.ttlMs
  });
}

async function initializeRuntimeServices() {
  if (runtimeState.runtimeServicesStarted) return;
  runtimeState.runtimeServicesStarted = true;
  runtimeState.jobMetricsWarningLogged = false;
  getConfiguredCrawlJobStore();

  runtimeState.durableDrainTimer = setInterval(() => {
    void drainDurableCrawlJobs();
  }, SERVER_CONFIG.jobs.dispatchIntervalMs);
  runtimeState.durableDrainTimer.unref?.();

  await pruneExpiredCrawlJobs();
  scheduleDurableCrawlDrain();
}

async function shutdownRuntimeServices() {
  if (runtimeState.durableDrainTimer) {
    clearInterval(runtimeState.durableDrainTimer);
    runtimeState.durableDrainTimer = null;
  }
  runtimeState.runtimeServicesStarted = false;
  runtimeState.durableDrainScheduled = false;
  runtimeState.durableDrainInFlight = false;
}

function scheduleDurableCrawlDrain() {
  if (runtimeState.shuttingDown || !runtimeState.runtimeServicesStarted || runtimeState.durableDrainScheduled) return;

  runtimeState.durableDrainScheduled = true;
  queueMicrotask(async () => {
    runtimeState.durableDrainScheduled = false;
    await drainDurableCrawlJobs();
  });
}

function runCrawlTask(task) {
  crawlExecutionState.active += 1;

  return Promise.resolve()
    .then(task)
    .finally(() => {
      crawlExecutionState.active = Math.max(0, crawlExecutionState.active - 1);
      scheduleDurableCrawlDrain();
    });
}

function runImmediateCrawl(task) {
  if (crawlExecutionState.active >= SERVER_CONFIG.crawl.maxActiveJobs) {
    throw new ApiError("Crawler is at capacity. Try again later.", {
      statusCode: 503,
      code: "CRAWL_CAPACITY_EXCEEDED",
      details: {
        activeJobs: crawlExecutionState.active,
        maxActiveJobs: SERVER_CONFIG.crawl.maxActiveJobs
      }
    });
  }

  return runCrawlTask(task);
}

function sendError(res, error, req = null) {
  const requestId = String(req?.requestId || res.getHeader("X-Request-Id") || "");
  const response = buildErrorResponse(error, requestId);

  if (response.statusCode >= 500) {
    const clientIp = req ? getClientIpInfo(req) : { ip: "", source: "socket" };
    logStructured("error", "http.request.error", {
      requestId,
      method: req?.method || "",
      path: req ? getRequestPathForLogs(req) : "",
      ip: clientIp.ip,
      ipSource: clientIp.source,
      error: serializeErrorForLog(error)
    });
  }

  return res.status(response.statusCode).json(response.body);
}

function makeJobProgress(overrides = {}) {
  return {
    phase: "queued",
    message: "Queued",
    percent: 0,
    pagesCrawled: 0,
    pagesQueued: 0,
    pagesDiscovered: 0,
    maxPages: 0,
    auditEntriesTested: 0,
    auditEntriesTotal: 0,
    parameterChecksDone: 0,
    parameterChecksTotal: 0,
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function createProgressEmitter(onProgress) {
  let lastSentAt = 0;
  let lastPercent = -1;
  let lastPhase = "";
  let lastPagesCrawled = -1;

  return (patch = {}, force = false) => {
    const next = makeJobProgress(patch);
    const now = Date.now();
    const shouldEmit =
      force ||
      next.percent !== lastPercent ||
      next.phase !== lastPhase ||
      next.pagesCrawled !== lastPagesCrawled ||
      now - lastSentAt >= 250;

    if (!shouldEmit) return;

    lastSentAt = now;
    lastPercent = next.percent;
    lastPhase = next.phase;
    lastPagesCrawled = next.pagesCrawled;
    onProgress(next);
  };
}

async function ensureDurableCrawlCapacity() {
  const jobStore = getConfiguredCrawlJobStore();
  const maxPendingJobs = SERVER_CONFIG.crawl.maxActiveJobs + SERVER_CONFIG.crawl.maxQueuedJobs;
  const counts = await jobStore.getPendingCounts({
    limit: maxPendingJobs + 1
  });

  const queuedCrawls = Number(counts?.queuedCrawls || 0);
  const runningCrawls = Number(counts?.runningCrawls || 0);

  if (queuedCrawls + runningCrawls >= maxPendingJobs) {
    throw new ApiError("Crawler queue is full. Try again later.", {
      statusCode: 503,
      code: "CRAWL_QUEUE_FULL",
      details: {
        queuedJobs: queuedCrawls,
        runningJobs: runningCrawls,
        maxQueuedJobs: SERVER_CONFIG.crawl.maxQueuedJobs,
        maxActiveJobs: SERVER_CONFIG.crawl.maxActiveJobs
      }
    });
  }

  return {
    queuedCrawls,
    runningCrawls
  };
}

async function createDurableCrawlJob(requestBody) {
  const jobStore = getConfiguredCrawlJobStore();
  const counts = await ensureDurableCrawlCapacity();
  const jobId = randomUUID();

  return jobStore.createJob({
    jobId,
    requestBody,
    queuedAhead: counts.queuedCrawls,
    progress: makeJobProgress({
      phase: "queued",
      message: counts.queuedCrawls > 0
        ? `Queued. ${counts.queuedCrawls} job${counts.queuedCrawls === 1 ? "" : "s"} ahead.`
        : "Queued",
      percent: 0
    })
  });
}

async function drainDurableCrawlJobs() {
  if (runtimeState.shuttingDown || !runtimeState.runtimeServicesStarted || runtimeState.durableDrainInFlight) return;

  runtimeState.durableDrainInFlight = true;

  try {
    await pruneExpiredCrawlJobs();

    while (!runtimeState.shuttingDown && crawlExecutionState.active < SERVER_CONFIG.crawl.maxActiveJobs) {
      const jobStore = getConfiguredCrawlJobStore();
      const runToken = randomUUID();
      let claimedJob = await jobStore.claimNextQueuedJob({
        ownerId: runtimeState.durableWorkerId,
        runToken,
        leaseDurationMs: SERVER_CONFIG.jobs.leaseMs
      });

      if (!claimedJob) {
        claimedJob = await jobStore.claimExpiredRunningJob({
          ownerId: runtimeState.durableWorkerId,
          runToken,
          leaseDurationMs: SERVER_CONFIG.jobs.leaseMs
        });
      }

      if (!claimedJob) {
        break;
      }

      void runCrawlTask(() => executeDurableBackgroundJob(claimedJob));
    }
  } catch (error) {
    logStructured("error", "crawl.jobs.drain_failed", {
      error: serializeErrorForLog(error)
    });
  } finally {
    runtimeState.durableDrainInFlight = false;
  }
}

async function executeDurableBackgroundJob(job) {
  const jobStore = getConfiguredCrawlJobStore();
  const ownerId = runtimeState.durableWorkerId;
  const runToken = String(job?.runToken || "");
  const requestBody = cloneJson(job?.requestBody || {});
  let latestProgress = makeJobProgress(job?.progress || {});
  let lostLease = false;
  let progressUpdates = Promise.resolve();
  let heartbeatTimer = null;

  function queueProgressUpdate(progressPatch = null) {
    progressUpdates = progressUpdates
      .then(async () => {
        const updatedJob = await jobStore.touchJob({
          jobId: job.id,
          ownerId,
          runToken,
          leaseDurationMs: SERVER_CONFIG.jobs.leaseMs,
          progress: progressPatch
        });

        if (!updatedJob) {
          lostLease = true;
          return null;
        }

        if (updatedJob.progress) {
          latestProgress = updatedJob.progress;
        }

        return updatedJob;
      })
      .catch((error) => {
        logStructured("warn", "crawl.job.progress_update_failed", {
          jobId: job.id,
          error: serializeErrorForLog(error)
        });
      });

    return progressUpdates;
  }

  try {
    const startMessage = latestProgress.phase === "running" ? "Resuming crawl" : "Starting crawl";
    latestProgress = makeJobProgress({
      ...latestProgress,
      phase: "setup",
      message: startMessage,
      percent: Math.max(1, Number(latestProgress.percent || 0))
    });
    void queueProgressUpdate(latestProgress);

    heartbeatTimer = setInterval(() => {
      void queueProgressUpdate();
    }, SERVER_CONFIG.jobs.heartbeatMs);
    heartbeatTimer.unref?.();

    const result = await getConfiguredCrawlExecutor()(requestBody, (progress) => {
      latestProgress = makeJobProgress(progress || {});
      void queueProgressUpdate(latestProgress);
    });

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    await progressUpdates;
    if (lostLease) return;

    latestProgress = makeJobProgress({
      ...latestProgress,
      phase: "complete",
      message: "Crawl complete",
      percent: 100
    });

    await jobStore.completeJob({
      jobId: job.id,
      ownerId,
      runToken,
      result,
      progress: latestProgress
    });
  } catch (error) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    await progressUpdates;
    if (lostLease) return;

    const clientError = buildClientSafeJobError(error);
    logStructured("error", "crawl.job.failed", {
      jobId: job.id,
      clientErrorCode: clientError.code,
      error: serializeErrorForLog(error)
    });

    latestProgress = makeJobProgress({
      ...latestProgress,
      phase: "failed",
      message: clientError.message
    });

    await jobStore.failJob({
      jobId: job.id,
      ownerId,
      runToken,
      clientError,
      progress: latestProgress
    });
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    scheduleDurableCrawlDrain();
  }
}

function buildClientSafeJobError(error) {
  return {
    message: "Internal server error",
    code: "INTERNAL_ERROR",
    details: null
  };
}

function getConfiguredCrawlExecutor() {
  return typeof app.locals?.crawlExecutor === "function"
    ? app.locals.crawlExecutor
    : executeCrawlRequest;
}


function canonicalizePathname(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const lower = seg.toLowerCase();
    const isLang = /^[a-z]{2}(-[a-z]{2})?$/i.test(seg);
    const prev = out.length ? out[out.length - 1] : null;

    if (isLang && prev && prev.toLowerCase() === lower) {
      continue;
    }

    out.push(seg);
  }
  return "/" + out.join("/");
}

function inferStartLanguagePrefix(startUrl) {
  try {
    const u = new URL(startUrl);
    const parts = String(u.pathname || "").split("/").filter(Boolean);
    const first = (parts[0] || "").toLowerCase();
    if (/^[a-z]{2}(-[a-z]{2})?$/i.test(first)) return first;
    return "";
  } catch {
    return "";
  }
}

function normalizePathForRules(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (!parts.length) return "/";

  const first = String(parts[0] || "").toLowerCase();
  const looksLikeLang = /^[a-z]{2}(-[a-z]{2})?$/i.test(first);
  if (looksLikeLang) parts.shift();

  return "/" + parts.join("/");
}

function parseUrlParts(urlString) {
  try {
    const u = new URL(urlString);
    return { host: u.host, pathname: String(u.pathname || "/") };
  } catch {
    return null;
  }
}

function sanitizePathLimits(pathLimits) {
  const inList = Array.isArray(pathLimits) ? pathLimits : [];
  const cleaned = inList
    .map((r) => {
      const p = String(r?.path || "").trim();
      const path = p ? (p.startsWith("/") ? p : `/${p}`) : "";
      const maxPages = Math.max(1, Math.min(5000, Number(r?.maxPages || 0) || 0));
      return { path, maxPages };
    })
    .filter((r) => r.path && r.path.startsWith("/") && r.path !== "/" && r.maxPages > 0);

  const byPath = new Map();
  for (const r of cleaned) {
    const key = r.path.toLowerCase();
    const existing = byPath.get(key);
    if (!existing || r.maxPages < existing.maxPages) {
      byPath.set(key, { path: r.path, maxPages: r.maxPages });
    }
  }

  return Array.from(byPath.values()).sort((a, b) => b.path.length - a.path.length);
}

function parseBoundedIntegerOption(rawValue, { name, defaultValue, min, max }) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return defaultValue;

  const value = Number(rawValue);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ApiError(`${name} must be an integer`, {
      statusCode: 400,
      code: "INVALID_OPTION",
      details: { option: name, value: rawValue }
    });
  }

  if (value < min || value > max) {
    throw new ApiError(`${name} must be between ${min} and ${max}`, {
      statusCode: 400,
      code: "OPTION_LIMIT_EXCEEDED",
      details: { option: name, value, min, max }
    });
  }

  return value;
}

function sanitizeCrawlOptions(rawOptions) {
  const input = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const next = { ...DEFAULTS, ...input };

  next.maxPages = parseBoundedIntegerOption(input.maxPages, {
    name: "maxPages",
    defaultValue: DEFAULTS.maxPages,
    min: 1,
    max: SERVER_CONFIG.crawl.maxPages
  });

  next.concurrency = parseBoundedIntegerOption(input.concurrency, {
    name: "concurrency",
    defaultValue: DEFAULTS.concurrency,
    min: 1,
    max: SERVER_CONFIG.crawl.maxConcurrency
  });

  next.timeoutMs = parseBoundedIntegerOption(input.timeoutMs, {
    name: "timeoutMs",
    defaultValue: DEFAULTS.timeoutMs,
    min: 1000,
    max: SERVER_CONFIG.crawl.maxTimeoutMs
  });

  next.includeQuery = input.includeQuery === undefined ? DEFAULTS.includeQuery : !!input.includeQuery;
  next.ignoreHash = input.ignoreHash === undefined ? DEFAULTS.ignoreHash : !!input.ignoreHash;
  next.sameHostOnly = input.sameHostOnly === undefined ? DEFAULTS.sameHostOnly : !!input.sameHostOnly;
  next.scopeToStartPath = input.scopeToStartPath === undefined ? DEFAULTS.scopeToStartPath : !!input.scopeToStartPath;
  next.ignoreJobPages = input.ignoreJobPages === undefined ? DEFAULTS.ignoreJobPages : !!input.ignoreJobPages;
  next.brokenLinkCheck = input.brokenLinkCheck === undefined ? DEFAULTS.brokenLinkCheck : !!input.brokenLinkCheck;
  next.parameterAudit = input.parameterAudit === undefined ? DEFAULTS.parameterAudit : !!input.parameterAudit;
  next.excludePaths = Array.isArray(input.excludePaths) ? input.excludePaths : DEFAULTS.excludePaths;
  next.pathLimits = sanitizePathLimits(input.pathLimits).map((rule) => ({
    ...rule,
    maxPages: Math.min(rule.maxPages, next.maxPages)
  }));
  next.excludeExtensions = Array.isArray(input.excludeExtensions) && input.excludeExtensions.length
    ? input.excludeExtensions
    : DEFAULTS.excludeExtensions;
  next.patternMatchFilter = String(input.patternMatchFilter || "").trim();

  return next;
}

function matchesPathLimit(normalizedPath, rulePath) {
  const cleanRule = String(rulePath || "").trim();
  if (!cleanRule || !cleanRule.startsWith("/")) return false;
  if (cleanRule === "/") return true;
  const r = cleanRule.endsWith("/") ? cleanRule.slice(0, -1) : cleanRule;
  return normalizedPath === r || normalizedPath.startsWith(r + "/");
}

function hasExcessiveRepeatedSegments(pathname, maxConsecutive = 2) {
  const parts = String(pathname || "").split("/").filter(Boolean).map((s) => s.toLowerCase());
  if (parts.length === 0) return false;

  let run = 1;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === parts[i - 1]) {
      run += 1;
      if (run > maxConsecutive) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

function normalizeUrl(inputUrl, baseUrl, options) {
  let u;
  try {
    u = baseUrl ? new URL(inputUrl, baseUrl) : new URL(inputUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(u.protocol)) return null;

  if (!options.includeQuery) u.search = "";
  if (options.ignoreHash) u.hash = "";

  u.pathname = canonicalizePathname(u.pathname);
  if (hasExcessiveRepeatedSegments(u.pathname, 2)) return null;

  let s = u.toString();
  if (s.endsWith("/")) s = s.slice(0, -1);

  return s;
}

function hasExcludedExtension(urlString, options) {
  const lower = urlString.toLowerCase();
  return options.excludeExtensions.some((ext) => lower.endsWith(ext));
}

function buildExcludeMatchers(excludedPaths = []) {
  const matchers = [];
  if (!excludedPaths || excludedPaths.length === 0) return matchers;

  for (const p of excludedPaths) {
    const clean = String(p || "").trim().toLowerCase();
    if (!clean) continue;
    if (!clean.startsWith("/")) continue;

    if (clean === "/") {
      matchers.push({ type: "all" });
      continue;
    }

    const withoutLeading = clean.replace(/^\/+/, "");
    const hasSubpath = withoutLeading.includes("/");

    if (hasSubpath) {
      const normalized = clean.endsWith("/") ? clean.slice(0, -1) : clean;
      matchers.push({ type: "subpath", value: normalized });
      continue;
    }

    const segment = withoutLeading.replace(/\/+$/g, "");
    if (!segment) continue;

    const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    matchers.push({ type: "segment", re: new RegExp(`(^|\\/)${escaped}(\\/|$)`) });
  }

  return matchers;
}

function isExcludedByPathname(pathnameLower, matchers) {
  if (!matchers || matchers.length === 0) return false;
  for (const m of matchers) {
    if (m.type === "all") return true;
    if (m.type === "subpath") {
      if (pathnameLower === m.value || pathnameLower.startsWith(m.value + "/")) return true;
    } else if (m.type === "segment") {
      if (m.re.test(pathnameLower)) return true;
    }
  }
  return false;
}

function isJobDetailPage(pathnameLower) {
  const pathName = pathnameLower || "";

  const jobKeyword =
    pathName.includes("/job") ||
    pathName.includes("/jobs") ||
    pathName.includes("/vacancy") ||
    pathName.includes("/vacancies") ||
    pathName.includes("/career") ||
    pathName.includes("/careers");

  if (!jobKeyword) return false;

  const segments = pathName.split("/").filter(Boolean);
  const isListing = segments.length <= 1 || (segments.length === 1 && (segments[0] === "jobs" || segments[0] === "careers"));
  if (isListing) return false;

  return true;
}

class OutboundRequestValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutboundRequestValidationError";
    this.statusCode = 403;
  }
}

function normalizeHostname(hostname) {
  return String(hostname || "").trim().replace(/\.+$/g, "").toLowerCase();
}

function normalizeIpAddress(address) {
  return String(address || "").trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
}

function parseIpv4(address) {
  const parts = normalizeIpAddress(address).split(".");
  if (parts.length !== 4) return null;

  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    out = (out << 8) + value;
  }

  return out >>> 0;
}

function expandIpv6(address) {
  const normalized = normalizeIpAddress(address);
  if (!normalized) return null;

  const doubleColonCount = normalized.split("::").length - 1;
  if (doubleColonCount > 1) return null;

  let [head, tail = ""] = normalized.split("::");
  const headParts = head ? head.split(":").filter((part) => part.length > 0) : [];
  const tailParts = tail ? tail.split(":").filter((part) => part.length > 0) : [];

  function normalizeIpv4Tail(parts) {
    if (!parts.length) return parts;
    const last = parts[parts.length - 1];
    if (!last.includes(".")) return parts;

    const ipv4 = parseIpv4(last);
    if (ipv4 === null) return null;

    const hi = ((ipv4 >>> 16) & 0xffff).toString(16);
    const lo = (ipv4 & 0xffff).toString(16);
    return [...parts.slice(0, -1), hi, lo];
  }

  const normalizedHead = normalizeIpv4Tail(headParts);
  const normalizedTail = normalizeIpv4Tail(tailParts);
  if (!normalizedHead || !normalizedTail) return null;

  const totalGroups = normalizedHead.length + normalizedTail.length;
  if (doubleColonCount === 0 && totalGroups !== 8) return null;
  if (totalGroups > 8) return null;

  const missingGroups = 8 - totalGroups;
  const groups = doubleColonCount === 0
    ? normalizedHead
    : [...normalizedHead, ...new Array(missingGroups).fill("0"), ...normalizedTail];

  if (groups.length !== 8) return null;
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;

  return groups.map((group) => group.padStart(4, "0"));
}

function parseIpv6(address) {
  const groups = expandIpv6(address);
  if (!groups) return null;

  let out = 0n;
  for (const group of groups) {
    out = (out << 16n) + BigInt(parseInt(group, 16));
  }
  return out;
}

function parseIpv6Cidr(cidr) {
  const [base, prefixValue] = String(cidr || "").split("/");
  const prefixLength = Number(prefixValue);
  const baseValue = parseIpv6(base);
  if (baseValue === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
    throw new Error(`Invalid IPv6 CIDR: ${cidr}`);
  }
  return { baseValue, prefixLength };
}

function ipv4InRange(address, cidr) {
  const parsedAddress = parseIpv4(address);
  if (parsedAddress === null) return false;

  const [baseAddress, prefixValue] = String(cidr || "").split("/");
  const parsedBase = parseIpv4(baseAddress);
  const prefixLength = Number(prefixValue);
  if (parsedBase === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    return false;
  }

  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (parsedAddress & mask) === (parsedBase & mask);
}

function ipv6InRange(address, cidr) {
  const parsedAddress = parseIpv6(address);
  if (parsedAddress === null) return false;

  const { baseValue, prefixLength } = parseIpv6Cidr(cidr);
  if (prefixLength === 0) return true;

  const shift = 128n - BigInt(prefixLength);
  return (parsedAddress >> shift) === (baseValue >> shift);
}

function extractMappedIpv4(address) {
  const groups = expandIpv6(address);
  if (!groups) return "";
  const prefix = groups.slice(0, 6).join(":");
  if (prefix !== "0000:0000:0000:0000:0000:ffff") return "";

  const hi = parseInt(groups[6], 16);
  const lo = parseInt(groups[7], 16);
  return [
    (hi >> 8) & 0xff,
    hi & 0xff,
    (lo >> 8) & 0xff,
    lo & 0xff
  ].join(".");
}

function classifyBlockedHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return "empty hostname";
  if (BLOCKED_HOSTNAMES.has(normalized)) return BLOCKED_HOSTNAMES.get(normalized) || "blocked hostname";

  const suffixMatch = BLOCKED_HOSTNAME_SUFFIXES.find((entry) => normalized.endsWith(entry.suffix));
  return suffixMatch ? suffixMatch.label : "";
}

function classifyBlockedIpAddress(address) {
  const normalized = normalizeIpAddress(address);
  const family = net.isIP(normalized);
  if (!family) return "";

  if (family === 4) {
    const match = BLOCKED_IPV4_RANGES.find((entry) => ipv4InRange(normalized, entry.cidr));
    return match ? `${match.label} (${match.cidr})` : "";
  }

  const mappedIpv4 = extractMappedIpv4(normalized);
  if (mappedIpv4) {
    const mappedReason = classifyBlockedIpAddress(mappedIpv4);
    return mappedReason ? `IPv4-mapped IPv6 address for ${mappedReason}` : "";
  }

  const match = BLOCKED_IPV6_RANGES.find((entry) => ipv6InRange(normalized, entry.cidr));
  return match ? `${match.label} (${match.cidr})` : "";
}

function buildBlockedTargetMessage(target, reason) {
  return `Outbound requests to ${target} are blocked: ${reason}`;
}

function buildResolutionMap(records = []) {
  const byFamily = new Map();

  for (const record of records) {
    const family = Number(record?.family || 0);
    if (family !== 4 && family !== 6) continue;
    const address = normalizeIpAddress(record?.address || "");
    if (!address) continue;

    const existing = byFamily.get(family) || [];
    if (!existing.some((entry) => entry.address === address)) {
      existing.push({ address, family });
      byFamily.set(family, existing);
    }
  }

  const ordered = [...(byFamily.get(4) || []), ...(byFamily.get(6) || [])];
  return { byFamily, ordered };
}

function createValidatedDispatcher(resolution) {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        const normalizedHost = normalizeHostname(hostname);
        if (normalizedHost !== resolution.hostname) {
          callback(new OutboundRequestValidationError(buildBlockedTargetMessage(normalizedHost || hostname, "hostname changed during outbound request")));
          return;
        }

        const requestedFamily = Number(options?.family || 0);
        const byFamily = resolution.addressesByFamily;
        const matching = requestedFamily === 4 || requestedFamily === 6
          ? (byFamily.get(requestedFamily) || [])
          : resolution.addresses;

        if (!matching.length) {
          callback(new OutboundRequestValidationError(buildBlockedTargetMessage(normalizedHost, "no validated public IP addresses were available")));
          return;
        }

        if (options?.all) {
          callback(null, matching.map((entry) => ({ address: entry.address, family: entry.family })));
          return;
        }

        callback(null, matching[0].address, matching[0].family);
      }
    }
  });
}

function createOutboundAccessController({ lookupFn = DEFAULT_LOOKUP } = {}) {
  const resolutionCache = new Map();

  async function resolveUrl(target) {
    let parsedUrl;
    try {
      parsedUrl = target instanceof URL ? new URL(target.toString()) : new URL(String(target || ""));
    } catch {
      throw new OutboundRequestValidationError("Invalid outbound URL");
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new OutboundRequestValidationError(`Unsupported outbound protocol: ${parsedUrl.protocol || "(missing)"}`);
    }

    const hostname = normalizeHostname(parsedUrl.hostname);
    if (!hostname) {
      throw new OutboundRequestValidationError("Outbound URL must include a hostname");
    }

    const blockedHostnameReason = classifyBlockedHostname(hostname);
    if (blockedHostnameReason) {
      throw new OutboundRequestValidationError(buildBlockedTargetMessage(hostname, blockedHostnameReason));
    }

    const literalReason = classifyBlockedIpAddress(hostname);
    if (literalReason) {
      throw new OutboundRequestValidationError(buildBlockedTargetMessage(hostname, literalReason));
    }

    if (net.isIP(hostname)) {
      const directRecords = buildResolutionMap([{ address: hostname, family: net.isIP(hostname) }]);
      return {
        url: parsedUrl,
        hostname,
        addresses: directRecords.ordered,
        addressesByFamily: directRecords.byFamily
      };
    }

    if (resolutionCache.has(hostname)) {
      return {
        url: parsedUrl,
        hostname,
        addresses: resolutionCache.get(hostname).addresses,
        addressesByFamily: resolutionCache.get(hostname).addressesByFamily
      };
    }

    let records;
    try {
      records = await lookupFn(hostname, { all: true, verbatim: true });
    } catch {
      throw new OutboundRequestValidationError(`Could not resolve outbound host: ${hostname}`);
    }

    const normalizedRecords = Array.isArray(records)
      ? records.map((entry) => ({
          address: normalizeIpAddress(entry?.address || ""),
          family: Number(entry?.family || 0)
        })).filter((entry) => entry.address && (entry.family === 4 || entry.family === 6))
      : [];

    if (!normalizedRecords.length) {
      throw new OutboundRequestValidationError(`Could not resolve outbound host: ${hostname}`);
    }

    const blockedRecord = normalizedRecords.find((entry) => classifyBlockedIpAddress(entry.address));
    if (blockedRecord) {
      throw new OutboundRequestValidationError(
        buildBlockedTargetMessage(hostname, `${blockedRecord.address} resolved to ${classifyBlockedIpAddress(blockedRecord.address)}`)
      );
    }

    const resolution = buildResolutionMap(normalizedRecords);
    if (!resolution.ordered.length) {
      throw new OutboundRequestValidationError(buildBlockedTargetMessage(hostname, "no validated public IP addresses were available"));
    }

    const cached = {
      hostname,
      addresses: resolution.ordered,
      addressesByFamily: resolution.byFamily
    };
    resolutionCache.set(hostname, cached);

    return {
      url: parsedUrl,
      hostname,
      addresses: cached.addresses,
      addressesByFamily: cached.addressesByFamily
    };
  }

  return {
    resolveUrl,
    createDispatcher(resolution) {
      return createValidatedDispatcher(resolution);
    }
  };
}

function normalizeMimeType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

function normalizeXmlTagName(tagName) {
  return String(tagName || "").trim().toLowerCase().split(":").pop() || "";
}

function isHtmlContentType(contentType) {
  return HTML_MIME_TYPES.has(normalizeMimeType(contentType));
}

function isXmlContentType(contentType) {
  const mimeType = normalizeMimeType(contentType);
  return XML_MIME_TYPES.has(mimeType) || mimeType.endsWith("+xml");
}

function isRobotsContentType(contentType) {
  const mimeType = normalizeMimeType(contentType);
  if (!mimeType || !mimeType.startsWith("text/")) return false;
  return !isHtmlContentType(mimeType) && !isXmlContentType(mimeType);
}

function buildUnexpectedContentTypeError(resourceLabel, contentType) {
  const normalized = normalizeMimeType(contentType);
  return `${resourceLabel} returned unsupported content-type: ${normalized || "(missing)"}`;
}

function rejectTextFetch(result, error) {
  return {
    ...result,
    ok: false,
    text: "",
    error
  };
}

async function readResponseTextLimited(res, { maxBytes, resourceLabel }) {
  const limit = Number(maxBytes || 0);
  const contentLengthHeader = String(res.headers.get("content-length") || "").trim();
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;

  if (limit > 0 && Number.isFinite(contentLength) && contentLength > limit) {
    throw new ResponseSizeLimitError(resourceLabel, limit, contentLength);
  }

  if (!res.body) return "";

  const chunks = [];
  let total = 0;

  for await (const chunk of res.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (limit > 0 && total > limit) {
      throw new ResponseSizeLimitError(resourceLabel, limit, total);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function fetchTextResource(url, { timeoutMs, robots, userAgent, accept, resourceLabel, isValidContentType, outboundController, maxResponseBytes }) {
  const r = await fetchWithRedirects(url, {
    method: "GET",
    timeoutMs,
    robots,
    userAgent,
    accept,
    outboundController,
    maxRedirects: SERVER_CONFIG.crawl.maxRedirects,
    maxResponseBytes,
    responseLabel: resourceLabel,
    readBody: true
  });

  if (!r.ok) {
    return { ...r, text: "", error: r.error || "" };
  }

  if (!isValidContentType(r.contentType || "")) {
    return rejectTextFetch(r, buildUnexpectedContentTypeError(resourceLabel, r.contentType));
  }

  return {
    ...r,
    error: ""
  };
}

async function fetchHtmlText(url, timeoutMs, robots, userAgent, outboundController) {
  return fetchTextResource(url, {
    timeoutMs,
    robots,
    userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    resourceLabel: "HTML page",
    isValidContentType: isHtmlContentType,
    outboundController,
    maxResponseBytes: SERVER_CONFIG.crawl.maxHtmlBytes
  });
}

function stripUtf8Bom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function findMarkupEnd(text, startIndex, { trackBracketDepth = false } = {}) {
  let quote = "";
  let bracketDepth = 0;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (trackBracketDepth) {
      if (ch === "[") {
        bracketDepth += 1;
        continue;
      }
      if (ch === "]" && bracketDepth > 0) {
        bracketDepth -= 1;
        continue;
      }
    }

    if (ch === ">" && bracketDepth === 0) {
      return i;
    }
  }

  return -1;
}

function readXmlTagName(tagBody) {
  const match = String(tagBody || "").trim().match(/^([^\s/>]+)/);
  return normalizeXmlTagName(match?.[1] || "");
}

function validateXmlWellFormed(xmlText) {
  const xml = stripUtf8Bom(xmlText).trim();
  if (!xml) {
    return { ok: false, error: "Sitemap XML was empty", xml: "" };
  }

  const stack = [];
  let sawElement = false;
  let i = 0;

  while (i < xml.length) {
    const openIndex = xml.indexOf("<", i);
    if (openIndex === -1) break;

    const marker = xml[openIndex + 1];
    if (!marker) {
      return { ok: false, error: "Sitemap XML ended mid-tag", xml: "" };
    }

    if (marker === "!") {
      if (xml.startsWith("<!--", openIndex)) {
        const endIndex = xml.indexOf("-->", openIndex + 4);
        if (endIndex === -1) {
          return { ok: false, error: "Sitemap XML contains an unterminated comment", xml: "" };
        }
        i = endIndex + 3;
        continue;
      }

      if (xml.startsWith("<![CDATA[", openIndex)) {
        const endIndex = xml.indexOf("]]>", openIndex + 9);
        if (endIndex === -1) {
          return { ok: false, error: "Sitemap XML contains unterminated CDATA", xml: "" };
        }
        i = endIndex + 3;
        continue;
      }

      const endIndex = findMarkupEnd(xml, openIndex + 2, {
        trackBracketDepth: /^<!doctype/i.test(xml.slice(openIndex, openIndex + 9))
      });
      if (endIndex === -1) {
        return { ok: false, error: "Sitemap XML contains an unterminated declaration", xml: "" };
      }
      i = endIndex + 1;
      continue;
    }

    if (marker === "?") {
      const endIndex = xml.indexOf("?>", openIndex + 2);
      if (endIndex === -1) {
        return { ok: false, error: "Sitemap XML contains an unterminated processing instruction", xml: "" };
      }
      i = endIndex + 2;
      continue;
    }

    const endIndex = findMarkupEnd(xml, openIndex + 1);
    if (endIndex === -1) {
      return { ok: false, error: "Sitemap XML contains an unterminated tag", xml: "" };
    }

    let tagBody = xml.slice(openIndex + 1, endIndex).trim();
    if (!tagBody) {
      return { ok: false, error: "Sitemap XML contains an empty tag", xml: "" };
    }

    const isClosingTag = tagBody.startsWith("/");
    if (isClosingTag) {
      tagBody = tagBody.slice(1).trim();
      const tagName = readXmlTagName(tagBody);
      if (!tagName) {
        return { ok: false, error: "Sitemap XML contains an invalid closing tag", xml: "" };
      }

      const expected = stack.pop();
      if (expected !== tagName) {
        return {
          ok: false,
          error: `Sitemap XML closing tag </${tagName}> did not match <${expected || "none"}>`,
          xml: ""
        };
      }

      sawElement = true;
      i = endIndex + 1;
      continue;
    }

    const isSelfClosingTag = /\/\s*$/.test(tagBody);
    if (isSelfClosingTag) {
      tagBody = tagBody.replace(/\/\s*$/, "").trim();
    }

    const tagName = readXmlTagName(tagBody);
    if (!tagName) {
      return { ok: false, error: "Sitemap XML contains an invalid opening tag", xml: "" };
    }

    if (!isSelfClosingTag) {
      stack.push(tagName);
    }

    sawElement = true;
    i = endIndex + 1;
  }

  if (!sawElement) {
    return { ok: false, error: "Sitemap XML did not contain a root element", xml: "" };
  }

  if (stack.length) {
    return {
      ok: false,
      error: `Sitemap XML ended before closing <${stack[stack.length - 1]}>`,
      xml: ""
    };
  }

  return { ok: true, error: "", xml };
}

function parseSitemapXml(xmlText) {
  const validation = validateXmlWellFormed(xmlText);
  if (!validation.ok) {
    return { ok: false, type: "", urls: [], error: validation.error };
  }

  const $ = cheerio.load(validation.xml, { xmlMode: true });
  const root = $.root().children().filter((_, el) => el.type === "tag").first();
  const rootName = normalizeXmlTagName(root[0]?.tagName || root[0]?.name || "");

  if (rootName !== "urlset" && rootName !== "sitemapindex") {
    return {
      ok: false,
      type: "",
      urls: [],
      error: `Sitemap XML root element must be <urlset> or <sitemapindex>, received <${rootName || "unknown"}>`
    };
  }

  const entryName = rootName === "urlset" ? "url" : "sitemap";
  const urls = root.children().toArray()
    .filter((node) => normalizeXmlTagName(node.tagName || node.name) === entryName)
    .map((node) => {
      const locNode = $(node).children().toArray()
        .find((child) => normalizeXmlTagName(child.tagName || child.name) === "loc");
      return locNode ? $(locNode).text().trim() : "";
    })
    .filter(Boolean);

  return {
    ok: true,
    type: rootName,
    urls,
    error: ""
  };
}

function getDefaultSitemapUrl(origin) {
  return origin.replace(/\/$/, "") + "/sitemap.xml";
}

function extractRobotsSitemapCandidates(origin, robots) {
  const out = [];
  const seen = new Set();

  function addCandidate(value) {
    const candidate = String(value || "").trim();
    if (!candidate) return;

    let normalized;
    try {
      normalized = new URL(candidate, origin).toString();
    } catch {
      return;
    }

    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  }

  if (typeof robots?.getSitemaps === "function") {
    const sitemaps = robots.getSitemaps();
    if (Array.isArray(sitemaps)) {
      sitemaps.forEach(addCandidate);
    }
  }

  addCandidate(getDefaultSitemapUrl(origin));
  return out;
}

async function fetchRobots(origin, timeoutMs, userAgent, outboundController) {
  const robotsUrl = origin.replace(/\/$/, "") + "/robots.txt";
  const r = await fetchTextResource(robotsUrl, {
    timeoutMs,
    robots: null,
    userAgent,
    accept: "text/plain,text/*;q=0.9,*/*;q=0.8",
    resourceLabel: "robots.txt",
    isValidContentType: isRobotsContentType,
    outboundController,
    maxResponseBytes: SERVER_CONFIG.crawl.maxRobotsBytes
  });

  if (!r.ok || !r.text) return null;
  return robotsParser(r.finalUrl || robotsUrl, r.text);
}

async function fetchSitemapUrls(origin, timeoutMs, robots, userAgent, outboundController) {
  const pending = extractRobotsSitemapCandidates(origin, robots);
  const seenSitemaps = new Set();
  const discoveredUrls = new Set();

  while (pending.length && seenSitemaps.size < MAX_SITEMAP_FETCHES) {
    const sitemapUrl = pending.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    const r = await fetchTextResource(sitemapUrl, {
      timeoutMs,
      robots: null,
      userAgent,
      accept: "application/xml,text/xml,application/*+xml,text/*+xml;q=0.9,*/*;q=0.8",
      resourceLabel: "sitemap XML",
      isValidContentType: isXmlContentType,
      outboundController,
      maxResponseBytes: SERVER_CONFIG.crawl.maxSitemapBytes
    });

    if (!r.ok || !r.text) continue;

    const parsed = parseSitemapXml(r.text);
    if (!parsed.ok) continue;

    parsed.urls.forEach((value) => {
      let resolvedUrl;
      try {
        resolvedUrl = new URL(value, r.finalUrl || sitemapUrl).toString();
      } catch {
        return;
      }

      if (parsed.type === "sitemapindex") {
        if (!seenSitemaps.has(resolvedUrl)) {
          pending.push(resolvedUrl);
        }
        return;
      }

      discoveredUrls.add(resolvedUrl);
    });
  }

  return Array.from(discoveredUrls);
}

async function quickStatus(url, timeoutMs, robots, userAgent, outboundController) {
  const head = await fetchWithRedirects(url, {
    method: "HEAD",
    timeoutMs,
    robots,
    userAgent,
    accept: "*/*",
    outboundController,
    maxRedirects: SERVER_CONFIG.crawl.maxRedirects,
    readBody: false,
    responseLabel: "status probe"
  });

  if (head.status && head.status !== 405 && head.status !== 501) {
    return {
      status: head.status,
      finalUrl: head.finalUrl,
      blockedByRobots: !!head.blockedByRobots,
      redirectChain: head.redirectChain || [url],
      redirectSteps: head.redirectSteps || [],
      loopDetected: !!head.loopDetected,
      maxRedirectsExceeded: !!head.maxRedirectsExceeded
    };
  }

  const get = await fetchWithRedirects(url, {
    method: "GET",
    timeoutMs,
    robots,
    userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    outboundController,
    maxRedirects: SERVER_CONFIG.crawl.maxRedirects,
    readBody: false,
    responseLabel: "status probe"
  });

  return {
    status: get.status,
    finalUrl: get.finalUrl,
    blockedByRobots: !!get.blockedByRobots,
    redirectChain: get.redirectChain || [url],
    redirectSteps: get.redirectSteps || [],
    loopDetected: !!get.loopDetected,
    maxRedirectsExceeded: !!get.maxRedirectsExceeded
  };
}

function toQuickStatusResult(record, fallbackUrl) {
  return {
    status: record?.status,
    finalUrl: record?.finalUrl || fallbackUrl,
    blockedByRobots: !!record?.blockedByRobots,
    redirectChain: record?.redirectChain || [fallbackUrl],
    redirectSteps: record?.redirectSteps || [],
    loopDetected: !!record?.loopDetected,
    maxRedirectsExceeded: !!record?.maxRedirectsExceeded
  };
}

async function fetchWithRedirects(
  url,
  {
    method = "GET",
    timeoutMs,
    robots,
    userAgent,
    accept,
    outboundController = createOutboundAccessController(),
    maxRedirects = SERVER_CONFIG.crawl.maxRedirects,
    maxResponseBytes = 0,
    responseLabel = "response",
    readBody = method !== "HEAD"
  }
) {
  const redirectChain = [url];
  const redirectSteps = [];
  const seen = new Set([url]);
  let current = url;

  for (let i = 0; i < maxRedirects; i++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let dispatcher = null;

    try {
      if (robots && !robots.isAllowed(current, userAgent)) {
        return {
          ok: false,
          status: 0,
          blockedByRobots: true,
          blockedByPolicy: false,
          text: "",
          finalUrl: current,
          redirectChain,
          redirectSteps,
          contentType: "",
          error: "Blocked by robots.txt",
          errorCode: "ROBOTS_BLOCKED",
          loopDetected: false,
          maxRedirectsExceeded: false
        };
      }

      const resolution = await outboundController.resolveUrl(current);
      dispatcher = outboundController.createDispatcher(resolution);

      const res = await fetch(current, {
        method,
        signal: controller.signal,
        redirect: "manual",
        dispatcher,
        headers: {
          "User-Agent": userAgent,
          "Accept": accept
        }
      });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const nextUrl = new URL(location, current).toString();
        redirectSteps.push({
          url: current,
          status: res.status,
          location,
          nextUrl
        });
        redirectChain.push(nextUrl);
        if (seen.has(nextUrl)) {
          return {
            ok: false,
            status: 310,
            blockedByRobots: false,
            blockedByPolicy: false,
            text: "",
            finalUrl: nextUrl,
            redirectChain,
            redirectSteps,
            contentType: "",
            error: "Redirect loop detected",
            errorCode: "REDIRECT_LOOP",
            loopDetected: true,
            maxRedirectsExceeded: false
          };
        }

        try {
          await outboundController.resolveUrl(nextUrl);
        } catch (error) {
          if (error instanceof OutboundRequestValidationError) {
            return {
              ok: false,
              status: 0,
              blockedByRobots: false,
              blockedByPolicy: true,
              text: "",
              finalUrl: nextUrl,
              redirectChain,
              redirectSteps,
              contentType: "",
              error: error.message,
              errorCode: "OUTBOUND_TARGET_BLOCKED",
              loopDetected: false,
              maxRedirectsExceeded: false
            };
          }
          throw error;
        }

        seen.add(nextUrl);
        current = nextUrl;
        continue;
      }

      const contentType = res.headers.get("content-type") || "";
      const text = readBody ? await readResponseTextLimited(res, {
        maxBytes: maxResponseBytes,
        resourceLabel: responseLabel
      }) : "";
      redirectSteps.push({
        url: current,
        status: res.status,
        location: "",
        nextUrl: ""
      });
      return {
        ok: res.ok,
        status: res.status,
        blockedByRobots: false,
        blockedByPolicy: false,
        text,
        finalUrl: current,
        redirectChain,
        redirectSteps,
        contentType,
        error: "",
        errorCode: "",
        loopDetected: false,
        maxRedirectsExceeded: false
      };
    } catch (error) {
      const isPolicyBlock = error instanceof OutboundRequestValidationError;
      const isTooLarge = error instanceof ResponseSizeLimitError;
      return {
        ok: false,
        status: isTooLarge ? 413 : 0,
        blockedByRobots: false,
        blockedByPolicy: isPolicyBlock,
        text: "",
        finalUrl: current,
        redirectChain,
        redirectSteps,
        contentType: "",
        error: isPolicyBlock || isTooLarge ? error.message : (error?.name === "AbortError" ? "Request timed out" : "Request failed"),
        errorCode: isPolicyBlock
          ? "OUTBOUND_TARGET_BLOCKED"
          : (isTooLarge ? error.code : (error?.name === "AbortError" ? "REQUEST_TIMEOUT" : "REQUEST_FAILED")),
        loopDetected: false,
        maxRedirectsExceeded: false
      };
    } finally {
      clearTimeout(t);
      if (dispatcher) {
        await dispatcher.close().catch(() => {});
      }
    }
  }

  return {
    ok: false,
    status: 310,
    blockedByRobots: false,
    blockedByPolicy: false,
    text: "",
    finalUrl: current,
    redirectChain,
    redirectSteps,
    contentType: "",
    error: "Maximum redirects exceeded",
    errorCode: "MAX_REDIRECTS_EXCEEDED",
    loopDetected: false,
    maxRedirectsExceeded: true
  };
}

function getMetaRobots(text) {
  try {
    const $ = cheerio.load(text || "");
    return String($('meta[name="robots"]').attr("content") || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function classifyRecord(record) {
  if (record?.blockedByRobots) return "soft_failure";
  if (record?.status === null || record?.status === undefined || record?.status === 0) return "soft_failure";
  if (record.status >= 400) return "broken";
  if (Array.isArray(record?.softFailureReasons) && record.softFailureReasons.length > 0) return "soft_failure";
  if ((record.redirectChain || []).length > 1 || (record.finalUrl && record.finalUrl !== record.url)) return "redirect_issue";
  if (record.metaRobots && /(noindex|nofollow)/i.test(record.metaRobots)) return "soft_failure";
  return "valid";
}

function createParameterVariant(urlString, variation) {
  try {
    const u = new URL(urlString);
    u.searchParams.set(variation.name, variation.value);
    return u.toString();
  } catch {
    return null;
  }
}

function getComparablePath(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.origin}${u.pathname.replace(/\/+$/g, "") || "/"}`;
  } catch {
    return urlString;
  }
}

function getSearchParamPairs(urlString) {
  try {
    const u = new URL(urlString);
    return Array.from(u.searchParams.entries());
  } catch {
    return [];
  }
}

function hasDroppedParams(originalUrl, finalUrl) {
  const originalPairs = getSearchParamPairs(originalUrl);
  if (!originalPairs.length) return false;

  try {
    const finalParams = new URL(finalUrl).searchParams;
    return originalPairs.some(([key, value]) => !finalParams.getAll(key).includes(value));
  } catch {
    return true;
  }
}

function getPathSegments(urlString) {
  try {
    const u = new URL(urlString);
    const normalized = normalizePathForRules(u.pathname || "/").toLowerCase();
    return normalized.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

function isHomeLikePath(urlString) {
  try {
    const u = new URL(urlString);
    return normalizePathForRules(u.pathname || "/") === "/";
  } catch {
    return false;
  }
}

function isIrrelevantDestination(originalUrl, finalUrl) {
  try {
    const original = new URL(originalUrl);
    const final = new URL(finalUrl);

    if (original.origin !== final.origin) return false;
    if (getComparablePath(originalUrl) === getComparablePath(finalUrl)) return false;

    if (isHomeLikePath(finalUrl) && !isHomeLikePath(originalUrl)) {
      return true;
    }

    const originalSegments = getPathSegments(originalUrl);
    const finalSegments = getPathSegments(finalUrl);
    if (!originalSegments.length || !finalSegments.length) return false;

    const sharedSegments = originalSegments.filter((segment) => finalSegments.includes(segment));
    if (sharedSegments.length > 0) return false;

    return true;
  } catch {
    return false;
  }
}

function buildRedirectAuditEntry(source, result) {
  const originalUrl = source.originalUrl;
  const finalResolvedUrl = result.finalUrl || originalUrl;
  const redirectChain = result.redirectChain || [originalUrl];
  const redirectSteps = Array.isArray(result.redirectSteps) ? result.redirectSteps : [];
  const redirectStatuses = redirectSteps
    .map((step) => Number(step?.status || 0))
    .filter((status) => Number.isFinite(status) && status > 0);
  const redirectStepCount = Math.max(0, redirectChain.length - 1);
  const loopDetected = !!result.loopDetected;
  const multipleHops = redirectStepCount > 1;
  const paramsLost = redirectStepCount > 0 && hasDroppedParams(originalUrl, finalResolvedUrl);
  const irrelevantDestination = redirectStepCount > 0 && isIrrelevantDestination(originalUrl, finalResolvedUrl);
  const hasIssue = loopDetected || multipleHops || paramsLost || irrelevantDestination;
  const classification = redirectStepCount === 0
    ? "direct"
    : (hasIssue ? "redirect_issue" : "redirect_ok");

  return {
    originalUrl,
    referrerPage: source.referrerPage || "",
    sourceType: source.sourceType || "",
    sourceValue: source.sourceValue || "",
    finalResolvedUrl,
    statusCode: result.status,
    redirectChain,
    redirectSteps,
    redirectStatuses,
    redirectStepCount,
    loopDetected,
    multipleHops,
    paramsLost,
    irrelevantDestination,
    maxRedirectsExceeded: !!result.maxRedirectsExceeded,
    maxOneHopPreferred: redirectStepCount <= 1,
    hasIssue,
    classification
  };
}

function hasExpectedParameter(urlString, variation) {
  try {
    const u = new URL(urlString);
    return u.searchParams.getAll(variation.name).includes(variation.value);
  } catch {
    return false;
  }
}

function summarizeParameterAudit(entries) {
  return entries.reduce((acc, entry) => {
    acc.total += 1;
    if (entry.hasIssue) acc.inconsistencies += 1;
    if (entry.statusCode >= 400) acc.httpErrors += 1;
    if (entry.paramsDropped) acc.paramsDropped += 1;
    if (entry.unexpectedRedirect) acc.unexpectedRedirects += 1;
    return acc;
  }, {
    total: 0,
    inconsistencies: 0,
    httpErrors: 0,
    paramsDropped: 0,
    unexpectedRedirects: 0
  });
}

function summarizeRedirectAudit(entries) {
  return entries.reduce((acc, entry) => {
    acc.total += 1;
    if (entry.redirectStepCount > 0) acc.redirected += 1;
    if (entry.hasIssue) acc.issues += 1;
    if (entry.loopDetected) acc.loops += 1;
    if (entry.multipleHops) acc.multipleHops += 1;
    if (entry.paramsLost) acc.paramsLost += 1;
    if (entry.irrelevantDestination) acc.irrelevantDestinations += 1;
    return acc;
  }, {
    total: 0,
    redirected: 0,
    issues: 0,
    loops: 0,
    multipleHops: 0,
    paramsLost: 0,
    irrelevantDestinations: 0
  });
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getVisiblePageText(html) {
  try {
    const $ = cheerio.load(html || "");
    $("script, style, noscript, template, svg").remove();
    return collapseWhitespace($("body").text());
  } catch {
    return "";
  }
}

function detectErrorTextMatches(text) {
  const haystack = collapseWhitespace(text).toLowerCase();
  if (!haystack) return [];
  return uniqueStrings(
    SOFT_FAILURE_ERROR_PATTERNS
      .filter((pattern) => pattern.re.test(haystack))
      .map((pattern) => pattern.label)
  );
}

function inferMissingExpectedComponents(pageUrl, $, bodyText) {
  const missing = [];
  const visibleLength = bodyText.length;
  const pathLower = (() => {
    try {
      return new URL(pageUrl).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();

  const hasMain = $("main, [role='main'], article").length > 0;
  const hasSearchControls = $("form, [role='search'], input[type='search'], input[name*='search' i], input[name*='keyword' i]").length > 0;
  const resultLikeCount = $("[data-search-results], [data-job-id], [data-results], .job, .jobs, .result, .results, main a[href], article a[href]").length;
  const looksLikeSearchPage = /search|jobs|results|find|vacanc|career/.test(pathLower) || hasSearchControls;

  if (visibleLength >= 80 && !hasMain && !hasSearchControls) {
    missing.push("primary content container missing");
  }

  if (looksLikeSearchPage && !hasSearchControls) {
    missing.push("search controls missing");
  }

  if (looksLikeSearchPage && resultLikeCount === 0) {
    missing.push("result content missing");
  }

  return uniqueStrings(missing);
}

function cleanEndpointCandidate(rawValue) {
  const value = String(rawValue || "").trim().replace(/^['"`]|['"`]$/g, "");
  if (!value) return "";
  if (value.startsWith("javascript:") || value.startsWith("data:")) return "";
  if (value.includes("${") || value.includes("{{") || value.includes("<%")) return "";
  if (/^https?:/i.test(value)) return value;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("?")) return value;
  return "";
}

function extractApiCandidates(html) {
  const candidates = new Set();
  const $ = cheerio.load(html || "");

  ["data-api", "data-endpoint", "data-fetch-url", "data-url"].forEach((attr) => {
    $(`[${attr}]`).each((_, el) => {
      const raw = cleanEndpointCandidate($(el).attr(attr));
      if (raw) candidates.add(raw);
    });
  });

  const scriptText = $("script").map((_, el) => $(el).html() || "").get().join("\n");
  const patterns = [
    /fetch\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /axios\.(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /\.open\s*\(\s*['"`](?:GET|POST|PUT|PATCH|DELETE)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g,
    /url\s*:\s*['"`]([^'"`]+)['"`]/g,
    /endpoint\s*:\s*['"`]([^'"`]+)['"`]/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(scriptText)) && candidates.size < 20) {
      const raw = cleanEndpointCandidate(match[1]);
      if (raw) candidates.add(raw);
    }
  }

  return Array.from(candidates).slice(0, 8);
}

async function probeApiCandidates(pageUrl, candidates, getQuickStatus, sameHostOnly, rootHost) {
  const jobs = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      try {
        const resolvedUrl = new URL(candidate, pageUrl).toString();
        const resolved = new URL(resolvedUrl);
        if (sameHostOnly && resolved.host !== rootHost) return null;
        return { candidate, resolvedUrl };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const results = await concurrencyMap(jobs, Math.min(4, jobs.length || 1), async (job) => {
    const res = await getQuickStatus(job.resolvedUrl);
    return {
      source: job.candidate,
      resolvedUrl: job.resolvedUrl,
      finalUrl: res.finalUrl || job.resolvedUrl,
      statusCode: res.status,
      redirectChain: res.redirectChain || [job.resolvedUrl],
      failed: !res.status || res.status >= 400
    };
  });

  return results.filter(Boolean);
}

async function analyzeSoftFailurePage(pageUrl, html, getQuickStatus, sameHostOnly, rootHost) {
  const $ = cheerio.load(html || "");
  const title = collapseWhitespace($("title").first().text());
  const bodyText = getVisiblePageText(html);
  const interactiveCount = $("a[href], button, input, select, textarea, form").length;
  const shellCount = $("header, nav, footer").length;

  const reasons = [];
  if (!bodyText || (bodyText.length < 40 && interactiveCount < 3)) {
    reasons.push("empty content");
  } else if (bodyText.length < 120 && shellCount > 0 && interactiveCount < 4) {
    reasons.push("page shell without meaningful content");
  }

  const missingExpectedComponents = inferMissingExpectedComponents(pageUrl, $, bodyText);
  const errorTextMatches = detectErrorTextMatches(`${title}\n${bodyText.slice(0, 4000)}`);
  const apiCandidates = extractApiCandidates(html);
  const apiChecks = apiCandidates.length
    ? await probeApiCandidates(pageUrl, apiCandidates, getQuickStatus, sameHostOnly, rootHost)
    : [];
  const apiFailures = apiChecks.filter((entry) => entry.failed);

  reasons.push(...missingExpectedComponents);
  reasons.push(...errorTextMatches.map((match) => `error text: ${match}`));
  if (apiFailures.length) {
    reasons.push(`failed fetch/XHR endpoints: ${apiFailures.length}`);
  }

  return {
    softFailureReasons: uniqueStrings(reasons),
    missingExpectedComponents,
    errorTextMatches,
    apiChecks,
    apiFailures
  };
}

function summarizeSoftFailureAudit(entries) {
  return entries.reduce((acc, entry) => {
    acc.total += 1;
    acc.apiFailures += Array.isArray(entry.apiFailures) ? entry.apiFailures.length : 0;
    if (entry.softFailureReasons.includes("empty content")) acc.emptyContent += 1;
    if (entry.softFailureReasons.some((reason) => reason.includes("missing"))) acc.missingExpectedComponents += 1;
    if (entry.softFailureReasons.some((reason) => reason.startsWith("error text:"))) acc.errorTextPatterns += 1;
    return acc;
  }, {
    total: 0,
    emptyContent: 0,
    missingExpectedComponents: 0,
    errorTextPatterns: 0,
    apiFailures: 0
  });
}

function tokenizeSegment(segment) {
  return String(segment || "")
    .toLowerCase()
    .split(/[-_]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function classifySegmentShape(segment) {
  const value = String(segment || "");
  if (!value) return "{empty}";
  if (/^\d+$/.test(value)) return "{num}";
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return "{uuid}";
  if (/^\d{4}-\d{2}-\d{2}$/i.test(value)) return "{date}";
  if (/^\d{4}\/\d{2}\/\d{2}$/i.test(value)) return "{date}";
  if (/^[A-Z0-9]{6,}$/.test(value)) return "{id}";
  if (/^\d[\d-]*$/.test(value)) return "{numlike}";
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(value)) return "{slug}";
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(value)) return "{snake}";
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) return "{camel}";
  return value.toLowerCase();
}

function getUrlPatternSignature(urlString) {
  try {
    const u = new URL(urlString);
    const segments = u.pathname.split("/").filter(Boolean).map(classifySegmentShape);
    const queryKeys = Array.from(u.searchParams.keys()).sort();
    const queryPart = queryKeys.length ? `?${queryKeys.join("&")}` : "";
    return `${u.origin}/${segments.join("/")}${queryPart}`;
  } catch {
    return urlString;
  }
}

function getUrlLeafKey(urlString) {
  try {
    const u = new URL(urlString);
    const segments = u.pathname.split("/").filter(Boolean);
    const leaf = String(segments[segments.length - 1] || "").toLowerCase();
    return classifySegmentShape(leaf);
  } catch {
    return "";
  }
}

function getUrlPathTokens(urlString) {
  try {
    const u = new URL(urlString);
    return u.pathname
      .split("/")
      .filter(Boolean)
      .flatMap((segment) => tokenizeSegment(segment))
      .filter((token) => !/^\d+$/.test(token));
  } catch {
    return [];
  }
}

function getNamingStyle(segment) {
  const value = String(segment || "");
  if (!value) return "plain";
  if (value.includes("_")) return "snake_case";
  if (value.includes("-")) return "kebab-case";
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) return "camel-or-mixed-case";
  if (value !== value.toLowerCase()) return "mixed-case";
  return "plain";
}

function normalizeParentPath(urlString) {
  try {
    const u = new URL(urlString);
    const parts = u.pathname.split("/").filter(Boolean);
    const parent = parts.slice(0, -1).join("/");
    return `${u.origin}/${parent}`;
  } catch {
    return urlString;
  }
}

function matchesPatternFilter(urlString, filterValue) {
  const filter = String(filterValue || "").trim().toLowerCase();
  if (!filter) return true;
  return String(urlString || "").toLowerCase().includes(filter);
}

function summarizePatternAudit(data) {
  return {
    totalUrls: data.totalUrls,
    filteredUrls: data.filteredUrls,
    patternGroups: data.patternGroups.length,
    duplicatePatterns: data.duplicatePatterns.length,
    legacyVsCurrent: data.legacyVsCurrent.length,
    inconsistentNaming: data.inconsistentNaming.length,
    filterApplied: data.filterApplied
  };
}

function buildPatternAudit(records, filterValue) {
  const source = Array.isArray(records) ? records : [];
  const filterApplied = String(filterValue || "").trim();
  const filteredRecords = source.filter((record) => {
    const original = record?.url || record?.originalUrl || "";
    const finalUrl = record?.finalUrl || record?.finalResolvedUrl || "";
    return matchesPatternFilter(original, filterApplied) || matchesPatternFilter(finalUrl, filterApplied);
  });

  const patternMap = new Map();
  const parentMap = new Map();
  const leafMap = new Map();

  for (const record of filteredRecords) {
    const url = record.url || record.originalUrl || "";
    const pattern = getUrlPatternSignature(url);
    const patternEntry = patternMap.get(pattern) || { pattern, urls: [] };
    patternEntry.urls.push(url);
    patternMap.set(pattern, patternEntry);

    const parent = normalizeParentPath(url);
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const leaf = String(parts[parts.length - 1] || "");
    const siblingEntry = parentMap.get(parent) || { parentPath: parent, children: [] };
    siblingEntry.children.push({
      url,
      leaf,
      style: getNamingStyle(leaf),
      hasMixedCase: leaf !== leaf.toLowerCase(),
      hasUnderscore: leaf.includes("_"),
      hasHyphen: leaf.includes("-")
    });
    parentMap.set(parent, siblingEntry);

    const leafKey = getUrlLeafKey(url);
    const tokens = getUrlPathTokens(url);
    const legacy = tokens.some((token) => ["old", "legacy", "archive", "deprecated", "v1"].includes(token));
    const current = tokens.some((token) => ["new", "current", "latest", "modern", "v2"].includes(token));
    const leafEntry = leafMap.get(leafKey) || { leafKey, items: [] };
    leafEntry.items.push({ url, tokens, legacy, current });
    leafMap.set(leafKey, leafEntry);
  }

  const patternGroups = Array.from(patternMap.values())
    .map((entry) => ({
      pattern: entry.pattern,
      count: entry.urls.length,
      sampleUrls: uniqueStrings(entry.urls).slice(0, 6)
    }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));

  const duplicatePatterns = patternGroups
    .filter((entry) => entry.count > 1)
    .map((entry) => ({
      pattern: entry.pattern,
      count: entry.count,
      sampleUrls: entry.sampleUrls
    }));

  const legacyVsCurrent = Array.from(leafMap.values())
    .map((entry) => {
      const legacyUrls = uniqueStrings(entry.items.filter((item) => item.legacy).map((item) => item.url));
      const currentUrls = uniqueStrings(entry.items.filter((item) => item.current || !item.legacy).map((item) => item.url));
      if (!legacyUrls.length || !currentUrls.length) return null;
      return {
        key: entry.leafKey,
        legacyUrls: legacyUrls.slice(0, 4),
        currentUrls: currentUrls.filter((url) => !legacyUrls.includes(url)).slice(0, 4)
      };
    })
    .filter((entry) => entry && entry.currentUrls.length > 0);

  const inconsistentNaming = Array.from(parentMap.values())
    .map((entry) => {
      const styles = uniqueStrings(entry.children.map((child) => child.style));
      const mixedCases = entry.children.some((child) => child.hasMixedCase);
      const mixedSeparators = entry.children.some((child) => child.hasHyphen) && entry.children.some((child) => child.hasUnderscore);
      if (styles.length <= 1 && !mixedCases && !mixedSeparators) return null;
      return {
        parentPath: entry.parentPath,
        styles,
        mixedCase: mixedCases,
        mixedSeparators,
        sampleUrls: uniqueStrings(entry.children.map((child) => child.url)).slice(0, 6)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.parentPath.localeCompare(b.parentPath));

  const result = {
    filterApplied,
    totalUrls: source.length,
    filteredUrls: filteredRecords.length,
    patternGroups,
    duplicatePatterns,
    legacyVsCurrent,
    inconsistentNaming
  };

  return {
    summary: summarizePatternAudit(result),
    ...result
  };
}

function isHomePageLike(urlString, startUrl) {
  try {
    const url = new URL(urlString);
    const start = new URL(startUrl);
    const cleanPath = url.pathname.replace(/\/+$/g, "") || "/";
    const startPath = start.pathname.replace(/\/+$/g, "") || "/";
    return url.origin === start.origin && (cleanPath === "/" || cleanPath === startPath);
  } catch {
    return false;
  }
}

function determineImpactLevel(entry, startUrl) {
  const occurrenceCount = Number(entry.occurrenceCount || 0);
  const referrerCount = Number(entry.referrerCount || 0);
  const isBroken = entry.issueType === "broken";
  const isRedirectIssue = entry.issueType === "redirect";
  const coreFlow = !!entry.coreFlow;
  const repeated = occurrenceCount >= 3 || referrerCount >= 3;
  const mediumRepeat = occurrenceCount >= 2 || referrerCount >= 2;
  const severeRedirect = !!(entry.maxRedirectsExceeded || entry.loopDetected || entry.multipleHops || entry.paramsLost || entry.irrelevantDestination);

  if ((isBroken && (coreFlow || repeated)) || (isRedirectIssue && severeRedirect && (coreFlow || repeated))) {
    return "high";
  }

  if (isBroken || severeRedirect || coreFlow || mediumRepeat) {
    return "medium";
  }

  return "low";
}

function buildImpactAudit(auditEntries, startUrl) {
  const relevantEntries = (Array.isArray(auditEntries) ? auditEntries : []).filter((entry) => {
    const statusCode = Number(entry.statusCode || 0);
    const redirected = Number(entry.redirectStepCount || 0) > 0 || getEntryFinalUrlForImpact(entry) !== getEntryOriginalUrlForImpact(entry);
    return statusCode >= 400 || redirected;
  });

  const issueMap = new Map();

  for (const entry of relevantEntries) {
    const originalUrl = getEntryOriginalUrlForImpact(entry);
    const finalResolvedUrl = getEntryFinalUrlForImpact(entry);
    const statusCode = Number(entry.statusCode || 0);
    const redirectStepCount = Number(entry.redirectStepCount || 0);
    const issueType = statusCode >= 400 ? "broken" : "redirect";
    const key = `${issueType}|${originalUrl}`;
    const existing = issueMap.get(key) || {
      issueType,
      originalUrl,
      finalResolvedUrl,
      statusCode,
      occurrenceCount: 0,
      referrers: new Set(),
      sourceTypes: new Set(),
      sourceValues: new Set(),
      redirectStepCount,
      loopDetected: false,
      multipleHops: false,
      paramsLost: false,
      irrelevantDestination: false,
      maxRedirectsExceeded: false,
      coreFlow: false,
      reasons: new Set()
    };

    existing.occurrenceCount += 1;
    if (entry.referrerPage) existing.referrers.add(entry.referrerPage);
    if (entry.sourceType) existing.sourceTypes.add(entry.sourceType);
    if (entry.sourceValue) existing.sourceValues.add(entry.sourceValue);
    existing.finalResolvedUrl = existing.finalResolvedUrl || finalResolvedUrl;
    existing.statusCode = existing.statusCode || statusCode;
    existing.redirectStepCount = Math.max(existing.redirectStepCount, redirectStepCount);
    existing.loopDetected = existing.loopDetected || !!entry.loopDetected;
    existing.multipleHops = existing.multipleHops || !!entry.multipleHops;
    existing.paramsLost = existing.paramsLost || !!entry.paramsLost;
    existing.irrelevantDestination = existing.irrelevantDestination || !!entry.irrelevantDestination;
    existing.maxRedirectsExceeded = existing.maxRedirectsExceeded || !!entry.maxRedirectsExceeded;

    const sourceType = String(entry.sourceType || "");
    const referrerPage = String(entry.referrerPage || "");
    const fromHome = referrerPage ? isHomePageLike(referrerPage, startUrl) : false;
    const coreFlow = sourceType === "start" || sourceType === "form" || sourceType === "sitemap" || fromHome;
    existing.coreFlow = existing.coreFlow || coreFlow;

    if (issueType === "broken") {
      existing.reasons.add(`http ${statusCode || "0"}`);
      if (coreFlow) existing.reasons.add("core flow");
      if (existing.occurrenceCount > 1) existing.reasons.add("repeated link");
    } else {
      if (existing.multipleHops) existing.reasons.add("multiple hops");
      if (existing.loopDetected) existing.reasons.add("redirect loop");
      if (existing.paramsLost) existing.reasons.add("params lost");
      if (existing.irrelevantDestination) existing.reasons.add("irrelevant destination");
      if (existing.maxRedirectsExceeded) existing.reasons.add("max redirects exceeded");
      if (coreFlow) existing.reasons.add("core flow");
      if (existing.occurrenceCount > 1) existing.reasons.add("repeated link");
      if (!existing.reasons.size) existing.reasons.add("redirected URL");
    }

    issueMap.set(key, existing);
  }

  const entries = Array.from(issueMap.values())
    .map((entry) => {
      const referrerPages = Array.from(entry.referrers).sort();
      const sourceTypes = Array.from(entry.sourceTypes).sort();
      const impactLevel = determineImpactLevel({
        ...entry,
        referrerCount: referrerPages.length
      }, startUrl);

      return {
        issueType: entry.issueType,
        impactLevel,
        originalUrl: entry.originalUrl,
        finalResolvedUrl: entry.finalResolvedUrl,
        statusCode: entry.statusCode,
        occurrenceCount: entry.occurrenceCount,
        referrerCount: referrerPages.length,
        referrerPages: referrerPages.slice(0, 12),
        sourceTypes,
        redirectStepCount: entry.redirectStepCount,
        loopDetected: entry.loopDetected,
        multipleHops: entry.multipleHops,
        paramsLost: entry.paramsLost,
        irrelevantDestination: entry.irrelevantDestination,
        maxRedirectsExceeded: entry.maxRedirectsExceeded,
        coreFlow: entry.coreFlow,
        reasons: Array.from(entry.reasons)
      };
    })
    .sort((a, b) => {
      const impactRank = { high: 0, medium: 1, low: 2 };
      const byImpact = (impactRank[a.impactLevel] ?? 9) - (impactRank[b.impactLevel] ?? 9);
      if (byImpact !== 0) return byImpact;
      const byOccurrences = b.occurrenceCount - a.occurrenceCount;
      if (byOccurrences !== 0) return byOccurrences;
      const byReferrers = b.referrerCount - a.referrerCount;
      if (byReferrers !== 0) return byReferrers;
      return a.originalUrl.localeCompare(b.originalUrl);
    });

  const summary = entries.reduce((acc, entry) => {
    acc.total += 1;
    if (entry.issueType === "broken") acc.broken += 1;
    if (entry.issueType === "redirect") acc.redirected += 1;
    if (entry.impactLevel === "high") acc.high += 1;
    if (entry.impactLevel === "medium") acc.medium += 1;
    if (entry.impactLevel === "low") acc.low += 1;
    return acc;
  }, {
    total: 0,
    broken: 0,
    redirected: 0,
    high: 0,
    medium: 0,
    low: 0
  });

  return { summary, entries };
}

function getEntryOriginalUrlForImpact(entry) {
  return String(entry?.originalUrl || entry?.url || "");
}

function getEntryFinalUrlForImpact(entry) {
  return String(entry?.finalResolvedUrl || entry?.finalUrl || getEntryOriginalUrlForImpact(entry));
}

function buildIssueReport(auditEntries, redirectAuditEntries, parameterAuditEntries, softFailureEntries, impactAudit) {
  const brokenUrls = (Array.isArray(auditEntries) ? auditEntries : [])
    .filter((entry) => Number(entry.statusCode || 0) >= 400 || entry.classification === "broken")
    .map((entry) => ({
      originalUrl: entry.originalUrl,
      referrerPage: entry.referrerPage,
      sourceType: entry.sourceType,
      finalResolvedUrl: entry.finalResolvedUrl,
      statusCode: entry.statusCode,
      classification: entry.classification
    }));

  const redirectIssues = (Array.isArray(redirectAuditEntries) ? redirectAuditEntries : [])
    .filter((entry) => entry.hasIssue)
    .map((entry) => ({
      originalUrl: entry.originalUrl,
      referrerPage: entry.referrerPage,
      finalResolvedUrl: entry.finalResolvedUrl,
      statusCode: entry.statusCode,
      redirectStepCount: entry.redirectStepCount,
      loopDetected: entry.loopDetected,
      multipleHops: entry.multipleHops,
      paramsLost: entry.paramsLost,
      irrelevantDestination: entry.irrelevantDestination,
      maxRedirectsExceeded: entry.maxRedirectsExceeded
    }));

  const parameterHandlingIssues = (Array.isArray(parameterAuditEntries) ? parameterAuditEntries : [])
    .filter((entry) => entry.hasIssue)
    .map((entry) => ({
      baseUrl: entry.baseUrl,
      parameterizedUrl: entry.parameterizedUrl,
      finalUrl: entry.finalUrl,
      statusCode: entry.statusCode,
      paramsDropped: entry.paramsDropped,
      unexpectedRedirect: entry.unexpectedRedirect
    }));

  const softFailures = (Array.isArray(softFailureEntries) ? softFailureEntries : [])
    .map((entry) => ({
      url: entry.url,
      finalUrl: entry.finalUrl,
      statusCode: entry.statusCode,
      reasons: entry.softFailureReasons,
      apiFailures: entry.apiFailures
    }));

  return {
    brokenUrls,
    redirectIssues,
    parameterHandlingIssues,
    softFailures,
    impactAnalysis: Array.isArray(impactAudit?.entries) ? impactAudit.entries : [],
    summary: {
      brokenUrls: brokenUrls.length,
      redirectIssues: redirectIssues.length,
      parameterHandlingIssues: parameterHandlingIssues.length,
      softFailures: softFailures.length,
      impactIssues: Array.isArray(impactAudit?.entries) ? impactAudit.entries.length : 0
    }
  };
}

function concurrencyMap(items, limit, fn) {
  return new Promise((resolve) => {
    const results = new Array(items.length);
    let idx = 0;
    let active = 0;

    const next = () => {
      if (idx >= items.length && active === 0) {
        resolve(results);
        return;
      }

      while (active < limit && idx < items.length) {
        const currentIndex = idx++;
        active++;
        Promise.resolve(fn(items[currentIndex], currentIndex))
          .then((r) => { results[currentIndex] = r; })
          .catch(() => { results[currentIndex] = null; })
          .finally(() => {
            active--;
            next();
          });
      }
    };

    next();
  });
}

function enforceCrawlStartRateLimit(req, res, next) {
  try {
    consumeRateLimit(crawlStartRateLimiter, req, res, "crawl-start");
    next();
  } catch (error) {
    next(error);
  }
}

app.use((error, req, res, next) => {
  if (error?.type === "entity.too.large") {
    return sendError(res, new ApiError("Request body exceeded the configured size limit", {
      statusCode: 413,
      code: "REQUEST_BODY_TOO_LARGE",
      details: {
        maxBytes: SERVER_CONFIG.requestBodyLimitBytes
      }
    }), req);
  }

  if (error instanceof SyntaxError && "body" in error) {
    return sendError(res, new ApiError("Request body contained invalid JSON", {
      statusCode: 400,
      code: "INVALID_JSON"
    }), req);
  }

  return next(error);
});

app.get("/healthz", async (req, res) => {
  try {
    return res.json(await buildHealthResponse());
  } catch (error) {
    return sendError(res, error, req);
  }
});

app.get("/readyz", async (req, res) => {
  try {
    const payload = await buildReadinessResponse();
    return res.status(payload.ready ? 200 : 503).json(payload);
  } catch (error) {
    return sendError(res, error, req);
  }
});

async function executeCrawlRequest(body, onProgress = () => {}) {
  const url = String(body?.url || "").trim();
  const options = sanitizeCrawlOptions(body?.options || {});
  delete options.languagePrefixes;
  const excludePathMatchers = buildExcludeMatchers(options.excludePaths);
  const userAgent = "SiteCrawler/1.0";
  const emitProgress = createProgressEmitter(onProgress);
  const outboundController = createOutboundAccessController();

  let root;
  try {
    root = new URL(url);
  } catch {
    const err = new Error("Invalid URL");
    err.statusCode = 400;
    throw err;
  }

  if (!["http:", "https:"].includes(root.protocol)) {
    const err = new Error(`Unsupported URL protocol: ${root.protocol || "(missing)"}`);
    err.statusCode = 400;
    throw err;
  }

  const origin = root.origin;
  const rootHost = root.host;
  const start = normalizeUrl(url, null, options);
  if (!start) {
    const err = new Error("Invalid URL");
    err.statusCode = 400;
    throw err;
  }

  try {
    await outboundController.resolveUrl(start);
  } catch (error) {
    if (error instanceof OutboundRequestValidationError) {
      error.statusCode = 403;
    }
    throw error;
  }

  emitProgress({
    phase: "setup",
    message: "Loading robots.txt and sitemap",
    percent: 2,
    pagesCrawled: 0,
    pagesQueued: 0,
    pagesDiscovered: 0,
    maxPages: options.maxPages
  }, true);

  const startLanguagePrefix = inferStartLanguagePrefix(start);
  let startPathScope = "/";
  try {
    const u = new URL(start);
    startPathScope = String(u.pathname || "/").replace(/\/+$/g, "") || "/";
  } catch {
    startPathScope = "/";
  }
  const startScope = !startPathScope || startPathScope === "/" ? "/" : (startPathScope.endsWith("/") ? startPathScope.slice(0, -1) : startPathScope);

  const robots = await fetchRobots(origin, options.timeoutMs, userAgent, outboundController);
  emitProgress({
    phase: "discovery",
    message: "Priming crawl queue",
    percent: 5,
    pagesCrawled: 0,
    pagesQueued: 0,
    pagesDiscovered: 0,
    maxPages: options.maxPages
  }, true);

  const toVisitQueue = [];
  const toVisitSet = new Set();
  const visited = new Set();
  const blockedByPathLimit = new Set();
  const discovered = new Set();
  const navigationEntries = [];
  let pagesCrawled = 0;

  const pathLimitCounters = new Map();
  const pathLimitSkipped = {};

  function reportCrawlProgress(message = "Crawling pages", force = false) {
    const crawlPercent = Math.min(70, 8 + Math.round((pagesCrawled / Math.max(1, options.maxPages)) * 62));
    emitProgress({
      phase: "crawl",
      message,
      percent: crawlPercent,
      pagesCrawled,
      pagesQueued: toVisitQueue.length,
      pagesDiscovered: discovered.size,
      maxPages: options.maxPages
    }, force);
  }

  function enqueue(urlString) {
    if (visited.has(urlString) || blockedByPathLimit.has(urlString) || toVisitSet.has(urlString)) return;
    if (visited.size + toVisitSet.size >= options.maxPages) return;
    toVisitSet.add(urlString);
    toVisitQueue.push(urlString);
  }

  function recordNavigationEntry(originalUrl, referrer, sourceType, sourceValue) {
    navigationEntries.push({
      originalUrl,
      referrerPage: referrer || "",
      sourceType,
      sourceValue
    });
  }

  recordNavigationEntry(start, "", "start", start);

  const sitemapUrls = await fetchSitemapUrls(origin, options.timeoutMs, robots, userAgent, outboundController);
  if (sitemapUrls.length) {
    sitemapUrls.forEach((u) => {
      const n = normalizeUrl(u, null, options);
      if (!n) return;

      const parts = parseUrlParts(n);
      if (!parts) return;
      if (options.sameHostOnly && parts.host !== rootHost) return;
      if (options.scopeToStartPath && startScope !== "/") {
        if (!(parts.pathname === startScope || parts.pathname.startsWith(startScope + "/"))) return;
      }

      recordNavigationEntry(n, "", "sitemap", u);
      enqueue(n);
    });
  } else {
    enqueue(start);
  }
  reportCrawlProgress(sitemapUrls.length ? "Queued sitemap URLs" : "Queued start URL", true);

  const records = new Map();
  const quickStatusCache = new Map();

  async function getQuickStatusCached(urlString) {
    const existingRecord = records.get(urlString);
    if (existingRecord && existingRecord.status !== null && existingRecord.status !== undefined) {
      return toQuickStatusResult(existingRecord, urlString);
    }

    if (quickStatusCache.has(urlString)) {
      return quickStatusCache.get(urlString);
    }

    const pending = quickStatus(urlString, options.timeoutMs, robots, userAgent, outboundController)
      .then((result) => ({
        status: result.status,
        finalUrl: result.finalUrl || urlString,
        blockedByRobots: !!result.blockedByRobots,
        redirectChain: result.redirectChain || [urlString],
        redirectSteps: result.redirectSteps || [],
        loopDetected: !!result.loopDetected,
        maxRedirectsExceeded: !!result.maxRedirectsExceeded
      }))
      .catch(() => ({
        status: 0,
        finalUrl: urlString,
        blockedByRobots: false,
        redirectChain: [urlString],
        redirectSteps: [],
        loopDetected: false,
        maxRedirectsExceeded: false
      }));

    quickStatusCache.set(urlString, pending);
    return pending;
  }

  async function processOne(currentUrl) {
    if (visited.has(currentUrl) || blockedByPathLimit.has(currentUrl)) return;

    const parts = parseUrlParts(currentUrl);
    if (!parts) return;
    const pathname = parts.pathname || "/";
    const pathnameLower = pathname.toLowerCase();

    if (options.scopeToStartPath && startScope !== "/") {
      if (!(pathname === startScope || pathname.startsWith(startScope + "/"))) return;
    }

    if (options.pathLimits && options.pathLimits.length) {
      const normalizedPath = normalizePathForRules(pathname).toLowerCase();

      for (const rule of options.pathLimits) {
        const rulePath = String(rule.path || "").trim().toLowerCase();
        if (!matchesPathLimit(normalizedPath, rulePath)) continue;

        const key = rulePath;
        const currentCount = pathLimitCounters.get(key) || 0;
        const maxAllowed = Number(rule.maxPages || 0) || 0;

        if (maxAllowed > 0 && currentCount >= maxAllowed) {
          blockedByPathLimit.add(currentUrl);
          pathLimitSkipped[rule.path] = (pathLimitSkipped[rule.path] || 0) + 1;
          return;
        }

        pathLimitCounters.set(key, currentCount + 1);
        break;
      }
    }

    visited.add(currentUrl);

    if (options.sameHostOnly) {
      if (parts.host !== rootHost) return;
    }

    if (hasExcludedExtension(currentUrl, options)) return;
    if (isExcludedByPathname(pathnameLower, excludePathMatchers)) return;
    if (options.ignoreJobPages && isJobDetailPage(pathnameLower)) return;

    const r = await fetchHtmlText(currentUrl, options.timeoutMs, robots, userAgent, outboundController);
    pagesCrawled += 1;
    reportCrawlProgress(`Crawled ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"}`);

    const existing = records.get(currentUrl) || {
      url: currentUrl,
      finalUrl: currentUrl,
      status: null,
      blockedByRobots: false,
      redirectChain: [currentUrl],
      redirectSteps: [],
      fetchError: "",
      fetchErrorCode: "",
      metaRobots: "",
      softFailureReasons: [],
      missingExpectedComponents: [],
      errorTextMatches: [],
      apiChecks: [],
      apiFailures: []
    };
    existing.finalUrl = r.finalUrl || currentUrl;
    existing.blockedByRobots = !!r.blockedByRobots;
    existing.status = r.status;
    existing.redirectChain = r.redirectChain || [currentUrl];
    existing.redirectSteps = r.redirectSteps || [];
    existing.fetchError = String(r.error || "");
    existing.fetchErrorCode = String(r.errorCode || "");
    existing.metaRobots = r.text ? getMetaRobots(r.text) : "";

    if (r.status === 200 && r.text) {
      const softFailure = await analyzeSoftFailurePage(
        existing.finalUrl || currentUrl,
        r.text,
        getQuickStatusCached,
        options.sameHostOnly,
        rootHost
      );
      existing.softFailureReasons = softFailure.softFailureReasons;
      existing.missingExpectedComponents = softFailure.missingExpectedComponents;
      existing.errorTextMatches = softFailure.errorTextMatches;
      existing.apiChecks = softFailure.apiChecks;
      existing.apiFailures = softFailure.apiFailures;
    } else {
      existing.softFailureReasons = [];
      existing.missingExpectedComponents = [];
      existing.errorTextMatches = [];
      existing.apiChecks = [];
      existing.apiFailures = [];
    }

    records.set(currentUrl, existing);

    if (!r.ok || !r.text) {
      discovered.add(currentUrl);
      return;
    }

    discovered.add(currentUrl);

    const $ = cheerio.load(r.text);
    const links = [];
    const baseForLinks = r.finalUrl || currentUrl;

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      const next = normalizeUrl(href, baseForLinks, options);
      if (!next) return;

      const nextParts = parseUrlParts(next);
      if (!nextParts) return;
      const nextPathname = nextParts.pathname || "/";
      const nextPathnameLower = nextPathname.toLowerCase();

      if (options.scopeToStartPath && startScope !== "/") {
        if (!(nextPathname === startScope || nextPathname.startsWith(startScope + "/"))) return;
      }

      if (options.sameHostOnly && nextParts.host !== rootHost) return;

      if (hasExcludedExtension(next, options)) return;
      if (isExcludedByPathname(nextPathnameLower, excludePathMatchers)) return;
      if (options.ignoreJobPages && isJobDetailPage(nextPathnameLower)) return;

      recordNavigationEntry(next, currentUrl, "link", href);
      links.push(next);
    });

    $("form[action]").each((_, el) => {
      const action = String($(el).attr("action") || "").trim();
      if (!action) return;

      const next = normalizeUrl(action, baseForLinks, options);
      if (!next) return;

      const nextParts = parseUrlParts(next);
      if (!nextParts) return;
      const nextPathname = nextParts.pathname || "/";
      const nextPathnameLower = nextPathname.toLowerCase();

      if (options.scopeToStartPath && startScope !== "/") {
        if (!(nextPathname === startScope || nextPathname.startsWith(startScope + "/"))) return;
      }

      if (options.sameHostOnly && nextParts.host !== rootHost) return;

      if (hasExcludedExtension(next, options)) return;
      if (isExcludedByPathname(nextPathnameLower, excludePathMatchers)) return;

      recordNavigationEntry(next, currentUrl, "form", action);
      links.push(next);
    });

    for (const next of links) {
      if (visited.size + toVisitSet.size >= options.maxPages) break;
      enqueue(next);
    }
  }

  while (toVisitQueue.length > 0 && visited.size < options.maxPages) {
    const batch = toVisitQueue.splice(0, options.concurrency * 2);
    batch.forEach((u) => toVisitSet.delete(u));
    await concurrencyMap(batch, options.concurrency, processOne);
  }
  emitProgress({
    phase: "crawl",
    message: "Page discovery complete",
    percent: 70,
    pagesCrawled,
    pagesQueued: 0,
    pagesDiscovered: discovered.size,
    maxPages: options.maxPages
  }, true);

  const urls = Array.from(discovered).sort();

  if (options.brokenLinkCheck) {
    const missingStatus = urls.filter((u) => {
      const existing = records.get(u);
      return existing?.status === null || existing?.status === undefined;
    });

    if (missingStatus.length) {
      let missingStatusDone = 0;
      await concurrencyMap(missingStatus, Math.min(options.concurrency, 6), async (u) => {
        const s = await getQuickStatusCached(u);
        const existing = records.get(u) || {
          url: u,
          finalUrl: u,
          status: null,
          blockedByRobots: false,
          redirectChain: [u],
          redirectSteps: [],
          fetchError: "",
          fetchErrorCode: "",
          metaRobots: "",
          softFailureReasons: [],
          missingExpectedComponents: [],
          errorTextMatches: [],
          apiChecks: [],
          apiFailures: []
        };
        existing.status = s.status;
        existing.finalUrl = s.finalUrl || existing.finalUrl || u;
        existing.blockedByRobots = !!s.blockedByRobots;
        existing.redirectChain = s.redirectChain || existing.redirectChain || [u];
        existing.redirectSteps = s.redirectSteps || existing.redirectSteps || [];
        records.set(u, existing);
        missingStatusDone += 1;
        emitProgress({
          phase: "status",
          message: `Checked statuses ${missingStatusDone}/${missingStatus.length}`,
          percent: Math.min(76, 70 + Math.round((missingStatusDone / Math.max(1, missingStatus.length)) * 6)),
          pagesCrawled,
          pagesQueued: 0,
          pagesDiscovered: discovered.size,
          maxPages: options.maxPages
        });
        return true;
      });
    }
  }

  const out = urls
    .map((u) => {
      const record = records.get(u) || {
        url: u,
        finalUrl: u,
        status: null,
        blockedByRobots: false,
        redirectChain: [u],
        redirectSteps: [],
        fetchError: "",
        fetchErrorCode: "",
        metaRobots: "",
        softFailureReasons: [],
        missingExpectedComponents: [],
        errorTextMatches: [],
        apiChecks: [],
        apiFailures: []
      };
      return {
        ...record,
        classification: classifyRecord(record)
      };
    })
    .sort((a, b) => a.url.localeCompare(b.url));

  const recordsByFinalUrl = new Map();
  for (const record of out) {
    if (record.finalUrl && !recordsByFinalUrl.has(record.finalUrl)) {
      recordsByFinalUrl.set(record.finalUrl, record);
    }
  }

  let navigationAuditDone = 0;
  emitProgress({
    phase: "audit",
    message: `Validated navigation 0/${navigationEntries.length || 0}`,
    percent: 76,
    pagesCrawled,
    pagesQueued: 0,
    pagesDiscovered: discovered.size,
    maxPages: options.maxPages,
    auditEntriesTested: 0,
    auditEntriesTotal: navigationEntries.length
  }, true);

  const auditedNavigationEntries = await concurrencyMap(
    navigationEntries,
    Math.min(options.concurrency, 8),
    async (entry) => {
      const result = await getQuickStatusCached(entry.originalUrl);
      const record = {
        url: entry.originalUrl,
        finalUrl: result.finalUrl || entry.originalUrl,
        status: result.status,
        blockedByRobots: !!result.blockedByRobots,
        redirectChain: result.redirectChain || [entry.originalUrl],
        redirectSteps: result.redirectSteps || [],
        metaRobots: ""
      };
      const matchedRecord = records.get(entry.originalUrl) || recordsByFinalUrl.get(record.finalUrl);
      record.softFailureReasons = matchedRecord?.softFailureReasons || [];
      record.missingExpectedComponents = matchedRecord?.missingExpectedComponents || [];
      record.errorTextMatches = matchedRecord?.errorTextMatches || [];
      record.apiChecks = matchedRecord?.apiChecks || [];
      record.apiFailures = matchedRecord?.apiFailures || [];
      const redirectAuditEntry = buildRedirectAuditEntry(entry, result);
      const auditedEntry = {
        originalUrl: entry.originalUrl,
        referrerPage: entry.referrerPage,
        sourceType: entry.sourceType,
        sourceValue: entry.sourceValue,
        finalResolvedUrl: record.finalUrl,
        statusCode: record.status,
        redirectChain: record.redirectChain,
        redirectSteps: record.redirectSteps,
        redirectStatuses: redirectAuditEntry.redirectStatuses,
        redirectStepCount: redirectAuditEntry.redirectStepCount,
        loopDetected: redirectAuditEntry.loopDetected,
        multipleHops: redirectAuditEntry.multipleHops,
        paramsLost: redirectAuditEntry.paramsLost,
        irrelevantDestination: redirectAuditEntry.irrelevantDestination,
        maxRedirectsExceeded: redirectAuditEntry.maxRedirectsExceeded,
        blockedByRobots: record.blockedByRobots,
        metaRobots: "",
        softFailureReasons: record.softFailureReasons,
        missingExpectedComponents: record.missingExpectedComponents,
        errorTextMatches: record.errorTextMatches,
        apiFailures: record.apiFailures,
        classification: classifyRecord(record)
      };
      navigationAuditDone += 1;
      emitProgress({
        phase: "audit",
        message: `Validated navigation ${navigationAuditDone}/${navigationEntries.length || 0}`,
        percent: Math.min(88, 76 + Math.round((navigationAuditDone / Math.max(1, navigationEntries.length || 1)) * 12)),
        pagesCrawled,
        pagesQueued: 0,
        pagesDiscovered: discovered.size,
        maxPages: options.maxPages,
        auditEntriesTested: navigationAuditDone,
        auditEntriesTotal: navigationEntries.length
      });
      return auditedEntry;
    }
  );

  const auditEntries = auditedNavigationEntries
    .filter(Boolean)
    .sort((a, b) => {
      const byReferrer = a.referrerPage.localeCompare(b.referrerPage);
      if (byReferrer !== 0) return byReferrer;
      return a.originalUrl.localeCompare(b.originalUrl);
    });

  const auditSummary = auditEntries.reduce((acc, entry) => {
    acc.total += 1;
    if (entry.classification === "valid") acc.valid += 1;
    if (entry.classification === "broken") acc.broken += 1;
    if (entry.classification === "redirect_issue") acc.redirectIssues += 1;
    if (entry.classification === "soft_failure") acc.softFailures += 1;
    return acc;
  }, { total: 0, valid: 0, broken: 0, redirectIssues: 0, softFailures: 0 });

  const impactAudit = buildImpactAudit(auditEntries, start);

  const redirectAuditEntries = auditEntries
    .map((entry) => ({
      originalUrl: entry.originalUrl,
      referrerPage: entry.referrerPage,
      sourceType: entry.sourceType,
      sourceValue: entry.sourceValue,
      finalResolvedUrl: entry.finalResolvedUrl,
      statusCode: entry.statusCode,
      redirectChain: entry.redirectChain,
      redirectSteps: entry.redirectSteps || [],
      redirectStatuses: entry.redirectStatuses || [],
      redirectStepCount: Number(entry.redirectStepCount || 0),
      loopDetected: !!entry.loopDetected,
      multipleHops: !!entry.multipleHops,
      paramsLost: !!entry.paramsLost,
      irrelevantDestination: !!entry.irrelevantDestination,
      maxRedirectsExceeded: !!entry.maxRedirectsExceeded,
      maxOneHopPreferred: Number(entry.redirectStepCount || 0) <= 1,
      hasIssue: !!(entry.loopDetected || entry.multipleHops || entry.paramsLost || entry.irrelevantDestination || entry.maxRedirectsExceeded),
      classification: Number(entry.redirectStepCount || 0) === 0
        ? "direct"
        : ((entry.loopDetected || entry.multipleHops || entry.paramsLost || entry.irrelevantDestination || entry.maxRedirectsExceeded) ? "redirect_issue" : "redirect_ok")
    }))
    .sort((a, b) => {
      const byReferrer = a.referrerPage.localeCompare(b.referrerPage);
      if (byReferrer !== 0) return byReferrer;
      return a.originalUrl.localeCompare(b.originalUrl);
    });

  const redirectAuditSummary = summarizeRedirectAudit(redirectAuditEntries);

  const softFailureEntries = out
    .filter((entry) => Array.isArray(entry.softFailureReasons) && entry.softFailureReasons.length > 0)
    .map((entry) => ({
      url: entry.url,
      finalUrl: entry.finalUrl,
      statusCode: entry.status,
      softFailureReasons: entry.softFailureReasons,
      missingExpectedComponents: entry.missingExpectedComponents || [],
      errorTextMatches: entry.errorTextMatches || [],
      apiFailures: entry.apiFailures || []
    }))
    .sort((a, b) => a.url.localeCompare(b.url));

  const softFailureSummary = summarizeSoftFailureAudit(softFailureEntries);
  const patternAudit = buildPatternAudit(out, options.patternMatchFilter);
  emitProgress({
    phase: "reporting",
    message: "Building audit reports",
    percent: 90,
    pagesCrawled,
    pagesQueued: 0,
    pagesDiscovered: discovered.size,
    maxPages: options.maxPages,
    auditEntriesTested: auditEntries.length,
    auditEntriesTotal: navigationEntries.length
  }, true);

  let parameterAudit = {
    summary: {
      total: 0,
      inconsistencies: 0,
      httpErrors: 0,
      paramsDropped: 0,
      unexpectedRedirects: 0
    },
    entries: []
  };

  if (options.parameterAudit) {
    const parameterTargets = out.map((record) => ({
      baseUrl: record.url,
      baseFinalUrl: record.finalUrl || record.url,
      baseStatusCode: record.status
    }));

    const parameterEntries = [];
    const parameterJobs = [];
    for (const target of parameterTargets) {
      for (const variation of PARAMETER_VARIATIONS) {
        const variantUrl = createParameterVariant(target.baseUrl, variation);
        if (!variantUrl) continue;
        parameterJobs.push({
          ...target,
          variation,
          variantUrl
        });
      }
    }

    let parameterChecksDone = 0;
    await concurrencyMap(parameterJobs, Math.min(options.concurrency, 8), async (job) => {
      const res = await getQuickStatusCached(job.variantUrl);
      const paramsPreserved = hasExpectedParameter(res.finalUrl || job.variantUrl, job.variation);
      const paramsDropped = !paramsPreserved;
      const unexpectedRedirect =
        (res.redirectChain || []).length > 1 &&
        getComparablePath(res.finalUrl || job.variantUrl) !== getComparablePath(job.baseFinalUrl || job.baseUrl);
      const hasIssue = (Number(res.status || 0) >= 400) || paramsDropped || unexpectedRedirect;

      parameterEntries.push({
        baseUrl: job.baseUrl,
        baseFinalUrl: job.baseFinalUrl,
        baseStatusCode: job.baseStatusCode,
        variation: `${job.variation.name}=${job.variation.value}`,
        parameterizedUrl: job.variantUrl,
        finalUrl: res.finalUrl || job.variantUrl,
        statusCode: res.status,
        redirectChain: res.redirectChain || [job.variantUrl],
        redirectBehaviour: (res.redirectChain || []).length > 1 ? "redirected" : "direct",
        paramsPreserved,
        paramsDropped,
        unexpectedRedirect,
        hasIssue
      });
      parameterChecksDone += 1;
      emitProgress({
        phase: "parameter_audit",
        message: `Checked parameters ${parameterChecksDone}/${parameterJobs.length}`,
        percent: Math.min(98, 90 + Math.round((parameterChecksDone / Math.max(1, parameterJobs.length)) * 8)),
        pagesCrawled,
        pagesQueued: 0,
        pagesDiscovered: discovered.size,
        maxPages: options.maxPages,
        auditEntriesTested: auditEntries.length,
        auditEntriesTotal: navigationEntries.length,
        parameterChecksDone,
        parameterChecksTotal: parameterJobs.length
      });
      return true;
    });

    parameterEntries.sort((a, b) => {
      const byBase = a.baseUrl.localeCompare(b.baseUrl);
      if (byBase !== 0) return byBase;
      return a.variation.localeCompare(b.variation);
    });

    parameterAudit = {
      summary: summarizeParameterAudit(parameterEntries),
      entries: parameterEntries
    };
  }

  const issueReport = buildIssueReport(
    auditEntries,
    redirectAuditEntries,
    parameterAudit.entries,
    softFailureEntries,
    impactAudit
  );

  const response = {
    startUrl: start,
    origin,
    counts: {
      crawled: pagesCrawled,
      visited: visited.size,
      returned: out.length,
      fromSitemap: sitemapUrls.length > 0,
      skippedByPathLimit: pathLimitSkipped
    },
    options: {
      ...options,
      excludePaths: options.excludePaths || [],
      pathLimits: options.pathLimits || [],
      inferredLanguagePrefix: startLanguagePrefix || ""
    },
    urls: out,
    audit: {
      summary: auditSummary,
      entries: auditEntries
    },
    impactAudit,
    redirectAudit: {
      summary: redirectAuditSummary,
      entries: redirectAuditEntries
    },
    softFailureAudit: {
      summary: softFailureSummary,
      entries: softFailureEntries
    },
    patternAudit,
    parameterAudit,
    issueReport
  };

  emitProgress({
    phase: "complete",
    message: "Crawl complete",
    percent: 100,
    pagesCrawled,
    pagesQueued: 0,
    pagesDiscovered: discovered.size,
    maxPages: options.maxPages,
    auditEntriesTested: auditEntries.length,
    auditEntriesTotal: navigationEntries.length,
    parameterChecksDone: parameterAudit.summary?.total || 0,
    parameterChecksTotal: parameterAudit.summary?.total || 0
  }, true);

  return response;
}

app.post("/api/crawl", enforceCrawlStartRateLimit, async (req, res) => {
  try {
    const result = await runImmediateCrawl(() => getConfiguredCrawlExecutor()(req.body));
    return res.json(result);
  } catch (error) {
    return sendError(res, error, req);
  }
});

app.post("/api/crawl/start", enforceCrawlStartRateLimit, async (req, res) => {
  try {
    await initializeRuntimeServices();
    const createdJob = await createDurableCrawlJob(req.body);
    scheduleDurableCrawlDrain();
    return res.json({ jobId: createdJob.job.id });
  } catch (error) {
    return sendError(res, error, req);
  }
});

app.get("/api/crawl/:jobId", async (req, res) => {
  try {
    const jobStore = getConfiguredCrawlJobStore();
    const job = await jobStore.getJob(String(req.params?.jobId || ""));
    if (!job) {
      throw new ApiError("Crawl job not found", {
        statusCode: 404,
        code: "CRAWL_JOB_NOT_FOUND"
      });
    }

    const completed = job.status === "completed";
    const limiter = completed ? crawlResultsRateLimiter : crawlStatusRateLimiter;
    const label = completed ? "crawl-results" : "crawl-status";
    consumeRateLimit(limiter, req, res, label);

    return res.json({
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      progress: job.progress,
      result: completed ? await jobStore.getCompletedJobResult(job.id) : null,
      error: job.error || "",
      errorCode: job.errorCode || "",
      errorDetails: job.errorDetails ?? null
    });
  } catch (error) {
    return sendError(res, error, req);
  }
});

app.use("/api", (req, res) => {
  return sendError(res, new ApiError("API route not found", {
    statusCode: 404,
    code: "API_ROUTE_NOT_FOUND"
  }), req);
});

app.use(express.static(path.join(__dirname, "../frontend/dist")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/dist/index.html"));
});

app.use((error, req, res, next) => {
  return sendError(res, error, req);
});

function normalizeProcessError(error) {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error("Non-serializable process error");
  }
}

function beginShutdown(reason, { exitCode = 0 } = {}) {
  if (runtimeState.shuttingDown) {
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }

  runtimeState.shuttingDown = true;
  runtimeState.shutdownReason = String(reason || "shutdown");
  void shutdownRuntimeServices();
  logStructured("warn", "process.shutdown.started", {
    reason: runtimeState.shutdownReason,
    exitCode,
    gracefulShutdownTimeoutMs: SERVER_CONFIG.observability.gracefulShutdownTimeoutMs
  });

  const server = runtimeState.server;
  if (!server) {
    process.exitCode = exitCode;
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

  const forcedExit = setTimeout(() => {
    logStructured("fatal", "process.shutdown.timeout", {
      reason: runtimeState.shutdownReason,
      exitCode
    });
    process.exit(exitCode || 1);
  }, SERVER_CONFIG.observability.gracefulShutdownTimeoutMs);
  forcedExit.unref();

  server.close((closeError) => {
    clearTimeout(forcedExit);

    if (closeError) {
      logStructured("fatal", "process.shutdown.failed", {
        reason: runtimeState.shutdownReason,
        exitCode,
        error: serializeErrorForLog(closeError)
      });
      process.exit(exitCode || 1);
      return;
    }

    logStructured("info", "process.shutdown.completed", {
      reason: runtimeState.shutdownReason,
      exitCode
    });

    if (exitCode !== 0) {
      process.exit(exitCode);
      return;
    }

    process.exitCode = 0;
  });
}

function registerProcessHandlers() {
  if (runtimeState.handlersRegistered) return;
  runtimeState.handlersRegistered = true;

  process.on("SIGTERM", () => {
    beginShutdown("SIGTERM", { exitCode: 0 });
  });

  process.on("SIGINT", () => {
    beginShutdown("SIGINT", { exitCode: 0 });
  });

  process.on("unhandledRejection", (reason) => {
    const error = normalizeProcessError(reason);
    logStructured("fatal", "process.unhandled_rejection", {
      error: serializeErrorForLog(error)
    });

    if (SERVER_CONFIG.observability.exitOnUnhandledError) {
      beginShutdown("unhandledRejection", { exitCode: 1 });
    }
  });

  process.on("uncaughtException", (error) => {
    logStructured("fatal", "process.uncaught_exception", {
      error: serializeErrorForLog(normalizeProcessError(error))
    });

    if (SERVER_CONFIG.observability.exitOnUnhandledError) {
      beginShutdown("uncaughtException", { exitCode: 1 });
    }
  });
}

const PORT = process.env.PORT || 8080;
const isDirectExecution = process.argv[1] ? path.resolve(process.argv[1]) === __filename : false;

function startServer(port = PORT) {
  const server = app.listen(port, () => {
    void initializeRuntimeServices();
    logStructured("info", "server.started", {
      port: Number(port),
      service: SERVER_CONFIG.observability.serviceName,
      trustProxy: SERVER_CONFIG.trustProxyDescription
    });
  });

  runtimeState.server = server;
  registerProcessHandlers();
  return server;
}

if (isDirectExecution) {
  startServer(PORT);
}

export {
  app,
  buildErrorResponse,
  buildHealthResponse,
  buildReadinessResponse,
  createOutboundAccessController,
  describeTrustProxySetting,
  executeCrawlRequest,
  extractRobotsSitemapCandidates,
  fetchHtmlText,
  fetchRobots,
  fetchSitemapUrls,
  fetchTextResource,
  fetchWithRedirects,
  getClientIpInfo,
  isRobotsContentType,
  isXmlContentType,
  parseSitemapXml,
  resolveTrustProxySetting,
  buildClientSafeJobError,
  getConfiguredCrawlJobStore,
  initializeRuntimeServices,
  shutdownRuntimeServices,
  startServer
};
