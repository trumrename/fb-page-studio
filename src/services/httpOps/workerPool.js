/**
 * Multi-thread (multi-worker async) pool for HTTP ops queue.
 * Runs hidden in process — no browser windows.
 */
import {
  claimNextOp,
  completeOp,
  failOp,
  ensureOpsQueueTables,
  queueStats,
} from "./opsQueue.js";
import { executeJob } from "./registry.js";

let running = false;
let stopFlag = false;
/** @type {Promise<void>|null} */
let loopPromise = null;
const state = {
  workers: 0,
  concurrency: 3,
  ticks: 0,
  last_error: null,
  last_job: null,
  started_at: null,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function workerLoop(workerId, concurrencySlot) {
  const id = `w${workerId}-${concurrencySlot}`;
  while (!stopFlag) {
    let job = null;
    try {
      job = claimNextOp(id);
      if (!job) {
        await sleep(800 + Math.random() * 400);
        continue;
      }
      state.last_job = { id: job.id, op: job.op, worker: id };
      const result = await executeJob(job);
      completeOp(job.id, result);
      state.ticks++;
      // polite gap between jobs on same worker
      await sleep(300);
    } catch (e) {
      const msg = e?.message || String(e);
      state.last_error = msg;
      if (job?.id) {
        const retry =
          e?.code === "SESSION_OP_NOT_MAPPED" ? false : true;
        const delay =
          /rate limit|(#4)|(#17)|(#32)/i.test(msg) ? 120_000 : 45_000;
        failOp(job.id, msg, {
          retry,
          retryAfterIso: new Date(Date.now() + delay).toISOString(),
        });
      }
      await sleep(500);
    }
  }
}

/**
 * @param {{ concurrency?: number }} [opts]
 */
export function startHttpOpsWorkers(opts = {}) {
  ensureOpsQueueTables();
  if (running) return getHttpOpsWorkerState();
  stopFlag = false;
  running = true;
  const concurrency = Math.max(1, Math.min(12, Number(opts.concurrency || 3)));
  state.concurrency = concurrency;
  state.workers = concurrency;
  state.started_at = new Date().toISOString();
  state.last_error = null;

  const loops = [];
  for (let i = 0; i < concurrency; i++) {
    loops.push(workerLoop(process.pid, i));
  }
  loopPromise = Promise.all(loops).finally(() => {
    running = false;
    state.workers = 0;
  });
  console.log(`[http-ops] worker pool started · concurrency=${concurrency}`);
  return getHttpOpsWorkerState();
}

export async function stopHttpOpsWorkers() {
  stopFlag = true;
  if (loopPromise) {
    await Promise.race([loopPromise, sleep(3000)]);
  }
  running = false;
  state.workers = 0;
  return getHttpOpsWorkerState();
}

export function getHttpOpsWorkerState() {
  return {
    running,
    ...state,
    queue: queueStats(),
  };
}
