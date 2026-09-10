/**
 * Job runner — multi-page tasks with per-page / per-task progress %.
 * Sequential Graph calls (safe). Live state for UI polling/SSE.
 */
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import {
  runOnePost,
  getPagePostConfig,
  mediaStats,
  getCaptionStats,
} from "./poster.js";
import { scheduleOnePost } from "./schedule.js";
import {
  createCommentSiteTracker,
  getCommentMaxPagesPerSite,
} from "./mediaLibrary.js";
import { getReportPaths } from "./reportExport.js";
import {
  isTransientGraphError,
  isGraphRateLimitError,
  isNetworkTransientError,
  estimateTransientWaitMs,
  waitWhileRateLimited,
} from "./rateLimit.js";

/** Auto-retry per task for Meta temp / throttle / network (bulk schedule & post). */
const TASK_TRANSIENT_MAX_ATTEMPTS = 8;

const bus = new EventEmitter();
bus.setMaxListeners(50);

/** @type {Map<string, object>} */
const jobs = new Map();
const MAX_JOBS = 40;
const JOB_STATE_FILE = path.join(path.dirname(config.databasePath), "jobs-state.json");
const JOB_HISTORY_FILE = path.join(path.dirname(config.databasePath), "jobs-history.jsonl");
const MAX_HISTORY = 200;
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PERSIST_THROTTLE_MS = 1500;
const TERMINAL_STATUSES = new Set(["ok", "fail", "partial", "stopped", "interrupted"]);

let persistTimer = null;
let persistDirty = false;
/** @type {Set<string>|null} */
let historyIdCache = null;

function persistJobsNow() {
  try {
    const list = [...jobs.values()]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, MAX_JOBS)
      .map((j) => {
        // Strip internal flags from disk snapshot
        const { _resume, _history_saved, _commentSiteTracker, ...rest } = j;
        return rest;
      });
    fs.writeFileSync(JOB_STATE_FILE, JSON.stringify(list, null, 2), "utf8");
    persistDirty = false;
  } catch (e) {
    console.warn("[jobs persist]", e.message);
  }
}

/** Throttle disk writes during live progress; force=true on terminal / shutdown. */
function persistJobs(force = false) {
  if (force) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistJobsNow();
    return;
  }
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (persistDirty) persistJobsNow();
  }, PERSIST_THROTTLE_MS);
}

function ensureHistoryIds() {
  if (historyIdCache) return historyIdCache;
  historyIdCache = new Set();
  try {
    if (!fs.existsSync(JOB_HISTORY_FILE)) return historyIdCache;
    const lines = fs.readFileSync(JOB_HISTORY_FILE, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.id) historyIdCache.add(String(row.id));
      } catch {
        /* skip bad line */
      }
    }
  } catch (e) {
    console.warn("[jobs history load]", e.message);
  }
  return historyIdCache;
}

function compactHistoryTask(t) {
  const r = t.result || {};
  return {
    id: t.id,
    index: t.index,
    kind: t.kind,
    status: t.status,
    percent: t.percent || 0,
    page_row_id: t.page_row_id,
    page_name: t.page_name,
    page_id: t.page_id,
    label: t.label,
    message: t.message || null,
    error: t.error || null,
    run_at: t.run_at || t.opts?.run_at || null,
    started_at: t.started_at || null,
    finished_at: t.finished_at || null,
    post_type: t.opts?.post_type || r.post_type || null,
    fb_post_id: r.post_id || r.fb_post_id || r.log?.fb_post_id || null,
    fb_post_url: r.post_url || r.fb_post_url || r.log?.fb_post_url || null,
    burst: !!t.opts?.burst,
    fb_check: t.fb_check || null,
  };
}

function historySummary(job) {
  const tasks = Array.isArray(job.tasks)
    ? job.tasks.slice(0, 500).map(compactHistoryTask)
    : [];
  return {
    id: job.id,
    title: job.title || job.id,
    type: job.type || "batch",
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    pages_expected: job.pages_expected ?? null,
    pages_planned: job.pages_planned ?? null,
    progress: job.progress
      ? {
          total: job.progress.total,
          done: job.progress.done,
          ok: job.progress.ok,
          fail: job.progress.fail,
          skipped: job.progress.skipped,
          percent: job.progress.percent,
        }
      : null,
    outcome: job.outcome || null,
    pages: (job.pages || []).map((p) => ({
      page_row_id: p.page_row_id,
      page_name: p.page_name,
      page_id: p.page_id,
      total: p.total,
      done: p.done,
      ok: p.ok,
      fail: p.fail,
      percent: p.percent,
      status: p.status,
      last_error: p.last_error || null,
    })),
    tasks,
    failed_tasks: (job.failed_tasks || []).map((t) => ({
      id: t.id,
      index: t.index,
      kind: t.kind,
      page_row_id: t.page_row_id,
      page_name: t.page_name,
      page_id: t.page_id,
      label: t.label,
      error: t.error || t.message || "Thất bại",
      message: t.message || null,
    })),
    archived_at: nowIso(),
  };
}

function trimHistoryFile(records) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const filtered = records.filter((r) => {
    const t = new Date(r.finished_at || r.archived_at || r.created_at || 0).getTime();
    return Number.isFinite(t) ? t >= cutoff : true;
  });
  // Keep newest MAX_HISTORY (file is append-order; newest at end)
  return filtered.length > MAX_HISTORY ? filtered.slice(-MAX_HISTORY) : filtered;
}

