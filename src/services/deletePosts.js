/**
 * Bulk delete Fanpage posts — list + filter + Graph batch delete (nhanh).
 * Only deletes posts the Page token can manage (official Graph API).
 */
import { EventEmitter } from "events";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { decryptToken } from "./crypto.js";
import {
  listPagePosts,
  deletePagePostsFast,
  sleep,
} from "./facebook.js";
import {
  setListSlotMax,
  acquireListSlot,
  releaseListSlot,
  waitGlobalGraphPause,
  isGlobalGraphPaused,
} from "./rateLimit.js";

const bus = new EventEmitter();
bus.setMaxListeners(40);

/** @type {Map<string, object>} */
const jobs = new Map();
const MAX_JOBS = 30;

function nowIso() {
  return new Date().toISOString();
}

function emit(job) {
  bus.emit("job", job);
  bus.emit(`job:${job.id}`, job);
}

function trimJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const list = [...jobs.values()].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );
  while (list.length > MAX_JOBS) {
    const old = list.shift();
    if (old && !["running", "listing"].includes(old.status)) {
      jobs.delete(old.id);
    } else break;
  }
}

/**
 * Load page row + decrypted page token + meta_app_key.
 * @param {number|string} pageRowId
 */
export function loadPageForDelete(pageRowId) {
  const row = getDb()
    .prepare(
      `SELECT p.id, p.page_id, p.name, p.page_token_enc, p.status, p.account_id,
              a.meta_app_key
       FROM fb_pages p
       LEFT JOIN fb_accounts a ON a.id = p.account_id
       WHERE p.id = ?`
    )
    .get(pageRowId);
  if (!row) throw new Error("Không tìm thấy Page (row id)");
  if (row.status && row.status !== "active") {
    throw new Error(`Page không active: ${row.name || row.page_id}`);
  }
  if (!row.page_token_enc) throw new Error("Page thiếu access token — Sync lại account");
  return {
    id: row.id,
    page_id: row.page_id,
    name: row.name,
    account_id: row.account_id,
    meta_app_key: row.meta_app_key || "app1",
    page_token: decryptToken(row.page_token_enc),
  };
}

function matchKeyword(post, keyword) {
  const kw = String(keyword || "").trim().toLowerCase();
  if (!kw) return true;
  const hay = [post.message, post.story, post.id]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return hay.includes(kw);
}

