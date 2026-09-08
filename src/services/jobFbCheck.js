/**
 * Đối soát task lịch sử với Graph API (bài còn trên Page hay đã mất).
 */
import { getDb } from "../db/index.js";
import { getPageToken } from "./accounts.js";
import { graphGetSoft } from "./facebook.js";
import { getJob, getJobHistory } from "./jobRunner.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function taskPostId(t) {
  return String(
    t.fb_post_id ||
      t.result?.post_id ||
      t.result?.fb_post_id ||
      t.result?.log?.fb_post_id ||
      ""
  ).trim();
}

function taskPostUrl(t) {
  return String(
    t.fb_post_url ||
      t.result?.post_url ||
      t.result?.fb_post_url ||
      t.result?.log?.fb_post_url ||
      ""
  ).trim();
}

function loadTasksForJob(job) {
  if (Array.isArray(job.tasks) && job.tasks.length) return job.tasks;
  if (Array.isArray(job.failed_tasks) && job.failed_tasks.length) {
    return job.failed_tasks;
  }
  return [];
}

function fillMissingIdsFromLogs(tasks) {
  const db = getDb();
  for (const t of tasks) {
    if (taskPostId(t) || t.status !== "ok") continue;
    const rowId = Number(t.page_row_id);
    if (!rowId) continue;
    const row = db
      .prepare(
        `SELECT fb_post_id, fb_post_url FROM post_logs
         WHERE page_row_id = ? AND status IN ('ok','ok_comment_failed','published','scheduled')
           AND fb_post_id IS NOT NULL AND fb_post_id != ''
         ORDER BY id DESC LIMIT 1`
      )
      .get(rowId);
    if (row?.fb_post_id) {
      t.fb_post_id = row.fb_post_id;
      t.fb_post_url = t.fb_post_url || row.fb_post_url;
    }
  }
}

export async function reconcileJobWithFacebook(jobId) {
  const live = getJob(jobId);
  const archived = live ? null : getJobHistory(jobId);
  const job = live || archived;
  if (!job) throw new Error("Không tìm thấy job / lịch sử task");

  const tasks = loadTasksForJob(job).map((t) => ({ ...t }));
  fillMissingIdsFromLogs(tasks);

  const toCheck = tasks.filter(
    (t) => t.status === "ok" || taskPostId(t) || taskPostUrl(t)
  );
  const tokenCache = new Map();
  const results = [];
  let onFb = 0;
  let missing = 0;
  let skipped = 0;
  let errors = 0;

  for (const t of toCheck) {
    const pid = taskPostId(t);
    const pageRowId = Number(t.page_row_id);
    if (!pid) {
      const check = {
        ok: false,
        on_facebook: null,
        error: "Task OK nhưng không có fb_post_id (bản lịch sử cũ)",
      };
      t.fb_check = check;
      results.push({ task_id: t.id, page_name: t.page_name, ...check });
      skipped += 1;
      continue;
    }
    if (!tokenCache.has(pageRowId)) {
      try {
        tokenCache.set(pageRowId, getPageToken(pageRowId));
      } catch {
        tokenCache.set(pageRowId, null);
      }
    }
    const token = tokenCache.get(pageRowId);
    if (!token) {
      const check = {
        ok: false,
        on_facebook: null,
        error: "Không đọc được page token — Connect / import token lại",
      };
      t.fb_check = check;
      results.push({ task_id: t.id, page_name: t.page_name, post_id: pid, ...check });
      errors += 1;
      continue;
    }
    const g = await graphGetSoft(
      `/${pid}`,
      token,
      { fields: "id,permalink_url,created_time,is_published,status_type,message" }
    );
    await sleep(80);
    if (g.ok && g.data?.id) {
      const check = {
        ok: true,
        on_facebook: true,
        post_id: g.data.id,
        permalink_url: g.data.permalink_url || taskPostUrl(t) || null,
        created_time: g.data.created_time || null,
        is_published: g.data.is_published !== false,
        status_type: g.data.status_type || null,
        checked_at: new Date().toISOString(),
      };
      t.fb_check = check;
      t.fb_post_id = pid;
      t.fb_post_url = check.permalink_url;
      results.push({ task_id: t.id, page_name: t.page_name, ...check });
      onFb += 1;
    } else {
      const code = g.code;
      const gone = code === 100 || code === 803 || /does not exist|unsupported get request/i.test(
        String(g.error || "")
      );
      const check = {
        ok: !gone,
        on_facebook: false,
        error: g.error || "Graph không trả bài",
        code,
        checked_at: new Date().toISOString(),
      };
      t.fb_check = check;
      results.push({ task_id: t.id, page_name: t.page_name, post_id: pid, ...check });
      if (gone) missing += 1;
      else errors += 1;
    }
  }

  if (live && Array.isArray(live.tasks)) {
    const byId = new Map(tasks.map((t) => [String(t.id), t]));
    for (const lt of live.tasks) {
      const u = byId.get(String(lt.id));
      if (u?.fb_check) lt.fb_check = u.fb_check;
    }
  }

  return {
    ok: true,
    job_id: job.id,
    title: job.title,
    checked: results.length,
    on_facebook: onFb,
    missing,
    skipped,
    errors,
    tasks: tasks.map((t) => ({
      id: t.id,
      page_name: t.page_name,
      page_id: t.page_id,
      status: t.status,
      label: t.label,
      error: t.error,
      post_type: t.post_type || t.opts?.post_type,
      fb_post_id: taskPostId(t) || null,
      fb_post_url: taskPostUrl(t) || t.fb_check?.permalink_url || null,
      fb_check: t.fb_check || null,
    })),
  };
}