function archiveJobHistory(job) {
  if (!job?.id || !TERMINAL_STATUSES.has(job.status)) return;
  if (job._history_saved) return;
  const ids = ensureHistoryIds();
  if (ids.has(String(job.id))) {
    job._history_saved = true;
    return;
  }
  try {
    const dir = path.dirname(JOB_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const row = historySummary(job);
    fs.appendFileSync(JOB_HISTORY_FILE, JSON.stringify(row) + "\n", "utf8");
    ids.add(String(job.id));
    job._history_saved = true;

    // Occasional trim when file grows
    if (ids.size > MAX_HISTORY + 20) {
      const all = readHistoryRaw();
      const trimmed = trimHistoryFile(all);
      fs.writeFileSync(
        JOB_HISTORY_FILE,
        trimmed.map((r) => JSON.stringify(r)).join("\n") + (trimmed.length ? "\n" : ""),
        "utf8"
      );
      historyIdCache = new Set(trimmed.map((r) => String(r.id)));
    }
  } catch (e) {
    console.warn("[jobs history]", e.message);
  }
}

function readHistoryRaw() {
  try {
    if (!fs.existsSync(JOB_HISTORY_FILE)) return [];
    const lines = fs.readFileSync(JOB_HISTORY_FILE, "utf8").split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** List archived jobs (newest first). Summary only — no full task opts. */
export function listJobHistory(limit = 50) {
  const all = readHistoryRaw();
  const byId = new Map();
  for (const row of all) {
    if (row?.id) byId.set(String(row.id), row);
  }
  return [...byId.values()]
    .sort(
      (a, b) =>
        new Date(b.finished_at || b.archived_at || b.created_at) -
        new Date(a.finished_at || a.archived_at || a.created_at)
    )
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export function getJobHistory(id) {
  if (!id) return null;
  const want = String(id);
  const all = readHistoryRaw();
  for (let i = all.length - 1; i >= 0; i--) {
    if (String(all[i]?.id) === want) return all[i];
  }
  return null;
}

function restoreJobs() {
  try {
    if (!fs.existsSync(JOB_STATE_FILE)) return;
    const list = JSON.parse(fs.readFileSync(JOB_STATE_FILE, "utf8"));
    if (!Array.isArray(list)) return;
    for (const job of list.slice(0, MAX_JOBS)) {
      if (!job?.id || !Array.isArray(job.tasks)) continue;
      if (["running", "paused", "queued"].includes(job.status)) {
        job.status = "interrupted";
        let hasPending = false;
        for (const task of job.tasks) {
          if (task.status === "running") {
            // Task đang gọi Graph khi app đóng — không rõ đã gửi hay chưa.
            // Để fail (an toàn, tránh gửi trùng); reconcile FB sẽ xác nhận sau.
            task.status = "fail";
            task.percent = 100;
            task.error = "App đã đóng khi nhiệm vụ đang chạy (không rõ đã gửi chưa)";
            task.message = task.error;
            task.finished_at = nowIso();
          } else if (task.status === "pending") {
            // Giữ pending để chạy tiếp sau khi mở lại app.
            hasPending = true;
          }
        }
        job.stop_requested = false;
        if (hasPending) {
          // Còn task chưa chạy → re-arm: đưa về queued rồi runJob chạy tiếp.
          job.status = "queued";
          job.paused = false;
          job.finished_at = null;
          job.notifications = job.notifications || [];
          job.notifications.unshift({
            id: nanoid(6), level: "info", title: "Chạy tiếp job dở",
            body: "App vừa mở lại — tiếp tục các nhiệm vụ chưa hoàn tất.", at: nowIso(),
          });
          job._resume = true;
        } else {
          // Không còn task pending → coi như kết thúc theo trạng thái task.
          job.status = job.progress?.fail ? "partial" : "ok";
          job.paused = false;
          job.finished_at = nowIso();
        }
      }
      recompute(job);
      jobs.set(job.id, job);
      if (TERMINAL_STATUSES.has(job.status)) {
        archiveJobHistory(job);
      }
      if (job._resume) {
        delete job._resume;
        setImmediate(() => runJob(job.id).catch((e) => console.error("[job resume]", e)));
      }
    }
    persistJobs(true);
  } catch (e) {
    console.warn("[jobs restore]", e.message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function trimJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const list = [...jobs.values()].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );
  while (list.length > MAX_JOBS) {
    const old = list.shift();
    if (old && old.status !== "running") jobs.delete(old.id);
    // skip running jobs — continue to evict older non-running ones
  }
}

function emit(job) {
  const terminal = TERMINAL_STATUSES.has(job.status);
  if (terminal) archiveJobHistory(job);
  persistJobs(terminal);
  bus.emit("job", job);
  bus.emit(`job:${job.id}`, job);
}

function recompute(job) {
  const tasks = job.tasks || [];
  const total = tasks.length || 1;
  const done = tasks.filter((t) =>
    ["ok", "fail", "skipped"].includes(t.status)
  ).length;
  const ok = tasks.filter((t) => t.status === "ok").length;
  const fail = tasks.filter((t) => t.status === "fail").length;
  const skipped = tasks.filter((t) => t.status === "skipped").length;
  const running = tasks.find((t) => t.status === "running");
  const progressUnits = done + (running ? (Number(running.percent) || 0) / 100 : 0);
  // Phân loại tiến trình theo 3 loại giao hàng:
  // fb_scheduled = hẹn giờ FB (kind schedule); scheduled_direct = hẹn giờ đăng
  // trực tiếp (kind post có run_at); direct = đăng ngay.
  const taskMode = (t) =>
    t.kind === "schedule"
      ? "fb_scheduled"
      : t.opts?.run_at || t.run_at
        ? "scheduled_direct"
        : "direct";
  const by_mode = {
    direct: { total: 0, ok: 0, fail: 0, done: 0 },
    scheduled_direct: { total: 0, ok: 0, fail: 0, done: 0 },
    fb_scheduled: { total: 0, ok: 0, fail: 0, done: 0 },
  };
  for (const t of tasks) {
    const m = by_mode[taskMode(t)];
    m.total++;
    if (["ok", "fail", "skipped"].includes(t.status)) m.done++;
    if (t.status === "ok") m.ok++;
    if (t.status === "fail") m.fail++;
  }
  let comments_ok = 0;
  let comments_fail = 0;
  let comments_pending = 0;
  for (const t of tasks) {
    const r = t.result;
    if (!r) continue;
    if (r.comment_id) comments_ok += 1;
    else if (r.comment_error) comments_fail += 1;
    else if (r.comment_pending || (r.comment_text && !r.comment_id)) comments_pending += 1;
  }
  job.progress = {
    total,
    done,
    ok,
    fail,
    skipped,
    percent: Math.min(100, Math.round((progressUnits / total) * 100)),
    by_mode,
    comments_ok,
    comments_fail,
    comments_pending,
    current_task_id: running?.id || null,
    current_label: running
      ? `${running.page_name || "?"} · ${running.label || running.kind}`
      : done >= total
        ? "Hoàn tất"
        : "Chờ…",
  };
  // per-page rollup (+ last / all errors for UI)
  const byPage = {};
  for (const t of tasks) {
    const k = String(t.page_row_id ?? t.page_name ?? "?");
    if (!byPage[k]) {
      byPage[k] = {
        page_row_id: t.page_row_id,
        page_name: t.page_name,
        page_id: t.page_id,
        total: 0,
        done: 0,
        ok: 0,
        fail: 0,
        percent: 0,
        status: "pending",
        last_error: null,
        errors: [],
        failed_task_ids: [],
      };
    }
    const p = byPage[k];
    p.total++;
    if (["ok", "fail", "skipped"].includes(t.status)) p.done++;
    if (t.status === "ok") p.ok++;
    if (t.status === "fail") {
      p.fail++;
      const errText = String(t.error || t.message || "Thất bại").trim();
      if (errText) {
        p.last_error = errText;
        if (!p.errors.includes(errText)) p.errors.push(errText);
      }
      if (t.id) p.failed_task_ids.push(t.id);
    }
    if (t.status === "running") p.status = "running";
  }
  for (const p of Object.values(byPage)) {
    p.percent = p.total ? Math.round((p.done / p.total) * 100) : 0;
    if (p.status !== "running") {
      if (p.done >= p.total) p.status = p.fail && !p.ok ? "fail" : p.fail ? "partial" : "ok";
      else if (p.done > 0) p.status = "running";
      else p.status = "pending";
    }
  }
  job.pages = Object.values(byPage);
  job.failed_tasks = tasks
    .filter((t) => t.status === "fail")
    .map((t) => ({
      id: t.id,
      index: t.index,
      kind: t.kind,
      page_row_id: t.page_row_id,
      page_name: t.page_name,
      page_id: t.page_id,
      label: t.label,
      error: t.error || t.message || "Thất bại",
      message: t.message,
      opts: t.opts || {},
      run_at: t.run_at || null,
    }));
  return job;
}

function refreshResources(job) {
  const pageIds = [...new Set((job.tasks || []).map((t) => Number(t.page_row_id)).filter((id) => id > 0))];
  const mediaPools = new Map();
  const captionPools = new Map();
  for (const id of pageIds) {
    try {
      const cfg = getPagePostConfig(id);
      const task = (job.tasks || []).find((item) => Number(item.page_row_id) === id);
      const pageName = task?.page_name || `Page#${id}`;
      const mediaFolder = cfg.media_folder || "";
      const mediaKey = path.resolve(mediaFolder || ".").toLowerCase();
      if (!mediaPools.has(mediaKey)) {
        const media = mediaStats(mediaFolder);
        mediaPools.set(mediaKey, {
          media_folder: mediaFolder,
          posted_folder: cfg.posted_folder || "",
          photos: media.photos || 0,
          videos: media.videos || 0,
          page_names: [],
        });
      }
      const mediaPool = mediaPools.get(mediaKey);
      if (!mediaPool.page_names.includes(pageName)) mediaPool.page_names.push(pageName);

      const captionFolder = cfg.captions_folder || "";
      const captionKey = captionFolder
        ? `folder:${path.resolve(captionFolder).toLowerCase()}`
        : `inline:${JSON.stringify(cfg.captions || [])}`;
      if (!captionPools.has(captionKey)) {
        const captions = getCaptionStats(cfg);
        captionPools.set(captionKey, {
          captions_folder: captionFolder,
          captions: captions.available ?? captions.total ?? 0,
          captions_total: captions.total || 0,
          captions_used_recent: captions.used_recent || 0,
          caption_window_hours: captions.duplicate_window_hours || 0,
          page_names: [],
        });
      }
      const captionPool = captionPools.get(captionKey);
      if (!captionPool.page_names.includes(pageName)) captionPool.page_names.push(pageName);
    } catch {
      /* keep job running even if one config cannot be summarized */
    }
  }
  job.resources = {
    updated_at: nowIso(),
    media_pools: [...mediaPools.values()],
    caption_pools: [...captionPools.values()],
  };
}

export function subscribeJobs(fn) {
  bus.on("job", fn);
  return () => bus.off("job", fn);
}

export function subscribeJob(id, fn) {
  bus.on(`job:${id}`, fn);
  return () => bus.off(`job:${id}`, fn);
}

/**
 * Lightweight list for discover/poll — avoid cloning full tasks/opts every 1–2s.
 * Use getJob(id) when UI needs full detail.
 */
export function listJobs(limit = 20) {
  return [...jobs.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit)
    .map((j) => ({
      id: j.id,
      type: j.type,
      title: j.title,
      status: j.status,
      created_at: j.created_at,
      started_at: j.started_at,
      finished_at: j.finished_at,
      pages_expected: j.pages_expected ?? null,
      pages_planned: j.pages_planned ?? null,
      progress: j.progress
        ? {
            total: j.progress.total,
            done: j.progress.done,
            ok: j.progress.ok,
            fail: j.progress.fail,
            skipped: j.progress.skipped,
            percent: j.progress.percent,
            current_label: j.progress.current_label,
          }
        : null,
      page_count: Array.isArray(j.pages) ? j.pages.length : 0,
    }));
}

export function getJob(id) {
  const j = jobs.get(id);
  if (j && ["running", "paused", "queued"].includes(j.status)) {
    const lastRefresh = new Date(j.resources?.updated_at || 0).getTime();
    if (!Number.isFinite(lastRefresh) || Date.now() - lastRefresh >= 10_000) {
      refreshResources(j);
    }
  }
  return j ? publicJob(j) : null;
}

function publicJob(j) {
  return JSON.parse(JSON.stringify(j));
}

restoreJobs();

// Flush throttled persist on process exit so last progress isn't lost
process.once("exit", () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistDirty) persistJobsNow();
});

/**
 * Create job from task defs then run async.
 * task: { kind, page_row_id, page_name?, page_id?, label?, opts? }
 */
export function startJob({
  type,
  title,
  tasks,
  continuous = false,
  continuous_settings = null,
  next_plan_day = null,
  pages_expected = null,
  pages_planned = null,
} = {}) {
  trimJobs();
  const id = nanoid(10);
  // Comment site budget: mỗi domain (site) tối đa N page trong job này
  let commentSiteMax = 10;
  try {
    const firstPage = (tasks || []).map((t) => Number(t.page_row_id)).find((n) => n > 0);
    if (firstPage) {
      const cfg0 = getPagePostConfig(firstPage);
      commentSiteMax = getCommentMaxPagesPerSite(cfg0?.link_lists || {}, 10);
    }
  } catch {
    /* keep default 10 */
  }
  const job = {
    id,
    type: type || "batch",
    title: title || "Job",
    status: "queued",
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    error: null,
    /** soft stop after current task */
    stop_requested: false,
    /** pause between tasks until resume */
    paused: false,
    /** Shared across tasks — limit comment links per domain to N pages */
    _commentSiteTracker: createCommentSiteTracker(commentSiteMax),
    /** Direct Local: replan next day after finishing */
    continuous: !!continuous,
    continuous_settings: continuous_settings || null,
    next_plan_day: next_plan_day || null,
    /** Số page user tick vs số page thật sự có task (debug thiếu page) */
    pages_expected:
      pages_expected != null
        ? Number(pages_expected)
        : [...new Set((tasks || []).map((t) => Number(t.page_row_id)).filter((n) => n > 0))]
            .length,
    pages_planned:
      pages_planned != null
        ? Number(pages_planned)
        : [...new Set((tasks || []).map((t) => Number(t.page_row_id)).filter((n) => n > 0))]
            .length,
    day_cycle: 0,
    tasks: (tasks || []).map((t, i) => ({
      id: `${id}-t${i + 1}`,
      index: i + 1,
      kind: t.kind || "post",
      label: t.label || t.kind || "task",
      page_row_id: t.page_row_id,
      page_name: t.page_name || "—",
      page_id: t.page_id || null,
      status: "pending",
      percent: 0,
      message: "Chờ…",
      error: null,
      result: null,
      started_at: null,
      finished_at: null,
      run_at: t.run_at || t.opts?.run_at || null,
      opts: t.opts || {},
    })),
    notifications: [],
    report_files: [],
  };
  recompute(job);
  refreshResources(job);
  jobs.set(id, job);
  emit(job);

  setImmediate(() => runJob(id).catch((e) => console.error("[job]", e)));
  return publicJob(job);
}

/** Request stop after current Graph call finishes */
export function stopJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (!["running", "paused", "queued"].includes(job.status)) {
    return publicJob(job);
  }
  job.stop_requested = true;
  job.paused = false;
  notify(job, "warn", "Dừng job", "Sẽ dừng sau task hiện tại…");
  recompute(job);
  emit(job);
  return publicJob(job);
}

export function pauseJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status !== "running") return publicJob(job);
  job.paused = true;
  job.status = "paused";
  notify(job, "warn", "Tạm dừng", "Job tạm dừng giữa các task. Bấm Tiếp tục để chạy.");
  recompute(job);
  emit(job);
  return publicJob(job);
}

