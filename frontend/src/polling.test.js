import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getRateLimitedPollDelayMs,
  getStatusPollDelayMs,
  isRetryableStatusPollResponse,
  parseRetryAfterDelayMs
} from "./polling.js";

function makeResponse(status, retryAfter = "") {
  return {
    status,
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

test("running status polls stay well under the backend in-progress read limit", () => {
  const delayMs = getStatusPollDelayMs("running", { phase: "crawl" });
  const requestsPerMinute = Math.floor(60_000 / delayMs);

  assert.equal(delayMs, 1000);
  assert.equal(requestsPerMinute, 60);
  assert.ok(requestsPerMinute < 120);
});

test("queued and setup states poll more slowly than active crawling", () => {
  assert.equal(getStatusPollDelayMs("queued", { phase: "queued" }), 2000);
  assert.equal(getStatusPollDelayMs("running", { phase: "setup" }), 2000);
});

test("completed and failed jobs stop polling immediately", () => {
  assert.equal(getStatusPollDelayMs("completed", { phase: "complete" }), 0);
  assert.equal(getStatusPollDelayMs("failed", { phase: "failed" }), 0);
});

test("retry-after parsing supports seconds and HTTP date values", () => {
  assert.equal(parseRetryAfterDelayMs("7"), 7000);
  assert.equal(
    parseRetryAfterDelayMs("Tue, 07 Apr 2026 10:00:05 GMT", Date.parse("Tue, 07 Apr 2026 10:00:00 GMT")),
    5000
  );
});

test("rate-limited poll retries respect the larger of retry-after and safe fallback delays", () => {
  const shortHeaderDelay = getRateLimitedPollDelayMs(makeResponse(429, "2"), {
    code: "RATE_LIMIT_EXCEEDED",
    details: { retryAfterMs: 2000 }
  });
  const longHeaderDelay = getRateLimitedPollDelayMs(makeResponse(429, "9"), {
    code: "RATE_LIMIT_EXCEEDED",
    details: { retryAfterMs: 2000 }
  });
  const missingHeaderDelay = getRateLimitedPollDelayMs(makeResponse(429, ""), {
    code: "RATE_LIMIT_EXCEEDED",
    details: {}
  });

  assert.equal(shortHeaderDelay, 5000);
  assert.equal(longHeaderDelay, 9000);
  assert.equal(missingHeaderDelay, 5000);
});

test("only backend rate-limit responses trigger automatic poll backoff", () => {
  assert.equal(isRetryableStatusPollResponse(makeResponse(429, "5"), { code: "RATE_LIMIT_EXCEEDED" }), true);
  assert.equal(isRetryableStatusPollResponse(makeResponse(404, ""), { code: "CRAWL_JOB_NOT_FOUND" }), false);
  assert.equal(isRetryableStatusPollResponse(makeResponse(429, "5"), { code: "OTHER_ERROR" }), false);
});
