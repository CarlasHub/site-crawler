import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FieldPath, Firestore } from "@google-cloud/firestore";

const DEFAULT_RESULT_CHUNK_BYTES = 240 * 1024;

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function toIsoString(value) {
  return new Date(Number(value || Date.now())).toISOString();
}

function sanitizeProgress(progress, updatedAtMs) {
  const base = progress && typeof progress === "object" ? cloneJson(progress) : {};
  return {
    phase: String(base.phase || "queued"),
    message: String(base.message || "Queued"),
    percent: Number(base.percent || 0),
    pagesCrawled: Number(base.pagesCrawled || 0),
    pagesQueued: Number(base.pagesQueued || 0),
    pagesDiscovered: Number(base.pagesDiscovered || 0),
    maxPages: Number(base.maxPages || 0),
    auditEntriesTested: Number(base.auditEntriesTested || 0),
    auditEntriesTotal: Number(base.auditEntriesTotal || 0),
    parameterChecksDone: Number(base.parameterChecksDone || 0),
    parameterChecksTotal: Number(base.parameterChecksTotal || 0),
    updatedAt: toIsoString(updatedAtMs)
  };
}

function mergeProgress(currentProgress, nextProgress, updatedAtMs) {
  const merged = {
    ...(currentProgress && typeof currentProgress === "object" ? cloneJson(currentProgress) : {}),
    ...(nextProgress && typeof nextProgress === "object" ? cloneJson(nextProgress) : {})
  };
  return sanitizeProgress(merged, updatedAtMs);
}

function buildJobRecord({
  jobId,
  requestBody,
  progress,
  queuedAhead = 0,
  now = Date.now()
}) {
  const progressMessage = queuedAhead > 0
    ? `Queued. ${queuedAhead} job${queuedAhead === 1 ? "" : "s"} ahead.`
    : "Queued";

  return {
    id: String(jobId),
    status: "queued",
    createdAt: toIsoString(now),
    createdAtMs: Number(now),
    updatedAt: toIsoString(now),
    updatedAtMs: Number(now),
    finishedAt: "",
    finishedAtMs: 0,
    progress: mergeProgress(
      {
        phase: "queued",
        message: progressMessage,
        percent: 0
      },
      progress,
      now
    ),
    requestBody: cloneJson(requestBody),
    resultInline: null,
    resultChunkCount: 0,
    resultSizeBytes: 0,
    error: "",
    errorCode: "",
    errorDetails: null,
    ownerId: "",
    runToken: "",
    leaseExpiresAt: "",
    leaseExpiresAtMs: 0,
    heartbeatAt: "",
    heartbeatAtMs: 0,
    attemptCount: 0
  };
}

function applyLease(job, { ownerId, runToken, leaseDurationMs, now = Date.now() }) {
  const leaseExpiresAtMs = Number(now) + Number(leaseDurationMs || 0);
  return {
    ...cloneJson(job),
    status: "running",
    ownerId: String(ownerId || ""),
    runToken: String(runToken || ""),
    updatedAt: toIsoString(now),
    updatedAtMs: Number(now),
    heartbeatAt: toIsoString(now),
    heartbeatAtMs: Number(now),
    leaseExpiresAt: toIsoString(leaseExpiresAtMs),
    leaseExpiresAtMs,
    attemptCount: Number(job?.attemptCount || 0) + 1
  };
}

function stripResultPayload(job) {
  if (!job) return null;
  const cloned = cloneJson(job);
  delete cloned.resultInline;
  return cloned;
}

function encodeResultChunks(result, maxChunkBytes = DEFAULT_RESULT_CHUNK_BYTES) {
  const payload = JSON.stringify(result ?? null);
  const bytes = Buffer.from(payload, "utf8");
  const chunks = [];

  for (let offset = 0; offset < bytes.length; offset += maxChunkBytes) {
    chunks.push(bytes.subarray(offset, offset + maxChunkBytes).toString("base64"));
  }

  return {
    chunks,
    sizeBytes: bytes.length
  };
}

