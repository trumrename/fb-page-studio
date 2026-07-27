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
  const hay = [
    post.message,
    post.story,
    post.description,
    post.title,
    post.content_source,
    post.media_type,
    post.id,
  ]
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
  const rawMax = opts.max_posts ?? opts.maxPosts;
  // preview default 200; 0 = full list (can be slow)
  const maxPosts =
    rawMax === undefined || rawMax === null || rawMax === ""
      ? 200
      : Math.max(0, Number(rawMax) || 0);
  const posts = await listPagePosts(page.page_id, page.page_token, {
    maxPosts,
    since: opts.since || undefined,
    until: opts.until || undefined,
    include_videos: opts.include_videos !== false,
    include_photos: opts.include_photos !== false,
    include_scheduled: opts.include_scheduled !== false,
    metaAppKey: page.meta_app_key,
  });

  let filtered = posts;
  if (opts.keyword) {
    filtered = posts.filter((p) => matchKeyword(p, opts.keyword));
  }

  const bySource = {};
  const byMedia = { video: 0, photo: 0, other: 0 };
  for (const p of filtered) {
    const src = String(p.content_source || "post").split("+")[0];
    bySource[src] = (bySource[src] || 0) + 1;
    const mt = String(p.media_type || p.status_type || "").toLowerCase();
    if (mt.includes("video") || src.includes("video")) byMedia.video++;
    else if (mt.includes("photo") || src === "photos") byMedia.photo++;
    else byMedia.other++;
  }

  return {
    page: {
      id: page.id,
      page_id: page.page_id,
      name: page.name,
    },
    total_fetched: posts.length,
    total_matched: filtered.length,
    source_hits: posts._source_hits || null,
    by_source: bySource,
    by_media: byMedia,
    posts: filtered.map((p) => ({
      id: p.id,
      message: (p.message || p.story || p.description || "").slice(0, 240),
      created_time: p.created_time || null,
      permalink_url: p.permalink_url || null,
      status_type: p.status_type || null,
      content_source: p.content_source || null,
      media_type: p.media_type || null,
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
 * - max_posts: cap per page when listing (0 = unlimited / full wipe)
 * - include_videos / include_photos / include_scheduled: default true
 * - use_batch: default true
 * - concurrency: default 8 (khi fallback single DELETE)
 * - page_parallel: số page chạy song song (list + delete), default 3, max 10
 * - delay_ms: pause giữa batch
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
  const pageParallel = Math.min(
    10,
    Math.max(1, Number(opts.page_parallel ?? opts.pageParallel ?? 3) || 3)
  );
  // 0 = unlimited (full wipe). UI "Xóa full" sends 0.
  const rawMax = opts.max_posts ?? opts.maxPosts;
  let maxPosts = 0;
  if (rawMax !== undefined && rawMax !== null && rawMax !== "") {
    maxPosts = Math.max(0, Number(rawMax) || 0);
  } else if (!opts.full_wipe && !opts.fullWipe) {
    // legacy default when neither full_wipe nor max set
    maxPosts = 0;
  }
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
      max_posts: maxPosts,
      full_wipe: Boolean(opts.full_wipe || opts.fullWipe) || maxPosts === 0,
      include_videos: opts.include_videos !== false && opts.includeVideos !== false,
      include_photos: opts.include_photos !== false && opts.includePhotos !== false,
      include_scheduled:
        opts.include_scheduled !== false && opts.includeScheduled !== false,
      use_batch: opts.use_batch !== false && opts.useBatch !== false,
      concurrency: Math.min(20, Math.max(1, Number(opts.concurrency) || 8)),
      page_parallel: pageParallel,
      delay_ms: Math.max(0, Number(opts.delay_ms ?? opts.delayMs ?? 0)),
      // Full clean: list→delete→list again until empty (or max passes)
      wipe_passes: Math.min(
        8,
        Math.max(1, Number(opts.wipe_passes ?? opts.wipePasses ?? (maxPosts === 0 ? 3 : 1)) || 1)
      ),
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
  job.recent.unshift({ at: nowIso(), text: line });
  if (job.recent.length > 80) job.recent.length = 80;
}

function recompute(job) {
  const pages = job.pages || [];
  const listed = pages.reduce((s, p) => s + (p.listed || 0), 0);
  const matched = pages.reduce((s, p) => s + (p.matched || 0), 0);
  const ok = pages.reduce((s, p) => s + (p.ok || 0), 0);
  const fail = pages.reduce((s, p) => s + (p.fail || 0), 0);
  const donePages = pages.filter((p) =>
    ["ok", "fail", "skipped", "dry_run"].includes(p.status)
  ).length;
  const totalDelete = job.progress.total_delete || matched;
  const deleted = ok + fail;
  let percent = 0;
  if (job.dry_run) {
    percent = pages.length
      ? Math.round((donePages / pages.length) * 100)
      : 100;
  } else if (totalDelete > 0) {
    // 20% list + 80% delete
    const listPct = pages.length ? (donePages / pages.length) * 20 : 0;
    // While listing incomplete, use listing share; once total known use delete share
    if (job.status === "listing") {
      percent = Math.min(20, Math.round((listed > 0 ? 10 : 5) + listPct));
    } else {
      const delPct = (deleted / totalDelete) * 80;
      percent = Math.min(100, Math.round(20 + delPct));
    }
  } else if (job.status === "ok" || job.status === "partial") {
    percent = 100;
  } else if (donePages === pages.length && pages.length) {
    percent = 100;
  }

  job.progress = {
    ...job.progress,
    percent,
    listed,
    matched,
    ok,
    fail,
    done: deleted,
    total_delete: totalDelete,
  };
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
  if (!info.ticking) {
    pushRecent(job, job.progress.label);
  }
  // keep previous logical phase for resume message
  job._status_before_limit = job._status_before_limit || prevStatus;
  emit(job);
}

function clearRateLimitUi(job, resumeLabel) {
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
    pushRecent(job, `▶ Hết limit — tiếp tục: ${resumeLabel}`);
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
    const page = loadPageForDelete(pageState.page_row_id);
    pageState.page_id = page.page_id;
    pageState.page_name = page.name;
    pageState.status = "listing";
    job.progress.label = `List · ${page.name} (//${job.options.page_parallel} page)`;
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
        include_videos: job.options.include_videos,
        include_photos: job.options.include_photos,
        include_scheduled: job.options.include_scheduled,
        metaAppKey: page.meta_app_key,
        shouldStop: () => job.stop_requested,
        onRateLimit: (info) => applyRateLimitUi(job, info, page.name),
        onBatch: (_batch, total, info) => {
          pageState.listed = total;
          if (info?.source) {
            job.progress.label = `List · ${page.name} · ${info.source} (unique ${total})`;
          }
          recompute(job);
          if (job.status === "rate_limited") {
            clearRateLimitUi(job, `List · ${page.name}`);
          }
          emit(job);
        },
      });
      clearRateLimitUi(job, `List xong · ${page.name}`);
      pageState.listed = posts.length;
      pageState.source_hits = posts._source_hits || null;
      const filtered = job.options.keyword
        ? posts.filter((p) => matchKeyword(p, job.options.keyword))
        : posts;
      pageState.matched = filtered.length;
      // count media kinds for report
      let nVideo = 0;
      let nPhoto = 0;
      for (const p of filtered) {
        const mt = String(p.media_type || p.status_type || p.content_source || "").toLowerCase();
        if (mt.includes("video")) nVideo++;
        else if (mt.includes("photo")) nPhoto++;
      }
      pageState.matched_videos = nVideo;
      pageState.matched_photos = nPhoto;
      ids = filtered.map((p) => p.id);
      for (const p of filtered) {
        meta.set(p.id, {
          id: p.id,
          link: buildPostUrl(p.id, page.page_id, p.permalink_url),
          message: String(p.message || p.story || p.description || "").slice(0, 200),
          created_time: p.created_time || null,
          content_source: p.content_source || null,
          media_type: p.media_type || p.status_type || null,
        });
      }
    }

    job._postMeta.set(pageState.page_row_id, meta);
    toDelete.set(pageState.page_row_id, ids);
    const srcNote = pageState.source_hits
      ? ` · nguồn ${JSON.stringify(pageState.source_hits)}`
      : "";
    pushRecent(
      job,
      `${page.name}: ${ids.length} bài khớp (list ${pageState.listed}` +
        `${pageState.matched_videos ? `, ~${pageState.matched_videos} video` : ""}` +
        `${pageState.matched_photos ? `, ~${pageState.matched_photos} ảnh` : ""})` +
        srcNote
    );

    if (job.dry_run) {
      pageState.status = "dry_run";
      pageState.ok = 0;
      pageState.fail = 0;
      pageState.failed_posts = [];
    } else {
      pageState.status = "ready";
    }
  } catch (e) {
    pageState.status = "fail";
    pageState.error = e.message || String(e);
    pushRecent(job, `Lỗi list page #${pageState.page_row_id}: ${pageState.error}`);
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

  let ids = toDelete.get(pageState.page_row_id) || [];
  if (!ids.length) {
    pageState.status = "ok";
    recompute(job);
    emit(job);
    return;
  }

  try {
    const page = loadPageForDelete(pageState.page_row_id);
    pageState.status = "deleting";
    const passes = job.options.wipe_passes || 1;
    job.progress.label = `Xóa · ${page.name} (${ids.length}) · ${passes} vòng · //${job.options.page_parallel}`;
    emit(job);

    let totalOk = 0;
    let totalFail = 0;
    let lastResult = null;
    const allFailed = [];

    for (let pass = 1; pass <= passes; pass++) {
      if (job.stop_requested) break;
      if (!ids.length && pass > 1) break;

      if (pass > 1) {
        // Re-list remaining content (videos often only surface after feed is cleared)
        pushRecent(job, `${page.name}: vòng ${pass}/${passes} — list lại…`);
        job.progress.label = `List lại · ${page.name} · vòng ${pass}/${passes}`;
        emit(job);
        const posts = await listPagePosts(page.page_id, page.page_token, {
          maxPosts: job.options.max_posts || 0,
          since: job.options.since || undefined,
          until: job.options.until || undefined,
          include_videos: job.options.include_videos,
          include_photos: job.options.include_photos,
          include_scheduled: job.options.include_scheduled,
          metaAppKey: page.meta_app_key,
          shouldStop: () => job.stop_requested,
          onRateLimit: (info) => applyRateLimitUi(job, info, page.name),
        });
        clearRateLimitUi(job, `List lại xong · ${page.name}`);
        const filtered = job.options.keyword
          ? posts.filter((p) => matchKeyword(p, job.options.keyword))
          : posts;
        ids = filtered.map((p) => p.id);
        pageState.listed = (pageState.listed || 0) + posts.length;
        pageState.matched = (pageState.matched || 0) + filtered.length;
        if (!ids.length) {
          pushRecent(job, `${page.name}: vòng ${pass} — hết bài, dừng.`);
          break;
        }
        pushRecent(job, `${page.name}: vòng ${pass} — còn ${ids.length} bài/video`);
        job.progress.total_delete = (job.progress.total_delete || 0) + ids.length;
      }

      job.progress.label = `Xóa · ${page.name} · vòng ${pass}/${passes} (${ids.length})`;
      emit(job);

      lastResult = await deletePagePostsFast(ids, page.page_token, {
        useBatch: job.options.use_batch,
        concurrency: job.options.concurrency,
        delayMs: job.options.delay_ms,
        metaAppKey: page.meta_app_key,
        shouldStop: () => job.stop_requested,
        onRateLimit: (info) => applyRateLimitUi(job, info, page.name),
        onProgress: (info) => {
          pageState.ok = totalOk + (info.ok || 0);
          pageState.fail = totalFail + (info.fail || 0);
          recompute(job);
          if (info.phase === "rate_limited" || info.rate_limit) return;
          if (job.status === "rate_limited" || job.progress.rate_limited) {
            clearRateLimitUi(
              job,
              `${page.name}: vòng ${pass} ${info.done}/${info.total}`
            );
          }
          job.progress.phase = "deleting";
          const active = job.pages.filter((p) => p.status === "deleting").length;
          job.progress.label = `${page.name}: vòng ${pass}/${passes} · ${info.done}/${info.total} · ${active} page`;
          emit(job);
        },
      });

      totalOk += lastResult.ok || 0;
      totalFail += lastResult.fail || 0;
      for (const it of lastResult.items || []) {
        if (!it.ok) allFailed.push(it);
      }
      pushRecent(
        job,
        `${page.name}: vòng ${pass}/${passes} · OK ${lastResult.ok} · fail ${lastResult.fail}` +
          (lastResult.gone ? ` · gone ${lastResult.gone}` : "")
      );

      // After a full wipe pass, clear ids so next pass re-lists fresh
      if (passes > 1) ids = [];
    }

    clearRateLimitUi(job, null);
    pageState.ok = totalOk;
    pageState.fail = totalFail;
    pageState.error_summary = lastResult?.error_summary || [];
    pageState.status =
      totalFail === 0 ? "ok" : totalOk === 0 ? "fail" : "partial";
    pageState.wipe_passes_done = passes;

    const meta = job._postMeta?.get(pageState.page_row_id) || new Map();
    const failed = [];
    // de-dupe failed by post_id, keep last error
    const failById = new Map();
    for (const it of allFailed) {
      failById.set(it.post_id, it);
    }
    for (const it of failById.values()) {
      const m = meta.get(it.post_id) || {};
      failed.push({
        post_id: it.post_id,
        link: m.link || buildPostUrl(it.post_id, page.page_id),
        message: m.message || "",
        created_time: m.created_time || null,
        content_source: m.content_source || null,
        media_type: m.media_type || null,
        error: it.error || "unknown",
      });
    }
    const MAX_FAIL_STORE = 3000;
    pageState.failed_posts = failed.slice(0, MAX_FAIL_STORE);
    pageState.failed_truncated = failed.length > MAX_FAIL_STORE;

    if (totalFail) {
      const top = (lastResult?.error_summary || [])[0];
      pageState.error =
        (top && `${top.message} (×${top.count})`) ||
        failed[0]?.error ||
        `${totalFail} lỗi`;
    }
    pushRecent(
      job,
      `${page.name}: TỔNG xóa OK ${totalOk} · fail ${totalFail} · ${passes} vòng`
    );
    if (failed.length) {
      pushRecent(
        job,
        `${page.name}: ${failed.length} link lỗi (xem bảng / CSV)`
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

  const pageParallel = job.options.page_parallel || 3;

  job.status = "listing";
  job.progress.phase = "listing";
  job.progress.label = `Đang lấy danh sách bài (//${pageParallel} page)…`;
  recompute(job);
  emit(job);

  /** @type {Map<number, string[]>} pageRowId -> post ids */
  const toDelete = new Map();

  await mapPool(job.pages, pageParallel, async (pageState) => {
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