export function resumeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (!job.paused && job.status !== "paused") return publicJob(job);
  job.paused = false;
  if (job.status === "paused") job.status = "running";
  notify(job, "info", "Tiếp tục", "Job tiếp tục chạy.");
  recompute(job);
  emit(job);
  return publicJob(job);
}

/**
 * Start a new job that re-runs failed tasks from a finished (or interrupted) job.
 * body filters (optional):
 *  - task_ids: string[] only those failed task ids
 *  - page_row_ids: number[] only failed tasks on those pages
 *
 * Keeps original kind (post/schedule) and opts so schedule times / post_type are preserved.
 */
export function retryFailedJob(sourceJobId, { task_ids, page_row_ids } = {}) {
  const source = jobs.get(sourceJobId);
  if (!source) return null;
  if (["running", "paused", "queued"].includes(source.status)) {
    throw new Error("Job vẫn đang chạy — chờ xong hoặc dừng trước khi đăng lại lỗi.");
  }

  let failed = (source.tasks || []).filter((t) => t.status === "fail");
  if (Array.isArray(task_ids) && task_ids.length) {
    const want = new Set(task_ids.map(String));
    failed = failed.filter((t) => want.has(String(t.id)));
  }
  if (Array.isArray(page_row_ids) && page_row_ids.length) {
    const want = new Set(page_row_ids.map(Number));
    failed = failed.filter((t) => want.has(Number(t.page_row_id)));
  }
  if (!failed.length) {
    throw new Error("Không có nhiệm vụ lỗi phù hợp để đăng lại.");
  }

  const tasks = failed.map((t, retryIndex) => {
    const kind = t.kind === "schedule" ? "schedule" : "post";
    const opts = { ...(t.opts || {}) };
    // Direct-local run_at already passed → publish immediately on retry
    if (kind === "post") {
      delete opts.run_at;
    } else {
      const raw = opts.scheduled_publish_time;
      const numeric = Number(raw);
      const originalMs = Number.isFinite(numeric) && numeric > 0
        ? numeric * (numeric < 10_000_000_000 ? 1000 : 1)
        : new Date(raw).getTime();
      const minimumMs = Date.now() + (15 + retryIndex * 2) * 60 * 1000;
      if (!Number.isFinite(originalMs) || originalMs < minimumMs) {
        opts.scheduled_publish_time = Math.floor(minimumMs / 1000);
      }
    }
    return {
      kind,
      page_row_id: t.page_row_id,
      page_name: t.page_name,
      page_id: t.page_id,
      run_at: null,
      label:
        kind === "schedule"
          ? `Đăng lại hẹn giờ · ${t.page_name || ""}`.trim()
          : `Đăng lại · ${t.page_name || ""}`.trim(),
      opts: {
        ...opts,
        // Retry should not soft-block on quota/interval leftovers from first run
        ignore_quota: opts.ignore_quota ?? false,
        ignore_interval: opts.ignore_interval ?? false,
        retry_of_task_id: t.id,
        retry_of_job_id: source.id,
        previous_error: t.error || t.message || null,
      },
    };
  });

  return startJob({
    type: "retry_failed",
    title: `Đăng lại lỗi · ${failed.length} task · từ ${source.title || source.id}`,
    tasks,
  });
}

