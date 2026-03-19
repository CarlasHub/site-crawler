import express from "express";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "1mb" }));

const DEFAULTS = {
  maxPages: 300,
  concurrency: 6,
  timeoutMs: 12000,
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
  parameterAudit: false
};

const PARAMETER_VARIATIONS = [
  { name: "test", value: "1" },
  { name: "page", value: "2" },
  { name: "filter", value: "value" }
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


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

async function fetchText(url, timeoutMs, robots, userAgent) {
  const r = await fetchWithRedirects(url, {
    method: "GET",
    timeoutMs,
    robots,
    userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  });

  const contentType = r.contentType || "";
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
  if (!r.ok) {
    return { ...r, text: "" };
  }
  if (!isHtml) {
    return { ...r, ok: false, text: "" };
  }
  return r;
}

async function fetchRobots(origin, timeoutMs, userAgent) {
  const robotsUrl = origin.replace(/\/$/, "") + "/robots.txt";
  const r = await fetchText(robotsUrl, timeoutMs, null, userAgent);
  if (!r.ok || !r.text) return null;
  return robotsParser(robotsUrl, r.text);
}

async function fetchSitemapUrls(origin, timeoutMs, robots, userAgent) {
  const sitemapUrl = origin.replace(/\/$/, "") + "/sitemap.xml";
  const r = await fetchText(sitemapUrl, timeoutMs, robots, userAgent);
  if (!r.ok || !r.text) return [];
  const $ = cheerio.load(r.text, { xmlMode: true });
  const locs = $("loc").map((_, el) => $(el).text().trim()).get();
  return locs.filter(Boolean);
}

async function quickStatus(url, timeoutMs, robots, userAgent) {
  const head = await fetchWithRedirects(url, {
    method: "HEAD",
    timeoutMs,
    robots,
    userAgent,
    accept: "*/*"
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
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
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

async function fetchWithRedirects(url, { method = "GET", timeoutMs, robots, userAgent, accept }) {
  const redirectChain = [url];
  const redirectSteps = [];
  const seen = new Set([url]);
  let current = url;

  for (let i = 0; i < 10; i++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (robots && !robots.isAllowed(current, userAgent)) {
        return {
          ok: false,
          status: 0,
          blockedByRobots: true,
          text: "",
          finalUrl: current,
          redirectChain,
          redirectSteps,
          contentType: "",
          loopDetected: false,
          maxRedirectsExceeded: false
        };
      }

      const res = await fetch(current, {
        method,
        signal: controller.signal,
        redirect: "manual",
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
            text: "",
            finalUrl: nextUrl,
            redirectChain,
            redirectSteps,
            contentType: "",
            loopDetected: true,
            maxRedirectsExceeded: false
          };
        }
        seen.add(nextUrl);
        current = nextUrl;
        continue;
      }

      const contentType = res.headers.get("content-type") || "";
      const text = method === "HEAD" ? "" : await res.text();
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
        text,
        finalUrl: current,
        redirectChain,
        redirectSteps,
        contentType,
        loopDetected: false,
        maxRedirectsExceeded: false
      };
    } catch {
      return {
        ok: false,
        status: 0,
        blockedByRobots: false,
        text: "",
        finalUrl: current,
        redirectChain,
        redirectSteps,
        contentType: "",
        loopDetected: false,
        maxRedirectsExceeded: false
      };
    } finally {
      clearTimeout(t);
    }
  }

  return {
    ok: false,
    status: 310,
    blockedByRobots: false,
    text: "",
    finalUrl: current,
    redirectChain,
    redirectSteps,
    contentType: "",
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

app.get("/api/config", (req, res) => {
  return res.json({ pinRequired: false });
});

app.post("/api/auth", (req, res) => {
  return res.json({ ok: true, pinRequired: false });
});

app.post("/api/crawl", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const options = { ...DEFAULTS, ...(req.body?.options || {}) };
  delete options.languagePrefixes;
  options.pathLimits = sanitizePathLimits(options.pathLimits);
  const excludePathMatchers = buildExcludeMatchers(options.excludePaths);
  const userAgent = "SiteCrawler/1.0";

  let root;
  try {
    root = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  const origin = root.origin;
  const rootHost = root.host;
  const start = normalizeUrl(url, null, options);
  if (!start) return res.status(400).json({ error: "Invalid URL" });

  const startLanguagePrefix = inferStartLanguagePrefix(start);
  let startPathScope = "/";
  try {
    const u = new URL(start);
    startPathScope = String(u.pathname || "/").replace(/\/+$/g, "") || "/";
  } catch {
    startPathScope = "/";
  }
  const startScope = !startPathScope || startPathScope === "/" ? "/" : (startPathScope.endsWith("/") ? startPathScope.slice(0, -1) : startPathScope);

  const robots = await fetchRobots(origin, options.timeoutMs, userAgent);

  const toVisitQueue = [];
  const toVisitSet = new Set();
  const visited = new Set();
  const blockedByPathLimit = new Set();
  const discovered = new Set();
  const navigationEntries = [];

  const pathLimitCounters = new Map();
  const pathLimitSkipped = {};

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

  const sitemapUrls = await fetchSitemapUrls(origin, options.timeoutMs, robots, userAgent);
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

  const records = new Map();

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

    const r = await fetchText(currentUrl, options.timeoutMs, robots, userAgent);

    const existing = records.get(currentUrl) || {
      url: currentUrl,
      finalUrl: currentUrl,
      status: null,
      blockedByRobots: false,
      redirectChain: [currentUrl],
      redirectSteps: [],
      metaRobots: ""
    };
    existing.finalUrl = r.finalUrl || currentUrl;
    existing.blockedByRobots = !!r.blockedByRobots;
    existing.status = r.status;
    existing.redirectChain = r.redirectChain || [currentUrl];
    existing.redirectSteps = r.redirectSteps || [];
    existing.metaRobots = r.text ? getMetaRobots(r.text) : "";
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

  const urls = Array.from(discovered).sort();

  if (options.brokenLinkCheck) {
    const missingStatus = urls.filter((u) => {
      const existing = records.get(u);
      return existing?.status === null || existing?.status === undefined;
    });

    if (missingStatus.length) {
      await concurrencyMap(missingStatus, Math.min(options.concurrency, 6), async (u) => {
        const s = await quickStatus(u, options.timeoutMs, robots, userAgent);
        const existing = records.get(u) || {
          url: u,
          finalUrl: u,
          status: null,
          blockedByRobots: false,
          redirectChain: [u],
          redirectSteps: [],
          metaRobots: ""
        };
        existing.status = s.status;
        existing.finalUrl = s.finalUrl || existing.finalUrl || u;
        existing.blockedByRobots = !!s.blockedByRobots;
        existing.redirectChain = s.redirectChain || existing.redirectChain || [u];
        existing.redirectSteps = s.redirectSteps || existing.redirectSteps || [];
        records.set(u, existing);
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
        metaRobots: ""
      };
      return {
        ...record,
        classification: classifyRecord(record)
      };
    })
    .sort((a, b) => a.url.localeCompare(b.url));

  const auditedNavigationEntries = await concurrencyMap(
    navigationEntries,
    Math.min(options.concurrency, 8),
    async (entry) => {
      const result = await quickStatus(entry.originalUrl, options.timeoutMs, robots, userAgent);
      const record = {
        url: entry.originalUrl,
        finalUrl: result.finalUrl || entry.originalUrl,
        status: result.status,
        blockedByRobots: !!result.blockedByRobots,
        redirectChain: result.redirectChain || [entry.originalUrl],
        redirectSteps: result.redirectSteps || [],
        metaRobots: ""
      };
      const redirectAuditEntry = buildRedirectAuditEntry(entry, result);
      return {
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
        classification: classifyRecord(record)
      };
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

    await concurrencyMap(parameterJobs, Math.min(options.concurrency, 8), async (job) => {
      const res = await quickStatus(job.variantUrl, options.timeoutMs, robots, userAgent);
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

  return res.json({
    startUrl: start,
    origin,
    counts: {
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
    redirectAudit: {
      summary: redirectAuditSummary,
      entries: redirectAuditEntries
    },
    parameterAudit
  });
});

app.use(express.static(path.join(__dirname, "../frontend/dist")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/dist/index.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
