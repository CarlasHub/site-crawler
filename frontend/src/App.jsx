import { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "siteCrawlerPresets.v1";
const LAST_USED_KEY = "siteCrawlerLastUsed.v1";

function makeId() {
  if (typeof crypto !== "undefined" && crypto?.getRandomValues) {
    const arr = new Uint32Array(2);
    crypto.getRandomValues(arr);
    return `${arr[0].toString(16)}${arr[1].toString(16)}`;
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function withRuleIds(list) {
  const rows = Array.isArray(list) ? list : [];
  return rows.map((r) => {
    const id = String(r?.id || "").trim();
    return {
      id: id || makeId(),
      path: String(r?.path || ""),
      maxPages: Number(r?.maxPages || 0)
    };
  });
}

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function isLangVariant(url) {
  try {
    const u = new URL(url);
    const lang = u.searchParams.get("lang") || u.searchParams.get("language") || u.searchParams.get("locale");
    if (lang) return true;
    const parts = u.pathname.split("/").filter(Boolean);
    const first = parts[0] || "";
    return /^[a-z]{2}(-[a-z]{2})?$/i.test(first);
  } catch {
    return false;
  }
}

function baseWithoutQuery(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getEntryOriginalUrl(row) {
  return String(row?.originalUrl || row?.url || "");
}

function getEntryFinalUrl(row) {
  return String(row?.finalResolvedUrl || row?.finalUrl || "");
}

function formatRedirectSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return list
    .map((step) => {
      const status = step?.status ? `[${step.status}]` : "[?]";
      const source = String(step?.url || "").trim();
      const next = String(step?.nextUrl || "").trim();
      return next ? `${status} ${source} -> ${next}` : `${status} ${source}`;
    })
    .filter(Boolean)
    .join(" | ");
}

function formatSoftFailureReasons(row) {
  return (Array.isArray(row?.softFailureReasons) ? row.softFailureReasons : []).join("; ");
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped, "i");
}

export default function App() {
  const [url, setUrl] = useState("");
  const [excludePaths, setExcludePaths] = useState("/jobs\n/careers\n/apply\n/login\n/admin");
  const [pathLimits, setPathLimits] = useState([
    { id: makeId(), path: "/job", maxPages: 5 }
  ]);
  const [maxPages, setMaxPages] = useState(300);
  const [concurrency, setConcurrency] = useState(6);
  const [includeQuery, setIncludeQuery] = useState(true);
  const [ignoreJobPages, setIgnoreJobPages] = useState(true);
  const [brokenLinkCheck, setBrokenLinkCheck] = useState(false);
  const [parameterAudit, setParameterAudit] = useState(false);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [notices, setNotices] = useState([]);
  const [data, setData] = useState(null);

  const [presets, setPresets] = useState([]);
  const [presetName, setPresetName] = useState("default");
  const fileInputRef = useRef(null);
  const [isBookmarklet, setIsBookmarklet] = useState(false);
  const [urlMatchPattern, setUrlMatchPattern] = useState("");

  useEffect(() => {
    const stored = safeJsonParse(localStorage.getItem(STORAGE_KEY), []);
    setPresets(Array.isArray(stored) ? stored : []);

    const last = safeJsonParse(localStorage.getItem(LAST_USED_KEY), null);
    if (last) {
      setUrl(last.url || "");
      setExcludePaths(last.excludePaths || "/jobs\n/careers\n/apply\n/login\n/admin");
      setPathLimits(withRuleIds(Array.isArray(last.pathLimits) ? last.pathLimits : [{ path: "/job", maxPages: 5 }]));
      setMaxPages(Number(last.maxPages || 300));
      setConcurrency(Number(last.concurrency || 6));
      setIncludeQuery(!!last.includeQuery);
      setIgnoreJobPages(last.ignoreJobPages !== false);
      setBrokenLinkCheck(!!last.brokenLinkCheck);
      setParameterAudit(!!last.parameterAudit);
      setPresetName(last.presetName || "default");
      setUrlMatchPattern(last.urlMatchPattern || "");
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search || "");
    const mode = String(params.get("mode") || "").toLowerCase();
    const flag = String(params.get("bookmarklet") || "").toLowerCase();
    const targetUrl = params.get("url");

    const inBookmarklet = mode === "bookmarklet" || flag === "1" || flag === "true";
    if (inBookmarklet) {
      setIsBookmarklet(true);
    }

    if (targetUrl) {
      setUrl(targetUrl);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      LAST_USED_KEY,
      JSON.stringify({
        url,
        excludePaths,
        pathLimits,
        maxPages,
        concurrency,
        includeQuery,
        ignoreJobPages,
        brokenLinkCheck,
        parameterAudit,
        presetName,
        urlMatchPattern
      })
    );
  }, [url, excludePaths, pathLimits, maxPages, concurrency, includeQuery, ignoreJobPages, brokenLinkCheck, parameterAudit, presetName, urlMatchPattern]);

  useEffect(() => {
    if (!loading) {
      setProgress(100);
      return;
    }

    setProgress(6);
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const cap = 92;
      const next = Math.min(cap, 6 + Math.floor(elapsed / 220));
      setProgress((p) => (p < next ? next : p));
    }, 200);

    return () => clearInterval(tick);
  }, [loading]);

  const excludePathList = useMemo(() => {
    return excludePaths
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x.startsWith("/"));
  }, [excludePaths]);

  const pageUrls = data?.urls || [];
  const auditEntries = data?.audit?.entries || pageUrls;
  const auditSummary = data?.audit?.summary || null;
  const issueReport = data?.issueReport || null;
  const impactAuditEntries = data?.impactAudit?.entries || [];
  const impactAuditSummary = data?.impactAudit?.summary || null;
  const redirectAuditEntries = data?.redirectAudit?.entries || [];
  const redirectAuditSummary = data?.redirectAudit?.summary || null;
  const softFailureEntries = data?.softFailureAudit?.entries || [];
  const softFailureSummary = data?.softFailureAudit?.summary || null;
  const patternAudit = data?.patternAudit || null;
  const patternAuditSummary = data?.patternAudit?.summary || null;
  const parameterAuditEntries = data?.parameterAudit?.entries || [];
  const parameterAuditSummary = data?.parameterAudit?.summary || null;

  const matchedUrls = useMemo(() => {
    const pattern = urlMatchPattern.trim();
    if (!pattern) return auditEntries;

    const lowerPattern = pattern.toLowerCase();
    const matcher = pattern.includes("*") ? wildcardToRegExp(pattern) : null;

    return auditEntries.filter((row) => {
      const original = getEntryOriginalUrl(row);
      const finalUrl = getEntryFinalUrl(row);
      if (matcher) {
        return matcher.test(original) || matcher.test(finalUrl);
      }
      return original.toLowerCase().includes(lowerPattern) || finalUrl.toLowerCase().includes(lowerPattern);
    });
  }, [auditEntries, urlMatchPattern]);

  const duplicateCandidates = useMemo(() => {
    const byBase = new Map();
    for (const row of pageUrls) {
      const original = getEntryOriginalUrl(row);
      const base = baseWithoutQuery(original);
      const entry = byBase.get(base) || { base, variants: [], hasQueryVariants: false, hasLangVariants: false };
      entry.variants.push(row);
      if (original.includes("?")) entry.hasQueryVariants = true;
      if (isLangVariant(original)) entry.hasLangVariants = true;
      byBase.set(base, entry);
    }
    const groups = Array.from(byBase.values()).filter((g) => g.variants.length > 1 || g.hasQueryVariants || g.hasLangVariants);
    groups.sort((a, b) => b.variants.length - a.variants.length);
    return groups;
  }, [pageUrls]);

  const sanitizedPathLimits = useMemo(() => {
    const cleaned = Array.isArray(pathLimits) ? pathLimits : [];
    return cleaned
      .map((r) => {
        const p = String(r?.path || "").trim();
        const max = clamp(Number(r?.maxPages || 0), 1, 5000);
        return { path: p.startsWith("/") ? p : p ? `/${p}` : "", maxPages: max };
      })
      .filter((r) => r.path && r.path.startsWith("/") && r.path !== "/");
  }, [pathLimits]);

  function pushNotice(type, message) {
    const cleanType = ["error", "warning", "success", "info"].includes(type) ? type : "info";
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) return;
    setNotices((prev) => [{ id: makeId(), type: cleanType, message: cleanMessage }, ...prev].slice(0, 4));
  }

  function savePreset() {
    const cleanName = presetName.trim();
    if (!cleanName) {
      setError("Preset name is required.");
      return;
    }

    const nextPreset = {
      name: cleanName,
      settings: {
        excludePaths,
        pathLimits,
        maxPages,
        concurrency,
        includeQuery,
        ignoreJobPages,
        brokenLinkCheck,
        parameterAudit,
        urlMatchPattern
      }
    };

    const existingIndex = presets.findIndex((p) => p.name === cleanName);
    let updated = [];
    if (existingIndex >= 0) {
      updated = [...presets];
      updated[existingIndex] = nextPreset;
    } else {
      updated = [...presets, nextPreset];
    }

    setPresets(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setError("");
  }

  function loadPreset(name) {
    const p = presets.find((x) => x.name === name);
    if (!p) return;

    setPresetName(p.name);
    setExcludePaths(p.settings.excludePaths || "");
    setPathLimits(withRuleIds(Array.isArray(p.settings.pathLimits) ? p.settings.pathLimits : [{ path: "/job", maxPages: 5 }]));
    setMaxPages(Number(p.settings.maxPages || 300));
    setConcurrency(Number(p.settings.concurrency || 6));
    setIncludeQuery(!!p.settings.includeQuery);
    setIgnoreJobPages(p.settings.ignoreJobPages !== false);
    setBrokenLinkCheck(!!p.settings.brokenLinkCheck);
    setParameterAudit(!!p.settings.parameterAudit);
    setUrlMatchPattern(p.settings.urlMatchPattern || "");
    setError("");
  }

  function deletePreset(name) {
    const updated = presets.filter((p) => p.name !== name);
    setPresets(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }

  function exportPresets() {
    downloadText("crawler-presets.json", JSON.stringify(presets, null, 2));
  }

  function importPresetsFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const imported = safeJsonParse(reader.result, null);
      if (!Array.isArray(imported)) {
        setError("Invalid presets file.");
        return;
      }
      setPresets(imported);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
      setError("");
    };
    reader.readAsText(file);
  }

  async function runCrawl() {
    setError("");
    setData(null);
    setNotices([]);

    const trimmed = url.trim();
    if (!trimmed) {
      setError("Homepage URL is required.");
      pushNotice("error", "Homepage URL is required.");
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setError("URL must start with http:// or https://");
      pushNotice("error", "URL must start with http:// or https://");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: trimmed,
          options: {
            excludePaths: excludePathList,
            pathLimits: sanitizedPathLimits,
            maxPages: clamp(Number(maxPages || 300), 10, 5000),
            concurrency: clamp(Number(concurrency || 6), 1, 20),
            includeQuery,
            ignoreJobPages,
            brokenLinkCheck,
            parameterAudit,
            patternMatchFilter: urlMatchPattern.trim()
          }
        })
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || "Request failed");
        pushNotice("error", json?.error || "Request failed");
        setLoading(false);
        return;
      }

      setData(json);
      pushNotice("success", "Crawl completed.");
      setLoading(false);
    } catch {
      setError("Network error");
      pushNotice("error", "Network error");
      setLoading(false);
    }
  }

  function downloadUrls() {
    if (!matchedUrls.length) return;
    const lines = matchedUrls.map((r) => {
      const original = getEntryOriginalUrl(r);
      const finalUrl = getEntryFinalUrl(r);
      const source = r?.sourceType ? `${r.sourceType}: ${r.sourceValue || ""}` : "page";
      const referrer = r?.referrerPage ? ` | referrer: ${r.referrerPage}` : "";
      const redirect = finalUrl && finalUrl !== original ? ` -> ${finalUrl}` : "";
      const status = r?.statusCode ?? r?.status;
      const statusPart = status === null || status === undefined ? "" : ` [${status}]`;
      const classification = r?.classification ? ` {${r.classification}}` : "";
      const redirectFlags = [
        r?.loopDetected ? "loop" : "",
        r?.multipleHops ? "multi-hop" : "",
        r?.paramsLost ? "params lost" : "",
        r?.irrelevantDestination ? "irrelevant destination" : ""
      ].filter(Boolean);
      const redirectPart = redirectFlags.length ? ` | redirects: ${redirectFlags.join(", ")}` : "";
      const softFailurePart = formatSoftFailureReasons(r) ? ` | soft failure: ${formatSoftFailureReasons(r)}` : "";
      return `${source}${referrer} | ${original}${redirect}${statusPart}${classification}${redirectPart}${softFailurePart}`;
    });
    downloadText("crawl-urls.txt", lines.join("\n"));
  }

  function downloadCsv() {
    if (!matchedUrls.length) return;
    const header = [
      "originalUrl",
      "referrerPage",
      "sourceType",
      "sourceValue",
      "finalResolvedUrl",
      "statusCode",
      "classification",
      "blockedByRobots",
      "redirectChain",
      "redirectSteps",
      "redirectStatuses",
      "redirectStepCount",
      "loopDetected",
      "multipleHops",
      "paramsLost",
      "irrelevantDestination",
      "softFailureReasons",
      "apiFailureCount",
      "apiFailures"
    ].join(",");
    const rows = matchedUrls.map((r) => {
      const values = [
        JSON.stringify(getEntryOriginalUrl(r)),
        JSON.stringify(r.referrerPage || ""),
        JSON.stringify(r.sourceType || ""),
        JSON.stringify(r.sourceValue || ""),
        JSON.stringify(getEntryFinalUrl(r)),
        JSON.stringify((r.statusCode ?? r.status) === null || (r.statusCode ?? r.status) === undefined ? "" : String(r.statusCode ?? r.status)),
        JSON.stringify(r.classification || ""),
        JSON.stringify(r.blockedByRobots ? "true" : "false"),
        JSON.stringify(Array.isArray(r.redirectChain) ? r.redirectChain.join(" -> ") : ""),
        JSON.stringify(formatRedirectSteps(r.redirectSteps)),
        JSON.stringify(Array.isArray(r.redirectStatuses) ? r.redirectStatuses.join(" -> ") : ""),
        JSON.stringify(r.redirectStepCount === null || r.redirectStepCount === undefined ? "" : String(r.redirectStepCount)),
        JSON.stringify(r.loopDetected ? "true" : "false"),
        JSON.stringify(r.multipleHops ? "true" : "false"),
        JSON.stringify(r.paramsLost ? "true" : "false"),
        JSON.stringify(r.irrelevantDestination ? "true" : "false"),
        JSON.stringify(formatSoftFailureReasons(r)),
        JSON.stringify(Array.isArray(r.apiFailures) ? String(r.apiFailures.length) : "0"),
        JSON.stringify(Array.isArray(r.apiFailures) ? r.apiFailures.map((entry) => `${entry.resolvedUrl} [${entry.statusCode ?? "n/a"}]`).join(" | ") : "")
      ];
      return values.join(",");
    });
    downloadText("crawl-urls.csv", [header, ...rows].join("\n"));
  }

  const summary = useMemo(() => {
    if (!data) return null;
    const total = pageUrls.length;
    const redirects = pageUrls.filter((u) => getEntryFinalUrl(u) !== getEntryOriginalUrl(u)).length;
    const broken = pageUrls.filter((u) => {
      const s = Number(u.statusCode ?? u.status);
      if (!s) return false;
      return s >= 400;
    }).length;
    const skippedByPathLimit = Object.values(data.counts?.skippedByPathLimit || {}).reduce((acc, n) => acc + Number(n || 0), 0);
    return {
      total,
      redirects,
      broken,
      skippedByPathLimit,
      fromSitemap: !!data.counts?.fromSitemap,
      visited: data.counts?.visited || 0
    };
  }, [data, pageUrls]);

  const brandName = isBookmarklet ? "Cat Crawler" : "Carla’s tools";
  const brandTag = isBookmarklet
    ? "Cat Crawler - Site Crawler for the page you are on."
    : "Site Crawler - Discover internal URLs with exclusions, redirects, duplicates and presets.";

  return (
    <div className={`shell${isBookmarklet ? " shell--bookmarklet" : ""}`}>
      <a className="skip" href="#main">Skip to content</a>

      <header className="header">
        <div className="headerInner">
          <div className="brand">
            <div className="brandMark" aria-hidden="true" />
            <div className="brandText">
              <div className="brandName">{brandName}</div>
              <div className="brandTag">{brandTag}</div>
            </div>
          </div>

          <nav className="nav" aria-label="Primary">
            <a className="navPill" href="#howto">How to use</a>
            <a className="navPill" href="#runner">Runner</a>
            <a className="navPill" href="#presets">Presets</a>
            <a className="navPill" href="#results">Results</a>
          </nav>

          <div className="headerActions" aria-label="Session">
            <span className="statusChip" aria-live="polite">
              {loading ? "Crawling" : "Ready"}
            </span>
          </div>
        </div>
      </header>

      <main id="main" className="main">
        <section className="hero" aria-label="Overview">
          <div className="heroGrid">
            <div className="heroCopy">
              <h1 className="heroTitle">Crawl a site fast</h1>
              <p className="heroSub">
                Sitemap first when available. robots.txt respected. Ignored pages by default. Optional quick status check for broken links.
              </p>
              <div className="heroBadges" aria-label="Highlights">
                <span className="badge">Sitemap</span>
                <span className="badge">robots</span>
                <span className="badge">Redirects</span>
                <span className="badge">Duplicates</span>
                <span className="badge">Presets</span>
              </div>
            </div>

            <div className={`heroOrb${loading ? " isRunning" : ""}`} aria-label="Crawl progress">
              <div
                className="ring"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                aria-live="polite"
                style={{ "--p": `${progress}%` }}
              >
                <span className="srOnly">{loading ? "Crawling in progress" : "Crawl complete"}</span>
              </div>

              <div className="orb" aria-hidden="true">
                <div className="orbInner" />
              </div>
              <div className="orbGlow" aria-hidden="true" />
            </div>
          </div>
        </section>

        <div className="content">
          {notices.length ? (
            <div className="noticeStack" role="status" aria-live="polite">
              {notices.map((n) => (
                <div key={n.id} className={`notice notice--${n.type}`}> {n.message} </div>
              ))}
            </div>
          ) : null}

          <section id="howto" className="panel" aria-labelledby="howtoTitle">
            <div className="panelHead">
              <h2 id="howtoTitle">How to use the crawler</h2>
              <div className="panelMeta">
                <span className="chip">5 steps</span>
                <span className="chip">Fast setup</span>
              </div>
            </div>

            <div className="panelBody">
              <div className="stepGrid" role="list">
                <div className="stepCard" role="listitem">
                  <div className="stepNum">1</div>
                  <div>
                    <h3>Enter a homepage URL</h3>
                    <p className="help">Use the root of the site you want to crawl (e.g. `https://example.com`).</p>
                  </div>
                </div>

                <div className="stepCard" role="listitem">
                  <div className="stepNum">2</div>
                  <div>
                    <h3>Add exclusions</h3>
                    <p className="help">One path per line (e.g. `/jobs`, `/careers`, `/admin`). Only lines starting with `/` are used.</p>
                  </div>
                </div>

                <div className="stepCard" role="listitem">
                  <div className="stepNum">3</div>
                  <div>
                    <h3>Set path limits</h3>
                    <p className="help">Cap noisy sections (e.g. `/job` max 5). Rules are language-agnostic, so `/job` also matches `/en/job`.</p>
                  </div>
                </div>

                <div className="stepCard" role="listitem">
                  <div className="stepNum">4</div>
                  <div>
                    <h3>Choose options</h3>
                    <p className="help">Max pages, concurrency, and toggles like “Ignore job pages” or “Broken link quick check.”</p>
                  </div>
                </div>

                <div className="stepCard" role="listitem">
                  <div className="stepNum">5</div>
                  <div>
                    <h3>Run and export</h3>
                    <p className="help">Click “Run crawl,” then download TXT or CSV from the Results section.</p>
                  </div>
                </div>
              </div>

              <div className="noteRow">
                <div className="noteCard">
                  <strong>Tip:</strong> Enable “Broken link quick check” to see HTTP status codes and spot 404s quickly.
                </div>
                <div className="noteCard">
                  <strong>Bookmarklet:</strong> Use `docs/bookmarklet.js` to run the crawler in-page on any site.
                </div>
              </div>
            </div>
          </section>

          <section id="runner" className="panel" aria-labelledby="runnerTitle">
            <div className="panelHead">
              <h2 id="runnerTitle">Runner</h2>
              <div className="panelMeta">
                {summary ? (
                  <>
                    <span className="chip">Visited {summary.visited}</span>
                    <span className="chip">Returned {summary.total}</span>
                    <span className="chip">Matched {matchedUrls.length}</span>
                    <span className="chip">Redirects {summary.redirects}</span>
                    <span className="chip">Broken {summary.broken}</span>
                    {summary.skippedByPathLimit ? <span className="chip">Capped {summary.skippedByPathLimit}</span> : null}
                  </>
                ) : (
                  <span className="chip">No results</span>
                )}
              </div>
            </div>

            <div className="formGrid">
              <div className="field">
                <label htmlFor="url">Homepage URL</label>
                <input
                  id="url"
                  type="url"
                  placeholder="https://example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  autoComplete="off"
                />
              </div>

              <div className="field">
                <label htmlFor="excludePaths">Exclude paths (one per line)</label>
                <textarea
                  id="excludePaths"
                  value={excludePaths}
                  onChange={(e) => setExcludePaths(e.target.value)}
                  rows={6}
                />
                <p className="help">Only lines starting with / are used. Single segment paths like /category match anywhere in the path, including /en/category. Single segment paths like /category match anywhere in the path, including /en/category. Single segment paths like /category match anywhere in the path, including /en/category.</p>
              </div>

              <div className="field">
                <div className="fieldHead">
                  <label>Crawl limits by path</label>
                  <button
                    type="button"
                    className="miniBtn"
                    onClick={() => setPathLimits((rows) => [...withRuleIds(rows), { id: makeId(), path: "/job", maxPages: 5 }])}
                  >
                    Add rule
                  </button>
                </div>

                <div className="pathLimitList" role="group" aria-label="Crawl limits by path">
                  {(Array.isArray(pathLimits) ? pathLimits : []).length === 0 ? (
                    <div className="emptyRow">No path limits. Add a rule to cap crawling for sections like /job.</div>
                  ) : (
                    (Array.isArray(pathLimits) ? pathLimits : []).map((r, i) => (
                      <div className="pathLimitRow" key={String(r?.id || i)}>
                        <div className="pathLimitPath">
                          <label className="srOnly" htmlFor={`limit-path-${i}`}>Path</label>
                          <input
                            id={`limit-path-${i}`}
                            type="text"
                            inputMode="text"
                            placeholder="/job"
                            value={pathLimits[i]?.path || ""}
                            onChange={(e) => {
                              const next = e.target.value;
                              setPathLimits((rows) => {
                                const copy = [...(Array.isArray(rows) ? rows : [])];
                                copy[i] = { ...(copy[i] || {}), path: next };
                                return copy;
                              });
                            }}
                          />
                        </div>

                        <div className="pathLimitMax">
                          <label className="srOnly" htmlFor={`limit-max-${i}`}>Max pages</label>
                          <input
                            id={`limit-max-${i}`}
                            type="number"
                            min={1}
                            max={5000}
                            value={Number(pathLimits[i]?.maxPages || 0) || 5}
                            onChange={(e) => {
                              const next = Number(e.target.value || 0);
                              setPathLimits((rows) => {
                                const copy = [...(Array.isArray(rows) ? rows : [])];
                                copy[i] = { ...(copy[i] || {}), maxPages: next };
                                return copy;
                              });
                            }}
                          />
                        </div>

                        <button
                          type="button"
                          className="miniBtn miniBtnDanger"
                          onClick={() => setPathLimits((rows) => (Array.isArray(rows) ? rows.filter((_, idx) => idx !== i) : []))}
                          aria-label={`Remove rule ${String(r?.path || "").trim() || ""}`}
                        >
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <p className="help">Caps how many pages are crawled for specific sections. Example: /job max 5 means only 5 pages under /job are crawled. Rules are language agnostic, so /job also matches /en/job, /fr/job, and similar.</p>
              </div>

              <div className="field">
                <label htmlFor="urlMatchPattern">URL match filter</label>
                <input
                  id="urlMatchPattern"
                  type="text"
                  placeholder="/jobs-zoeken*"
                  value={urlMatchPattern}
                  onChange={(e) => setUrlMatchPattern(e.target.value)}
                  autoComplete="off"
                />
                <p className="help">Optional. Filters results after crawling. Supports simple wildcard matching with `*`, for example `/jobs-zoeken*`.</p>
              </div>

              <div className="fieldRow">
                <div className="field">
                  <label htmlFor="maxPages">Max pages</label>
                  <input
                    id="maxPages"
                    type="number"
                    min={10}
                    max={5000}
                    value={maxPages}
                    onChange={(e) => setMaxPages(Number(e.target.value || 0))}
                  />
                </div>

                <div className="field">
                  <label htmlFor="concurrency">Concurrency</label>
                  <input
                    id="concurrency"
                    type="number"
                    min={1}
                    max={20}
                    value={concurrency}
                    onChange={(e) => setConcurrency(Number(e.target.value || 1))}
                  />
                </div>
              </div>

              <div className="checks" role="group" aria-label="Options">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={includeQuery}
                    onChange={(e) => setIncludeQuery(e.target.checked)}
                  />
                  <span>Include querystrings</span>
                </label>

                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={ignoreJobPages}
                    onChange={(e) => setIgnoreJobPages(e.target.checked)}
                  />
                  <span>Ignore job pages</span>
                </label>

                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={brokenLinkCheck}
                    onChange={(e) => setBrokenLinkCheck(e.target.checked)}
                  />
                  <span>Broken link quick check</span>
                </label>

                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={parameterAudit}
                    onChange={(e) => setParameterAudit(e.target.checked)}
                  />
                  <span>Parameter audit</span>
                </label>
              </div>

              <div className="actions">
                <button className="btnPrimary" type="button" onClick={runCrawl} disabled={loading}>
                  {loading ? "Crawling" : "Run crawl"}
                </button>
                <button className="btnGhost" type="button" onClick={downloadUrls} disabled={!matchedUrls.length}>
                  Download TXT
                </button>
                <button className="btnGhost" type="button" onClick={downloadCsv} disabled={!matchedUrls.length}>
                  Download CSV
                </button>
              </div>

              {error ? (
                <div className="alert" role="alert">
                  <strong>Error:</strong> {error}
                </div>
              ) : null}
            </div>
          </section>

          <section id="presets" className="panel" aria-labelledby="presetsTitle">
            <div className="panelHead">
              <h2 id="presetsTitle">Client presets</h2>
              <div className="panelMeta">
                <span className="chip">Saved {presets.length}</span>
              </div>
            </div>

            <div className="presetGrid">
              <div className="field">
                <label htmlFor="presetName">Preset name</label>
                <input
                  id="presetName"
                  type="text"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
              </div>

              <div className="actions">
                <button className="btnGhost" type="button" onClick={savePreset}>
                  Save preset
                </button>
                <button className="btnGhost" type="button" onClick={exportPresets} disabled={!presets.length}>
                  Export presets
                </button>
                <button className="btnGhost" type="button" onClick={() => fileInputRef.current?.click()}>
                  Import presets
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  className="file"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importPresetsFile(f);
                    e.target.value = "";
                  }}
                />
              </div>

              <div className="presetList" role="list">
                {presets.length ? (
                  presets
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((p) => (
                      <div key={p.name} className="presetRow" role="listitem">
                        <div className="presetInfo">
                          <div className="presetName">{p.name}</div>
                          <div className="presetMetaText">
                            maxPages {p.settings.maxPages} | concurrency {p.settings.concurrency} | ignore jobs {p.settings.ignoreJobPages !== false ? "yes" : "no"}
                          </div>
                        </div>
                        <div className="presetBtns">
                          <button className="btnGhost" type="button" onClick={() => loadPreset(p.name)}>
                            Load
                          </button>
                          <button className="btnDanger" type="button" onClick={() => deletePreset(p.name)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                ) : (
                  <p className="muted">No presets saved.</p>
                )}
              </div>
            </div>
          </section>

          <section id="results" className="panel" aria-labelledby="resultsTitle">
            <div className="panelHead">
              <h2 id="resultsTitle">Results</h2>
              <div className="panelMeta">
                <span className="chip">Sitemap {data?.counts?.fromSitemap ? "yes" : "no"}</span>
                <span className="chip">Status checked {brokenLinkCheck ? "yes" : "no"}</span>
                {auditSummary ? <span className="chip">Valid {auditSummary.valid}</span> : null}
                {auditSummary ? <span className="chip">Broken {auditSummary.broken}</span> : null}
                {auditSummary ? <span className="chip">Redirect issues {auditSummary.redirectIssues}</span> : null}
                {auditSummary ? <span className="chip">Soft failures {auditSummary.softFailures}</span> : null}
                {impactAuditSummary ? <span className="chip">High impact {impactAuditSummary.high}</span> : null}
                {impactAuditSummary ? <span className="chip">Medium impact {impactAuditSummary.medium}</span> : null}
                {redirectAuditSummary ? <span className="chip">Redirect loops {redirectAuditSummary.loops}</span> : null}
                {redirectAuditSummary ? <span className="chip">Multi-hop {redirectAuditSummary.multipleHops}</span> : null}
                {redirectAuditSummary ? <span className="chip">Params lost {redirectAuditSummary.paramsLost}</span> : null}
                {softFailureSummary ? <span className="chip">API failures {softFailureSummary.apiFailures}</span> : null}
                {patternAuditSummary ? <span className="chip">Pattern groups {patternAuditSummary.patternGroups}</span> : null}
                {patternAuditSummary ? <span className="chip">Naming issues {patternAuditSummary.inconsistentNaming}</span> : null}
              </div>
            </div>

            <div className="resultsGrid">
              <div className="field">
                <label htmlFor="urls">Audit report</label>
                <textarea
                  id="urls"
                  readOnly
                  value={matchedUrls.map((u) => {
                    const original = getEntryOriginalUrl(u);
                    const finalUrl = getEntryFinalUrl(u);
                    const status = u.statusCode ?? u.status;
                    const statusPart = status !== null && status !== undefined && status !== "" ? ` [${status}]` : "";
                    const redirectPart = finalUrl && finalUrl !== original ? ` -> ${finalUrl}` : "";
                    const sourcePart = u.sourceType ? `${u.sourceType}: ${u.sourceValue || ""}` : "page";
                    const referrerPart = u.referrerPage ? ` | referrer: ${u.referrerPage}` : "";
                    const classificationPart = u.classification ? ` | ${u.classification}` : "";
                    const redirectFlags = [
                      u.loopDetected ? "loop" : "",
                      u.multipleHops ? "multi-hop" : "",
                      u.paramsLost ? "params lost" : "",
                      u.irrelevantDestination ? "irrelevant destination" : ""
                    ].filter(Boolean);
                    const redirectFlagPart = redirectFlags.length ? ` | redirects: ${redirectFlags.join(", ")}` : "";
                    const softFailurePart = formatSoftFailureReasons(u) ? ` | soft failure: ${formatSoftFailureReasons(u)}` : "";
                    return `${sourcePart}${referrerPart} | ${original}${statusPart}${redirectPart}${classificationPart}${redirectFlagPart}${softFailurePart}`;
                  }).join("\n")}
                  rows={14}
                />
                <p className="help">
                  Showing {matchedUrls.length} of {auditEntries.length} audit entries from {pageUrls.length} crawled pages.
                </p>
              </div>

              {parameterAuditSummary ? (
                <details className="details" open={parameterAuditSummary.inconsistencies > 0}>
                  <summary>
                    Parameter audit
                    {` (${parameterAuditSummary.inconsistencies} inconsistencies)`}
                  </summary>
                  <div className="dupes">
                    <p className="help">
                      Checked {parameterAuditSummary.total} parameterized requests. HTTP errors {parameterAuditSummary.httpErrors}, params dropped {parameterAuditSummary.paramsDropped}, unexpected redirects {parameterAuditSummary.unexpectedRedirects}.
                    </p>
                    {parameterAuditEntries.length ? (
                      parameterAuditEntries
                        .filter((entry) => entry.hasIssue)
                        .slice(0, 80)
                        .map((entry) => (
                          <div key={`${entry.baseUrl}-${entry.variation}`} className="dupeGroup">
                            <div className="dupeHead">
                              <div className="dupeBase">{entry.baseUrl}</div>
                              <div className="dupeFlags">
                                <span className="flag">{entry.variation}</span>
                                <span className="flag">status {entry.statusCode ?? "n/a"}</span>
                                {!entry.paramsPreserved ? <span className="flag">params dropped</span> : null}
                                {entry.unexpectedRedirect ? <span className="flag">unexpected redirect</span> : null}
                              </div>
                            </div>
                            <ul className="dupeList">
                              <li>Parameterized URL: {entry.parameterizedUrl}</li>
                              <li>Final URL: {entry.finalUrl}</li>
                              <li>Redirect behaviour: {entry.redirectBehaviour}</li>
                              <li>Parameter preservation: {entry.paramsPreserved ? "preserved" : "not preserved"}</li>
                            </ul>
                          </div>
                        ))
                    ) : (
                      <p className="muted">No parameter audit issues detected.</p>
                    )}
                    {parameterAuditEntries.filter((entry) => entry.hasIssue).length > 80 ? (
                      <p className="muted">Showing first 80 parameter issues.</p>
                    ) : null}
                  </div>
                </details>
              ) : null}

              {issueReport ? (
                <details className="details" open={(issueReport.summary?.brokenUrls + issueReport.summary?.redirectIssues + issueReport.summary?.parameterHandlingIssues + issueReport.summary?.softFailures) > 0}>
                  <summary>Validation report</summary>
                  <div className="dupes">
                    <p className="help">
                      Broken URLs {issueReport.summary?.brokenUrls ?? 0}, redirect issues {issueReport.summary?.redirectIssues ?? 0}, parameter handling issues {issueReport.summary?.parameterHandlingIssues ?? 0}, soft failures {issueReport.summary?.softFailures ?? 0}, impact issues {issueReport.summary?.impactIssues ?? 0}.
                    </p>

                    <p className="help"><strong>Broken URLs</strong></p>
                    {issueReport.brokenUrls?.length ? (
                      issueReport.brokenUrls.slice(0, 20).map((entry, index) => (
                        <div key={`broken-${entry.originalUrl}-${index}`} className="dupeGroup">
                          <div className="dupeHead">
                            <div className="dupeBase">{entry.originalUrl}</div>
                            <div className="dupeFlags">
                              <span className="flag">status {entry.statusCode ?? "n/a"}</span>
                            </div>
                          </div>
                          <ul className="dupeList">
                            <li>Referrer: {entry.referrerPage || "start"}</li>
                            <li>Final URL: {entry.finalResolvedUrl}</li>
                          </ul>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No broken URLs.</p>
                    )}

                    <p className="help"><strong>Redirect issues</strong></p>
                    {issueReport.redirectIssues?.length ? (
                      issueReport.redirectIssues.slice(0, 20).map((entry, index) => (
                        <div key={`redirect-${entry.originalUrl}-${index}`} className="dupeGroup">
                          <div className="dupeHead">
                            <div className="dupeBase">{entry.originalUrl}</div>
                            <div className="dupeFlags">
                              <span className="flag">hops {entry.redirectStepCount}</span>
                              {entry.loopDetected ? <span className="flag">loop</span> : null}
                              {entry.multipleHops ? <span className="flag">multi-hop</span> : null}
                              {entry.paramsLost ? <span className="flag">params lost</span> : null}
                            </div>
                          </div>
                          <ul className="dupeList">
                            <li>Referrer: {entry.referrerPage || "start"}</li>
                            <li>Final URL: {entry.finalResolvedUrl}</li>
                          </ul>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No redirect issues.</p>
                    )}

                    <p className="help"><strong>Parameter handling issues</strong></p>
                    {issueReport.parameterHandlingIssues?.length ? (
                      issueReport.parameterHandlingIssues.slice(0, 20).map((entry, index) => (
                        <div key={`param-${entry.parameterizedUrl}-${index}`} className="dupeGroup">
                          <div className="dupeHead">
                            <div className="dupeBase">{entry.parameterizedUrl}</div>
                            <div className="dupeFlags">
                              <span className="flag">status {entry.statusCode ?? "n/a"}</span>
                              {entry.paramsDropped ? <span className="flag">params dropped</span> : null}
                              {entry.unexpectedRedirect ? <span className="flag">unexpected redirect</span> : null}
                            </div>
                          </div>
                          <ul className="dupeList">
                            <li>Base URL: {entry.baseUrl}</li>
                            <li>Final URL: {entry.finalUrl}</li>
                          </ul>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No parameter handling issues.</p>
                    )}

                    <p className="help"><strong>Soft failures</strong></p>
                    {issueReport.softFailures?.length ? (
                      issueReport.softFailures.slice(0, 20).map((entry, index) => (
                        <div key={`soft-${entry.url}-${index}`} className="dupeGroup">
                          <div className="dupeHead">
                            <div className="dupeBase">{entry.url}</div>
                            <div className="dupeFlags">
                              <span className="flag">status {entry.statusCode ?? "n/a"}</span>
                            </div>
                          </div>
                          <ul className="dupeList">
                            <li>Final URL: {entry.finalUrl}</li>
                            <li>Reasons: {Array.isArray(entry.reasons) ? entry.reasons.join(", ") : "n/a"}</li>
                          </ul>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No soft failures.</p>
                    )}

                    <p className="help"><strong>Impact analysis</strong></p>
                    {issueReport.impactAnalysis?.length ? (
                      issueReport.impactAnalysis.slice(0, 20).map((entry) => (
                        <div key={`impact-${entry.issueType}-${entry.originalUrl}`} className="dupeGroup">
                          <div className="dupeHead">
                            <div className="dupeBase">{entry.originalUrl}</div>
                            <div className="dupeFlags">
                              <span className="flag">{entry.impactLevel}</span>
                              <span className="flag">{entry.issueType}</span>
                            </div>
                          </div>
                          <ul className="dupeList">
                            <li>Occurrences: {entry.occurrenceCount}</li>
                            <li>Referrers: {entry.referrerCount}</li>
                            <li>Reasons: {Array.isArray(entry.reasons) ? entry.reasons.join(", ") : "n/a"}</li>
                          </ul>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No impact issues.</p>
                    )}
                  </div>
                </details>
              ) : null}

              {impactAuditSummary ? (
                <details className="details" open={impactAuditSummary.high > 0}>
                  <summary>
                    Issue impact
                    {` (${impactAuditSummary.total} issues)`}
                  </summary>
                  <div className="dupes">
                    <p className="help">
                      Broken issues {impactAuditSummary.broken}, redirected issues {impactAuditSummary.redirected}. High impact {impactAuditSummary.high}, medium {impactAuditSummary.medium}, low {impactAuditSummary.low}.
                    </p>
                    {impactAuditEntries.length ? (
                      impactAuditEntries.slice(0, 80).map((entry) => (
                        <div key={`${entry.issueType}-${entry.originalUrl}`} className="dupeGroup">
                          <div className="dupeHead">
                            <div className="dupeBase">{entry.originalUrl}</div>
                            <div className="dupeFlags">
                              <span className="flag">{entry.impactLevel}</span>
                              <span className="flag">{entry.issueType}</span>
                              <span className="flag">occurrences {entry.occurrenceCount}</span>
                              <span className="flag">referrers {entry.referrerCount}</span>
                            </div>
                          </div>
                          <ul className="dupeList">
                            <li>Final URL: {entry.finalResolvedUrl}</li>
                            <li>Status: {entry.statusCode ?? "n/a"}</li>
                            <li>Reasons: {Array.isArray(entry.reasons) ? entry.reasons.join(", ") : "n/a"}</li>
                            <li>Core flow: {entry.coreFlow ? "yes" : "no"}</li>
                            <li>Referrer pages: {Array.isArray(entry.referrerPages) && entry.referrerPages.length ? entry.referrerPages.join(" | ") : "start"}</li>
                          </ul>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No broken or redirected issues detected.</p>
                    )}
                    {impactAuditEntries.length > 80 ? (
                      <p className="muted">Showing first 80 prioritised issues.</p>
                    ) : null}
                  </div>
                </details>
              ) : null}

              {softFailureSummary ? (
                <details className="details" open={softFailureSummary.total > 0}>
                  <summary>
                    Soft failures
                    {` (${softFailureSummary.total} pages)`}
                  </summary>
                  <div className="dupes">
                    <p className="help">
                      Checked successful pages for empty content, missing expected components, error text, and failed fetch/XHR endpoints. Empty content {softFailureSummary.emptyContent}, missing expected components {softFailureSummary.missingExpectedComponents}, error text matches {softFailureSummary.errorTextPatterns}, failed API calls {softFailureSummary.apiFailures}.
                    </p>
                    {softFailureEntries.length ? (
                      softFailureEntries
                        .slice(0, 80)
                        .map((entry) => (
                          <div key={entry.url} className="dupeGroup">
                            <div className="dupeHead">
                              <div className="dupeBase">{entry.url}</div>
                              <div className="dupeFlags">
                                <span className="flag">status {entry.statusCode ?? "n/a"}</span>
                                {Array.isArray(entry.apiFailures) && entry.apiFailures.length ? <span className="flag">api failures {entry.apiFailures.length}</span> : null}
                              </div>
                            </div>
                            <ul className="dupeList">
                              <li>Final URL: {entry.finalUrl}</li>
                              <li>Reasons: {formatSoftFailureReasons(entry) || "n/a"}</li>
                              {entry.missingExpectedComponents?.length ? <li>Missing expected components: {entry.missingExpectedComponents.join(", ")}</li> : null}
                              {entry.errorTextMatches?.length ? <li>Error text matches: {entry.errorTextMatches.join(", ")}</li> : null}
                              {entry.apiFailures?.length ? <li>Failed fetch/XHR: {entry.apiFailures.map((failure) => `${failure.resolvedUrl} [${failure.statusCode ?? "n/a"}]`).join(" | ")}</li> : null}
                            </ul>
                          </div>
                        ))
                    ) : (
                      <p className="muted">No soft failures detected.</p>
                    )}
                    {softFailureEntries.length > 80 ? (
                      <p className="muted">Showing first 80 soft failures.</p>
                    ) : null}
                  </div>
                </details>
              ) : null}

              {patternAuditSummary ? (
                <details className="details" open={(patternAuditSummary.duplicatePatterns + patternAuditSummary.legacyVsCurrent + patternAuditSummary.inconsistentNaming) > 0}>
                  <summary>
                    URL patterns
                    {` (${patternAuditSummary.patternGroups} groups)`}
                  </summary>
                  <div className="dupes">
                    <p className="help">
                      Checked {patternAuditSummary.filteredUrls} URLs{patternAuditSummary.filterApplied ? ` matching "${patternAuditSummary.filterApplied}"` : ""}. Duplicate patterns {patternAuditSummary.duplicatePatterns}, legacy vs current paths {patternAuditSummary.legacyVsCurrent}, inconsistent naming groups {patternAuditSummary.inconsistentNaming}.
                    </p>

                    {patternAudit?.duplicatePatterns?.length ? (
                      <>
                        <p className="help"><strong>Duplicate patterns</strong></p>
                        {patternAudit.duplicatePatterns.slice(0, 20).map((entry) => (
                          <div key={`dup-${entry.pattern}`} className="dupeGroup">
                            <div className="dupeHead">
                              <div className="dupeBase">{entry.pattern}</div>
                              <div className="dupeFlags">
                                <span className="flag">count {entry.count}</span>
                              </div>
                            </div>
                            <ul className="dupeList">
                              {entry.sampleUrls.map((url) => <li key={url}>{url}</li>)}
                            </ul>
                          </div>
                        ))}
                      </>
                    ) : null}

                    {patternAudit?.legacyVsCurrent?.length ? (
                      <>
                        <p className="help"><strong>Legacy vs current</strong></p>
                        {patternAudit.legacyVsCurrent.slice(0, 20).map((entry) => (
                          <div key={`legacy-${entry.key}`} className="dupeGroup">
                            <div className="dupeHead">
                              <div className="dupeBase">{entry.key}</div>
                            </div>
                            <ul className="dupeList">
                              <li>Legacy: {entry.legacyUrls.join(" | ")}</li>
                              <li>Current: {entry.currentUrls.join(" | ")}</li>
                            </ul>
                          </div>
                        ))}
                      </>
                    ) : null}

                    {patternAudit?.inconsistentNaming?.length ? (
                      <>
                        <p className="help"><strong>Inconsistent naming</strong></p>
                        {patternAudit.inconsistentNaming.slice(0, 20).map((entry) => (
                          <div key={`name-${entry.parentPath}`} className="dupeGroup">
                            <div className="dupeHead">
                              <div className="dupeBase">{entry.parentPath}</div>
                              <div className="dupeFlags">
                                {entry.styles.map((style) => <span key={style} className="flag">{style}</span>)}
                                {entry.mixedCase ? <span className="flag">mixed case</span> : null}
                                {entry.mixedSeparators ? <span className="flag">mixed separators</span> : null}
                              </div>
                            </div>
                            <ul className="dupeList">
                              {entry.sampleUrls.map((url) => <li key={url}>{url}</li>)}
                            </ul>
                          </div>
                        ))}
                      </>
                    ) : null}

                    {!patternAudit?.duplicatePatterns?.length && !patternAudit?.legacyVsCurrent?.length && !patternAudit?.inconsistentNaming?.length ? (
                      <p className="muted">No structural URL inconsistencies detected.</p>
                    ) : null}
                  </div>
                </details>
              ) : null}

              {redirectAuditSummary ? (
                <details className="details" open={redirectAuditSummary.issues > 0}>
                  <summary>
                    Redirect audit
                    {` (${redirectAuditSummary.issues} issues)`}
                  </summary>
                  <div className="dupes">
                    <p className="help">
                      Checked {redirectAuditSummary.total} navigation paths. Redirected {redirectAuditSummary.redirected}, loops {redirectAuditSummary.loops}, multi-hop chains {redirectAuditSummary.multipleHops}, params lost {redirectAuditSummary.paramsLost}, irrelevant destinations {redirectAuditSummary.irrelevantDestinations}.
                    </p>
                    {redirectAuditEntries.filter((entry) => entry.hasIssue).length ? (
                      redirectAuditEntries
                        .filter((entry) => entry.hasIssue)
                        .slice(0, 80)
                        .map((entry) => (
                          <div key={`${entry.referrerPage}-${entry.originalUrl}-${entry.sourceType}-${entry.sourceValue}`} className="dupeGroup">
                            <div className="dupeHead">
                              <div className="dupeBase">{entry.originalUrl}</div>
                              <div className="dupeFlags">
                                <span className="flag">status {entry.statusCode ?? "n/a"}</span>
                                <span className="flag">hops {entry.redirectStepCount}</span>
                                {entry.loopDetected ? <span className="flag">loop</span> : null}
                                {entry.multipleHops ? <span className="flag">multi-hop</span> : null}
                                {entry.paramsLost ? <span className="flag">params lost</span> : null}
                                {entry.irrelevantDestination ? <span className="flag">irrelevant destination</span> : null}
                              </div>
                            </div>
                            <ul className="dupeList">
                              <li>Source: {entry.sourceType || "page"} {entry.sourceValue ? `(${entry.sourceValue})` : ""}</li>
                              <li>Referrer: {entry.referrerPage || "start"}</li>
                              <li>Final URL: {entry.finalResolvedUrl}</li>
                              <li>Statuses: {Array.isArray(entry.redirectStatuses) && entry.redirectStatuses.length ? entry.redirectStatuses.join(" -> ") : (entry.statusCode ?? "n/a")}</li>
                              <li>Chain: {formatRedirectSteps(entry.redirectSteps) || (Array.isArray(entry.redirectChain) ? entry.redirectChain.join(" -> ") : entry.finalResolvedUrl)}</li>
                            </ul>
                          </div>
                        ))
                    ) : (
                      <p className="muted">No redirect issues detected.</p>
                    )}
                    {redirectAuditEntries.filter((entry) => entry.hasIssue).length > 80 ? (
                      <p className="muted">Showing first 80 redirect issues.</p>
                    ) : null}
                  </div>
                </details>
              ) : null}

              <details className="details">
                <summary>Duplicate content candidates</summary>
                {duplicateCandidates.length ? (
                  <div className="dupes">
                    {duplicateCandidates.slice(0, 30).map((g) => (
                      <div key={g.base} className="dupeGroup">
                        <div className="dupeHead">
                          <div className="dupeBase">{g.base}</div>
                          <div className="dupeFlags">
                            {g.hasQueryVariants ? <span className="flag">query variants</span> : null}
                            {g.hasLangVariants ? <span className="flag">lang variants</span> : null}
                            <span className="flag">count {g.variants.length}</span>
                          </div>
                        </div>
                        <ul className="dupeList">
                          {g.variants.slice(0, 10).map((v) => (
                            <li key={v.url}>{v.url}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {duplicateCandidates.length > 30 ? <p className="muted">Showing first 30 groups.</p> : null}
                  </div>
                ) : (
                  <p className="muted">No obvious duplicates detected.</p>
                )}
              </details>
            </div>
          </section>
        </div>
      </main>

      <footer className="footer">
        <p className="footText">Tip: Exclude /jobs and /careers paths to prevent crawling job content.</p>
      </footer>
    </div>
  );
}