async function waitWhilePaused(job) {
  while (job.paused && !job.stop_requested) {
    job.status = "paused";
    recompute(job);
    emit(job);
    await sleep(400);
  }
  if (!job.stop_requested && job.status === "paused") {
    job.status = "running";
  }
}

function notify(job, level, title, body) {
  const n = {
    id: nanoid(6),
    level, // success | error | info | warn
    title,
    body,
    at: nowIso(),
  };
  job.notifications.unshift(n);
  if (job.notifications.length > 100) job.notifications.length = 100;
  return n;
}

function formatWait(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatDueVn(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
  });
}

/** Wait locally while the tool remains open, then execute a direct post. */
async function waitUntilTaskDue(job, task) {
  const raw = task.run_at || task.opts?.run_at;
  if (!raw) return true;
  const targetMs = typeof raw === "number" && raw < 10_000_000_000
    ? raw * 1000
    : new Date(raw).getTime();
  if (!Number.isFinite(targetMs)) throw new Error(`Thời điểm chạy local không hợp lệ: ${raw}`);
  task.due_at = new Date(targetMs).toISOString();
  let lastBucket = null;
  while (!job.stop_requested) {
    await waitWhilePaused(job);
    if (job.stop_requested) return false;
    const remainingMs = targetMs - Date.now();
    if (remainingMs <= 0) {
      task.wait_remaining_seconds = 0;
      return true;
    }
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    task.percent = 5;
    task.wait_remaining_seconds = remainingSeconds;
    task.message = `Tool đang chờ đến ${formatDueVn(task.due_at)} giờ VN · còn ${formatWait(remainingSeconds)}`;
    recompute(job);
    const bucket = Math.floor(remainingSeconds / 30);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      emit(job);
    }
    await sleep(Math.min(1000, remainingMs));
  }
  return false;
}

