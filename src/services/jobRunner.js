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
import { getReportPaths } from "./reportExport.js";

const bus = new EventEmitter();
bus.setMaxListeners(50);

/** @type {Map<string, object>} */
const jobs = new Map();
const MAX_JOBS = 40;
const JOB_STATE_FILE = path.join(path.dirname(config.databasePath), "jobs-state.json");

function persistJobs() {
  try {
    const list = [...jobs.values()]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, MAX_JOBS);
    fs.writeFileSync(JOB_STATE_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.warn("[jobs persist]", e.message);
  }
}

function restoreJobs() {
  try {
    if (!fs.existsSync(JOB_STATE_FILE)) return;
    const list = JSON.parse(fs.readFileSync(JOB_STATE_FILE, "utf8"));
    if (!Array.isArray(list)) return;
    for (const job of list.slice(0, MAX_JOBS)) {
      if (!job?.id || !Array.isArray(job.tasks)) continue;
      if (["running", "paused", "queued"].includes(job.status)) {
        for (const task of job.tasks) {
          if (task.status === "running") {
            task.status = "fail";
            task.percent = 100;
            task.error = "App đã đóng hoặc khởi động lại khi nhiệm vụ đang chạy";
            task.message = task.error;
            task.finished_at = nowIso();
          } else if (task.status === "pending") {
            task.status = "skipped";
            task.percent = 100;
            task.message = "Bỏ qua vì App đã khởi động lại";
            task.finished_at = nowIso();
          }
        }
        job.status = "interrupted";
        job.paused = false;
        job.stop_requested = true;
        job.finished_at = nowIso();
        job.notifications = job.notifications || [];
        job.notifications.unshift({
          id: nanoid(6), level: "error", title: "Job bị gián đoạn",
          body: "App đã đóng hoặc khởi động lại trước khi job hoàn tất.", at: nowIso(),
        });
      }
      recompute(job);
      jobs.set(job.id, job);
    }
    persistJobs();
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
    else break;
  }
}

function emit(job) {
  persistJobs();
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
  job.progress = {
    total,
    done,
    ok,
    fail,
    skipped,
    percent: Math.min(100, Math.round((progressUnits / total) * 100)),
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
  const folders = new Map();
  for (const id of pageIds) {
    try {
      const cfg = getPagePostConfig(id);
      const key = `${cfg.media_folder || ""}|${cfg.captions_folder || ""}`;
      if (folders.has(key)) continue;
      const media = mediaStats(cfg.media_folder);
      const captions = getCaptionStats(cfg);
      folders.set(key, {
        media_folder: cfg.media_folder || "",
        posted_folder: cfg.posted_folder || "",
        captions_folder: cfg.captions_folder || "",
        photos: media.photos || 0,
        videos: media.videos || 0,
        captions: captions.available ?? captions.total ?? 0,
        captions_total: captions.total || 0,
        captions_used_recent: captions.used_recent || 0,
        caption_window_hours: captions.duplicate_window_hours || 0,
      });
    } catch {
      /* keep job running even if one config cannot be summarized */
    }
  }
  job.resources = {
    updated_at: nowIso(),
    folders: [...folders.values()],
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

export function listJobs(limit = 20) {
  return [...jobs.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit)
    .map((j) => publicJob(j));
}

export function getJob(id) {
  const j = jobs.get(id);
  return j ? publicJob(j) : null;
}

function publicJob(j) {
  return JSON.parse(JSON.stringify(j));
}

restoreJobs();

/**
 * Create job from task defs then run async.
 * task: { kind, page_row_id, page_name?, page_id?, label?, opts? }
 */
export function startJob({ type, title, tasks }) {
  trimJobs();
  const id = nanoid(10);
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

  const tasks = failed.map((t) => {
    const kind = t.kind === "schedule" ? "schedule" : "post";
    const opts = { ...(t.opts || {}) };
    // Direct-local run_at already passed → publish immediately on retry
    if (kind === "post") {
      delete opts.run_at;
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

async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "running";
  job.started_at = nowIso();
  notify(job, "info", `Job bắt đầu · ${job.title}`, `${job.tasks.length} nhiệm vụ đang chạy tuần tự.`);
  recompute(job);
  emit(job);

  for (const task of job.tasks) {
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
      const result = await executeTask(task);
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

    // gentle pace between tasks
    await sleep(350);
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
    `Job xong · ${job.title}`,
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
  return {
    ok: result.ok !== false && result.scheduled !== false,
    post_id: result.post?.post_id || result.log?.fb_post_id || null,
    post_url: result.post?.post_url || result.log?.fb_post_url || null,
    post_type: result.post_type || result.log?.post_type || null,
    caption: result.log?.caption || null,
    media_moved_to: result.media_moved_to || null,
    scheduled_at: result.scheduled_at_iso || result.log?.scheduled_publish_time || null,
    error: result.error || null,
  };
}

function successMessage(task, result) {
  const r = summarizeResult(result);
  const link = r?.post_url || r?.post_id || "—";
  if (task.kind === "schedule" || result?.scheduled) {
    return `Đã hẹn ${r?.post_type || ""} · ${r?.scheduled_at || ""} · ${link}`;
  }
  return `Đã đăng ${r?.post_type || ""} · ${link}`;
}

async function executeTask(task) {
  const kind = task.kind;
  task.percent = 40;
  if (kind === "post" || kind === "run") {
    return runOnePost(task.page_row_id, {
      force: true,
      ignore_quota: !!task.opts.ignore_quota,
      ignore_interval: !!task.opts.ignore_interval,
      post_type: task.opts.post_type,
    });
  }
  if (kind === "schedule") {
    return scheduleOnePost(task.page_row_id, {
      scheduled_publish_time: task.opts.scheduled_publish_time,
      post_type: task.opts.post_type,
      caption: task.opts.caption,
    });
  }
  throw new Error(`Unknown task kind: ${kind}`);
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
export function startBulkScheduleJob({ slots, title } = {}) {
  const tasks = (slots || []).map((s, i) => ({
    kind: "schedule",
    page_row_id: s.page_row_id,
    page_name: s.page_name || `page#${s.page_row_id}`,
    page_id: s.page_id || null,
    label: `Hẹn giờ #${i + 1} · ${s.local_label || s.unix || ""}`,
    opts: {
      scheduled_publish_time: s.unix || s.scheduled_publish_time,
      post_type: s.post_type,
    },
  }));
  return startJob({
    type: "bulk_schedule",
    title: title || `Hẹn giờ FB · ${tasks.length} slot`,
    tasks,
  });
}
