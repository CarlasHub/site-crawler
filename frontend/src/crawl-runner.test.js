import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCrawlStartRequestBody,
  executeCrawlFlow,
  formatAuditReportLines
} from "./crawl-runner.js";

function makeResponse(status, retryAfter = "") {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        if (String(name || "").toLowerCase() === "retry-after") {
          return retryAfter;
        }
        return null;
      }
    }
  };
}

test("crawl start request body sanitizes form values to the backend contract", () => {
  const requestBody = buildCrawlStartRequestBody({
    url: " https://example.com ",
    excludePaths: "/jobs\ninvalid\n /careers \nabout",
    pathLimits: [
      { path: "job", maxPages: 999 },
      { path: "/", maxPages: 5 },
      { path: "", maxPages: 7 }
    ],
    maxPages: 999,
    concurrency: 99,
    includeQuery: true,
    ignoreJobPages: true,
    brokenLinkCheck: false,
    parameterAudit: true,
    urlMatchPattern: " /jobs* "
  });

  assert.deepEqual(requestBody, {
    url: "https://example.com",
    options: {
      excludePaths: ["/jobs", "/careers"],
      pathLimits: [{ path: "/job", maxPages: 300 }],
      maxPages: 300,
      concurrency: 6,
      includeQuery: true,
      ignoreJobPages: true,
      brokenLinkCheck: false,
      parameterAudit: true,
      patternMatchFilter: "/jobs*"
    }
  });
});

test("crawl flow rejects an empty homepage URL before any network submission", async () => {
  let requests = 0;

  const result = await executeCrawlFlow({
    url: "",
    excludePaths: "",
    pathLimits: [],
    maxPages: 300,
    concurrency: 6,
    includeQuery: true,
    ignoreJobPages: true,
    brokenLinkCheck: false,
    parameterAudit: false,
    urlMatchPattern: "",
    fetchJsonWithRetry: async () => {
      requests += 1;
      return { res: makeResponse(200), json: {} };
    },
    sleep: async () => {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Homepage URL is required.");
  assert.equal(requests, 0);
});

test("crawl flow backs off on rate-limited status polling and resumes to completion", async () => {
  const requests = [];
  const sleeps = [];
  const notices = [];
  const progressUpdates = [];
  const activeJobRef = { current: "" };
  const responses = [
    { res: makeResponse(200), json: { jobId: "job-123" } },
    { res: makeResponse(429, "9"), json: { code: "RATE_LIMIT_EXCEEDED", details: { retryAfterMs: 2000 } } },
    { res: makeResponse(200), json: { status: "running", progress: { phase: "crawl", message: "Crawling pages", percent: 55, pagesCrawled: 12 } } },
    { res: makeResponse(200), json: { status: "completed", progress: { phase: "complete", message: "Backend complete", percent: 92 }, result: { counts: { crawled: 12 } } } }
  ];

  const result = await executeCrawlFlow({
    url: "https://example.com",
    excludePaths: "/jobs",
    pathLimits: [{ path: "/job", maxPages: 5 }],
    maxPages: 300,
    concurrency: 6,
    includeQuery: true,
    ignoreJobPages: true,
    brokenLinkCheck: false,
    parameterAudit: false,
    urlMatchPattern: "",
    fetchJsonWithRetry: async (input) => {
      requests.push(String(input));
      const next = responses.shift();
      if (!next) {
        throw new Error("Unexpected extra request");
      }
      return next;
    },
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
    onProgress: (progress) => {
      progressUpdates.push({ ...progress });
    },
    onNotice: (type, message) => {
      notices.push({ type, message });
    },
    activeJobRef
  });

  assert.equal(result.ok, true);
  assert.equal(result.jobId, "job-123");
  assert.deepEqual(result.data, { counts: { crawled: 12 } });
  assert.equal(result.progress?.phase, "complete");
  assert.equal(result.progress?.message, "Crawl complete");
  assert.equal(result.progress?.percent, 100);
  assert.deepEqual(requests, [
    "/api/crawl/start",
    "/api/crawl/job-123",
    "/api/crawl/job-123",
    "/api/crawl/job-123"
  ]);
  assert.deepEqual(sleeps, [9000, 1000]);
  assert.deepEqual(notices, [
    {
      type: "warning",
      message: "Status checks were temporarily slowed to stay within the server polling limit."
    }
  ]);
  assert.equal(progressUpdates[0]?.phase, "setup");
  assert.equal(progressUpdates[1]?.message, "Waiting 9s before the next status check");
  assert.equal(progressUpdates.at(-1)?.message, "Crawl complete");
  assert.equal(activeJobRef.current, "");
});

test("crawl flow returns the backend failure message for a failed job and stops polling", async () => {
  const activeJobRef = { current: "" };
  const responses = [
    { res: makeResponse(200), json: { jobId: "job-456" } },
    { res: makeResponse(200), json: { status: "failed", progress: { phase: "failed", message: "Internal server error", percent: 27 }, error: "Internal server error" } }
  ];

  const result = await executeCrawlFlow({
    url: "https://example.com",
    excludePaths: "",
    pathLimits: [],
    maxPages: 300,
    concurrency: 6,
    includeQuery: true,
    ignoreJobPages: true,
    brokenLinkCheck: false,
    parameterAudit: false,
    urlMatchPattern: "",
    fetchJsonWithRetry: async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error("Unexpected extra request");
      }
      return next;
    },
    sleep: async () => {
      throw new Error("sleep should not be called after a failed status");
    },
    activeJobRef
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Internal server error");
  assert.equal(result.jobId, "job-456");
  assert.equal(result.progress?.phase, "failed");
  assert.equal(result.progress?.message, "Internal server error");
  assert.equal(activeJobRef.current, "");
});

test("audit report formatting keeps key operator-visible state in the rendered text", () => {
  const lines = formatAuditReportLines([
    {
      originalUrl: "https://example.com/jobs",
      finalResolvedUrl: "https://example.com/careers",
      statusCode: 302,
      sourceType: "link",
      sourceValue: "/jobs",
      referrerPage: "https://example.com/",
      classification: "redirect_issue",
      multipleHops: true,
      paramsLost: true,
      softFailureReasons: ["error text: unexpected error"]
    }
  ]);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^link: \/jobs \| referrer: https:\/\/example\.com\/ \| https:\/\/example\.com\/jobs \[302\] -> https:\/\/example\.com\/careers/);
  assert.match(lines[0], /\| redirect_issue/);
  assert.match(lines[0], /\| redirects: multi-hop, params lost/);
  assert.match(lines[0], /\| soft failure: error text: unexpected error/);
});