function burstGroupFrom(job, task) {
  if (!task?.opts?.burst) return [task];
  const idx = job.tasks.indexOf(task);
  if (idx < 0) return [task];
  const pageId = Number(task.page_row_id);
  const t0 = Date.parse(task.run_at || task.opts?.run_at || "") || 0;
  const group = [task];
  for (let i = idx + 1; i < job.tasks.length; i++) {
    const t = job.tasks[i];
    if (["ok", "fail", "skipped", "running"].includes(t.status)) break;
    if (!t.opts?.burst || Number(t.page_row_id) !== pageId) break;
    const t1 = Date.parse(t.run_at || t.opts?.run_at || "") || 0;
    if (t0 && t1 && t1 - t0 > 31_000) break;
    group.push(t);
    if (group.length >= 3) break;
  }
  return group;
}

async function finishTaskResult(job, task, result) {
  task.result = summarizeResult(result);
  task.percent = 100;
  if (result?.ok === false || result?.scheduled === false) {
    task.status = "fail";
    task.error = result.error || "Thất bại";
    task.message = `Thất bại: ${task.error}`;
    notify(job, "error", `FAIL · ${task.page_name}`, `${task.label}: ${task.error}`);
  } else {
    task.status = "ok";
    task.message = successMessage(task, result);
    if (result?.auto_retries) task.message += ` · tự retry ${result.auto_retries} lần`;
    notify(job, "success", `OK · ${task.page_name}`, task.message);
    const cr = task.result;
    if (cr?.comment_error) {
      notify(job, "warn", `Comment ✗ · ${task.page_name}`, String(cr.comment_error).slice(0, 180));
    } else if (cr?.comment_id) {
      notify(
        job,
        "success",
        `Comment ✓ · ${task.page_name}`,
        String(cr.comment_text || cr.comment_id || "").slice(0, 160)
      );
    } else if (cr?.comment_pending) {
      notify(
        job,
        "info",
        `Comment ⏳ · ${task.page_name}`,
        "Chờ bài publish rồi gửi comment (after_publish / retry)"
      );
    }
  }
  const paths = getReportPaths();
  job.report_files = uniqueFiles(job.report_files, {
    csv: paths.csv_exists ? paths.csv : null,
    xlsx: paths.xlsx_exists ? paths.xlsx : null,
  });
}

async function runBurstParallel(job, group) {
  const due = await waitUntilTaskDue(job, group[0]);
  if (!due) {
    for (const task of group) {
      task.status = "skipped";
      task.percent = 100;
      task.message = "Đã dừng trong lúc chờ giờ đăng trực tiếp";
      task.finished_at = nowIso();
    }
    recompute(job);
    emit(job);
    return;
  }
  const t0 = Date.parse(group[0].run_at || group[0].opts?.run_at || "") || Date.now();
  await Promise.all(
    group.map(async (task, i) => {
      const t1 = Date.parse(task.run_at || task.opts?.run_at || "") || t0;
      const delay = Math.max(0, Math.min(30_000, t1 - t0, i * 15_000));
      if (delay > 0) await sleep(delay);
      if (job.stop_requested) {
        task.status = "skipped";
        task.percent = 100;
        task.message = "Đã dừng — bỏ qua";
        task.finished_at = nowIso();
        return;
      }
      task.status = "running";
      task.percent = 40;
      task.message = `Burst ${i + 1}/${group.length} · đăng song song (cách ≤30s)…`;
      task.started_at = nowIso();
      recompute(job);
      emit(job);
      try {
        const result = await executeTaskWithRetry(job, task);
        await finishTaskResult(job, task, result);
      } catch (e) {
        task.status = "fail";
        task.percent = 100;
        task.error = e.message;
        task.message = `Thất bại: ${e.message}`;
        notify(job, "error", `FAIL · ${task.page_name}`, e.message);
      }
      task.finished_at = nowIso();
      refreshResources(job);
      recompute(job);
      emit(job);
    })
  );
}

