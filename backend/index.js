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

async function probeApiCandidates(pageUrl, candidates, timeoutMs, robots, userAgent, sameHostOnly, rootHost) {
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
    const res = await quickStatus(job.resolvedUrl, timeoutMs, robots, userAgent);
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

async function analyzeSoftFailurePage(pageUrl, html, timeoutMs, robots, userAgent, sameHostOnly, rootHost) {
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
    ? await probeApiCandidates(pageUrl, apiCandidates, timeoutMs, robots, userAgent, sameHostOnly, rootHost)
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
  options.patternMatchFilter = String(options.patternMatchFilter || "").trim();
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
    existing.metaRobots = r.text ? getMetaRobots(r.text) : "";

    if (r.status === 200 && r.text) {
      const softFailure = await analyzeSoftFailurePage(
        existing.finalUrl || currentUrl,
        r.text,
        options.timeoutMs,
        robots,
        userAgent,
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
      const matchedRecord = records.get(entry.originalUrl) || recordsByFinalUrl.get(record.finalUrl);
      record.softFailureReasons = matchedRecord?.softFailureReasons || [];
      record.missingExpectedComponents = matchedRecord?.missingExpectedComponents || [];
      record.errorTextMatches = matchedRecord?.errorTextMatches || [];
      record.apiChecks = matchedRecord?.apiChecks || [];
      record.apiFailures = matchedRecord?.apiFailures || [];
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
        softFailureReasons: record.softFailureReasons,
        missingExpectedComponents: record.missingExpectedComponents,
        errorTextMatches: record.errorTextMatches,
        apiFailures: record.apiFailures,
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

  const issueReport = buildIssueReport(
    auditEntries,
    redirectAuditEntries,
    parameterAudit.entries,
    softFailureEntries,
    impactAudit
  );

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