/** Build a human-openable Facebook URL for a post id. */
export function buildPostUrl(postId, pageId = "", permalink = "") {
  if (permalink && /^https?:\/\//i.test(permalink)) return permalink;
  const id = String(postId || "").trim();
  if (!id) return "";
  if (id.includes("_")) {
    const [pid, sid] = id.split("_");
    if (pid && sid) return `https://www.facebook.com/${pid}/posts/${sid}`;
  }
  const pid = String(pageId || "").trim();
  if (pid) return `https://www.facebook.com/${pid}/posts/${id}`;
  return `https://www.facebook.com/${id}`;
}

function buildJobReport(job) {
  const pages = (job.pages || []).map((p) => ({
    page_row_id: p.page_row_id,
    page_id: p.page_id,
    page_name: p.page_name || p.page_id || `#${p.page_row_id}`,
    status: p.status,
    listed: p.listed || 0,
    matched: p.matched || 0,
    ok: p.ok || 0,
    fail: p.fail || 0,
    error: p.error || null,
    error_summary: p.error_summary || [],
    failed_count: (p.failed_posts || []).length,
  }));
  const failed_posts = [];
  for (const p of job.pages || []) {
    for (const f of p.failed_posts || []) {
      failed_posts.push({
        page_row_id: p.page_row_id,
        page_id: p.page_id,
        page_name: p.page_name || p.page_id,
        ...f,
      });
    }
  }
  return {
    job_id: job.id,
    status: job.status,
    finished_at: job.finished_at,
    totals: {
      pages: pages.length,
      pages_with_fail: pages.filter((p) => (p.fail || 0) > 0).length,
      listed: pages.reduce((s, p) => s + (p.listed || 0), 0),
      ok: pages.reduce((s, p) => s + (p.ok || 0), 0),
      fail: pages.reduce((s, p) => s + (p.fail || 0), 0),
      failed_links: failed_posts.length,
    },
    pages,
    failed_posts,
  };
}

function finalizeReport(job) {
  job.report = buildJobReport(job);
  const t = job.report.totals;
  if (t.fail > 0) {
    pushRecent(
      job,
      `📊 KẾT THÚC: ${t.ok} OK · ${t.fail} lỗi · ${t.pages_with_fail}/${t.pages} page có lỗi · ${t.failed_links} link fail`
    );
    for (const p of job.report.pages) {
      if ((p.fail || 0) > 0) {
        pushRecent(
          job,
          `   ✗ ${p.page_name}: ${p.fail} lỗi / ${p.ok} OK (list ${p.matched || p.listed})`
        );
      }
    }
  } else {
    pushRecent(job, `📊 KẾT THÚC: ${t.ok} OK · 0 lỗi · ${t.pages} page`);
  }
}

/**
 * Preview posts for one page (không xóa).
 */
export async function previewPagePosts(pageRowId, opts = {}) {
  const page = loadPageForDelete(pageRowId);
  const maxPosts = Math.max(0, Number(opts.max_posts) || Number(opts.maxPosts) || 200);
  const posts = await listPagePosts(page.page_id, page.page_token, {
    maxPosts: maxPosts || 200,
    since: opts.since || undefined,
    until: opts.until || undefined,
    metaAppKey: page.meta_app_key,
    listMode: "full", // preview needs richer edges for UI
  });

  let filtered = posts;
  if (opts.keyword) {
    filtered = posts.filter((p) => matchKeyword(p, opts.keyword));
  }

  return {
    page: {
      id: page.id,
      page_id: page.page_id,
      name: page.name,
    },
    total_fetched: posts.length,
    total_matched: filtered.length,
    posts: filtered.map((p) => ({
      id: p.id,
      message: (p.message || p.story || "").slice(0, 240),
      created_time: p.created_time || null,
      permalink_url: p.permalink_url || null,
      status_type: p.status_type || null,
      has_picture: Boolean(p.full_picture),
    })),
  };
}

/**
 * Start async bulk-delete job for one or many pages.
 *
 * Body opts:
 * - page_row_ids: number[]
 * - post_ids: string[] (optional — nếu có thì xóa đúng list, bỏ list API)
 * - since / until: unix or ISO
 * - keyword: filter message
 * - max_posts: cap per page when listing
 * - use_batch: default true
 * - concurrency: default 12 (khi fallback single DELETE)
 * - list_parallel: page list song song (default 1 — Meta #4 storm if multi-list)
 * - page_parallel: page DELETE song song (default 2, max 12)
 * - batch_parallel: max concurrent Graph batch HTTP (×50 DELETE), default 6, max 12
 * - adaptive: true = ramp // based on X-App-Usage + rate-limit
 * - list_mode: wipe (3 edges) | full (all edges)
 * - delay_ms: base pause giữa batch
 * - dry_run: chỉ list, không xóa
 */
export function startDeleteJob(opts = {}) {
  const pageRowIds = [
    ...new Set(
      (opts.page_row_ids || opts.pageRowIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (!pageRowIds.length) {
    throw new Error("Chọn ít nhất 1 Page (page_row_ids)");
  }

  const explicitIds = Array.isArray(opts.post_ids)
    ? opts.post_ids.map(String).filter(Boolean)
    : Array.isArray(opts.postIds)
      ? opts.postIds.map(String).filter(Boolean)
      : null;

  const dryRun = Boolean(opts.dry_run || opts.dryRun);
  // DELETE multi-page OK; LIST must stay low (each list = hundreds of GETs)
  const pageParallel = Math.min(
    12,
    Math.max(1, Number(opts.page_parallel ?? opts.pageParallel ?? 2) || 2)
  );
  // Community 2026: serialize list across pages under Platform rate limit (#4)
  const listParallel = Math.min(
    3,
    Math.max(1, Number(opts.list_parallel ?? opts.listParallel ?? 1) || 1)
  );
  const adaptive =
    opts.adaptive !== false &&
    opts.adaptive !== 0 &&
    String(opts.adaptive).toLowerCase() !== "false";
  const listMode =
    String(opts.list_mode ?? opts.listMode ?? "wipe").toLowerCase() === "full"
      ? "full"
      : "wipe";
  const job = {
    id: nanoid(10),
    kind: "delete_posts",
    status: "queued",
    dry_run: dryRun,
    created_at: nowIso(),
    finished_at: null,
    stop_requested: false,
    options: {
      since: opts.since || null,
      until: opts.until || null,
      keyword: opts.keyword || null,
      // 0 = không giới hạn (xóa full text+ảnh+video+reel). UI mặc định 0 hoặc số lớn.
      max_posts: (() => {
        const n = Number(opts.max_posts ?? opts.maxPosts);
        if (Number.isFinite(n) && n >= 0) return n;
        return 0;
      })(),
      use_batch: opts.use_batch !== false && opts.useBatch !== false,
      concurrency: Math.min(24, Math.max(1, Number(opts.concurrency) || 12)),
      // Ceiling for concurrent Graph batch (50 DELETE each). Adaptive ramps within this.
      batch_parallel: Math.min(
        12,
        Math.max(1, Number(opts.batch_parallel ?? opts.batchParallel ?? 6) || 6)
      ),
      adaptive,
      page_parallel: pageParallel,
      list_parallel: listParallel,
      list_mode: listMode,
      delay_ms: Math.max(0, Number(opts.delay_ms ?? opts.delayMs ?? 0)),
    },
    pages: pageRowIds.map((id) => ({
      page_row_id: id,
      page_id: null,
      page_name: null,
      status: "pending",
      listed: 0,
      matched: 0,
      ok: 0,
      fail: 0,
      error: null,
      error_summary: [],
      failed_posts: [],
    })),
    progress: {
      percent: 0,
      phase: "queued",
      label: "Chờ chạy…",
      listed: 0,
      matched: 0,
      ok: 0,
      fail: 0,
      done: 0,
      total_delete: 0,
      rate_limited: false,
      rate_limit_remaining_sec: 0,
      rate_limit_message: null,
    },
    recent: [],
    notifications: [],
    report: null,
    explicit_post_ids: explicitIds,
    /** @type {Map<number, Map<string, object>>} filled while job runs (not snapshotted fully) */
    _postMeta: null,
  };

  jobs.set(job.id, job);
  trimJobs();
  setImmediate(() => runDeleteJob(job.id).catch((e) => {
    const j = jobs.get(job.id);
    if (!j) return;
    j.status = "fail";
    j.finished_at = nowIso();
    j.progress.phase = "error";
    j.progress.label = e.message || String(e);
    j.notifications.unshift({
      id: nanoid(6),
      level: "error",
      title: "Xóa bài thất bại",
      body: e.message || String(e),
      at: nowIso(),
    });
    emit(j);
  }));

  return snapshot(job);
}

function pushRecent(job, line) {
  const text = String(line || "");
  // Debounce spam limit lines (parallel batches used to flood UI)
  if (/FB limit|Tạm dừng|tạm dừng|rate.?limit/i.test(text)) {
    const last = job.recent?.[0];
    if (
      last &&
      /FB limit|Tạm dừng|tạm dừng/i.test(last.text || "") &&
      Date.now() - Date.parse(last.at || 0) < 2500
    ) {
      job.recent[0] = { at: nowIso(), text };
      return;
    }
  }
  job.recent.unshift({ at: nowIso(), text });
  if (job.recent.length > 60) job.recent.length = 60;
}

function recompute(job) {
  const pages = job.pages || [];
  const listed = pages.reduce((s, p) => s + (Number(p.listed) || 0), 0);
  const matched = pages.reduce((s, p) => s + (Number(p.matched) || 0), 0);
  // Prefer ok/fail from page states; clamp so ok+fail never exceed matched
  let ok = pages.reduce((s, p) => s + (Number(p.ok) || 0), 0);
  let fail = pages.reduce((s, p) => s + (Number(p.fail) || 0), 0);
  if (matched > 0 && ok + fail > matched) {
    // mid-update race: keep ratio, clamp to matched
    const t = ok + fail;
    ok = Math.round((ok / t) * matched);
    fail = matched - ok;
  }
  const pending = Math.max(0, matched - ok - fail);
  const donePages = pages.filter((p) =>
    ["ok", "fail", "partial", "skipped", "dry_run"].includes(p.status)
  ).length;
  const finished = ["ok", "fail", "partial", "stopped"].includes(job.status);
  let percent = 0;
  if (job.dry_run) {
    percent = pages.length ? Math.round((donePages / pages.length) * 100) : 100;
  } else if (job.status === "listing" || job.status === "queued") {
    const listedPages = pages.filter((p) =>
      ["ready", "listing", "deleting", "ok", "fail", "partial", "dry_run"].includes(
        p.status
      )
    ).length;
    percent = pages.length
      ? Math.min(15, Math.round((listedPages / pages.length) * 15))
      : 5;
  } else if (matched > 0) {
    percent = Math.min(
      finished ? 100 : 99,
      Math.round(((ok + fail) / matched) * 100)
    );
  } else if (finished) {
    percent = 100;
  }

  job.progress = {
    ...job.progress,
    percent,
    listed,
    matched,
    ok,
    fail,
    pending,
    done: ok + fail,
    total_delete: matched,
    label:
      job.progress?.rate_limited && job.progress?.label
        ? job.progress.label
        : job.progress?.label || "",
  };
  // Keep a clean human label when not rate-limited
  if (!job.progress.rate_limited) {
    if (job.status === "listing") {
      job.progress.label = `Đang list… ${listed} object`;
    } else if (["running", "rate_limited"].includes(job.status) || pending > 0) {
      const active = pages.filter((p) => p.status === "deleting").map((p) => p.page_name);
      const who = active.length ? active.slice(0, 2).join(", ") : "…";
      job.progress.label = `${who} · OK ${ok} · lỗi ${fail} · còn ${pending}/${matched}`;
    }
  }
}

function snapshot(job) {
  // Drop internal non-serializable maps
  const copy = { ...job, _postMeta: undefined };
  return JSON.parse(JSON.stringify(copy));
}

/** Run async work over items with limited parallelism. */
async function mapPool(items, parallel, worker) {
  const list = [...items];
  let i = 0;
  const n = Math.min(Math.max(1, parallel), list.length || 1);
  async function run() {
    while (i < list.length) {
      const idx = i++;
      await worker(list[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: n }, () => run()));
}

function applyRateLimitUi(job, info, pageName = "") {
  const prevStatus = job.status;
  if (["listing", "running", "rate_limited"].includes(job.status) || !job.finished_at) {
    job.status = "rate_limited";
  }
  job.progress.phase = "rate_limited";
  job.progress.rate_limited = true;
  job.progress.rate_limit_remaining_sec = info.remaining_sec ?? Math.ceil((info.wait_ms || 0) / 1000);
  job.progress.rate_limit_message = info.message || null;
  job.progress.label =
    info.message ||
    `⚠ FB limit${pageName ? ` · ${pageName}` : ""} — tạm dừng, còn ${job.progress.rate_limit_remaining_sec}s…`;
  // Debounce log: only 1 non-tick line / 5s (was spam Hết limit × every page)
  const now = Date.now();
  if (!info.ticking) {
    if (!job._lastRlLogAt || now - job._lastRlLogAt >= 5000) {
      job._lastRlLogAt = now;
      pushRecent(job, job.progress.label);
    }
  }
  job._status_before_limit = job._status_before_limit || prevStatus;
  emit(job);
}

function clearRateLimitUi(job, resumeLabel) {
  // If still in GLOBAL pause, do not clear banner / spam "Hết limit"
  if (isGlobalGraphPaused()) {
    return;
  }
  job.progress.rate_limited = false;
  job.progress.rate_limit_remaining_sec = 0;
  job.progress.rate_limit_message = null;
  if (job.status === "rate_limited") {
    job.status = job._status_before_limit === "listing" ? "listing" : "running";
  }
  job._status_before_limit = null;
  if (resumeLabel) {
    job.progress.phase = job.status === "listing" ? "listing" : "deleting";
    job.progress.label = resumeLabel;
    const now = Date.now();
    if (!job._lastResumeLogAt || now - job._lastResumeLogAt >= 8000) {
      job._lastResumeLogAt = now;
      pushRecent(job, `▶ Hết limit — tiếp tục: ${resumeLabel}`);
    }
  }
  emit(job);
}

async function listOnePage(job, pageState, toDelete) {
  if (job.stop_requested) {
    pageState.status = "skipped";
    pageState.error = "Đã dừng";
    return;
  }
  try {
    // Wait global pause before taking list slot (no N pages queue-storm)
    if (isGlobalGraphPaused()) {
      await waitGlobalGraphPause({
        shouldStop: () => job.stop_requested,
        onTick: (info) => applyRateLimitUi(job, { ...info, ticking: true }),
      });
    }
    await acquireListSlot({ shouldStop: () => job.stop_requested });
    try {
    const page = loadPageForDelete(pageState.page_row_id);
    pageState.page_id = page.page_id;
    pageState.page_name = page.name;
    pageState.status = "listing";
    job.progress.label = `List · ${page.name} (list//${job.options.list_parallel || 1})`;
    emit(job);

    if (!job._postMeta) job._postMeta = new Map();
    const meta = new Map();

    let ids;
    if (job.explicit_post_ids?.length && job.pages.length === 1) {
      ids = job.explicit_post_ids;
      pageState.listed = ids.length;
      pageState.matched = ids.length;
      for (const id of ids) {
        meta.set(id, {
          id,
          link: buildPostUrl(id, page.page_id),
          message: "",
          created_time: null,
        });
      }
    } else {
      const posts = await listPagePosts(page.page_id, page.page_token, {
        maxPosts: job.options.max_posts || 0,
        since: job.options.since || undefined,
        until: job.options.until || undefined,
        metaAppKey: page.meta_app_key,
        listMode: job.options.list_mode || "wipe",
        shouldStop: () => job.stop_requested,
        onRateLimit: (info) => applyRateLimitUi(job, info, page.name),
        onBatch: (_batch, total) => {
          pageState.listed = total;
          recompute(job);
          if (job.status === "rate_limited" && !isGlobalGraphPaused()) {
            clearRateLimitUi(job, `List · ${page.name}`);
          }
          emit(job);
        },
      });
      if (!isGlobalGraphPaused()) {
        clearRateLimitUi(job, `List xong · ${page.name}`);
      }
      pageState.listed = posts.length;
      pageState.edge_stats = posts._edgeStats || null;
      if (posts._edgeStats) {
        const parts = Object.entries(posts._edgeStats)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}:${n}`)
          .join(", ");
        if (parts) {
          pushRecent(job, `${page.name} · edges: ${parts}`);
        }
      }
      const filtered = job.options.keyword
        ? posts.filter((p) => matchKeyword(p, job.options.keyword))
        : posts;
      pageState.matched = filtered.length;
      ids = filtered.map((p) => p.id);
      for (const p of filtered) {
        meta.set(p.id, {
          id: p.id,
          link: buildPostUrl(p.id, page.page_id, p.permalink_url),
          message: String(p.message || p.story || p.description || "").slice(0, 200),
          created_time: p.created_time || null,
          source: p._source || null,
        });
      }
    }

    job._postMeta.set(pageState.page_row_id, meta);
    toDelete.set(pageState.page_row_id, ids);
    pushRecent(
      job,
      `${page.name}: ${ids.length} object (post/video/reel) khớp (unique id ${pageState.listed})`
    );

    if (job.dry_run) {
      pageState.status = "dry_run";
      pageState.ok = 0;
      pageState.fail = 0;
      pageState.failed_posts = [];
    } else {
      pageState.status = "ready";
    }
    } finally {
      releaseListSlot();
    }
  } catch (e) {
    if (e.code === "STOPPED") {
      pageState.status = "skipped";
      pageState.error = "Đã dừng";
    } else {
      pageState.status = "fail";
      pageState.error = e.message || String(e);
      pushRecent(job, `Lỗi list page #${pageState.page_row_id}: ${pageState.error}`);
    }
  }
  recompute(job);
  emit(job);
}

async function deleteOnePage(job, pageState, toDelete) {
  if (job.stop_requested) {
    if (pageState.status === "ready") {
      pageState.status = "skipped";
      pageState.error = "Đã dừng";
    }
    return;
  }
  if (pageState.status !== "ready") return;

  const ids = toDelete.get(pageState.page_row_id) || [];
  if (!ids.length) {
    pageState.status = "ok";
    recompute(job);
    emit(job);
    return;
  }

  try {
    const page = loadPageForDelete(pageState.page_row_id);
    pageState.status = "deleting";
    job.progress.label = `Xóa · ${page.name} (${ids.length}) · //${job.options.page_parallel} page`;
    emit(job);

    const onDelProgress = (info) => {
      // Absolute counts from this delete call (+ base from prior pass)
      const base = pageState._ok_base || 0;
      pageState.ok = base + (Number(info.ok) || 0);
      pageState.fail = Number(info.fail) || 0;
      // never exceed matched for this page
      if (pageState.matched > 0) {
        const sum = pageState.ok + pageState.fail;
        if (sum > pageState.matched) {
          pageState.fail = Math.max(0, pageState.matched - pageState.ok);
        }
      }
      recompute(job);
      if (info.phase === "rate_limited" || info.rate_limit) {
        emit(job);
        return;
      }
      if (job.status === "rate_limited" || job.progress.rate_limited) {
        clearRateLimitUi(job, null);
      }
      job.progress.phase = "deleting";
      emit(job);
    };

    let result = await deletePagePostsFast(ids, page.page_token, {
      useBatch: job.options.use_batch,
      concurrency: job.options.concurrency,
      batchParallel: job.options.batch_parallel,
      adaptive: job.options.adaptive !== false,
      delayMs: job.options.delay_ms,
      metaAppKey: page.meta_app_key,
      shouldStop: () => job.stop_requested,
      onRateLimit: (info) => applyRateLimitUi(job, info, page.name),
      onProgress: onDelProgress,
    });

    // Pass 2+3: re-list + delete leftovers (videos/reels often only on /videos)
    // Always when full wipe (max=0) and no keyword/explicit filter
    const fullWipe =
      !job.options.keyword &&
      !job.explicit_post_ids?.length &&
      (job.options.max_posts === 0 || job.options.max_posts >= 5000);

    async function mergeDeleteResult(base, extra) {
      const mergedItems = [...(base.items || [])];
      const byPid = new Map(mergedItems.map((x) => [x.post_id, x]));
      for (const it of extra.items || []) {
        const prev = byPid.get(it.post_id);
        if (it.ok) {
          if (prev) {
            prev.ok = true;
            delete prev.error;
          } else {
            mergedItems.push(it);
            byPid.set(it.post_id, it);
          }
        } else if (!prev) {
          mergedItems.push(it);
          byPid.set(it.post_id, it);
        }
      }
      return {
        total: mergedItems.length,
        ok: mergedItems.filter((x) => x.ok).length,
        fail: mergedItems.filter((x) => !x.ok).length,
        gone: (base.gone || 0) + (extra.gone || 0),
        rate_limit_pauses:
          (base.rate_limit_pauses || 0) + (extra.rate_limit_pauses || 0),
        error_summary: extra.error_summary || base.error_summary,
        items: mergedItems,
      };
    }

    if (fullWipe && !job.stop_requested) {
      for (let pass = 2; pass <= 3; pass++) {
        if (job.stop_requested) break;
        try {
          pushRecent(
            job,
            `${page.name}: quét lại pass ${pass} (videos/reels/photos)…`
          );
          const again = await listPagePosts(page.page_id, page.page_token, {
            maxPosts: 0,
            metaAppKey: page.meta_app_key,
            // Pass 2+: still wipe edges only (videos leftovers) unless user chose full
            listMode: job.options.list_mode || "wipe",
            shouldStop: () => job.stop_requested,
            onRateLimit: (info) => applyRateLimitUi(job, info, page.name),
          });
          if (again?._edgeStats) {
            const parts = Object.entries(again._edgeStats)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${k}:${n}`)
              .join(", ");
            if (parts) pushRecent(job, `${page.name} pass ${pass} edges: ${parts}`);
          }
          const okSet = new Set(
            (result.items || []).filter((x) => x.ok).map((x) => x.post_id)
          );
          const stillThere = [
            ...new Set((again || []).map((p) => String(p.id)).filter(Boolean)),
          ].filter((id) => !okSet.has(id));

          if (!stillThere.length) {
            pushRecent(
              job,
              `${page.name}: pass ${pass} — hết object list được`
            );
            break;
          }
          pushRecent(
            job,
            `${page.name}: pass ${pass} còn ${stillThere.length} → xóa tiếp`
          );
          pageState._ok_base = result.ok || 0;
          const rPass = await deletePagePostsFast(stillThere, page.page_token, {
            useBatch: job.options.use_batch,
            concurrency: job.options.concurrency,
            // Re-scan pass: keep high ceiling; adaptive still protects #4
            batchParallel: Math.max(
              2,
              Math.min(12, job.options.batch_parallel || 6)
            ),
            adaptive: job.options.adaptive !== false,
            delayMs: job.options.delay_ms,
            metaAppKey: page.meta_app_key,
            shouldStop: () => job.stop_requested,
            onRateLimit: (info) => applyRateLimitUi(job, info, page.name),
            onProgress: onDelProgress,
          });
          result = await mergeDeleteResult(result, rPass);
        } catch (ePass) {
          pushRecent(
            job,
            `${page.name}: pass ${pass} bỏ qua — ${ePass.message || ePass}`
          );
        }
      }
    }

    clearRateLimitUi(job, null);
    pageState.ok = result.ok;
    pageState.fail = result.fail;
    pageState.error_summary = result.error_summary || [];
    pageState.status =
      result.fail === 0 ? "ok" : result.ok === 0 ? "fail" : "partial";

    const meta = job._postMeta?.get(pageState.page_row_id) || new Map();
    const failed = [];
    for (const it of result.items || []) {
      if (it.ok) continue;
      const m = meta.get(it.post_id) || {};
      failed.push({
        post_id: it.post_id,
        link: m.link || buildPostUrl(it.post_id, page.page_id),
        message: m.message || "",
        created_time: m.created_time || null,
        error: it.error || "unknown",
        source: m.source || null,
      });
    }
    // Cap stored fails per page to keep job JSON sane (UI can still show + export)
    const MAX_FAIL_STORE = 3000;
    pageState.failed_posts = failed.slice(0, MAX_FAIL_STORE);
    pageState.failed_truncated = failed.length > MAX_FAIL_STORE;

    if (result.fail) {
      const top = (result.error_summary || [])[0];
      const firstFail = result.items.find((x) => !x.ok);
      pageState.error =
        (top && `${top.message} (×${top.count})`) ||
        firstFail?.error ||
        `${result.fail} lỗi`;
    }
    const pauseNote =
      result.rate_limit_pauses > 0
        ? ` · đã tạm dừng limit ${result.rate_limit_pauses}+ lần`
        : "";
    const goneNote = result.gone ? ` · đã mất sẵn ${result.gone}` : "";
    pushRecent(
      job,
      `${page.name}: xóa OK ${result.ok} · fail ${result.fail}${goneNote}${pauseNote}`
    );
    if (result.error_summary?.length) {
      const top3 = result.error_summary
        .slice(0, 3)
        .map((e) => `「${e.message}」×${e.count}`)
        .join(" · ");
      pushRecent(job, `${page.name} · top lỗi: ${top3}`);
    }
    if (failed.length) {
      pushRecent(
        job,
        `${page.name}: ${failed.length} link lỗi (xem bảng kết quả / tải CSV)`
      );
    }
  } catch (e) {
    pageState.status = "fail";
    pageState.error = e.message || String(e);
    pageState.failed_posts = pageState.failed_posts || [];
    pushRecent(job, `Lỗi xóa ${pageState.page_name}: ${pageState.error}`);
  }

  recompute(job);
  emit(job);
}

async function runDeleteJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const pageParallel = job.options.page_parallel || 2;
  const listParallel = job.options.list_parallel || 1;
  setListSlotMax(listParallel);

  job.status = "listing";
  job.progress.phase = "listing";
  job.progress.label = `Đang list (list//${listParallel}, xóa//${pageParallel}) · mode ${job.options.list_mode || "wipe"}…`;
  recompute(job);
  emit(job);
  pushRecent(
    job,
    `Cấu hình: list//${listParallel} · delete//${pageParallel} · batch max ${job.options.batch_parallel} · ${job.options.list_mode || "wipe"} edges (Meta: 1 list tránh #4 storm)`
  );

  /** @type {Map<number, string[]>} pageRowId -> post ids */
  const toDelete = new Map();

  // LIST phase: serial/low parallel — #4 usually dies here, not on DELETE
  await mapPool(job.pages, listParallel, async (pageState) => {
    await listOnePage(job, pageState, toDelete);
  });

  const allIdsCount = [...toDelete.values()].reduce((s, a) => s + a.length, 0);
  job.progress.total_delete = allIdsCount;
  job.progress.matched = allIdsCount;

  if (job.dry_run) {
    job.status = "ok";
    job.finished_at = nowIso();
    job.progress.phase = "dry_run";
    job.progress.label = `Dry-run: ${allIdsCount} bài sẽ xóa`;
    job.progress.percent = 100;
    job.notifications.unshift({
      id: nanoid(6),
      level: "info",
      title: "Dry-run xong",
      body: `Tìm thấy ${allIdsCount} bài khớp bộ lọc. Chưa xóa gì.`,
      at: nowIso(),
    });
    finalizeReport(job);
    recompute(job);
    emit(job);
    return;
  }

  if (!allIdsCount) {
    job.status = "ok";
    job.finished_at = nowIso();
    job.progress.phase = "done";
    job.progress.label = "Không có bài nào để xóa";
    job.progress.percent = 100;
    finalizeReport(job);
    emit(job);
    return;
  }

  job.status = "running";
  job.progress.phase = "deleting";
  job.progress.label = `Đang xóa ${allIdsCount} bài (//${pageParallel} page)…`;
  recompute(job);
  emit(job);

  await mapPool(job.pages, pageParallel, async (pageState) => {
    await deleteOnePage(job, pageState, toDelete);
  });

  const okPages = job.pages.filter((p) => p.status === "ok").length;
  const failPages = job.pages.filter((p) =>
    ["fail", "partial"].includes(p.status)
  ).length;
  job.finished_at = nowIso();
  job.progress.percent = 100;
  job.progress.phase = "done";

  job.progress.rate_limited = false;
  job.progress.rate_limit_remaining_sec = 0;

  if (job.stop_requested) {
    job.status = "stopped";
    job.progress.label = "Đã dừng giữa chừng";
  } else if (failPages && okPages) {
    job.status = "partial";
    job.progress.label = `Xong một phần · OK ${job.progress.ok} · lỗi ${job.progress.fail}`;
  } else if (failPages && !okPages && job.progress.ok === 0) {
    job.status = "fail";
    job.progress.label = `Thất bại · ${job.progress.fail} lỗi`;
  } else {
    job.status = "ok";
    job.progress.label = `Xong · đã xóa ${job.progress.ok} bài`;
  }

  finalizeReport(job);
  if (job.report?.totals?.fail) {
    job.progress.label = `${job.progress.label} · ${job.report.totals.pages_with_fail} page lỗi · xem báo cáo bên dưới`;
  }

  job.notifications.unshift({
    id: nanoid(6),
    level: job.status === "ok" ? "success" : job.status === "fail" ? "error" : "warn",
    title: "Xóa bài Fanpage",
    body: job.progress.label,
    at: nowIso(),
  });
  // free meta maps
  job._postMeta = null;
  emit(job);
}

/** CSV string of failed posts for a finished job */
export function failedPostsToCsv(jobOrId) {
  const job = typeof jobOrId === "string" ? jobs.get(jobOrId) : jobOrId;
  if (!job) return null;
  const report = job.report || buildJobReport(job);
  const rows = report.failed_posts || [];
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = [
    "page_name",
    "page_id",
    "post_id",
    "link",
    "error",
    "created_time",
    "message",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        esc(r.page_name),
        esc(r.page_id),
        esc(r.post_id),
        esc(r.link),
        esc(r.error),
        esc(r.created_time),
        esc(r.message),
      ].join(",")
    );
  }
  return lines.join("\r\n");
}

export function getDeleteJob(id) {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

export function listDeleteJobs(limit = 20) {
  return [...jobs.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit)
    .map(snapshot);
}

export function stopDeleteJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.stop_requested = true;
  if (["queued", "listing", "running"].includes(job.status)) {
    pushRecent(job, "Yêu cầu dừng…");
    emit(job);
  }
  return snapshot(job);
}

export function onDeleteJob(id, fn) {
  const key = `job:${id}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

export function onAnyDeleteJob(fn) {
  bus.on("job", fn);
  return () => bus.off("job", fn);
}