async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (!job._commentSiteTracker) {
    let max = 10;
    try {
      const pid = (job.tasks || []).map((t) => Number(t.page_row_id)).find((n) => n > 0);
      if (pid) max = getCommentMaxPagesPerSite(getPagePostConfig(pid)?.link_lists || {}, 10);
    } catch {
      /* default */
    }
    job._commentSiteTracker = createCommentSiteTracker(max);
  }
  job.status = "running";
  job.started_at = nowIso();
  notify(job, "info", `Job bắt đầu · ${job.title}`, `${job.tasks.length} nhiệm vụ đang chạy tuần tự.`);
  recompute(job);
  emit(job);

  const consumed = new Set();
  for (const task of job.tasks) {
    // Resume-safe: task đã có kết quả cuối (ok/fail/skipped) thì KHÔNG chạy lại
    // — tránh đăng trùng khi job được re-arm sau khi mở lại app.
    if (consumed.has(task) || ["ok", "fail", "skipped"].includes(task.status)) {
      continue;
    }
    const burstGroup = burstGroupFrom(job, task);
    if (burstGroup.length > 1) {
      for (const t of burstGroup) consumed.add(t);
      if (job.stop_requested) {
        for (const t of burstGroup) {
          if (t.status === "pending") {
            t.status = "skipped";
            t.percent = 100;
            t.message = "Đã dừng — bỏ qua";
            t.finished_at = nowIso();
          }
        }
        continue;
      }
      await waitWhilePaused(job);
      await runBurstParallel(job, burstGroup);
      continue;
    }

    if (job.stop_requested) {
      if (task.status === "pending") {
        task.status = "skipped";
        task.percent = 100;
        task.message = "Đã dừng — bỏ qua";
        task.finished_at = nowIso();
      }
      continue;
    }

    await waitWhilePaused(job);
    if (job.stop_requested) {
      if (task.status === "pending") {
        task.status = "skipped";
        task.percent = 100;
        task.message = "Đã dừng — bỏ qua";
        task.finished_at = nowIso();
      }
      continue;
    }

    task.status = "running";
    task.percent = 10;
    task.message = "Đang chạy…";
    task.started_at = nowIso();
    recompute(job);
    emit(job);

    try {
      const due = await waitUntilTaskDue(job, task);
      if (!due) {
        task.status = "skipped";
        task.percent = 100;
        task.message = "Đã dừng trong lúc chờ giờ đăng trực tiếp";
        task.finished_at = nowIso();
        recompute(job);
        emit(job);
        continue;
      }
      task.percent = 40;
      task.message = "Đã đến giờ · đang đăng trực tiếp qua Facebook API…";
      recompute(job);
      emit(job);
      const result = await executeTaskWithRetry(job, task);
      task.result = summarizeResult(result);
      task.percent = 100;
      if (result?.ok === false || result?.scheduled === false) {
        task.status = "fail";
        task.error = result.error || "Thất bại";
        task.message = `Thất bại: ${task.error}`;
        notify(
          job,
          "error",
          `FAIL · ${task.page_name}`,
          `${task.label}: ${task.error}`
        );
      } else {
        task.status = "ok";
        task.message = successMessage(task, result);
        if (result?.auto_retries) {
          task.message += ` · tự retry ${result.auto_retries} lần`;
        }
        notify(
          job,
          "success",
          `OK · ${task.page_name}`,
          task.message
        );
      }
      // CSV/Excel written inside publish log pipeline (postLogCsv → reportExport)
      const paths = getReportPaths();
      job.report_files = uniqueFiles(job.report_files, {
        csv: paths.csv_exists ? paths.csv : null,
        xlsx: paths.xlsx_exists ? paths.xlsx : null,
      });
    } catch (e) {
      task.status = "fail";
      task.percent = 100;
      task.error = e.message;
      task.message = `Thất bại: ${e.message}`;
      notify(job, "error", `FAIL · ${task.page_name}`, e.message);
      const paths = getReportPaths();
      job.report_files = uniqueFiles(job.report_files, {
        csv: paths.csv_exists ? paths.csv : null,
        xlsx: paths.xlsx_exists ? paths.xlsx : null,
      });
    }

    task.finished_at = nowIso();
    refreshResources(job);
    recompute(job);
    emit(job);

    // Pace: gap 0 / cùng mốc giờ → bắn nhanh (chỉ ~80ms chống rate limit nhẹ)
    const next = job.tasks[job.tasks.indexOf(task) + 1];
    const tDue = Date.parse(task.run_at || task.opts?.run_at || "") || 0;
    const nDue = next
      ? Date.parse(next.run_at || next.opts?.run_at || "") || 0
      : 0;
    const burst =
      next &&
      tDue > 0 &&
      nDue > 0 &&
      Math.abs(nDue - tDue) < 15_000; // cùng đợt < 15s
    await sleep(burst ? 80 : 350);
  }

  // Mark remaining pending as skipped if stopped mid-run
  for (const task of job.tasks) {
    if (task.status === "pending") {
      task.status = "skipped";
      task.percent = 100;
      task.message = "Đã dừng — bỏ qua";
      task.finished_at = nowIso();
    }
  }

  if (job.stop_requested) {
    job.status = "stopped";
    job.finished_at = nowIso();
    recompute(job);
    refreshResources(job);
    job.outcome = {
      expected: job.progress.total,
      success: job.progress.ok,
      failed: job.progress.fail,
      skipped: job.progress.skipped,
      shortfall: Math.max(0, job.progress.total - job.progress.ok),
    };
    notify(
      job,
      "warn",
      `Job dừng · ${job.title}`,
      `OK ${job.progress.ok} · FAIL ${job.progress.fail} · SKIP ${job.progress.skipped}`
    );
    emit(job);
    return;
  }

  // Continuous Direct Local: lập ngày kế tiếp và chạy tiếp (đến khi bấm Dừng)
  while (
    job.continuous &&
    job.continuous_settings &&
    job.type === "rotation_run_now" &&
    !job.stop_requested
  ) {
    try {
      const { buildRunNowPlan } = await import("./rotationPlan.js");
      job.day_cycle = (job.day_cycle || 0) + 1;
      const forceDay = job.next_plan_day || null;
      notify(
        job,
        "info",
        `Chu kỳ ${job.day_cycle} xong · lập ngày tiếp`,
        forceDay
          ? `Đang lập lịch ngày ${forceDay} (chạy liên tục)…`
          : "Đang lập lịch ngày kế tiếp (chạy liên tục)…"
      );
      recompute(job);
      emit(job);

      // Giữ đúng phạm vi page lúc bấm Chạy (selected + page_row_ids) — không mở rộng all
      const cont = job.continuous_settings || {};
      const plan = buildRunNowPlan({
        ...cont,
        page_target_mode: cont.page_target_mode === "all" ? "all" : "selected",
        page_row_ids:
          cont.page_target_mode === "all"
            ? []
            : (cont.page_row_ids || []).map(Number).filter((n) => n > 0),
        force_plan_day: forceDay || undefined,
      });
      if (plan.blockers?.length || !plan.slots?.length) {
        notify(
          job,
          "warn",
          "Tạm dừng lập ngày tiếp",
          plan.blockers?.[0] || "Không có slot — thử lại sau 30 phút"
        );
        // chờ rồi thử lại (có thể folder media trống tạm thời)
        for (let w = 0; w < 60 && !job.stop_requested; w++) {
          await sleep(30_000);
          await waitWhilePaused(job);
        }
        continue;
      }

      const firstMs = plan.slots[0].unix * 1000;
      while (!job.stop_requested && firstMs - Date.now() > 60_000) {
        const remain = firstMs - Date.now();
        job.message = `Chạy liên tục · chờ ngày ${plan.summary?.plan_day || "mới"} · còn ${Math.ceil(remain / 60000)} phút`;
        emit(job);
        await sleep(Math.min(30_000, Math.max(1000, remain - 30_000)));
        await waitWhilePaused(job);
      }
      if (job.stop_requested) break;

      const base = job.tasks.length;
      for (const s of plan.slots) {
        job.tasks.push({
          id: `${job.id}-t${job.tasks.length + 1}`,
          index: job.tasks.length + 1,
          kind: "post",
          label: s.immediate
            ? `Ngày ${plan.summary?.plan_day || "?"} · Vòng ${s.post_round} · đăng ngay · ${s.account_name}`
            : `Ngày ${plan.summary?.plan_day || "?"} · Vòng ${s.post_round} · chờ ${s.local_label} · ${s.account_name}`,
          page_row_id: s.page_row_id,
          page_name: s.page_name,
          page_id: s.page_id,
          status: "pending",
          percent: 0,
          message: "Chờ…",
          error: null,
          result: null,
          started_at: null,
          finished_at: null,
          run_at: s.iso,
          opts: {
            // Direct Local continuous: cùng first batch — gap/quota do lịch, không chặn lại
            ignore_quota: true,
            ignore_interval: true,
            burst: !!s.burst,
            post_type: s.planned_post_type,
            run_at: s.iso,
            use_caption: job.continuous_settings?.use_caption !== false,
          },
        });
      }
      job.next_plan_day = plan.summary?.next_plan_day || null;
      const baseTitle = String(job.title || "Direct Local").split(" · ngày")[0];
      job.title = `${baseTitle} · ngày ${plan.summary?.plan_day || "?"} · chu kỳ ${job.day_cycle + 1}`;
      recompute(job);
      refreshResources(job);
      notify(
        job,
        "info",
        `Đã thêm ${plan.slots.length} task ngày ${plan.summary?.plan_day}`,
        "Tiếp tục treo tool — bấm Dừng để kết thúc."
      );
      emit(job);

      const consumedDay = new Set();
      for (let i = base; i < job.tasks.length; i++) {
        if (job.stop_requested) break;
        const task = job.tasks[i];
        if (consumedDay.has(task) || ["ok", "fail", "skipped"].includes(task.status)) continue;
        const burstGroup = burstGroupFrom(job, task);
        if (burstGroup.length > 1) {
          for (const t of burstGroup) consumedDay.add(t);
          await waitWhilePaused(job);
          if (job.stop_requested) {
            for (const t of burstGroup) {
              if (t.status === "pending") {
                t.status = "skipped";
                t.percent = 100;
                t.message = "Đã dừng — bỏ qua";
                t.finished_at = nowIso();
              }
            }
            continue;
          }
          await runBurstParallel(job, burstGroup);
          continue;
        }
        await waitWhilePaused(job);
        if (job.stop_requested) {
          if (task.status === "pending") {
            task.status = "skipped";
            task.percent = 100;
            task.message = "Đã dừng — bỏ qua";
            task.finished_at = nowIso();
          }
          continue;
        }
        task.status = "running";
        task.percent = 10;
        task.message = "Đang chạy…";
        task.started_at = nowIso();
        recompute(job);
        emit(job);
        try {
          const due = await waitUntilTaskDue(job, task);
          if (!due) {
            task.status = "skipped";
            task.percent = 100;
            task.message = "Đã dừng trong lúc chờ giờ đăng trực tiếp";
            task.finished_at = nowIso();
            recompute(job);
            emit(job);
            continue;
          }
          task.percent = 40;
          task.message = "Đã đến giờ · đang đăng trực tiếp qua Facebook API…";
          recompute(job);
          emit(job);
          const result = await executeTask(task, job);
          task.result = summarizeResult(result);
          task.percent = 100;
          if (result?.ok === false || result?.scheduled === false) {
            task.status = "fail";
            task.error = result.error || "Thất bại";
            task.message = `Thất bại: ${task.error}`;
            notify(job, "error", `FAIL · ${task.page_name}`, `${task.label}: ${task.error}`);
          } else {
            task.status = "ok";
            task.message = "Xong";
            notify(job, "success", `OK · ${task.page_name}`, task.label);
          }
        } catch (e) {
          task.status = "fail";
          task.error = e.message;
          task.percent = 100;
          task.message = `Thất bại: ${e.message}`;
          notify(job, "error", `FAIL · ${task.page_name}`, e.message);
        }
        task.finished_at = nowIso();
        refreshResources(job);
        recompute(job);
        emit(job);
        await sleep(350);
      }
    } catch (e) {
      console.error("[job continuous]", e);
      notify(job, "error", "Lỗi lập ngày liên tục", e.message);
      break;
    }
  }

  if (job.stop_requested) {
    job.status = "stopped";
    job.finished_at = nowIso();
    recompute(job);
    refreshResources(job);
    notify(job, "warn", `Job dừng · ${job.title}`, `OK ${job.progress.ok} · FAIL ${job.progress.fail}`);
    emit(job);
    return;
  }

  job.status =
    job.progress.fail && !job.progress.ok
      ? "fail"
      : job.progress.fail
        ? "partial"
        : "ok";
  job.finished_at = nowIso();
  job.outcome = {
    expected: job.progress.total,
    success: job.progress.ok,
    failed: job.progress.fail,
    skipped: job.progress.skipped,
    shortfall: Math.max(0, job.progress.total - job.progress.ok),
  };
  recompute(job);
  notify(
    job,
    job.status === "ok" ? "success" : job.status === "partial" ? "warn" : "error",
    job.continuous ? `Kết thúc chu kỳ · ${job.title}` : `Job xong · ${job.title}`,
    `OK ${job.progress.ok} · FAIL ${job.progress.fail} · ${job.progress.percent}%`
  );
  emit(job);
}

