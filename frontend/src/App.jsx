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

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [notices, setNotices] = useState([]);
  const [data, setData] = useState(null);

  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState("");
  const [runnerPin, setRunnerPin] = useState("");
  const [isUnlocked, setIsUnlocked] = useState(false);

  const [presets, setPresets] = useState([]);
  const [presetName, setPresetName] = useState("default");
  const fileInputRef = useRef(null);
  const [isBookmarklet, setIsBookmarklet] = useState(false);

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
      setPresetName(last.presetName || "default");
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
    let isMounted = true;
    fetch("/api/config")
      .then((r) => r.json())
      .then((json) => {
        if (!isMounted) return;
        const required = !!json?.pinRequired;
        setPinRequired(required);

        if (!required) {
          setIsUnlocked(true);
          setPin("");
          setRunnerPin("");
          return;
        }

        const storedPin = sessionStorage.getItem("siteCrawlerRunnerPin") || "";
        if (!storedPin) {
          setIsUnlocked(false);
          setRunnerPin("");
          return;
        }

        setRunnerPin(storedPin);

        return fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: storedPin })
        })
          .then((r) => {
            if (!r.ok) throw new Error("Invalid pin");
            return r.json();
          })
          .then((auth) => {
            if (!isMounted) return;
            if (auth?.ok) {
              setIsUnlocked(true);
              setPin("");
            } else {
              sessionStorage.removeItem("siteCrawlerRunnerPin");
              setIsUnlocked(false);
              setRunnerPin("");
            }
          })
          .catch(() => {
            if (!isMounted) return;
            sessionStorage.removeItem("siteCrawlerRunnerPin");
            setIsUnlocked(false);
            setRunnerPin("");
          });
      })
      .catch(() => {
        if (!isMounted) return;
        setPinRequired(false);
        setIsUnlocked(true);
        setPin("");
        setRunnerPin("");
      });

    return () => {
      isMounted = false;
    };
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
        presetName
      })
    );
  }, [url, excludePaths, pathLimits, maxPages, concurrency, includeQuery, ignoreJobPages, brokenLinkCheck, presetName]);

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

  const urls = data?.urls || [];

  const duplicateCandidates = useMemo(() => {
    const byBase = new Map();
    for (const row of urls) {
      const original = row.url;
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
  }, [urls]);

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

  async function unlockRunner() {
    setError("");
    setNotices([]);

    if (!pinRequired) {
      setIsUnlocked(true);
      setPin("");
      setRunnerPin("");
      pushNotice("success", "Runner access is already open.");
      return;
    }

    const trimmedPin = pin.trim();
    if (!trimmedPin) {
      setError("Pin is required.");
      pushNotice("error", "Enter a pin to unlock the runner.");
      return;
    }

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: trimmedPin })
      });

      const json = await res.json();
      if (!res.ok || !json?.ok) {
        const msg = json?.error || "Invalid pin";
        setError(msg);
        setIsUnlocked(false);
        setRunnerPin("");
        sessionStorage.removeItem("siteCrawlerRunnerPin");
        pushNotice("error", msg);
        return;
      }

      sessionStorage.setItem("siteCrawlerRunnerPin", trimmedPin);
      setRunnerPin(trimmedPin);
      setIsUnlocked(true);
      setPin("");
      pushNotice("success", "Runner unlocked.");
    } catch {
      setError("Network error");
      setIsUnlocked(false);
      setRunnerPin("");
      pushNotice("error", "Network error while unlocking the runner.");
    }
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
        brokenLinkCheck
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

    if (pinRequired && !isUnlocked) {
      setError("Runner is locked. Unlock the runner to start a crawl.");
      pushNotice("error", "Runner is locked. Unlock it first.");
      return;
    }

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
      const headers = { "Content-Type": "application/json" };
      if (pinRequired) headers["x-runner-pin"] = runnerPin.trim();

      const res = await fetch("/api/crawl", {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: trimmed,
          options: {
            excludePaths: excludePathList,
            pathLimits: sanitizedPathLimits,
            maxPages: clamp(Number(maxPages || 300), 10, 5000),
            concurrency: clamp(Number(concurrency || 6), 1, 20),
            includeQuery,
            ignoreJobPages,
            brokenLinkCheck
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
    if (!urls.length) return;
    const lines = urls.map((r) => r.url);
    downloadText("crawl-urls.txt", lines.join("\n"));
  }

  function downloadCsv() {
    if (!urls.length) return;
    const header = ["url", "finalUrl", "status", "blockedByRobots"].join(",");
    const rows = urls.map((r) => {
      const values = [
        JSON.stringify(r.url || ""),
        JSON.stringify(r.finalUrl || ""),
        JSON.stringify(r.status === null || r.status === undefined ? "" : String(r.status)),
        JSON.stringify(r.blockedByRobots ? "true" : "false")
      ];
      return values.join(",");
    });
    downloadText("crawl-urls.csv", [header, ...rows].join("\n"));
  }

  const summary = useMemo(() => {
    if (!data) return null;
    const total = urls.length;
    const redirects = urls.filter((u) => (u.finalUrl || u.url) !== u.url).length;
    const broken = urls.filter((u) => {
      const s = Number(u.status);
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
  }, [data, urls]);

  const brandName = isBookmarklet ? "A11y Cat" : "Carla’s tools";
  const brandTag = isBookmarklet
    ? "A11y Cat - Site Crawler for the page you are on."
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
            <a className="navPill" href="#access">Access</a>
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

          <section id="access" className="panel" aria-labelledby="accessTitle">
            <div className="panelHead">
              <h2 id="accessTitle">Access control</h2>
              <div className="panelMeta">
                <span className="chip">
                  {pinRequired ? (isUnlocked ? "Unlocked" : "Locked") : "Open"}
                </span>
              </div>
            </div>

            <div className="panelBody">
              <h3 className="panelSubTitle">Enter your pin to access the runner access control</h3>
              <p className="help">
                If a pin is configured on the server, you must unlock the runner before you can start a crawl. If no pin is configured, the runner is open.
              </p>

              <div className="formGrid">
                <div className="field">
                  <label htmlFor="pin">Pin</label>
                  <input
                    id="pin"
                    type="password"
                    inputMode="text"
                    autoComplete="off"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    placeholder={pinRequired ? "Enter pin" : "No pin required"}
                    disabled={!pinRequired || isUnlocked}
                  />
                </div>

                <div className="actions">
                  <button className="btnPrimary" type="button" onClick={unlockRunner} disabled={!pinRequired || isUnlocked}>
                    {pinRequired ? (isUnlocked ? "Runner unlocked" : "Unlock runner") : "Runner open"}
                  </button>
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
              </div>

              <div className="actions">
                <button className="btnPrimary" type="button" onClick={runCrawl} disabled={loading || (pinRequired && !isUnlocked)}>
                  {loading ? "Crawling" : "Run crawl"}
                </button>
                <button className="btnGhost" type="button" onClick={downloadUrls} disabled={!urls.length}>
                  Download TXT
                </button>
                <button className="btnGhost" type="button" onClick={downloadCsv} disabled={!urls.length}>
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
              </div>
            </div>

            <div className="resultsGrid">
              <div className="field">
                <label htmlFor="urls">URLs</label>
                <textarea
                  id="urls"
                  readOnly
                  value={urls.map((u) => {
                    const statusPart = u.status !== null && u.status !== undefined && u.status !== "" ? ` [${u.status}]` : "";
                    const redirectPart = u.finalUrl && u.finalUrl !== u.url ? ` -> ${u.finalUrl}` : "";
                    return `${u.url}${statusPart}${redirectPart}`;
                  }).join("\n")}
                  rows={14}
                />
              </div>

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
