/**
 * Job runner — multi-page tasks with per-page / per-task progress %.
 * Sequential Graph calls (safe). Live state for UI polling/SSE.
 */
import { EventEmitter } from "events";
import { nanoid } from "nanoid";
import { runOnePost } from "./poster.js";
import { scheduleOnePost } from "./schedule.js";
import { getReportPaths } from "./reportExport.js";

const bus = new EventEmitter();
bus.setMaxListeners(50);

/** @type {Map<string, object>} */
const jobs = new Map();
const MAX_JOBS = 40;

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
  job.progress = {
    total,
    done,
    ok,
    fail,
    skipped,
    percent: Math.min(100, Math.round((done / total) * 100)),
    current_task_id: running?.id || null,
    current_label: running
      ? `${running.page_name || "?"} · ${running.label || running.kind}`
      : done >= total
        ? "Hoàn tất"
        : "Chờ…",
  };
  // per-page rollup
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
      };
    }
    const p = byPage[k];
    p.total++;
    if (["ok", "fail", "skipped"].includes(t.status)) p.done++;
    if (t.status === "ok") p.ok++;
    if (t.status === "fail") p.fail++;
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
  return job;
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
      opts: t.opts || {},
    })),
    notifications: [],
    report_files: [],
  };
  recompute(job);
  jobs.set(id, job);
  emit(job);

  setImmediate(() => runJob(id).catch((e) => console.error("[job]", e)));
  return publicJob(job);
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

async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "running";
  job.started_at = nowIso();
  recompute(job);
  emit(job);

  for (const task of job.tasks) {
    task.status = "running";
    task.percent = 10;
    task.message = "Đang chạy…";
    task.started_at = nowIso();
    recompute(job);
    emit(job);

    try {
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
    recompute(job);
    emit(job);

    // gentle pace between tasks
    await sleep(350);
  }

  job.status =
    job.progress.fail && !job.progress.ok
      ? "fail"
      : job.progress.fail
        ? "partial"
        : "ok";
  job.finished_at = nowIso();
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