function uniqueFiles(list, paths) {
  const set = new Set(list || []);
  if (paths.csv) set.add(paths.csv);
  if (paths.xlsx) set.add(paths.xlsx);
  return [...set];
}

function summarizeResult(result) {
  if (!result) return null;
  const commentText =
    result.comment_text ||
    result.comment_text_preview ||
    result.log?.comment_text ||
    null;
  const commentId = result.comment_id || result.log?.comment_id || null;
  const commentError = result.comment_error || null;
  const commentPending =
    !!result.comment_pending ||
    (!!commentText && !commentId && !commentError && !!result.scheduled);
  return {
    ok: result.ok !== false && result.scheduled !== false,
    post_id: result.post?.post_id || result.log?.fb_post_id || null,
    post_url: result.post?.post_url || result.log?.fb_post_url || null,
    post_type: result.post_type || result.log?.post_type || null,
    caption: result.log?.caption || null,
    media_moved_to: result.media_moved_to || null,
    scheduled_at: result.scheduled_at_iso || result.log?.scheduled_publish_time || null,
    error: result.error || null,
    comment_id: commentId,
    comment_text: commentText,
    comment_error: commentError,
    comment_pending: commentPending,
    comment_when: result.comment_when || null,
    comment_immediate: !!result.comment_immediate || !!commentId,
  };
}

function successMessage(task, result) {
  const r = summarizeResult(result);
  const link = r?.post_url || r?.post_id || "—";
  let base =
    task.kind === "schedule" || result?.scheduled
      ? `Đã hẹn ${r?.post_type || ""} · ${r?.scheduled_at || ""} · ${link}`
      : `Đã đăng ${r?.post_type || ""} · ${link}`;
  if (r?.comment_error) base += ` · comment ✗ ${r.comment_error}`;
  else if (r?.comment_id) base += " · comment ✓";
  else if (r?.comment_pending) base += " · comment ⏳ chờ sau publish";
  else if (r?.comment_text) base += " · comment đã gán";
  return base;
}

async function executeTask(task, job = null) {
  const kind = task.kind;
  task.percent = 40;
  if (kind === "post" || kind === "run") {
    // Task có run_at = hẹn giờ đăng trực tiếp (tool chờ → published=true).
    // Ảnh / video / text đều dùng path này khi user chọn mode đó.
    const deliveryMode = task.opts && task.opts.run_at ? "scheduled_direct" : "direct";
    return runOnePost(task.page_row_id, {
      force: true,
      ignore_quota: !!task.opts.ignore_quota,
      ignore_interval: !!task.opts.ignore_interval,
      burst: !!task.opts.burst,
      post_type: task.opts.post_type,
      delivery_mode: deliveryMode,
      use_caption: task.opts.use_caption,
      comment_site_tracker: job?._commentSiteTracker || null,
    });
  }
  if (kind === "schedule") {
    // Hẹn giờ Facebook (Graph scheduled_publish_time) — ảnh/video/text
    return scheduleOnePost(task.page_row_id, {
      scheduled_publish_time: task.opts.scheduled_publish_time,
      post_type: task.opts.post_type,
      caption: task.opts.caption,
      use_caption: task.opts.use_caption,
      comment_site_tracker: job?._commentSiteTracker || null,
    });
  }
  throw new Error(`Unknown task kind: ${kind}`);
}

