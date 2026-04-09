import {
  getRateLimitedPollDelayMs,
  getStatusPollDelayMs,
  isRetryableStatusPollResponse
} from "./polling.js";

export const MIN_MAX_PAGES = 1;
export const MAX_MAX_PAGES = 300;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 6;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function sanitizeMaxPages(value) {
  return clamp(Number(value || MAX_MAX_PAGES), MIN_MAX_PAGES, MAX_MAX_PAGES);
}

export function sanitizeConcurrency(value) {
  return clamp(Number(value || MAX_CONCURRENCY), MIN_CONCURRENCY, MAX_CONCURRENCY);
}

export function normalizeExcludePaths(value) {
  return String(value || "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("/"));
}

export function sanitizePathLimits(pathLimits) {
  const cleaned = Array.isArray(pathLimits) ? pathLimits : [];
  return cleaned
    .map((rule) => {
      const rawPath = String(rule?.path || "").trim();
      const normalizedPath = rawPath.startsWith("/") ? rawPath : (rawPath ? `/${rawPath}` : "");
      return {
        path: normalizedPath,
        maxPages: clamp(Number(rule?.maxPages || 0), 1, MAX_MAX_PAGES)
      };
    })
    .filter((rule) => rule.path && rule.path.startsWith("/") && rule.path !== "/");
}

export function validateHomepageUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "Homepage URL is required.";
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return "URL must start with http:// or https://";
  }

  return "";
}

function getEntryOriginalUrl(row) {
  return String(row?.originalUrl || row?.url || "");
}

function getEntryFinalUrl(row) {
  return String(row?.finalResolvedUrl || row?.finalUrl || "");
}

function formatSoftFailureReasons(row) {
  return (Array.isArray(row?.softFailureReasons) ? row.softFailureReasons : []).join("; ");
}

export function formatAuditReportLines(rows) {
  const list = Array.isArray(rows) ? rows : [];

  return list.map((row) => {
    const original = getEntryOriginalUrl(row);
    const finalUrl = getEntryFinalUrl(row);
    const source = row?.sourceType ? `${row.sourceType}: ${row.sourceValue || ""}` : "page";
    const referrer = row?.referrerPage ? ` | referrer: ${row.referrerPage}` : "";
    const status = row?.statusCode ?? row?.status;
    const statusPart = status === null || status === undefined ? "" : ` [${status}]`;
    const redirectPart = finalUrl && finalUrl !== original ? ` -> ${finalUrl}` : "";
    const classificationPart = row?.classification ? ` | ${row.classification}` : "";
    const redirectFlags = [
      row?.loopDetected ? "loop" : "",
      row?.multipleHops ? "multi-hop" : "",
      row?.paramsLost ? "params lost" : "",
      row?.irrelevantDestination ? "irrelevant destination" : ""
    ].filter(Boolean);
    const redirectFlagPart = redirectFlags.length ? ` | redirects: ${redirectFlags.join(", ")}` : "";
    const softFailurePart = formatSoftFailureReasons(row) ? ` | soft failure: ${formatSoftFailureReasons(row)}` : "";
    return `${source}${referrer} | ${original}${statusPart}${redirectPart}${classificationPart}${redirectFlagPart}${softFailurePart}`;
  });
}

export function buildCrawlStartRequestBody({
  url,
  excludePaths,
  pathLimits,
  maxPages,
  concurrency,
  includeQuery,
  ignoreJobPages,
  brokenLinkCheck,
  parameterAudit,
  urlMatchPattern
}) {
  return {
    url: String(url || "").trim(),
    options: {
      excludePaths: normalizeExcludePaths(excludePaths),
      pathLimits: sanitizePathLimits(pathLimits),
      maxPages: sanitizeMaxPages(maxPages),
      concurrency: sanitizeConcurrency(concurrency),
      includeQuery: !!includeQuery,
      ignoreJobPages: !!ignoreJobPages,
      brokenLinkCheck: !!brokenLinkCheck,
      parameterAudit: !!parameterAudit,
      patternMatchFilter: String(urlMatchPattern || "").trim()
    }
  };
}

