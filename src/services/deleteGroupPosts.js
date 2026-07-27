/**
 * Bulk delete Facebook Group posts (user token — Admin / Moderator).
 * Best-effort via Graph API. Meta deprecated Groups API for many apps —
 * list/delete may fail without permissions; UI allows manual group IDs.
 */
import { EventEmitter } from "events";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { decryptToken } from "./crypto.js";
import {
  listUserGroups,
  listGroupPosts,
  deletePagePostsFast,
  sleep,
} from "./facebook.js";
/** Openable Facebook Group post URL */
export function buildGroupPostUrl(postId, groupId = "", permalink = "") {
  if (permalink && /^https?:\/\//i.test(permalink)) return permalink;
  const id = String(postId || "").trim();
  const gid = String(groupId || "").trim();
  if (!id) return "";
  if (id.includes("_")) {
    const [a, b] = id.split("_");
    const g = gid || a;
    if (g && b) return `https://www.facebook.com/groups/${g}/posts/${b}`;
  }
  if (gid) return `https://www.facebook.com/groups/${gid}/permalink/${id}`;
  return `https://www.facebook.com/${id}`;
}

const bus = new EventEmitter();
bus.setMaxListeners(40);

/** @type {Map<string, object>} */
const jobs = new Map();
const MAX_JOBS = 20;

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

function pushRecent(job, line) {
  job.recent.unshift({ at: nowIso(), text: line });
  if (job.recent.length > 100) job.recent.length = 100;
}

function snapshot(job) {
  const copy = { ...job, _postMeta: undefined };
  return JSON.parse(JSON.stringify(copy));
}

/** Load account + user token */
export function loadAccountForGroups(accountId) {
  const row = getDb()
    .prepare(
      `SELECT id, fb_user_id, name, user_token_enc, status, meta_app_key
       FROM fb_accounts WHERE id = ?`
    )
    .get(accountId);
  if (!row) throw new Error("Không tìm thấy account");
  if (row.status && row.status !== "active") {
    throw new Error(`Account không active: ${row.name || row.id}`);
  }
  if (!row.user_token_enc) throw new Error("Account thiếu user token — Connect lại Facebook");
  return {
    id: row.id,
    fb_user_id: row.fb_user_id,
    name: row.name,
    meta_app_key: row.meta_app_key || "app1",
    user_token: decryptToken(row.user_token_enc),
  };
}

/** Page tokens of same account — sometimes work when Page is Group admin */
export function loadPageTokensForAccount(accountId) {
  const rows = getDb()
    .prepare(
      `SELECT id, page_id, name, page_token_enc, status
       FROM fb_pages WHERE account_id = ? AND status = 'active'`
    )
    .all(accountId);
  return rows
    .map((r) => {
      try {
        return {
          page_row_id: r.id,
          page_id: r.page_id,
          name: r.name,
          token: decryptToken(r.page_token_enc),
          label: `page:${r.name || r.page_id}`,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Parse post ids / facebook links / saved HTML from free text.
 * Meta closed Groups feed API — bulk paste is the practical path.
 *
 * Supports: raw id, gid_sid, /posts/, /permalink/, story_fbid, fbid,
 * multi_permalinks, encoded URLs, HTML attributes, JSON "post_id".
 *
 * @param {string} text
 * @param {{ groupId?: string }} [opts] — if set, prefer `groupId_storyId` form
 * @returns {string[]}
 */
export function parsePostIdsFromText(text, opts = {}) {
  const raw = String(text || "");
  const preferGid = String(opts.groupId || opts.group_id || "").trim();
  /** @type {Set<string>} */
  const compounds = new Set();
  /** @type {Set<string>} */
  const stories = new Set();

  const addStory = (sid) => {
    const s = String(sid || "").replace(/\D/g, "");
    if (s.length >= 5 && s.length <= 25) stories.add(s);
  };
  const addCompound = (a, b) => {
    const ga = String(a || "").replace(/\D/g, "");
    const sb = String(b || "").replace(/\D/g, "");
    if (ga.length >= 8 && sb.length >= 5) {
      compounds.add(`${ga}_${sb}`);
      stories.add(sb);
    }
  };

  // Decode common URL encoding once for better matches
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    /* keep raw */
  }
  const blob = `${raw}\n${decoded}`;

  // groups/GID/posts/SID  or  groups/GID/permalink/SID
  for (const m of blob.matchAll(
    /\/groups\/(\d{8,})\/(?:posts|permalink)\/(\d{5,})/gi
  )) {
    addCompound(m[1], m[2]);
  }
  // multi_permalinks.php?story_fbid=SID&id=GID
  for (const m of blob.matchAll(
    /story_fbid=(\d{5,})[^&\s"']{0,80}(?:&|&amp;)id=(\d{8,})/gi
  )) {
    addCompound(m[2], m[1]);
  }
  for (const m of blob.matchAll(
    /[?&]id=(\d{8,})[^&\s"']{0,80}(?:&|&amp;)story_fbid=(\d{5,})/gi
  )) {
    addCompound(m[1], m[2]);
  }
  // permalink.php?story_fbid=SID&id=GID
  for (const m of blob.matchAll(
    /permalink\.php\?[^"'<\s]*story_fbid=(\d{5,})[^"'<\s]*[?&]id=(\d{8,})/gi
  )) {
    addCompound(m[2], m[1]);
  }
  // pfbid / classic
  for (const m of blob.matchAll(/story_fbid=(\d{5,})/gi)) addStory(m[1]);
  for (const m of blob.matchAll(/[?&]fbid=(\d{5,})/gi)) addStory(m[1]);
  for (const m of blob.matchAll(/[?&]story_fbid%3D(\d{5,})/gi)) addStory(m[1]);
  // /posts/SID or /permalink/SID (no group in path)
  for (const m of blob.matchAll(/\/(?:posts|permalink)\/(\d{5,})\b/gi)) {
    addStory(m[1]);
  }
  // HTML / JSON: "post_id":"GID_SID" or post_id: GID_SID
  for (const m of blob.matchAll(
    /["']?post_id["']?\s*[:=]\s*["']?(\d{8,})_(\d{5,})["']?/gi
  )) {
    addCompound(m[1], m[2]);
  }
  for (const m of blob.matchAll(
    /["'](?:top_level_post_id|feedback_id|legacy_story_id)["']\s*:\s*["'](\d{5,})["']/gi
  )) {
    addStory(m[1]);
  }
  // bare GID_SID
  for (const m of blob.matchAll(/\b(\d{8,})_(\d{5,})\b/g)) {
    addCompound(m[1], m[2]);
  }
  // bare long numbers (story-ish) — only if few lines of pure IDs, avoid noise from HTML
  // Collect from lines that look like id-only
  for (const line of blob.split(/\r?\n/)) {
    const t = line.trim();
    if (/^\d{10,22}$/.test(t)) addStory(t);
    if (/^\d{8,}_\d{5,}$/.test(t)) {
      const [a, b] = t.split("_");
      addCompound(a, b);
    }
  }

  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const push = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  // Prefer compound matching preferGid
  if (preferGid) {
    for (const c of compounds) {
      if (c.startsWith(`${preferGid}_`)) push(c);
    }
    for (const s of stories) push(`${preferGid}_${s}`);
    for (const c of compounds) push(c);
    for (const s of stories) push(s);
  } else {
    for (const c of compounds) push(c);
    for (const s of stories) push(s);
  }
  return out;
}

/**
 * Summarize parse result for UI.
 */
export function analyzePostIdPaste(text, groupId = "") {
  const ids = parsePostIdsFromText(text, { groupId });
  const compounds = ids.filter((x) => x.includes("_"));
  const singles = ids.filter((x) => !x.includes("_"));
  return {
    ok: true,
    count: ids.length,
    compound_count: compounds.length,
    single_count: singles.length,
    ids: ids.slice(0, 5000),
    sample: ids.slice(0, 8),
    tip:
      ids.length === 0
        ? "Không tìm thấy post_id/link. Hãy copy link bài (Chuột phải → Copy link) hoặc Save as HTML trang group rồi dán/upload."
        : groupId
          ? `Đã nhận ${ids.length} id (ưu tiên dạng ${groupId}_…). Graph không list feed — xóa bằng list này.`
          : `Đã nhận ${ids.length} id. Nên điền Group ID để ưu tiên dạng groupId_storyId.`,
  };
}

/**
 * Sync / list groups for one account (or all accounts).
 */
export async function fetchManagedGroups(opts = {}) {
  const accountIds = opts.account_id
    ? [Number(opts.account_id)]
    : getDb()
        .prepare(
          `SELECT id FROM fb_accounts WHERE status = 'active' ORDER BY id`
        )
        .all()
        .map((r) => r.id);

  const all = [];
  const notes = [];

  for (const aid of accountIds) {
    try {
      const acc = loadAccountForGroups(aid);
      const r = await listUserGroups(acc.user_token, {
        adminOnly: opts.admin_only !== false,
        metaAppKey: acc.meta_app_key,
      });
      if (r.errors?.length) {
        notes.push(`Account ${acc.name || aid}: ${r.errors.join(" | ")}`);
      }
      for (const g of r.groups || []) {
        all.push({
          ...g,
          account_id: acc.id,
          account_name: acc.name,
          meta_app_key: acc.meta_app_key,
        });
      }
      if (!r.ok && !(r.groups || []).length) {
        notes.push(
          `Account ${acc.name || aid}: ${(r.error || "list group fail").slice(0, 200)}`
        );
      }
    } catch (e) {
      notes.push(`Account #${aid}: ${e.message}`);
    }
  }

  // de-dupe group id (keep first)
  const map = new Map();
  for (const g of all) {
    if (!map.has(g.id)) map.set(g.id, g);
  }

  return {
    ok: map.size > 0,
    groups: [...map.values()],
    notes,
    warning:
      map.size === 0
        ? "Không lấy được danh sách Group từ Graph. Meta đã deprecate Groups API trên nhiều app. Hãy dán Group ID thủ công (bạn phải là Admin/Mod) và Connect lại token."
        : null,
  };
}

function matchKeyword(post, keyword) {
  const kw = String(keyword || "").trim().toLowerCase();
  if (!kw) return true;
  const hay = [post.message, post.story, post.from?.name, post.id]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return hay.includes(kw);
}

export async function previewGroupPosts(opts = {}) {
  const groupId = String(opts.group_id || opts.groupId || "").trim();
  const accountId = Number(opts.account_id || opts.accountId);
  if (!groupId) throw new Error("Thiếu group_id");
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error("Thiếu account_id (nick Admin/Mod đã Connect)");
  }
  const acc = loadAccountForGroups(accountId);
  const maxPosts = Math.max(0, Number(opts.max_posts || opts.maxPosts) || 100);
  const pageToks = loadPageTokensForAccount(accountId);
  const posts = await listGroupPosts(groupId, acc.user_token, {
    maxPosts: maxPosts || 100,
    since: opts.since || undefined,
    until: opts.until || undefined,
    metaAppKey: acc.meta_app_key,
    extraTokens: pageToks.map((p) => ({
      token: p.token,
      label: p.label,
      metaAppKey: acc.meta_app_key,
    })),
  });
  let filtered = posts;
  if (opts.keyword) filtered = posts.filter((p) => matchKeyword(p, opts.keyword));
  return {
    group_id: groupId,
    account: { id: acc.id, name: acc.name },
    total_fetched: posts.length,
    total_matched: filtered.length,
    posts: filtered.map((p) => ({
      id: p.id,
      message: (p.message || p.story || "").slice(0, 240),
      created_time: p.created_time || null,
      permalink_url: p.permalink_url || buildGroupPostUrl(p.id, groupId),
      from: p.from?.name || null,
    })),
  };
}

function recompute(job) {
  const pages = job.groups || [];
  const listed = pages.reduce((s, p) => s + (p.listed || 0), 0);
  const matched = pages.reduce((s, p) => s + (p.matched || 0), 0);
  const ok = pages.reduce((s, p) => s + (p.ok || 0), 0);
  const fail = pages.reduce((s, p) => s + (p.fail || 0), 0);
  const doneGroups = pages.filter((p) =>
    ["ok", "fail", "skipped", "dry_run", "partial"].includes(p.status)
  ).length;
  const totalDelete = job.progress.total_delete || matched;
  const deleted = ok + fail;
  let percent = 0;
  if (job.dry_run) {
    percent = pages.length ? Math.round((doneGroups / pages.length) * 100) : 100;
  } else if (totalDelete > 0) {
    if (job.status === "listing") {
      percent = Math.min(20, Math.round((doneGroups / Math.max(1, pages.length)) * 20));
    } else {
      percent = Math.min(100, Math.round(20 + (deleted / totalDelete) * 80));
    }
  } else if (["ok", "partial", "fail", "stopped"].includes(job.status)) {
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

function buildJobReport(job) {
  const groups = (job.groups || []).map((p) => ({
    group_id: p.group_id,
    group_name: p.group_name || p.group_id,
    account_id: p.account_id,
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
  for (const p of job.groups || []) {
    for (const f of p.failed_posts || []) {
      failed_posts.push({
        group_id: p.group_id,
        group_name: p.group_name,
        account_id: p.account_id,
        ...f,
      });
    }
  }
  return {
    job_id: job.id,
    kind: "delete_group_posts",
    status: job.status,
    finished_at: job.finished_at,
    totals: {
      groups: groups.length,
      groups_with_fail: groups.filter((g) => (g.fail || 0) > 0).length,
      listed: groups.reduce((s, g) => s + (g.listed || 0), 0),
      ok: groups.reduce((s, g) => s + (g.ok || 0), 0),
      fail: groups.reduce((s, g) => s + (g.fail || 0), 0),
      failed_links: failed_posts.length,
    },
    groups,
    failed_posts,
  };
}

function finalizeReport(job) {
  job.report = buildJobReport(job);
  const t = job.report.totals;
  if (t.fail > 0) {
    pushRecent(
      job,
      `📊 GROUP XONG: ${t.ok} OK · ${t.fail} lỗi · ${t.groups_with_fail}/${t.groups} group có lỗi · ${t.failed_links} link`
    );
    for (const g of job.report.groups) {
      if ((g.fail || 0) > 0) {
        pushRecent(
          job,
          `   ✗ ${g.group_name}: ${g.fail} lỗi / ${g.ok} OK (list ${g.matched || g.listed})`
        );
      }
    }
  } else {
    pushRecent(job, `📊 GROUP XONG: ${t.ok} OK · 0 lỗi · ${t.groups} group`);
  }
}

function applyRateLimitUi(job, info, name = "") {
  const prevStatus = job.status;
  if (["listing", "running", "rate_limited"].includes(job.status) || !job.finished_at) {
    job.status = "rate_limited";
  }
  job.progress.phase = "rate_limited";
  job.progress.rate_limited = true;
  job.progress.rate_limit_remaining_sec =
    info.remaining_sec ?? Math.ceil((info.wait_ms || 0) / 1000);
  job.progress.rate_limit_message = info.message || null;
  job.progress.label =
    info.message ||
    `⚠ FB limit${name ? ` · ${name}` : ""} — tạm dừng, còn ${job.progress.rate_limit_remaining_sec}s…`;
  if (!info.ticking) pushRecent(job, job.progress.label);
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

/**
 * Start group delete job.
 * body: groups: [{ group_id, group_name?, account_id }], max_posts, keyword, since, until,
 *        page_parallel, delay_ms, use_batch, dry_run,
 *        post_ids / post_ids_text — xóa theo list id (bỏ qua list feed khi Meta chặn API)
 */
export function startGroupDeleteJob(opts = {}) {
  let groups = opts.groups || [];
  if (!groups.length && opts.group_id) {
    groups = [
      {
        group_id: opts.group_id,
        group_name: opts.group_name || opts.group_id,
        account_id: opts.account_id,
      },
    ];
  }
  groups = groups
    .map((g) => ({
      group_id: String(g.group_id || g.id || "").trim(),
      group_name: g.group_name || g.name || g.group_id || g.id,
      account_id: Number(g.account_id || opts.account_id),
    }))
    .filter((g) => g.group_id && Number.isFinite(g.account_id) && g.account_id > 0);

  // Manual post ids (when feed API blocked)
  let manualPostIds = [];
  if (Array.isArray(opts.post_ids)) {
    manualPostIds = opts.post_ids.map(String).filter(Boolean);
  } else if (opts.post_ids_text || opts.postIdsText) {
    manualPostIds = parsePostIdsFromText(opts.post_ids_text || opts.postIdsText);
  }

  if (!groups.length) {
    throw new Error("Chọn/dán ít nhất 1 Group + account Admin/Mod (account_id)");
  }

  const pageParallel = Math.min(
    10,
    Math.max(1, Number(opts.page_parallel ?? opts.pageParallel ?? 2) || 2)
  );
  const dryRun = Boolean(opts.dry_run || opts.dryRun);

  const job = {
    id: nanoid(10),
    kind: "delete_group_posts",
    status: "queued",
    dry_run: dryRun,
    created_at: nowIso(),
    finished_at: null,
    stop_requested: false,
    options: {
      since: opts.since || null,
      until: opts.until || null,
      keyword: opts.keyword || null,
      max_posts: Number(opts.max_posts || opts.maxPosts || 2000) || 2000,
      use_batch: opts.use_batch !== false && opts.useBatch !== false,
      concurrency: Math.min(20, Math.max(1, Number(opts.concurrency) || 6)),
      page_parallel: pageParallel,
      delay_ms: Math.max(0, Number(opts.delay_ms ?? opts.delayMs ?? 80)),
      manual_post_ids: manualPostIds,
    },
    groups: groups.map((g) => ({
      group_id: g.group_id,
      group_name: g.group_name,
      account_id: g.account_id,
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
    _postMeta: null,
  };

  jobs.set(job.id, job);
  trimJobs();
  setImmediate(() =>
    runJob(job.id).catch((e) => {
      const j = jobs.get(job.id);
      if (!j) return;
      j.status = "fail";
      j.finished_at = nowIso();
      j.progress.label = e.message || String(e);
      finalizeReport(j);
      emit(j);
    })
  );
  return snapshot(job);
}

async function listOneGroup(job, state, toDelete) {
  if (job.stop_requested) {
    state.status = "skipped";
    state.error = "Đã dừng";
    return;
  }
  try {
    const acc = loadAccountForGroups(state.account_id);
    state.status = "listing";
    job.progress.label = `List group · ${state.group_name}`;
    emit(job);

    if (!job._postMeta) job._postMeta = new Map();
    const meta = new Map();

    // Manual post IDs: skip Graph feed (Meta often blocks groups feed/posts)
    const manual = job.options.manual_post_ids || [];
    if (manual.length && job.groups.length === 1) {
      const ids = [...new Set(manual)];
      state.listed = ids.length;
      state.matched = ids.length;
      for (const id of ids) {
        meta.set(id, {
          id,
          link: buildGroupPostUrl(id, state.group_id),
          message: "",
          created_time: null,
          from: null,
        });
      }
      job._postMeta.set(state.group_id, meta);
      toDelete.set(state.group_id, {
        ids,
        account_id: state.account_id,
        metaAppKey: acc.meta_app_key,
        delete_tokens: buildDeleteTokenList(acc),
      });
      pushRecent(
        job,
        `${state.group_name}: dùng ${ids.length} post_id dán tay (không list feed)`
      );
      state.status = job.dry_run ? "dry_run" : "ready";
      recompute(job);
      emit(job);
      return;
    }

    const pageToks = loadPageTokensForAccount(state.account_id);
    const posts = await listGroupPosts(state.group_id, acc.user_token, {
      maxPosts: job.options.max_posts,
      since: job.options.since || undefined,
      until: job.options.until || undefined,
      metaAppKey: acc.meta_app_key,
      shouldStop: () => job.stop_requested,
      onRateLimit: (info) => applyRateLimitUi(job, info, state.group_name),
      extraTokens: pageToks.map((p) => ({
        token: p.token,
        label: p.label,
        metaAppKey: acc.meta_app_key,
      })),
      onBatch: (_b, total) => {
        state.listed = total;
        recompute(job);
        if (job.status === "rate_limited") {
          clearRateLimitUi(job, `List · ${state.group_name}`);
        }
        emit(job);
      },
    });
    clearRateLimitUi(job, `List xong · ${state.group_name}`);
    state.listed = posts.length;
    const filtered = job.options.keyword
      ? posts.filter((p) => matchKeyword(p, job.options.keyword))
      : posts;
    state.matched = filtered.length;
    const ids = filtered.map((p) => p.id);
    for (const p of filtered) {
      meta.set(p.id, {
        id: p.id,
        link: buildGroupPostUrl(p.id, state.group_id, p.permalink_url),
        message: String(p.message || p.story || "").slice(0, 200),
        created_time: p.created_time || null,
        from: p.from?.name || null,
      });
    }
    job._postMeta.set(state.group_id, meta);
    toDelete.set(state.group_id, {
      ids,
      account_id: state.account_id,
      metaAppKey: acc.meta_app_key,
      delete_tokens: buildDeleteTokenList(acc),
    });
    pushRecent(job, `${state.group_name}: ${ids.length} bài khớp (list ${state.listed})`);
    state.status = job.dry_run ? "dry_run" : "ready";
  } catch (e) {
    state.status = "fail";
    // Short user-facing error; full text in recent
    const msg = e.message || String(e);
    if (e.group_api_blocked || /nonexisting field|deprecate/i.test(msg)) {
      state.error =
        "Meta chặn đọc feed Group (API deprecated). Hãy dán post_id/link bài vào ô «Post ID / link» rồi xóa.";
    } else {
      state.error = msg.slice(0, 300);
    }
    pushRecent(job, `Lỗi list ${state.group_name}: ${msg.slice(0, 400)}`);
  }
  recompute(job);
  emit(job);
}

function buildDeleteTokenList(acc) {
  const list = [{ token: acc.user_token, label: "user", metaAppKey: acc.meta_app_key }];
  for (const p of loadPageTokensForAccount(acc.id)) {
    list.push({
      token: p.token,
      label: p.label,
      metaAppKey: acc.meta_app_key,
    });
  }
  return list;
}

async function deleteOneGroup(job, state, toDelete) {
  if (job.stop_requested) {
    if (state.status === "ready") {
      state.status = "skipped";
      state.error = "Đã dừng";
    }
    return;
  }
  if (state.status !== "ready") return;

  const pack = toDelete.get(state.group_id);
  const ids = pack?.ids || [];
  if (!ids.length) {
    state.status = "ok";
    recompute(job);
    emit(job);
    return;
  }

  try {
    const acc = loadAccountForGroups(state.account_id);
    state.status = "deleting";
    job.progress.label = `Xóa group · ${state.group_name} (${ids.length})`;
    emit(job);

    // Try user token first, then page tokens if many permanent fails
    const tokenList =
      pack?.delete_tokens || buildDeleteTokenList(acc);
    let result = null;
    let remaining = [...ids];
    const allItems = [];
    let totalOk = 0;
    let totalGone = 0;
    let errorSummaryMap = {};

    for (let ti = 0; ti < tokenList.length && remaining.length; ti++) {
      const tok = tokenList[ti];
      if (job.stop_requested) break;
      pushRecent(
        job,
        `${state.group_name}: xóa bằng ${tok.label} (${remaining.length} bài)…`
      );
      const r = await deletePagePostsFast(remaining, tok.token, {
        useBatch: job.options.use_batch,
        concurrency: job.options.concurrency,
        delayMs: job.options.delay_ms,
        metaAppKey: tok.metaAppKey || acc.meta_app_key,
        shouldStop: () => job.stop_requested,
        onRateLimit: (info) => applyRateLimitUi(job, info, state.group_name),
        onProgress: (info) => {
          state.ok = totalOk + info.ok;
          state.fail = info.fail;
          recompute(job);
          if (info.phase === "rate_limited" || info.rate_limit) return;
          if (job.status === "rate_limited" || job.progress.rate_limited) {
            clearRateLimitUi(job, `${state.group_name}: ${info.done}/${info.total}`);
          }
          job.progress.phase = "deleting";
          job.progress.label = `${state.group_name}: ${tok.label} ${info.done}/${info.total}`;
          emit(job);
        },
      });
      totalOk += r.ok;
      totalGone += r.gone || 0;
      for (const it of r.items || []) {
        if (it.ok) {
          allItems.push(it);
        }
      }
      // retry only failures with next token
      remaining = (r.items || []).filter((x) => !x.ok).map((x) => x.post_id);
      for (const e of r.error_summary || []) {
        errorSummaryMap[e.message] = (errorSummaryMap[e.message] || 0) + e.count;
      }
      result = r;
      if (!remaining.length) break;
      if (ti < tokenList.length - 1) {
        pushRecent(
          job,
          `${state.group_name}: còn ${remaining.length} fail → thử token tiếp`
        );
      } else {
        for (const it of r.items || []) {
          if (!it.ok) allItems.push(it);
        }
      }
    }

    // Build final fail list from last remaining
    if (remaining.length && result) {
      // ensure failed items present
      const have = new Set(allItems.map((x) => x.post_id));
      for (const id of remaining) {
        if (!have.has(id)) {
          allItems.push({
            post_id: id,
            ok: false,
            error: "Xóa fail với mọi token (user + page)",
          });
        }
      }
    }

    clearRateLimitUi(job, null);
    const failCount = allItems.filter((x) => !x.ok).length;
    state.ok = totalOk;
    state.fail = failCount;
    state.error_summary = Object.entries(errorSummaryMap)
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    state.status =
      failCount === 0 ? "ok" : totalOk === 0 ? "fail" : "partial";

    const meta = job._postMeta?.get(state.group_id) || new Map();
    const failed = [];
    for (const it of allItems) {
      if (it.ok) continue;
      const m = meta.get(it.post_id) || {};
      failed.push({
        post_id: it.post_id,
        link: m.link || buildGroupPostUrl(it.post_id, state.group_id),
        message: m.message || "",
        created_time: m.created_time || null,
        from: m.from || null,
        error: it.error || "unknown",
      });
    }
    state.failed_posts = failed.slice(0, 3000);
    if (failCount) {
      const top = state.error_summary[0];
      state.error =
        (top && `${top.message} (×${top.count})`) || `${failCount} lỗi`;
    }
    pushRecent(
      job,
      `${state.group_name}: xóa OK ${totalOk} · fail ${failCount}${totalGone ? ` · gone ${totalGone}` : ""}`
    );
    if (state.error_summary?.length) {
      pushRecent(
        job,
        `${state.group_name} · top lỗi: ${state.error_summary
          .slice(0, 3)
          .map((e) => `「${e.message}」×${e.count}`)
          .join(" · ")}`
      );
    }
  } catch (e) {
    state.status = "fail";
    state.error = e.message || String(e);
    pushRecent(job, `Lỗi xóa ${state.group_name}: ${state.error}`);
  }
  recompute(job);
  emit(job);
}

async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  const parallel = job.options.page_parallel || 2;

  job.status = "listing";
  job.progress.phase = "listing";
  job.progress.label = `Đang list feed Group (//${parallel})…`;
  recompute(job);
  emit(job);

  /** @type {Map<string, {ids:string[], account_id:number}>} */
  const toDelete = new Map();

  await mapPool(job.groups, parallel, async (state) => {
    await listOneGroup(job, state, toDelete);
  });

  const allIdsCount = [...toDelete.values()].reduce((s, p) => s + p.ids.length, 0);
  job.progress.total_delete = allIdsCount;
  job.progress.matched = allIdsCount;

  if (job.dry_run) {
    job.status = "ok";
    job.finished_at = nowIso();
    job.progress.phase = "dry_run";
    job.progress.label = `Dry-run: ${allIdsCount} bài group sẽ xóa`;
    job.progress.percent = 100;
    finalizeReport(job);
    emit(job);
    return;
  }

  if (!allIdsCount) {
    job.status = "ok";
    job.finished_at = nowIso();
    job.progress.phase = "done";
    job.progress.label = "Không có bài group để xóa (list rỗng hoặc lỗi API)";
    job.progress.percent = 100;
    finalizeReport(job);
    emit(job);
    return;
  }

  job.status = "running";
  job.progress.phase = "deleting";
  job.progress.label = `Đang xóa ${allIdsCount} bài group…`;
  recompute(job);
  emit(job);

  await mapPool(job.groups, parallel, async (state) => {
    await deleteOneGroup(job, state, toDelete);
  });

  job.finished_at = nowIso();
  job.progress.percent = 100;
  job.progress.rate_limited = false;
  const failG = job.groups.filter((g) => ["fail", "partial"].includes(g.status)).length;
  const okG = job.groups.filter((g) => g.status === "ok").length;

  if (job.stop_requested) {
    job.status = "stopped";
    job.progress.label = "Đã dừng giữa chừng";
  } else if (failG && okG) {
    job.status = "partial";
    job.progress.label = `Xong một phần · OK ${job.progress.ok} · lỗi ${job.progress.fail}`;
  } else if (failG && !okG && job.progress.ok === 0) {
    job.status = "fail";
    job.progress.label = `Thất bại · ${job.progress.fail} lỗi`;
  } else {
    job.status = "ok";
    job.progress.label = `Xong · đã xóa ${job.progress.ok} bài group`;
  }

  finalizeReport(job);
  if (job.report?.totals?.fail) {
    job.progress.label += ` · ${job.report.totals.groups_with_fail} group lỗi · xem báo cáo`;
  }
  job._postMeta = null;
  emit(job);
}

export function getGroupDeleteJob(id) {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

export function listGroupDeleteJobs(limit = 20) {
  return [...jobs.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit)
    .map(snapshot);
}

export function stopGroupDeleteJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.stop_requested = true;
  pushRecent(job, "Yêu cầu dừng…");
  emit(job);
  return snapshot(job);
}

export function onGroupDeleteJob(id, fn) {
  const key = `job:${id}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

export function groupFailedPostsToCsv(jobOrId) {
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
    "group_name",
    "group_id",
    "post_id",
    "link",
    "error",
    "from",
    "created_time",
    "message",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        esc(r.group_name),
        esc(r.group_id),
        esc(r.post_id),
        esc(r.link),
        esc(r.error),
        esc(r.from),
        esc(r.created_time),
        esc(r.message),
      ].join(",")
    );
  }
  return lines.join("\r\n");
}