/** Normalize task fail payloads / thrown errors for transient detection. */
function asTransientProbe(resultOrErr) {
  if (!resultOrErr) return null;
  if (resultOrErr instanceof Error) return resultOrErr;
  if (typeof resultOrErr === "object") {
    return {
      message: resultOrErr.error || resultOrErr.message || "",
      code: resultOrErr.code ?? resultOrErr.fb?.code,
      fb: resultOrErr.fb || resultOrErr.error_fb || null,
      http_status: resultOrErr.http_status || resultOrErr.status,
    };
  }
  return { message: String(resultOrErr) };
}

function isRetryableTaskOutcome(resultOrErr) {
  return isTransientGraphError(asTransientProbe(resultOrErr));
}

/**
 * Run one post/schedule task with automatic retries on:
 * - Meta "Please retry your request later" / unexpected error
 * - rate / throttle limits
 * - network "fetch failed"
 */
async function executeTaskWithRetry(job, task) {
  const maxAttempts = TASK_TRANSIENT_MAX_ATTEMPTS;
  let lastResult = null;
  let lastError = null;
  let autoRetries = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (job.stop_requested) {
      const err = new Error("Đã dừng khi đang retry Facebook");
      err.code = "STOPPED";
      throw err;
    }
    try {
      if (attempt > 0) {
        task.percent = Math.min(55, 35 + attempt * 2);
        task.message = `Tự thử lại ${attempt + 1}/${maxAttempts}…`;
        recompute(job);
        emit(job);
      }
      const result = await executeTask(task, job);
      lastResult = result;
      const failed = result?.ok === false || result?.scheduled === false;
      if (!failed) {
        if (autoRetries > 0 && result && typeof result === "object") {
          result.auto_retries = autoRetries;
        }
        return result;
      }
      if (!isRetryableTaskOutcome(result) || attempt >= maxAttempts - 1) {
        if (autoRetries > 0 && result && typeof result === "object") {
          result.error = `${result.error || "Thất bại"} (đã tự retry ${autoRetries} lần)`;
        }
        return result;
      }
      lastError = new Error(result.error || "Thất bại tạm thời");
      lastError.fb = result.fb || null;
      lastError.code = result.fb?.code || result.code;
    } catch (e) {
      lastError = e;
      if (!isRetryableTaskOutcome(e) || attempt >= maxAttempts - 1) {
        if (autoRetries > 0) {
          e.message = `${e.message || e} (đã tự retry ${autoRetries} lần)`;
        }
        throw e;
      }
    }

    autoRetries += 1;
    const probe = asTransientProbe(lastError || lastResult);
    const waitMs = estimateTransientWaitMs(probe, { attempt });
    const isLimit = isGraphRateLimitError(probe);
    const isNet = isNetworkTransientError(probe);
    const kindLabel = isLimit ? "limit/throttle" : isNet ? "mạng" : "lỗi tạm FB";
    task.retry_count = autoRetries;
    task.message = `⚠ ${kindLabel}: chờ ~${Math.ceil(waitMs / 1000)}s rồi tự thử lại (${attempt + 1}/${maxAttempts})`;
    task.percent = Math.min(50, 30 + attempt * 2);
    recompute(job);
    emit(job);
    notify(
      job,
      "warn",
      `Tự retry · ${task.page_name}`,
      `${task.label}: ${kindLabel} — chờ ${Math.ceil(waitMs / 1000)}s (lần ${attempt + 1}/${maxAttempts})`
    );

    const w = await waitWhileRateLimited(waitMs, {
      attempt: attempt + 1,
      shouldStop: () => job.stop_requested,
      message: task.message,
      onTick: (tick) => {
        task.message = `⚠ ${kindLabel}: còn ${tick.remaining_sec}s… rồi tự thử lại (${attempt + 1}/${maxAttempts})`;
        task.wait_remaining_seconds = tick.remaining_sec;
        recompute(job);
        if (tick.remaining_sec % 5 === 0 || tick.remaining_sec <= 3) emit(job);
      },
    });
    if (w.stopped) {
      const err = new Error("Đã dừng khi đang chờ retry Facebook");
      err.code = "STOPPED";
      throw err;
    }
    delete task.wait_remaining_seconds;
  }

  if (lastResult) return lastResult;
  throw lastError || new Error("Hết số lần tự retry Facebook");
}


function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build publish-now job for many pages (1 post each).
 */
export function startBulkPostJob({
  page_row_ids,
  pagesMeta = [],
  ignore_quota = false,
  ignore_interval = false,
  title,
} = {}) {
  const meta = new Map(pagesMeta.map((p) => [p.id, p]));
  const tasks = (page_row_ids || []).map((id) => {
    const p = meta.get(id) || {};
    return {
      kind: "post",
      page_row_id: id,
      page_name: p.name || `page#${id}`,
      page_id: p.page_id || null,
      label: "Đăng 1 bài ngay",
      opts: { ignore_quota, ignore_interval },
    };
  });
  return startJob({
    type: "bulk_post",
    title: title || `Đăng ngay · ${tasks.length} page`,
    tasks,
  });
}

/**
 * Build schedule job from flat list of slots.
 * slots: [{ page_row_id, page_name, page_id, unix, post_type? }]
 */
export function startBulkScheduleJob({
  slots,
  title,
  pages_expected = null,
  pages_planned = null,
} = {}) {
  // kind=schedule → hẹn giờ Facebook (Graph). Ảnh/video/text đều qua path này.
  // Mode «chờ giờ đăng trực tiếp» là kind=post + run_at (job khác / rotation), không gộp vào đây.
  const tasks = (slots || []).map((s, i) => ({
    kind: "schedule",
    page_row_id: s.page_row_id,
    page_name: s.page_name || `page#${s.page_row_id}`,
    page_id: s.page_id || null,
    label: `Hẹn giờ #${i + 1} · ${s.local_label || s.unix || ""}`,
    opts: {
      scheduled_publish_time: s.unix || s.scheduled_publish_time,
      post_type: s.post_type,
      use_caption: s.use_caption,
    },
  }));
  const uniquePages = [
    ...new Set(tasks.map((t) => Number(t.page_row_id)).filter((n) => n > 0)),
  ];
  return startJob({
    type: "bulk_schedule",
    title: title || `Hẹn giờ FB · ${tasks.length} slot · ${uniquePages.length} page`,
    tasks,
    pages_expected: pages_expected != null ? pages_expected : uniquePages.length,
    pages_planned: pages_planned != null ? pages_planned : uniquePages.length,
  });
}