function makeInitialProgress(maxPages) {
  return {
    phase: "setup",
    message: "Starting crawl",
    percent: 1,
    pagesCrawled: 0,
    pagesQueued: 0,
    pagesDiscovered: 0,
    maxPages: sanitizeMaxPages(maxPages),
    auditEntriesTested: 0,
    auditEntriesTotal: 0,
    parameterChecksDone: 0,
    parameterChecksTotal: 0
  };
}

export async function executeCrawlFlow({
  url,
  excludePaths,
  pathLimits,
  maxPages,
  concurrency,
  includeQuery,
  ignoreJobPages,
  brokenLinkCheck,
  parameterAudit,
  urlMatchPattern,
  fetchJsonWithRetry,
  sleep,
  onProgress = () => {},
  onNotice = () => {},
  activeJobRef = { current: "" }
}) {
  const trimmedUrl = String(url || "").trim();
  const validationError = validateHomepageUrl(trimmedUrl);
  if (validationError) {
    return {
      ok: false,
      error: validationError,
      jobId: "",
      data: null,
      progress: null
    };
  }

  let latestProgress = makeInitialProgress(maxPages);
  let hasShownPollBackoffNotice = false;

  function updateProgress(patch) {
    latestProgress = {
      ...latestProgress,
      ...(patch && typeof patch === "object" ? patch : {})
    };
    onProgress({ ...latestProgress });
  }

  updateProgress(latestProgress);

  const { res, json } = await fetchJsonWithRetry(
    "/api/crawl/start",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildCrawlStartRequestBody({
          url: trimmedUrl,
          excludePaths,
          pathLimits,
          maxPages,
          concurrency,
          includeQuery,
          ignoreJobPages,
          brokenLinkCheck,
          parameterAudit,
          urlMatchPattern
        })
      )
    },
    { attempts: 3, retryDelayMs: 700 }
  );

  if (!res.ok) {
    return {
      ok: false,
      error: json?.error || "Request failed",
      jobId: "",
      data: null,
      progress: latestProgress
    };
  }

  const jobId = String(json?.jobId || "").trim();
  if (!jobId) {
    throw new Error("Crawl job did not start.");
  }

  activeJobRef.current = jobId;

  while (activeJobRef.current === jobId) {
    const { res: statusRes, json: statusJson } = await fetchJsonWithRetry(
      `/api/crawl/${jobId}`,
      { cache: "no-store" },
      { attempts: 4, retryDelayMs: 700 }
    );

    if (isRetryableStatusPollResponse(statusRes, statusJson)) {
      const retryDelayMs = getRateLimitedPollDelayMs(statusRes, statusJson);
      const retryDelaySeconds = Math.ceil(retryDelayMs / 1000);

      updateProgress({
        phase: latestProgress?.phase || "status",
        message: `Waiting ${retryDelaySeconds}s before the next status check`
      });

      if (!hasShownPollBackoffNotice) {
        onNotice("warning", "Status checks were temporarily slowed to stay within the server polling limit.");
        hasShownPollBackoffNotice = true;
      }

      await sleep(retryDelayMs);
      continue;
    }

    if (!statusRes.ok) {
      throw new Error(statusJson?.error || "Progress request failed");
    }

    hasShownPollBackoffNotice = false;

    if (statusJson?.progress) {
      updateProgress(statusJson.progress);
    }

    if (statusJson?.status === "completed") {
      updateProgress({
        ...(statusJson.progress || {}),
        phase: "complete",
        message: "Crawl complete",
        percent: 100
      });
      activeJobRef.current = "";
      return {
        ok: true,
        error: "",
        jobId,
        data: statusJson.result || null,
        progress: latestProgress
      };
    }

    if (statusJson?.status === "failed") {
      activeJobRef.current = "";
      return {
        ok: false,
        error: statusJson?.error || "Crawl failed",
        jobId,
        data: null,
        progress: latestProgress
      };
    }

    const nextPollDelayMs = getStatusPollDelayMs(statusJson?.status, statusJson?.progress);
    if (nextPollDelayMs > 0) {
      await sleep(nextPollDelayMs);
    }
  }

  return {
    ok: false,
    cancelled: true,
    error: "",
    jobId,
    data: null,
    progress: latestProgress
  };
}