function decodeResultChunks(chunks) {
  const buffers = chunks.map((chunk) => Buffer.from(String(chunk || ""), "base64"));
  const text = Buffer.concat(buffers).toString("utf8");
  return JSON.parse(text || "null");
}

class FileCrawlJobStore {
  constructor({ filePath }) {
    this.filePath = path.resolve(String(filePath || ""));
    this.writeQueue = Promise.resolve();
  }

  async close() {}

  async getJob(jobId) {
    const state = await this.readState();
    const job = state.jobs[String(jobId || "")];
    return stripResultPayload(job);
  }

  async getCompletedJobResult(jobId) {
    const state = await this.readState();
    return cloneJson(state.jobs[String(jobId || "")]?.resultInline ?? null);
  }

  async createJob({ jobId, requestBody, progress, queuedAhead = 0, now = Date.now() }) {
    return this.withWriteLock(async (state) => {
      const createdAtMs = Number(now);
      if (state.jobs[String(jobId || "")]) {
        throw new Error(`Job already exists: ${jobId}`);
      }

      const job = buildJobRecord({
        jobId,
        requestBody,
        progress,
        queuedAhead,
        now: createdAtMs
      });

      state.jobs[job.id] = job;
      state.queue.push({
        jobId: job.id,
        createdAtMs
      });
      state.queue.sort((a, b) => {
        const byCreated = Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0);
        if (byCreated !== 0) return byCreated;
        return String(a.jobId || "").localeCompare(String(b.jobId || ""));
      });

      return {
        job: stripResultPayload(job),
        queuedAhead: Number(queuedAhead)
      };
    });
  }

  async getPendingCounts({ limit = Number.MAX_SAFE_INTEGER } = {}) {
    const state = await this.readState();
    const queuedCrawls = Math.min(state.queue.length, limit);
    let runningCrawls = 0;
    for (const job of Object.values(state.jobs)) {
      if (job.status === "running") {
        runningCrawls += 1;
        if (runningCrawls >= limit) break;
      }
    }
    return {
      queuedCrawls,
      runningCrawls
    };
  }

  async getMetrics() {
    const state = await this.readState();
    let runningCrawls = 0;
    for (const job of Object.values(state.jobs)) {
      if (job.status === "running") runningCrawls += 1;
    }
    return {
      trackedJobs: Object.keys(state.jobs).length,
      queuedCrawls: state.queue.length,
      runningCrawls
    };
  }

  async claimNextQueuedJob({ ownerId, runToken, leaseDurationMs, now = Date.now() }) {
    return this.withWriteLock(async (state) => {
      while (state.queue.length > 0) {
        const next = state.queue.shift();
        const job = state.jobs[String(next?.jobId || "")];
        if (!job || job.status !== "queued") continue;

        const claimed = applyLease(job, { ownerId, runToken, leaseDurationMs, now });
        state.jobs[claimed.id] = claimed;
        return stripResultPayload(claimed);
      }

      return null;
    });
  }

  async claimExpiredRunningJob({ ownerId, runToken, leaseDurationMs, now = Date.now() }) {
    return this.withWriteLock(async (state) => {
      const candidates = Object.values(state.jobs)
        .filter((job) => job.status === "running" && Number(job.leaseExpiresAtMs || 0) <= Number(now))
        .sort((a, b) => {
          const byLease = Number(a.leaseExpiresAtMs || 0) - Number(b.leaseExpiresAtMs || 0);
          if (byLease !== 0) return byLease;
          return String(a.id || "").localeCompare(String(b.id || ""));
        });

      if (candidates.length === 0) return null;

      const claimed = applyLease(candidates[0], { ownerId, runToken, leaseDurationMs, now });
      state.jobs[claimed.id] = claimed;
      return stripResultPayload(claimed);
    });
  }

  async touchJob({ jobId, ownerId, runToken, leaseDurationMs, progress = null, now = Date.now() }) {
    return this.withWriteLock(async (state) => {
      const job = state.jobs[String(jobId || "")];
      if (!job || job.status !== "running") return null;
      if (String(job.ownerId || "") !== String(ownerId || "")) return null;
      if (String(job.runToken || "") !== String(runToken || "")) return null;

      const updated = applyLease(job, { ownerId, runToken, leaseDurationMs, now });
      updated.progress = progress ? mergeProgress(job.progress, progress, now) : mergeProgress(job.progress, {}, now);
      state.jobs[updated.id] = updated;
      return stripResultPayload(updated);
    });
  }

  async completeJob({ jobId, ownerId, runToken, result, progress = null, now = Date.now() }) {
    return this.withWriteLock(async (state) => {
      const job = state.jobs[String(jobId || "")];
      if (!job) return null;
      if (String(job.ownerId || "") !== String(ownerId || "")) return null;
      if (String(job.runToken || "") !== String(runToken || "")) return null;

      const updatedAtMs = Number(now);
      const updated = {
        ...cloneJson(job),
        status: "completed",
        updatedAt: toIsoString(updatedAtMs),
        updatedAtMs,
        finishedAt: toIsoString(updatedAtMs),
        finishedAtMs: updatedAtMs,
        progress: mergeProgress(job.progress, progress || {}, updatedAtMs),
        resultInline: cloneJson(result),
        resultChunkCount: 0,
        resultSizeBytes: Buffer.byteLength(JSON.stringify(result ?? null), "utf8"),
        error: "",
        errorCode: "",
        errorDetails: null,
        ownerId: "",
        runToken: "",
        heartbeatAt: "",
        heartbeatAtMs: 0,
        leaseExpiresAt: "",
        leaseExpiresAtMs: 0
      };
      state.jobs[updated.id] = updated;
      state.queue = state.queue.filter((entry) => String(entry.jobId || "") !== updated.id);
      return stripResultPayload(updated);
    });
  }

  async failJob({ jobId, ownerId, runToken, clientError, progress = null, now = Date.now() }) {
    return this.withWriteLock(async (state) => {
      const job = state.jobs[String(jobId || "")];
      if (!job) return null;
      if (String(job.ownerId || "") !== String(ownerId || "")) return null;
      if (String(job.runToken || "") !== String(runToken || "")) return null;

      const updatedAtMs = Number(now);
      const updated = {
        ...cloneJson(job),
        status: "failed",
        updatedAt: toIsoString(updatedAtMs),
        updatedAtMs,
        finishedAt: toIsoString(updatedAtMs),
        finishedAtMs: updatedAtMs,
        progress: mergeProgress(job.progress, progress || {}, updatedAtMs),
        resultInline: null,
        resultChunkCount: 0,
        resultSizeBytes: 0,
        error: String(clientError?.message || "Crawl failed"),
        errorCode: String(clientError?.code || "INTERNAL_ERROR"),
        errorDetails: cloneJson(clientError?.details ?? null),
        ownerId: "",
        runToken: "",
        heartbeatAt: "",
        heartbeatAtMs: 0,
        leaseExpiresAt: "",
        leaseExpiresAtMs: 0
      };
      state.jobs[updated.id] = updated;
      state.queue = state.queue.filter((entry) => String(entry.jobId || "") !== updated.id);
      return stripResultPayload(updated);
    });
  }

  async pruneExpiredJobs({ ttlMs, now = Date.now() }) {
    return this.withWriteLock(async (state) => {
      const cutoff = Number(now) - Number(ttlMs || 0);
      const deletedJobIds = [];

      for (const [jobId, job] of Object.entries(state.jobs)) {
        const finishedAtMs = Number(job?.finishedAtMs || 0);
        if (!finishedAtMs) continue;
        if (finishedAtMs > cutoff) continue;
        delete state.jobs[jobId];
        deletedJobIds.push(jobId);
      }

      if (deletedJobIds.length > 0) {
        const deleted = new Set(deletedJobIds);
        state.queue = state.queue.filter((entry) => !deleted.has(String(entry.jobId || "")));
      }

      return deletedJobIds.length;
    });
  }

  async readState() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        jobs: parsed?.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {},
        queue: Array.isArray(parsed?.queue) ? parsed.queue : []
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          jobs: {},
          queue: []
        };
      }
      throw error;
    }
  }

  async writeState(state) {
    const directory = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }

  async withWriteLock(fn) {
    const run = this.writeQueue.then(async () => {
      const state = await this.readState();
      const result = await fn(state);
      await this.writeState(state);
      return result;
    });

    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

class FirestoreCrawlJobStore {
  constructor({ collectionName, resultChunkBytes = DEFAULT_RESULT_CHUNK_BYTES }) {
    this.firestore = new Firestore();
    this.collectionName = String(collectionName || "crawlJobs");
    this.resultChunkBytes = Number(resultChunkBytes || DEFAULT_RESULT_CHUNK_BYTES);
    this.jobs = this.firestore.collection(this.collectionName);
    this.queue = this.firestore.collection(`${this.collectionName}Queue`);
  }

  async close() {}

  async getJob(jobId) {
    const snapshot = await this.jobs.doc(String(jobId || "")).get();
    if (!snapshot.exists) return null;
    return stripResultPayload({ id: snapshot.id, ...snapshot.data() });
  }

  async getCompletedJobResult(jobId) {
    const chunksSnapshot = await this.jobs
      .doc(String(jobId || ""))
      .collection("resultChunks")
      .orderBy("index")
      .get();

    if (chunksSnapshot.empty) return null;
    const chunks = chunksSnapshot.docs.map((doc) => String(doc.data()?.chunkBase64 || ""));
    return decodeResultChunks(chunks);
  }

  async createJob({ jobId, requestBody, progress, queuedAhead = 0, now = Date.now() }) {
    const createdAtMs = Number(now);
    const job = buildJobRecord({
      jobId,
      requestBody,
      progress,
      queuedAhead,
      now: createdAtMs
    });

    const batch = this.firestore.batch();
    const jobRef = this.jobs.doc(job.id);
    const queueRef = this.queue.doc(job.id);
    batch.set(jobRef, cloneJson(job));
    batch.set(queueRef, {
      jobId: job.id,
      createdAtMs
    });
    await batch.commit();

    return {
      job: stripResultPayload(job),
      queuedAhead: Number(queuedAhead)
    };
  }

  async getPendingCounts({ limit = Number.MAX_SAFE_INTEGER } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit || 1), 1000));
    const [queueSnapshot, runningSnapshot] = await Promise.all([
      this.queue.limit(boundedLimit).get(),
      this.jobs.where("status", "==", "running").limit(boundedLimit).get()
    ]);

    return {
      queuedCrawls: queueSnapshot.size,
      runningCrawls: runningSnapshot.size
    };
  }

  async getMetrics() {
    const [queueSnapshot, runningSnapshot, trackedSnapshot] = await Promise.all([
      this.queue.get(),
      this.jobs.where("status", "==", "running").get(),
      this.jobs.get()
    ]);

    return {
      trackedJobs: trackedSnapshot.size,
      queuedCrawls: queueSnapshot.size,
      runningCrawls: runningSnapshot.size
    };
  }

  async claimNextQueuedJob({ ownerId, runToken, leaseDurationMs, now = Date.now() }) {
    let claimedJob = null;

    await this.firestore.runTransaction(async (transaction) => {
      const queueSnapshot = await transaction.get(this.queue.orderBy("createdAtMs").limit(1));
      if (queueSnapshot.empty) return;

      const queueDoc = queueSnapshot.docs[0];
      const jobId = String(queueDoc.data()?.jobId || queueDoc.id);
      const jobRef = this.jobs.doc(jobId);
      const jobSnapshot = await transaction.get(jobRef);

      if (!jobSnapshot.exists) {
        transaction.delete(queueDoc.ref);
        return;
      }

      const currentJob = { id: jobSnapshot.id, ...jobSnapshot.data() };
      if (currentJob.status !== "queued") {
        transaction.delete(queueDoc.ref);
        return;
      }

      const updated = applyLease(currentJob, { ownerId, runToken, leaseDurationMs, now });
      transaction.update(jobRef, cloneJson(updated));
      transaction.delete(queueDoc.ref);
      claimedJob = stripResultPayload(updated);
    });

    return claimedJob;
  }

  async claimExpiredRunningJob({ ownerId, runToken, leaseDurationMs, now = Date.now() }) {
    const runningSnapshot = await this.jobs.where("status", "==", "running").get();
    const expiredCandidates = runningSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((job) => Number(job.leaseExpiresAtMs || 0) <= Number(now))
      .sort((a, b) => {
        const byLease = Number(a.leaseExpiresAtMs || 0) - Number(b.leaseExpiresAtMs || 0);
        if (byLease !== 0) return byLease;
        return String(a.id || "").localeCompare(String(b.id || ""));
      });

    for (const candidate of expiredCandidates) {
      let claimedJob = null;
      await this.firestore.runTransaction(async (transaction) => {
        const jobRef = this.jobs.doc(candidate.id);
        const snapshot = await transaction.get(jobRef);
        if (!snapshot.exists) return;
        const currentJob = { id: snapshot.id, ...snapshot.data() };
        if (currentJob.status !== "running") return;
        if (Number(currentJob.leaseExpiresAtMs || 0) > Number(now)) return;

        const updated = applyLease(currentJob, { ownerId, runToken, leaseDurationMs, now });
        transaction.update(jobRef, cloneJson(updated));
        claimedJob = stripResultPayload(updated);
      });

      if (claimedJob) return claimedJob;
    }

    return null;
  }

  async touchJob({ jobId, ownerId, runToken, leaseDurationMs, progress = null, now = Date.now() }) {
    let updatedJob = null;

    await this.firestore.runTransaction(async (transaction) => {
      const jobRef = this.jobs.doc(String(jobId || ""));
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) return;

      const currentJob = { id: snapshot.id, ...snapshot.data() };
      if (currentJob.status !== "running") return;
      if (String(currentJob.ownerId || "") !== String(ownerId || "")) return;
      if (String(currentJob.runToken || "") !== String(runToken || "")) return;

      const updated = applyLease(currentJob, { ownerId, runToken, leaseDurationMs, now });
      updated.progress = progress ? mergeProgress(currentJob.progress, progress, now) : mergeProgress(currentJob.progress, {}, now);
      transaction.update(jobRef, cloneJson(updated));
      updatedJob = stripResultPayload(updated);
    });

    return updatedJob;
  }

  async completeJob({ jobId, ownerId, runToken, result, progress = null, now = Date.now() }) {
    const targetJobId = String(jobId || "");
    const updatedAtMs = Number(now);
    const encodedResult = encodeResultChunks(result, this.resultChunkBytes);
    const jobRef = this.jobs.doc(targetJobId);
    const resultCollection = jobRef.collection("resultChunks");
    const queueRef = this.queue.doc(targetJobId);

    let updatedJob = null;
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) return;

      const currentJob = { id: snapshot.id, ...snapshot.data() };
      if (String(currentJob.ownerId || "") !== String(ownerId || "")) return;
      if (String(currentJob.runToken || "") !== String(runToken || "")) return;

      const updated = {
        ...cloneJson(currentJob),
        status: "completed",
        updatedAt: toIsoString(updatedAtMs),
        updatedAtMs,
        finishedAt: toIsoString(updatedAtMs),
        finishedAtMs: updatedAtMs,
        progress: mergeProgress(currentJob.progress, progress || {}, updatedAtMs),
        resultInline: null,
        resultChunkCount: encodedResult.chunks.length,
        resultSizeBytes: encodedResult.sizeBytes,
        error: "",
        errorCode: "",
        errorDetails: null,
        ownerId: "",
        runToken: "",
        heartbeatAt: "",
        heartbeatAtMs: 0,
        leaseExpiresAt: "",
        leaseExpiresAtMs: 0
      };

      transaction.update(jobRef, cloneJson(updated));
      transaction.delete(queueRef);
      updatedJob = stripResultPayload(updated);
    });

    if (!updatedJob) return null;

    await this.replaceResultChunks(targetJobId, encodedResult.chunks);
    return updatedJob;
  }

  async failJob({ jobId, ownerId, runToken, clientError, progress = null, now = Date.now() }) {
    const targetJobId = String(jobId || "");
    const updatedAtMs = Number(now);
    const jobRef = this.jobs.doc(targetJobId);
    const queueRef = this.queue.doc(targetJobId);

    let updatedJob = null;
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) return;

      const currentJob = { id: snapshot.id, ...snapshot.data() };
      if (String(currentJob.ownerId || "") !== String(ownerId || "")) return;
      if (String(currentJob.runToken || "") !== String(runToken || "")) return;

      const updated = {
        ...cloneJson(currentJob),
        status: "failed",
        updatedAt: toIsoString(updatedAtMs),
        updatedAtMs,
        finishedAt: toIsoString(updatedAtMs),
        finishedAtMs: updatedAtMs,
        progress: mergeProgress(currentJob.progress, progress || {}, updatedAtMs),
        resultInline: null,
        resultChunkCount: 0,
        resultSizeBytes: 0,
        error: String(clientError?.message || "Crawl failed"),
        errorCode: String(clientError?.code || "INTERNAL_ERROR"),
        errorDetails: cloneJson(clientError?.details ?? null),
        ownerId: "",
        runToken: "",
        heartbeatAt: "",
        heartbeatAtMs: 0,
        leaseExpiresAt: "",
        leaseExpiresAtMs: 0
      };

      transaction.update(jobRef, cloneJson(updated));
      transaction.delete(queueRef);
      updatedJob = stripResultPayload(updated);
    });

    if (!updatedJob) return null;
    await this.replaceResultChunks(targetJobId, []);
    return updatedJob;
  }

  async pruneExpiredJobs({ ttlMs, now = Date.now() }) {
    const cutoff = Number(now) - Number(ttlMs || 0);
    const snapshot = await this.jobs.where("finishedAtMs", "<=", cutoff).get();
    if (snapshot.empty) return 0;

    for (const doc of snapshot.docs) {
      await this.deleteJobArtifacts(doc.id);
    }

    return snapshot.size;
  }

  async replaceResultChunks(jobId, chunks) {
    const resultCollection = this.jobs.doc(String(jobId || "")).collection("resultChunks");
    const existing = await resultCollection.get();
    const batch = this.firestore.batch();

    for (const doc of existing.docs) {
      batch.delete(doc.ref);
    }

    chunks.forEach((chunkBase64, index) => {
      batch.set(resultCollection.doc(String(index).padStart(6, "0")), {
        index,
        chunkBase64: String(chunkBase64 || "")
      });
    });

    await batch.commit();
  }

  async deleteJobArtifacts(jobId) {
    const jobRef = this.jobs.doc(String(jobId || ""));
    const queueRef = this.queue.doc(String(jobId || ""));
    const chunks = await jobRef.collection("resultChunks").get();
    const batch = this.firestore.batch();

    chunks.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    batch.delete(queueRef);
    batch.delete(jobRef);
    await batch.commit();
  }
}

function createFileCrawlJobStore(options) {
  return new FileCrawlJobStore(options);
}

function createFirestoreCrawlJobStore(options) {
  return new FirestoreCrawlJobStore(options);
}

export {
  DEFAULT_RESULT_CHUNK_BYTES,
  createFileCrawlJobStore,
  createFirestoreCrawlJobStore
};
