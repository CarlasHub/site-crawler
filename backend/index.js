import express from "express";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "1mb" }));

const RUNNER_PIN = String(process.env.RUNNER_PIN || "").trim();

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
  brokenLinkCheck: false
};

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

function isExcludedByPath(urlString, excludedPaths = []) {
  if (!excludedPaths || excludedPaths.length === 0) return false;

  const pathname = new URL(urlString).pathname.toLowerCase();

  return excludedPaths.some((p) => {
    const clean = String(p || "").trim().toLowerCase();
    if (!clean) return false;
    if (!clean.startsWith("/")) return false;

    if (clean === "/") return true;

    const withoutLeading = clean.replace(/^\/+/, "");
    const hasSubpath = withoutLeading.includes("/");

    if (hasSubpath) {
      const normalized = clean.endsWith("/") ? clean.slice(0, -1) : clean;
      return pathname === normalized || pathname.startsWith(normalized + "/");
    }

    const segment = withoutLeading.replace(/\/+$/g, "");
    if (!segment) return false;

    const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reSegment = new RegExp(`(^|\\/)${escaped}(\\/|$)`);
    return reSegment.test(pathname);
  });
}




function isJobDetailPage(urlString) {
  const u = new URL(urlString);
  const pathName = u.pathname.toLowerCase();

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
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (robots && !robots.isAllowed(url, userAgent)) {
      return { ok: false, status: 0, blockedByRobots: true, text: "", finalUrl: url };
    }

    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    const finalUrl = res.url || url;
    const contentType = res.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    if (!res.ok) {
      return { ok: false, status: res.status, blockedByRobots: false, text: "", finalUrl };
    }
    if (!isHtml) {
      return { ok: false, status: res.status, blockedByRobots: false, text: "", finalUrl };
    }

    const text = await res.text();
    return { ok: true, status: res.status, blockedByRobots: false, text, finalUrl };
  } catch {
    return { ok: false, status: 0, blockedByRobots: false, text: "", finalUrl: url };
  } finally {
    clearTimeout(t);
  }
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
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (robots && !robots.isAllowed(url, userAgent)) {
      return { status: 0, finalUrl: url, blockedByRobots: true };
    }

    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": userAgent, "Accept": "*/*" }
    });

    return { status: res.status, finalUrl: res.url || url, blockedByRobots: false };
  } catch {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": userAgent, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
      });
      return { status: res.status, finalUrl: res.url || url, blockedByRobots: false };
    } catch {
      return { status: 0, finalUrl: url, blockedByRobots: false };
    }
  } finally {
    clearTimeout(t);
  }
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
  return res.json({ pinRequired: !!RUNNER_PIN });
});

app.post("/api/auth", (req, res) => {
  if (!RUNNER_PIN) return res.json({ ok: true, pinRequired: false });
  const pin = String(req.body?.pin || "").trim();
  if (pin && pin === RUNNER_PIN) {
    return res.json({ ok: true, pinRequired: true });
  }
  return res.status(401).json({ ok: false, pinRequired: true, error: "Invalid pin" });
});

app.post("/api/crawl", async (req, res) => {
  if (RUNNER_PIN) {
    const provided = String(req.get("x-runner-pin") || "").trim();
    if (!provided || provided !== RUNNER_PIN) {
      return res.status(401).json({ error: "Runner is locked. Enter a valid pin to run the crawl." });
    }
  }

  const url = String(req.body?.url || "").trim();
  const options = { ...DEFAULTS, ...(req.body?.options || {}) };
  delete options.languagePrefixes;
  options.pathLimits = sanitizePathLimits(options.pathLimits);
  const userAgent = "SiteCrawler/1.0";

  let root;
  try {
    root = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  const origin = root.origin;
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

  function isWithinStartScope(urlString) {
    if (!options.scopeToStartPath) return true;
    if (!startPathScope || startPathScope === "/") return true;
    try {
      const u = new URL(urlString);
      const pathname = String(u.pathname || "/");
      const scope = startPathScope.endsWith("/") ? startPathScope.slice(0, -1) : startPathScope;
      if (scope === "/") return true;
      return pathname === scope || pathname.startsWith(scope + "/");
    } catch {
      return false;
    }
  }

  const robots = await fetchRobots(origin, options.timeoutMs, userAgent);

  const toVisit = new Set();
  const visited = new Set();
  const blockedByPathLimit = new Set();
  const discovered = new Set();

  const pathLimitCounters = new Map();
  const pathLimitSkipped = {};

  const sitemapUrls = await fetchSitemapUrls(origin, options.timeoutMs, robots, userAgent);
  if (sitemapUrls.length) {
    sitemapUrls.forEach((u) => {
      const n = normalizeUrl(u, null, options);
      if (!n) return;

      if (options.scopeToStartPath && startPathScope !== "/") {
        try {
          const p = new URL(n).pathname;
          if (p !== startPathScope && !p.startsWith(startPathScope + "/")) return;
        } catch {
          return;
        }
      }

      toVisit.add(n);
    });
  } else {
    toVisit.add(start);
  }

  const records = new Map();

  async function processOne(currentUrl) {
    if (visited.has(currentUrl) || blockedByPathLimit.has(currentUrl)) return;

    if (options.scopeToStartPath && startPathScope !== "/") {
      try {
        const p = new URL(currentUrl).pathname;
        if (p !== startPathScope && !p.startsWith(startPathScope + "/")) return;
      } catch {
        return;
      }
    }

    if (options.pathLimits && options.pathLimits.length) {
      let normalizedPath = "/";
      try {
        const u = new URL(currentUrl);
        normalizedPath = normalizePathForRules(u.pathname).toLowerCase();
      } catch {
        normalizedPath = "/";
      }

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
      const u = new URL(currentUrl);
      if (u.host !== root.host) return;
    }

    if (hasExcludedExtension(currentUrl, options)) return;
    if (isExcludedByPath(currentUrl, options.excludePaths)) return;
    if (options.ignoreJobPages && isJobDetailPage(currentUrl)) return;

    const r = await fetchText(currentUrl, options.timeoutMs, robots, userAgent);

    const existing = records.get(currentUrl) || { url: currentUrl, finalUrl: currentUrl, status: null, blockedByRobots: false };
    existing.finalUrl = r.finalUrl || currentUrl;
    existing.blockedByRobots = !!r.blockedByRobots;
    existing.status = options.brokenLinkCheck ? r.status : null;
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

      if (options.scopeToStartPath && startPathScope !== "/") {
        try {
          const p = new URL(next).pathname;
          if (p !== startPathScope && !p.startsWith(startPathScope + "/")) return;
        } catch {
          return;
        }
      }

      if (options.sameHostOnly) {
        try {
          const u = new URL(next);
          if (u.host !== root.host) return;
        } catch {
          return;
        }
      }

      if (hasExcludedExtension(next, options)) return;
      if (isExcludedByPath(next, options.excludePaths)) return;
      if (options.ignoreJobPages && isJobDetailPage(next)) return;
      if (!isWithinStartScope(next)) return;

      links.push(next);
    });

    for (const next of links) {
      if (visited.size + toVisit.size >= options.maxPages) break;
      if (!visited.has(next) && !blockedByPathLimit.has(next)) toVisit.add(next);
    }
  }

  while (toVisit.size > 0 && visited.size < options.maxPages) {
    const batch = Array.from(toVisit).slice(0, options.concurrency * 2);
    batch.forEach((u) => toVisit.delete(u));
    await concurrencyMap(batch, options.concurrency, processOne);
  }

  const urls = Array.from(discovered).sort();

  if (options.brokenLinkCheck) {
    await concurrencyMap(urls, Math.min(options.concurrency, 6), async (u) => {
      const s = await quickStatus(u, options.timeoutMs, robots, userAgent);
      const existing = records.get(u) || { url: u, finalUrl: u, status: null, blockedByRobots: false };
      existing.status = s.status;
      existing.finalUrl = s.finalUrl || existing.finalUrl || u;
      existing.blockedByRobots = !!s.blockedByRobots;
      records.set(u, existing);
      return true;
    });
  }

  const out = urls.map((u) => records.get(u) || { url: u, finalUrl: u, status: null, blockedByRobots: false });

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
    urls: out
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