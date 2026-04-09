import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createFileCrawlJobStore } from "../job-store.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "site-crawler-job-store-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("file crawl job store persists completed job state across new store instances", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "jobs.json");
    const storeA = createFileCrawlJobStore({ filePath });

    await storeA.createJob({
      jobId: "job-1",
      requestBody: {
        url: "https://example.com",
        options: { maxPages: 1, concurrency: 1 }
      },
      queuedAhead: 0,
      now: 1000
    });

    const claimed = await storeA.claimNextQueuedJob({
      ownerId: "worker-a",
      runToken: "run-a",
      leaseDurationMs: 60000,
      now: 2000
    });

    assert.equal(claimed?.status, "running");

    await storeA.completeJob({
      jobId: "job-1",
      ownerId: "worker-a",
      runToken: "run-a",
      result: {
        counts: { crawled: 1 },
        urls: [{ url: "https://example.com", status: 200 }]
      },
      progress: {
        phase: "complete",
        message: "Crawl complete",
        percent: 100
      },
      now: 3000
    });

    const storeB = createFileCrawlJobStore({ filePath });
    const storedJob = await storeB.getJob("job-1");
    const storedResult = await storeB.getCompletedJobResult("job-1");

    assert.equal(storedJob?.status, "completed");
    assert.equal(storedJob?.finishedAtMs, 3000);
    assert.equal(storedJob?.progress?.phase, "complete");
    assert.deepEqual(storedResult, {
      counts: { crawled: 1 },
      urls: [{ url: "https://example.com", status: 200 }]
    });

    await storeA.close();
    await storeB.close();
  });
});

test("file crawl job store can reclaim an expired running job from another store instance", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "jobs.json");
    const storeA = createFileCrawlJobStore({ filePath });
    const storeB = createFileCrawlJobStore({ filePath });

    await storeA.createJob({
      jobId: "job-2",
      requestBody: {
        url: "https://example.com/recover",
        options: { maxPages: 1, concurrency: 1 }
      },
      queuedAhead: 0,
      now: 1000
    });

    const firstClaim = await storeA.claimNextQueuedJob({
      ownerId: "worker-a",
      runToken: "run-a",
      leaseDurationMs: 5000,
      now: 2000
    });

    assert.equal(firstClaim?.ownerId, "worker-a");
    assert.equal(firstClaim?.attemptCount, 1);

    const reclaimed = await storeB.claimExpiredRunningJob({
      ownerId: "worker-b",
      runToken: "run-b",
      leaseDurationMs: 5000,
      now: 8000
    });

    assert.equal(reclaimed?.status, "running");
    assert.equal(reclaimed?.ownerId, "worker-b");
    assert.equal(reclaimed?.runToken, "run-b");
    assert.equal(reclaimed?.attemptCount, 2);
    assert.ok(Number(reclaimed?.leaseExpiresAtMs || 0) > 8000);

    const storedJob = await storeA.getJob("job-2");
    assert.equal(storedJob?.ownerId, "worker-b");
    assert.equal(storedJob?.runToken, "run-b");

    await storeA.close();
    await storeB.close();
  });
});
