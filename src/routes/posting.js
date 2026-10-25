import { Router } from "express";
import path from "path";
import fs from "fs";
import { getDb } from "../db/index.js";
import {
  getPagePostConfig,
  savePagePostConfig,
  runOnePost,
  runSchedulerTick,
  listPostLogs,
  mediaStats,
  getCaptionStats,
  getDefaultConfig,
} from "../services/poster.js";
import { getPostLogCsvPath } from "../services/postLogCsv.js";
import {
  getActiveTimesForPageRow,
  savePreferredHours,
  savePreferredHoursBulk,
  getPreferredHours,
  DEFAULT_PREFERRED_HOURS,
} from "../services/activeTimes.js";
import {
  scheduleOnePost,
  scheduleBulk,
  listFbScheduledForPage,
  reconcileScheduledLogs,
} from "../services/schedule.js";
import { listJobs, getJob } from "../services/jobRunner.js";
import { listMetaAppsPublic } from "../services/metaApps.js";
import { getFollowerGrowth } from "../services/followerHistory.js";
import { getAppSetting, saveAppSetting } from "../services/appSettings.js";
import { archivedLinkOrdinals, bundleLinkFolder, linkLineOrdinal } from "../services/bundleArchive.js";
import {
  getSelectionGroups,
  saveSelectionGroups,
  upsertAccountGroup,
  upsertPageGroup,
  deleteAccountGroup,
  deletePageGroup,
  resolveGroupToPageIds,
} from "../services/selectionGroups.js";
import {
  installListMedia,
  installTokenMedia,
  setTokenMediaEnabled,
  installPageGroupMedia,
  setPageGroupMediaEnabled,
  addPagesToPageGroup,
} from "../services/tokenMedia.js";
import { splitPagesByToken } from "../services/tokenSplit.js";

const router = Router();
const POSTING_WORKSPACE_KEY = "posting_workspace_v1";

const DEFAULT_WORKSPACE = Object.freeze({
  selected_page_ids: [],
  active_page_id: null,
  active_view: "configure",
  bulk: {},
  rotation: {},
  bundle: {},
});

function todayVnKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function configForToday(cfg) {
  const today = todayVnKey();
  return {
    ...cfg,
    posts_today: cfg.posts_today_date === today ? Number(cfg.posts_today) || 0 : 0,
    posts_today_date: today,
  };
}

function normalizeWorkspaceState(input = {}) {
  const db = getDb();
  const activeIds = new Set(
    db
      .prepare(`SELECT id FROM fb_pages WHERE status = 'active'`)
      .all()
      .map((row) => Number(row.id))
  );
  const selected = [
    ...new Set(
      (Array.isArray(input.selected_page_ids) ? input.selected_page_ids : [])
        .map(Number)
        .filter((id) => id > 0 && activeIds.has(id))
    ),
  ];
  const requestedActiveId = Number(input.active_page_id);
  if (!selected.length && activeIds.has(requestedActiveId)) {
    selected.push(requestedActiveId);
  }
  const activeId = selected.includes(requestedActiveId)
    ? requestedActiveId
    : selected[0] || null;
  const allowedViews = new Set(["configure", "run", "bundle", "schedule", "monitor"]);
  const objectBag = (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    selected_page_ids: selected,
    active_page_id: activeId,
    active_view: allowedViews.has(input.active_view)
      ? input.active_view
      : "configure",
    bulk: objectBag(input.bulk),
    rotation: objectBag(input.rotation),
    bundle: objectBag(input.bundle),
  };
}

/** Durable Page selection + last-used posting controls. */
router.get("/workspace-state", (_req, res) => {
  const saved = getAppSetting(POSTING_WORKSPACE_KEY, DEFAULT_WORKSPACE);
  const state = normalizeWorkspaceState({ ...DEFAULT_WORKSPACE, ...saved });
  if (JSON.stringify(saved) !== JSON.stringify(state)) {
    saveAppSetting(POSTING_WORKSPACE_KEY, state);
  }
  res.json({ state });
});

router.put("/workspace-state", (req, res) => {
  const current = getAppSetting(POSTING_WORKSPACE_KEY, DEFAULT_WORKSPACE);
  const incoming = req.body?.state || req.body || {};
  const merged = {
    ...DEFAULT_WORKSPACE,
    ...current,
    ...incoming,
    bulk: { ...(current.bulk || {}), ...(incoming.bulk || {}) },
    rotation: { ...(current.rotation || {}), ...(incoming.rotation || {}) },
    bundle: { ...(current.bundle || {}), ...(incoming.bundle || {}) },
  };
  const state = normalizeWorkspaceState(merged);
  saveAppSetting(POSTING_WORKSPACE_KEY, state);
  res.json({ ok: true, state });
});

/**
 * Custom groups for easier multi-select when posting.
 * GET  /api/posting/selection-groups
 * PUT  /api/posting/selection-groups  { account_groups, page_groups }
 * POST /api/posting/selection-groups/account  create/update one account group
 * POST /api/posting/selection-groups/page     create/update one page group
 * DELETE /api/posting/selection-groups/account/:id
 * DELETE /api/posting/selection-groups/page/:id
 * POST /api/posting/selection-groups/resolve  → page_row_ids from a group
 */
router.get("/selection-groups", (_req, res) => {
  res.json({ ok: true, ...getSelectionGroups() });
});

router.put("/selection-groups", (req, res) => {
  try {
    const data = saveSelectionGroups(req.body || {});
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/selection-groups/account", (req, res) => {
  try {
    const data = upsertAccountGroup(req.body || {});
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/selection-groups/page", (req, res) => {
  try {
    const data = upsertPageGroup(req.body || {});
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.delete("/selection-groups/account/:id", (req, res) => {
  try {
    const data = deleteAccountGroup(req.params.id);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.delete("/selection-groups/page/:id", (req, res) => {
  try {
    const data = deletePageGroup(req.params.id);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/selection-groups/resolve", (req, res) => {
  try {
    const r = resolveGroupToPageIds(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/posting/token-media/token  { account_id, media_folder, posted_folder? } */
router.post("/token-media/token", (req, res) => {
  try {
    const row = installTokenMedia(
      req.body?.account_id,
      req.body?.media_folder,
      req.body?.posted_folder
    );
    res.json({ ok: true, ...row });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/posting/token-media/use  { account_id, enabled } */
router.post("/token-media/use", (req, res) => {
  try {
    const row = setTokenMediaEnabled(req.body?.account_id, req.body?.enabled);
    res.json({ ok: true, ...row });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/posting/token-media/list  { account_group_id, media_folder, posted_folder? } */
router.post("/token-media/list", (req, res) => {
  try {
    const row = installListMedia(
      req.body?.account_group_id,
      req.body?.media_folder,
      req.body?.posted_folder
    );
    res.json({ ok: true, ...row, ...getSelectionGroups() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/posting/page-group-media/install  { page_group_id, media_folder, posted_folder? } */
router.post("/page-group-media/install", (req, res) => {
  try {
    const row = installPageGroupMedia(
      req.body?.page_group_id,
      req.body?.media_folder,
      req.body?.posted_folder
    );
    res.json({ ok: true, ...row, ...getSelectionGroups() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/posting/page-group-media/use  { page_group_id, enabled } */
router.post("/page-group-media/use", (req, res) => {
  try {
    const row = setPageGroupMediaEnabled(req.body?.page_group_id, req.body?.enabled);
    res.json({ ok: true, ...row, ...getSelectionGroups() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/posting/page-groups/add  { page_group_id, page_row_ids } */
router.post("/page-groups/add", (req, res) => {
  try {
    const row = addPagesToPageGroup(req.body?.page_group_id, req.body?.page_row_ids);
    res.json({ ok: true, ...row, ...getSelectionGroups() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/posting/split-by-token  { pages_per_token?: 15 } */
router.post("/split-by-token", async (req, res) => {
  try {
    const r = await splitPagesByToken({
      pages_per_token: req.body?.pages_per_token,
    });
    res.json(r);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

function pageExists(id) {
  return getDb()
    .prepare(`SELECT id, page_id, name, status FROM fb_pages WHERE id = ?`)
    .get(id);
}

function normalizeConfigBody(input) {
  const body = { ...(input || {}) };
  for (const key of ["captions", "comment_templates"]) {
    if (typeof body[key] === "string") {
      body[key] = body[key].split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  }
  if (typeof body.sequence === "string") {
    body.sequence = body.sequence.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  if (body.link_lists && typeof body.link_lists === "object") {
    const out = {};
    // Scalar keys (NOT URL lists) — must not be split into arrays
    const scalarKeys = new Set([
      "story_link_mode",
      "comment_link_mode",
      "comment_pick_mode",
      "comment_when",
      "comment_link_next",
      "comment_tpl_next",
      "comment_delay_minutes",
      "comment_min_likes",
      "comment_max_pages_per_site",
      "caption_lead_enabled",
      "caption_lead_mode",
      "caption_lead_tpl_next",
      "caption_lead_link_next",
      "video_title_enabled",
      "video_titles_path",
      "mention_enabled",
      "mention_ids",
      "mention_target",
      "mention_position",
      "use_caption",
      "comment_with_link",
      "comment_open_folder",
      "comment_bundle_mode",
    ]);
    for (const [k, v] of Object.entries(body.link_lists)) {
      if (scalarKeys.has(k)) {
        if (
          k === "comment_link_next" ||
          k === "comment_tpl_next" ||
          k === "comment_delay_minutes" ||
          k === "comment_min_likes" ||
          k === "comment_max_pages_per_site" ||
          k === "caption_lead_tpl_next" ||
          k === "caption_lead_link_next"
        ) {
          const n = Number(Array.isArray(v) ? v[0] : v);
          const cap =
            k === "comment_delay_minutes"
              ? 7 * 24 * 60
              : k === "comment_min_likes"
                ? 1_000_000
                : 500;
          out[k] = Number.isFinite(n) ? Math.max(0, Math.min(cap, n)) : 0;
        } else if (
          k === "caption_lead_enabled" ||
          k === "video_title_enabled" ||
          k === "mention_enabled" ||
          k === "use_caption" ||
          k === "comment_with_link"
        ) {
          const raw = Array.isArray(v) ? v[0] : v;
          const s = String(raw ?? "").trim().toLowerCase();
          out[k] =
            raw === true ||
            raw === 1 ||
            s === "1" ||
            s === "on" ||
            s === "true" ||
            s === "yes"
              ? 1
              : 0;
        } else if (k === "video_titles_path" || k === "comment_open_folder") {
          const raw = Array.isArray(v) ? v[0] : v;
          out[k] = String(raw ?? "").trim();
        } else if (
          k === "comment_link_mode" ||
          k === "comment_pick_mode" ||
          k === "caption_lead_mode"
        ) {
          const raw = Array.isArray(v) ? v[0] : v;
          const m = String(raw || "random").trim().toLowerCase();
          if (
            m === "match_media" ||
            m === "by_media" ||
            m === "by_filename" ||
            m === "theo_ten" ||
            m === "theo_ten_media" ||
            m === "media_name"
          ) {
            out[k] = "match_media";
          } else if (m === "sequential" || m === "sequence" || m === "theo_bai") {
            out[k] = "sequential";
          } else {
            out[k] = "random";
          }
        } else if (k === "comment_bundle_mode") {
          const raw = Array.isArray(v) ? v[0] : v;
          const m = String(raw || "split").trim().toLowerCase();
          out[k] = m === "merged" ? "merged" : "split";
        } else if (k === "comment_when") {
          const raw = Array.isArray(v) ? v[0] : v;
          const m = String(raw || "after_publish").trim().toLowerCase();
          out[k] =
            m === "immediate" || m === "now" || m === "ngay" || m === "right_after_schedule"
              ? "immediate"
              : "after_publish";
        } else {
          // story_link_mode
          out[k] = String(v || body.story_link_mode || "combo");
        }
        continue;
      }
      // URL / line lists
      out[k] =
        typeof v === "string"
          ? v
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean)
          : Array.isArray(v)
            ? v.map((s) => String(s ?? "").trim()).filter(Boolean)
            : [];
    }
    if (body.story_link_mode && !out.story_link_mode) {
      out.story_link_mode = String(body.story_link_mode);
    }
    body.link_lists = out;
  } else if (body.story_link_mode) {
    body.link_lists = {
      see_more: [],
      full_album: [],
      story_link_mode: String(body.story_link_mode),
    };
  }
  return body;
}

function assertConfigFolders(body) {
  for (const [key, label] of [
    ["media_folder", "Media"],
    ["posted_folder", "Posted"],
    ["captions_folder", "Caption"],
  ]) {
    if (body[key] == null || String(body[key]).trim() === "") continue;
    const folder = path.resolve(String(body[key]).trim());
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new Error(`${label} folder không tồn tại: ${folder}`);
    }
    body[key] = folder;
  }
  return body;
}

/** GET /api/posting/config/:pageRowId */
router.get("/config/:pageRowId", (req, res) => {
  const id = Number(req.params.pageRowId);
  const page = pageExists(id);
  if (!page) return res.status(404).json({ error: "Page not found" });
  const cfg = configForToday(getPagePostConfig(id));
  res.json({
    page,
    config: cfg,
    media: mediaStats(cfg.media_folder),
    captions_pool: getCaptionStats(cfg),
    story_note:
      "Story = Page Stories API (ảnh/video). Meta không có sticker link — tool dùng combo Story + Feed link hoặc in URL lên ảnh (overlay).",
  });
});

/** PUT /api/posting/config/:pageRowId */
router.put("/config/:pageRowId", (req, res) => {
  const id = Number(req.params.pageRowId);
  if (!pageExists(id)) return res.status(404).json({ error: "Page not found" });
  let body;
  try {
    body = assertConfigFolders(normalizeConfigBody(req.body));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const cfg = configForToday(savePagePostConfig(id, body));
  res.json({
    config: cfg,
    media: mediaStats(cfg.media_folder),
    captions_pool: getCaptionStats(cfg),
  });
});

/** PUT /api/posting/config-bulk — apply one full config to many pages. */
router.put("/config-bulk", (req, res) => {
  const ids = [...new Set((req.body?.page_row_ids || []).map(Number).filter((id) => id > 0))];
  if (!ids.length) return res.status(400).json({ error: "Chưa chọn Page" });
  const missing = ids.filter((id) => !pageExists(id));
  if (missing.length) return res.status(404).json({ error: `Page không tồn tại: ${missing.join(", ")}` });
  let configBody;
  try {
    configBody = assertConfigFolders(normalizeConfigBody(req.body?.config || {}));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const bundleLinks = filterArchivedBundleLinks(configBody);
  const saved = getDb().transaction(() => ids.map((id) => savePagePostConfig(id, configBody)))();
  res.json({
    ok: true,
    updated: saved.length,
    page_row_ids: ids,
    ...(bundleLinks ? { comment_links: bundleLinks.links, dropped_archived_links: bundleLinks.dropped } : {}),
  });
});

/** Chỉ lần lưu Theo bộ. Link đã nằm trong link/đã đăng thì bỏ khỏi ô, khỏi bị dán lại. */
function filterArchivedBundleLinks(configBody) {
  const ll = configBody?.link_lists;
  if (!ll || typeof ll !== "object" || !Array.isArray(ll.comment_links)) return null;
  const openFolder = String(ll.comment_open_folder || "").trim();
  if (ll.comment_link_mode !== "match_media" || !openFolder) return null;
  const archived = archivedLinkOrdinals(bundleLinkFolder(configBody.media_folder));
  if (!archived.size) return { links: ll.comment_links, dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (const line of ll.comment_links) {
    const n = linkLineOrdinal(line);
    if (n != null && archived.has(n)) dropped += 1;
    else kept.push(line);
  }
  ll.comment_links = kept;
  if (!kept.length && dropped) ll.force_clear_link_lists = true;
  return { links: kept, dropped };
}

/**
 * POST /api/posting/run/:pageRowId
 * Manual one post. Body: { ignore_quota?, ignore_interval? }
 * force=true allows even if enabled=0
 */
router.post("/run/:pageRowId", async (req, res) => {
  try {
    const id = Number(req.params.pageRowId);
    if (!pageExists(id)) return res.status(404).json({ error: "Page not found" });
    const result = await runOnePost(id, {
      force: true,
      ignore_quota: !!req.body?.ignore_quota,
      ignore_interval: !!req.body?.ignore_interval,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, fb: e.fb || null });
  }
});

/** POST /api/posting/scheduler/tick — run due pages once */
router.post("/scheduler/tick", async (_req, res) => {
  try {
    const results = await runSchedulerTick();
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/posting/logs */
router.get("/logs", (req, res) => {
  try {
    const pageRowId = req.query.page_row_id
      ? Number(req.query.page_row_id)
      : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    res.json({ logs: listPostLogs({ pageRowId, limit }) });
  } catch (e) {
    res.status(500).json({ error: e.message || "Không đọc được nhật ký bài" });
  }
});

/** POST /api/posting/reconcile-scheduled — verify overdue schedules with Facebook.
 * Body: { limit?, day?: "YYYY-MM-DD", stream?: boolean }
 * stream=true → SSE tiến trình % (event: progress | done | error)
 */
router.post("/reconcile-scheduled", async (req, res) => {
  const wantStream =
    req.body?.stream === true ||
    String(req.query.stream || "") === "1" ||
    String(req.headers.accept || "").includes("text/event-stream");
  try {
    if (wantStream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send("progress", { percent: 0, message: "Bắt đầu…" });
      const scope = {
        limit: req.body?.limit || 50,
        day: req.body?.day || null,
        account_id: req.body?.account_id || null,
        meta_app_key: req.body?.meta_app_key || null,
        page_row_ids: req.body?.page_row_ids || null,
        log_ids: req.body?.log_ids || null,
        page_group_id: req.body?.page_group_id || null,
        account_group_id: req.body?.account_group_id || null,
      };
      const result = await reconcileScheduledLogs({
        ...scope,
        onProgress: (p) => send("progress", p),
      });
      send("done", { ok: true, scope, ...result });
      res.end();
      return;
    }
    const scope = {
      limit: req.body?.limit || 50,
      day: req.body?.day || null,
      account_id: req.body?.account_id || null,
      meta_app_key: req.body?.meta_app_key || null,
      page_row_ids: req.body?.page_row_ids || null,
      log_ids: req.body?.log_ids || null,
      page_group_id: req.body?.page_group_id || null,
      account_group_id: req.body?.account_group_id || null,
    };
    const result = await reconcileScheduledLogs(scope);
    res.json({ ok: true, scope, ...result });
  } catch (e) {
    if (wantStream) {
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({ ok: false, error: e.message })}\n\n`
        );
        res.end();
      } catch {
        /* */
      }
      return;
    }
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** GET /api/posting/logs/csv — download post log CSV (empty file ok) */
router.get("/logs/csv", (_req, res) => {
  const file = getPostLogCsvPath();
  if (!fs.existsSync(file)) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="post_logs.csv"'
    );
    return res.status(200).send("\uFEFFcreated_at,page_name,post_type,status,error\n");
  }
  res.download(file, "post_logs.csv");
});

/**
 * delivery_mode chuẩn hoá cho cả dữ liệu cũ (chưa có cột / rỗng):
 *  - có giá trị valid → dùng
 *  - scheduled_publish_time not null → fb_scheduled
 *  - else direct
 * Dùng COALESCE để an toàn nếu cột NULL trên row cũ.
 */
const DELIVERY_MODE_SQL = `
  CASE
    WHEN COALESCE(delivery_mode,'') IN ('direct','scheduled_direct','fb_scheduled') THEN delivery_mode
    WHEN scheduled_publish_time IS NOT NULL AND scheduled_publish_time <> '' THEN 'fb_scheduled'
    ELSE 'direct'
  END`;
// Ngày VN (post_logs lưu UTC) — dùng scheduled_publish_time nếu có, else created_at.
const VN_DAY_SQL = `date(COALESCE(NULLIF(scheduled_publish_time,''), created_at), '+7 hours')`;

/** Graph đôi khi trả permalink dạng /reel/ID — thiếu host → link «mở» sai. */
function normalizeFacebookPostUrl(url, postId = null) {
  const raw = String(url || "").trim();
  const id = postId != null ? String(postId).trim() : "";
  if (raw) {
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("//")) return `https:${raw}`;
    if (raw.startsWith("/")) return `https://www.facebook.com${raw}`;
    if (/^(facebook\.com|fb\.watch|fb\.com)/i.test(raw)) return `https://${raw}`;
    return `https://www.facebook.com/${raw.replace(/^\/+/, "")}`;
  }
  if (id) {
    // pageId_postId → https://www.facebook.com/pageId/posts/postId
    if (/^\d+_\d+$/.test(id)) {
      const [pageId, storyId] = id.split("_");
      return `https://www.facebook.com/${pageId}/posts/${storyId}`;
    }
    return `https://www.facebook.com/${id}`;
  }
  return null;
}
const SUCCESS_STATUS = "('ok','ok_comment_failed','scheduled','published','schedule_overdue')";

/**
 * GET /api/posting/stats/summary?day=YYYY-MM-DD
 * Tiến trình tổng + theo ngày, phân 3 loại delivery_mode.
 */
router.get("/stats/summary", (req, res) => {
  const db = getDb();
  const day =
    typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
      ? req.query.day
      : null;
  const rowsFor = (whereDay) => {
    const rows = db
      .prepare(
        `SELECT ${DELIVERY_MODE_SQL} AS mode,
                SUM(CASE WHEN status IN ${SUCCESS_STATUS} THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN status NOT IN ${SUCCESS_STATUS} THEN 1 ELSE 0 END) AS fail,
                COUNT(*) AS total
         FROM post_logs
         ${whereDay ? `WHERE ${VN_DAY_SQL} = ?` : ""}
         GROUP BY mode`
      )
      .all(...(whereDay ? [whereDay] : []));
    const out = {
      direct: { ok: 0, fail: 0, total: 0 },
      scheduled_direct: { ok: 0, fail: 0, total: 0 },
      fb_scheduled: { ok: 0, fail: 0, total: 0 },
      all: { ok: 0, fail: 0, total: 0 },
    };
    for (const r of rows) {
      const m = out[r.mode] || out.direct;
      m.ok += Number(r.ok || 0);
      m.fail += Number(r.fail || 0);
      m.total += Number(r.total || 0);
      out.all.ok += Number(r.ok || 0);
      out.all.fail += Number(r.fail || 0);
      out.all.total += Number(r.total || 0);
    }
    return out;
  };
  const todayVn = todayVnKey();
  res.json({
    day: day || todayVn,
    today: rowsFor(day || todayVn),
    total: rowsFor(null),
  });
});

/**
 * GET /api/posting/pending
 * Bài đã hẹn / chờ đăng — hỗ trợ lịch Meta Suite-style.
 * Query:
 *  days | month=YYYY-MM | account_id | meta_app_key |
 *  page_group_id | account_group_id | job_id | limit
 */
router.get("/pending", (req, res) => {
  try {
    const db = getDb();
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 31));
    const limit = Math.min(3000, Math.max(1, Number(req.query.limit) || 800));
    const filterAccountId = Number(req.query.account_id || 0) || null;
    const filterApp = String(req.query.meta_app_key || "").trim() || null;
    const filterJobId = String(req.query.job_id || "").trim() || null;
    const pageGroupId = String(req.query.page_group_id || "").trim() || null;
    const accountGroupId = String(req.query.account_group_id || "").trim() || null;
    const filterPageRowId = Number(req.query.page_row_id || 0) || null;
    const filterPageQ = String(req.query.page_q || req.query.q || "")
      .trim()
      .toLowerCase();

    let monthYear = null;
    let monthNum = null;
    const monthRaw = String(req.query.month || "").trim();
    const mm = monthRaw.match(/^(\d{4})-(\d{2})$/);
    if (mm) {
      monthYear = Number(mm[1]);
      monthNum = Number(mm[2]);
    }
    const fromDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ""))
      ? String(req.query.from)
      : null;
    const toDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ""))
      ? String(req.query.to)
      : null;
    const inView = (day) => {
      const d = String(day || "");
      if (fromDay && toDay) return d >= fromDay && d <= toDay;
      if (monthYear && monthNum) {
        return d.startsWith(`${monthYear}-${String(monthNum).padStart(2, "0")}`);
      }
      return true;
    };

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const minMs = nowMs - days * 24 * 3600 * 1000;
    const maxMs = nowMs + days * 24 * 3600 * 1000;

    // page_row_id → account / app
    const pageMeta = new Map();
    try {
      const rows = db
        .prepare(
          `SELECT p.id AS page_row_id, p.account_id, p.name AS page_name,
                  a.name AS account_name, COALESCE(a.meta_app_key,'app1') AS meta_app_key
           FROM fb_pages p
           LEFT JOIN fb_accounts a ON a.id = p.account_id`
        )
        .all();
      for (const r of rows) {
        pageMeta.set(Number(r.page_row_id), {
          account_id: Number(r.account_id) || null,
          account_name: r.account_name || null,
          meta_app_key: r.meta_app_key || "app1",
          page_name: r.page_name || null,
        });
      }
    } catch (e) {
      console.warn("[pending] pageMeta:", e.message);
    }

    let allowedPages = null;
    if (pageGroupId || accountGroupId) {
      try {
        const resolved = resolveGroupToPageIds({
          page_group_id: pageGroupId || undefined,
          account_group_id: accountGroupId || undefined,
        });
        allowedPages = new Set(
          (resolved?.page_row_ids || []).map(Number).filter((n) => n > 0)
        );
      } catch (e) {
        console.warn("[pending] group resolve:", e.message);
        allowedPages = new Set();
      }
    }

    const passPageFilters = (pageRowId, pageName = null, fbPageId = null) => {
      const pid = Number(pageRowId);
      if (allowedPages && !allowedPages.has(pid)) return false;
      if (filterPageRowId && pid !== filterPageRowId) return false;
      const meta = pageMeta.get(pid);
      if (filterAccountId && Number(meta?.account_id) !== filterAccountId) return false;
      if (filterApp && String(meta?.meta_app_key || "app1") !== filterApp) return false;
      if (filterPageQ) {
        const name = String(pageName || meta?.page_name || "").toLowerCase();
        const fbId = String(fbPageId || "").toLowerCase();
        const rowId = String(pid);
        if (
          !name.includes(filterPageQ) &&
          !fbId.includes(filterPageQ) &&
          !rowId.includes(filterPageQ)
        ) {
          return false;
        }
      }
      return true;
    };

    // page_id (FB) map for search
    const pageFbId = new Map();
    try {
      for (const r of db.prepare(`SELECT id, page_id FROM fb_pages`).all()) {
        pageFbId.set(Number(r.id), String(r.page_id || ""));
      }
    } catch {
      /* */
    }

    // Lọc ngày ngay trong SQL. Không lấy 2000 bài cũ nhất rồi cắt —
    // nếu không, các ngày mới trong tháng bị mất khỏi lịch.
    const daySqlParts = [];
    const daySqlArgs = [];
    if (fromDay && toDay) {
      daySqlParts.push(`${VN_DAY_SQL} >= ? AND ${VN_DAY_SQL} <= ?`);
      daySqlArgs.push(fromDay, toDay);
    } else if (monthYear && monthNum) {
      daySqlParts.push(`${VN_DAY_SQL} LIKE ?`);
      daySqlArgs.push(`${monthYear}-${String(monthNum).padStart(2, "0")}%`);
    }
    const rawFb = db
      .prepare(
        `SELECT id, page_row_id, page_name, post_type, status, error,
                fb_post_id, fb_post_url, caption, media_path,
                comment_text, comment_id,
                created_at, scheduled_publish_time, last_reconciled_at,
                ${DELIVERY_MODE_SQL} AS delivery_mode,
                ${VN_DAY_SQL} AS day_vn
         FROM post_logs
         WHERE status IN ('scheduled', 'schedule_overdue')
           AND scheduled_publish_time IS NOT NULL
           AND trim(scheduled_publish_time) <> ''
           ${daySqlParts.length ? `AND ${daySqlParts.join(" AND ")}` : ""}
         ORDER BY scheduled_publish_time ASC`
      )
      .all(...daySqlArgs);

    const fbRows = [];
    for (const r of rawFb) {
      if (
        !passPageFilters(
          r.page_row_id,
          r.page_name,
          pageFbId.get(Number(r.page_row_id))
        )
      ) {
        continue;
      }
      const ms = Date.parse(r.scheduled_publish_time);
      if (!Number.isFinite(ms)) continue;
      if (fromDay && toDay) {
        if (!inView(r.day_vn)) continue;
      } else if (monthYear && monthNum) {
        if (!inView(r.day_vn)) continue;
      } else if (ms < minMs || ms > maxMs) {
        continue;
      }
      const meta = pageMeta.get(Number(r.page_row_id)) || {};
      // waiting = chưa tới giờ
      // needs_reconcile = đã tới giờ + chưa đối soát (hoặc FB báo chưa public)
      // reconciled_waiting = đã đối soát, FB vẫn còn trên lịch hẹn
      const waiting = Number.isFinite(ms) && ms > nowMs;
      const pastDue = Number.isFinite(ms) && ms <= nowMs;
      const hasReconciled = !!(r.last_reconciled_at && String(r.last_reconciled_at).trim());
      const needs_reconcile =
        pastDue && (!hasReconciled || r.status === "schedule_overdue");
      const reconciled_waiting = pastDue && hasReconciled && r.status === "scheduled";
      fbRows.push({
        id: r.id,
        page_row_id: r.page_row_id,
        page_name: r.page_name || meta.page_name,
        account_id: meta.account_id || null,
        account_name: meta.account_name || null,
        meta_app_key: meta.meta_app_key || "app1",
        post_type: r.post_type,
        status: r.status,
        scheduled_publish_time: r.scheduled_publish_time,
        created_at: r.created_at,
        last_reconciled_at: r.last_reconciled_at || null,
        delivery_mode: r.delivery_mode || "fb_scheduled",
        fb_post_id: r.fb_post_id,
        fb_post_url: normalizeFacebookPostUrl(r.fb_post_url, r.fb_post_id),
        media_name: r.media_path ? String(r.media_path).split(/[/\\]/).pop() : null,
        caption_preview: r.caption ? String(r.caption).slice(0, 80) : null,
        day_vn: r.day_vn || null,
        waiting,
        needs_reconcile,
        reconciled_waiting,
        // alias cũ
        overdue: needs_reconcile,
      });
    }

    const byDay = new Map();
    for (const r of fbRows) {
      const day = r.day_vn || "unknown";
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    }

    // Job Direct Local đang chạy
    let jobWaiting = [];
    const jobOptions = [];
    try {
      const jobs = listJobs(40) || [];
      const now = Date.now();
      for (const j of jobs) {
        if (!j) continue;
        const st = String(j.status || "");
        if (!["running", "paused", "pending", "queued"].includes(st) && st !== "ok") {
          // vẫn cho chọn job gần đây trong filter dropdown
        }
        jobOptions.push({
          id: j.id,
          title: j.title || j.id,
          status: j.status,
        });
        if (!["running", "paused", "pending", "queued"].includes(st)) continue;
        const full = getJob(j.id) || j;
        if (filterJobId && String(full.id || j.id) !== filterJobId) continue;
        for (const t of full?.tasks || []) {
          if (t.status !== "pending" && t.status !== "waiting") continue;
          if (
            !passPageFilters(
              t.page_row_id,
              t.page_name,
              pageFbId.get(Number(t.page_row_id))
            )
          ) {
            continue;
          }
          const runAt = t.run_at || t.opts?.run_at;
          if (!runAt) continue;
          const ms = Date.parse(runAt);
          if (!Number.isFinite(ms)) continue;
          const dayVn = new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);
          if ((fromDay && toDay) || (monthYear && monthNum)) {
            if (!inView(dayVn)) continue;
          }
          const meta = pageMeta.get(Number(t.page_row_id)) || {};
          jobWaiting.push({
            job_id: full.id || j.id,
            job_title: full.title || j.title,
            task_id: t.id,
            page_name: t.page_name || meta.page_name,
            page_row_id: t.page_row_id,
            account_id: meta.account_id || null,
            account_name: meta.account_name || null,
            meta_app_key: meta.meta_app_key || "app1",
            label: t.label,
            post_type: t.opts?.post_type || null,
            run_at: runAt,
            day_vn: dayVn,
            delivery_mode: "scheduled_direct",
            waiting: ms > now,
            needs_reconcile: ms <= now,
            overdue: ms <= now,
            post_round: t.opts?.post_round || null,
          });
        }
      }
      jobWaiting.sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at));
    } catch (e) {
      console.warn("[pending] jobs:", e.message);
    }

    // Merge Direct Local into byDay for calendar cells
    for (const t of jobWaiting) {
      const day = t.day_vn || "unknown";
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({
        ...t,
        id: `job:${t.job_id}:${t.task_id}`,
        scheduled_publish_time: t.run_at,
        status: "scheduled",
        fb_post_id: null,
        fb_post_url: null,
        media_name: null,
        caption_preview: t.label || null,
      });
    }

    const daysOut = [...byDay.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([day, rows]) => ({
        day,
        count: rows.length,
        waiting: rows.filter((x) => x.waiting).length,
        needs_reconcile: rows.filter((x) => x.needs_reconcile || x.overdue).length,
        overdue: rows.filter((x) => x.needs_reconcile || x.overdue).length,
        sample_pages: [
          ...new Set(rows.map((x) => x.page_name).filter(Boolean)),
        ].slice(0, 6),
        rows,
      }));

    // Calendar cells: tháng, hoặc đúng khoảng from–to (tuần giao tháng)
    let calYear = monthYear;
    let calMonth = monthNum;
    if (!calYear || !calMonth) {
      const anchor = fromDay || new Date(nowMs + 7 * 3600 * 1000).toISOString().slice(0, 10);
      calYear = Number(anchor.slice(0, 4));
      calMonth = Number(anchor.slice(5, 7));
    }
    const cells = [];
    const pushCell = (day) => {
      const pack = daysOut.find((x) => x.day === day);
      cells.push({
        day,
        count: pack?.count || 0,
        waiting: pack?.waiting || 0,
        overdue: pack?.overdue || 0,
        sample_pages: pack?.sample_pages || [],
      });
    };
    if (fromDay && toDay && fromDay <= toDay) {
      const cur = new Date(`${fromDay}T12:00:00Z`);
      const end = new Date(`${toDay}T12:00:00Z`);
      for (let i = 0; i < 40 && cur <= end; i++) {
        pushCell(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    } else {
      const dim = new Date(Date.UTC(calYear, calMonth, 0)).getUTCDate();
      for (let d = 1; d <= dim; d++) {
        pushCell(
          `${calYear}-${String(calMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`
        );
      }
    }

    // Filter dropdown data
    const accountsMap = new Map();
    const appsMap = new Map();
    for (const meta of pageMeta.values()) {
      if (meta.account_id) {
        if (!accountsMap.has(meta.account_id)) {
          accountsMap.set(meta.account_id, {
            id: meta.account_id,
            name: meta.account_name || `TK #${meta.account_id}`,
            meta_app_key: meta.meta_app_key,
          });
        }
      }
      const ak = meta.meta_app_key || "app1";
      if (!appsMap.has(ak)) appsMap.set(ak, { meta_app_key: ak, name: ak });
    }
    let groups = { account_groups: [], page_groups: [] };
    try {
      groups = getSelectionGroups() || groups;
    } catch {
      /* */
    }

    const flat = [...byDay.values()].flat();
    res.json({
      ok: true,
      now: nowIso,
      days_ahead: days,
      filters: {
        account_id: filterAccountId,
        meta_app_key: filterApp,
        page_group_id: pageGroupId,
        account_group_id: accountGroupId,
        page_row_id: filterPageRowId,
        page_q: filterPageQ || null,
        job_id: filterJobId,
        month: `${calYear}-${String(calMonth).padStart(2, "0")}`,
      },
      filter_options: {
        accounts: [...accountsMap.values()].sort((a, b) =>
          String(a.name).localeCompare(String(b.name), "vi")
        ),
        tokens: [...appsMap.values()],
        account_groups: groups.account_groups || [],
        page_groups: groups.page_groups || [],
        jobs: jobOptions.slice(0, 40),
        pages: [...pageMeta.entries()]
          .map(([id, m]) => ({
            id,
            name: m.page_name || `Page #${id}`,
            account_id: m.account_id,
            page_id: pageFbId.get(id) || null,
            meta_app_key: m.meta_app_key,
          }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name), "vi")),
      },
      calendar: {
        year: calYear,
        month: calMonth,
        cells,
      },
      fb_scheduled: {
        total: fbRows.length,
        waiting: flat.filter((x) => x.waiting && x.delivery_mode !== "scheduled_direct")
          .length,
        overdue: flat.filter((x) => x.overdue && x.delivery_mode !== "scheduled_direct")
          .length,
        by_day: daysOut,
      },
      direct_local_waiting: jobWaiting,
      summary: {
        fb_waiting: flat.filter(
          (x) => x.waiting && x.delivery_mode !== "scheduled_direct"
        ).length,
        fb_overdue: flat.filter(
          (x) => x.overdue && x.delivery_mode !== "scheduled_direct"
        ).length,
        tool_waiting: jobWaiting.filter((x) => x.waiting).length,
        total_in_view: flat.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/posting/pending/reconcile-day
 * Đối soát Graph scheduled_posts cho các page có bài trong 1 ngày VN.
 * Body: { day: "YYYY-MM-DD", page_row_ids?: number[], limit_pages?: number }
 */
router.post("/pending/reconcile-day", async (req, res) => {
  try {
    const day = String(req.body?.day || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.status(400).json({ ok: false, error: "Thiếu day YYYY-MM-DD" });
    }
    const limitPages = Math.min(
      20,
      Math.max(1, Number(req.body?.limit_pages) || 12)
    );
    let pageIds = Array.isArray(req.body?.page_row_ids)
      ? req.body.page_row_ids.map(Number).filter((n) => n > 0)
      : [];
    if (!pageIds.length) {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT DISTINCT page_row_id FROM post_logs
           WHERE status IN ('scheduled','schedule_overdue')
             AND ${VN_DAY_SQL} = ?
           LIMIT ?`
        )
        .all(day, limitPages);
      pageIds = rows.map((r) => Number(r.page_row_id)).filter((n) => n > 0);
    }
    pageIds = [...new Set(pageIds)].slice(0, limitPages);

    const results = [];
    for (const pid of pageIds) {
      try {
        const data = await listFbScheduledForPage(pid);
        const posts = (data.posts || []).map((p) => {
          const unix = Number(p.scheduled_publish_time);
          let dayVn = null;
          if (Number.isFinite(unix) && unix > 0) {
            dayVn = new Date(unix * 1000 + 7 * 3600 * 1000)
              .toISOString()
              .slice(0, 10);
          }
          return {
            id: p.id,
            scheduled_publish_time: p.scheduled_publish_time,
            day_vn: dayVn,
            message: String(p.message || "").slice(0, 80),
          };
        });
        const onDay = posts.filter((p) => p.day_vn === day);
        results.push({
          page_row_id: pid,
          page_name: data.page?.name || null,
          ok: true,
          fb_total: posts.length,
          fb_on_day: onDay.length,
          posts: onDay,
        });
      } catch (e) {
        results.push({
          page_row_id: pid,
          ok: false,
          error: e.message || String(e),
        });
      }
    }
    res.json({
      ok: true,
      day,
      pages_checked: results.length,
      results,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/posting/history/days — danh sách ngày VN có dữ liệu (mới → cũ).
 */
router.get("/history/days", (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ${VN_DAY_SQL} AS day, COUNT(*) AS n
       FROM post_logs
       GROUP BY day
       ORDER BY day DESC`
    )
    .all();
  res.json({ days: rows.map((r) => ({ day: r.day, count: Number(r.n || 0) })) });
});

/**
 * GET /api/posting/published
 * Bài đã đăng (publish) — lịch/list theo ngày VN + lọc TK/nhóm/App.
 * Query: month=YYYY-MM | day=YYYY-MM-DD | account_id | meta_app_key |
 *        page_group_id | account_group_id | days | limit
 */
router.get("/published", (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(3000, Math.max(1, Number(req.query.limit) || 800));
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 31));
    const filterAccountId = Number(req.query.account_id || 0) || null;
    const filterApp = String(req.query.meta_app_key || "").trim() || null;
    const pageGroupId = String(req.query.page_group_id || "").trim() || null;
    const accountGroupId = String(req.query.account_group_id || "").trim() || null;
    const filterPageRowId = Number(req.query.page_row_id || 0) || null;
    const filterPageQ = String(req.query.page_q || req.query.q || "")
      .trim()
      .toLowerCase();
    const dayExact =
      typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
        ? req.query.day
        : null;

    let monthYear = null;
    let monthNum = null;
    const monthRaw = String(req.query.month || "").trim();
    const mm = monthRaw.match(/^(\d{4})-(\d{2})$/);
    if (mm) {
      monthYear = Number(mm[1]);
      monthNum = Number(mm[2]);
    }
    const fromDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ""))
      ? String(req.query.from)
      : null;
    const toDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ""))
      ? String(req.query.to)
      : null;

    const pageMeta = new Map();
    const pageFbId = new Map();
    const rowsMeta = db
      .prepare(
        `SELECT p.id AS page_row_id, p.page_id, p.account_id, p.name AS page_name,
                a.name AS account_name, COALESCE(a.meta_app_key,'app1') AS meta_app_key
         FROM fb_pages p
         LEFT JOIN fb_accounts a ON a.id = p.account_id`
      )
      .all();
    for (const r of rowsMeta) {
      pageMeta.set(Number(r.page_row_id), {
        account_id: Number(r.account_id) || null,
        account_name: r.account_name || null,
        meta_app_key: r.meta_app_key || "app1",
        page_name: r.page_name || null,
      });
      pageFbId.set(Number(r.page_row_id), String(r.page_id || ""));
    }

    let allowedPages = null;
    if (pageGroupId || accountGroupId) {
      try {
        const resolved = resolveGroupToPageIds({
          page_group_id: pageGroupId || undefined,
          account_group_id: accountGroupId || undefined,
        });
        allowedPages = new Set(
          (resolved?.page_row_ids || []).map(Number).filter((n) => n > 0)
        );
      } catch {
        allowedPages = new Set();
      }
    }

    const passPageFilters = (pageRowId, pageName = null) => {
      const pid = Number(pageRowId);
      if (allowedPages && !allowedPages.has(pid)) return false;
      if (filterPageRowId && pid !== filterPageRowId) return false;
      const meta = pageMeta.get(pid);
      if (filterAccountId && Number(meta?.account_id) !== filterAccountId) return false;
      if (filterApp && String(meta?.meta_app_key || "app1") !== filterApp) return false;
      if (filterPageQ) {
        const name = String(pageName || meta?.page_name || "").toLowerCase();
        const fbId = String(pageFbId.get(pid) || "").toLowerCase();
        if (
          !name.includes(filterPageQ) &&
          !fbId.includes(filterPageQ) &&
          !String(pid).includes(filterPageQ)
        ) {
          return false;
        }
      }
      return true;
    };

    const nowMs = Date.now();
    let calYear = monthYear;
    let calMonth = monthNum;
    if (!calYear || !calMonth) {
      const vn = new Date(nowMs + 7 * 3600 * 1000);
      calYear = vn.getUTCFullYear();
      calMonth = vn.getUTCMonth() + 1;
    }
    const monthPrefix = `${calYear}-${String(calMonth).padStart(2, "0")}`;

    // Published / successfully posted (not waiting scheduled)
    const pubDayParts = [];
    const pubDayArgs = [];
    if (dayExact) {
      pubDayParts.push(`${VN_DAY_SQL} = ?`);
      pubDayArgs.push(dayExact);
    } else if (fromDay && toDay) {
      pubDayParts.push(`${VN_DAY_SQL} >= ? AND ${VN_DAY_SQL} <= ?`);
      pubDayArgs.push(fromDay, toDay);
    } else if (monthYear && monthNum) {
      pubDayParts.push(`${VN_DAY_SQL} LIKE ?`);
      pubDayArgs.push(`${monthPrefix}%`);
    }
    const raw = db
      .prepare(
        `SELECT id, page_row_id, page_name, post_type, status, error,
                fb_post_id, fb_post_url, caption, media_path,
                created_at, scheduled_publish_time,
                ${DELIVERY_MODE_SQL} AS delivery_mode,
                ${VN_DAY_SQL} AS day_vn
         FROM post_logs
         WHERE status IN ('ok','ok_comment_failed','published')
           ${pubDayParts.length ? `AND ${pubDayParts.join(" AND ")}` : ""}
         ORDER BY COALESCE(NULLIF(scheduled_publish_time,''), created_at) DESC`
      )
      .all(...pubDayArgs);

    const items = [];
    for (const r of raw) {
      if (!passPageFilters(r.page_row_id, r.page_name)) continue;
      const day = r.day_vn || "unknown";
      if (dayExact && day !== dayExact) continue;
      if (!dayExact && fromDay && toDay) {
        if (String(day) < fromDay || String(day) > toDay) continue;
      } else if (!dayExact && monthYear && monthNum) {
        if (!String(day).startsWith(monthPrefix)) continue;
      } else if (!dayExact) {
        const ms = Date.parse(r.scheduled_publish_time || r.created_at);
        if (Number.isFinite(ms)) {
          const minMs = nowMs - days * 24 * 3600 * 1000;
          if (ms < minMs) continue;
        }
      }
      const meta = pageMeta.get(Number(r.page_row_id)) || {};
      items.push({
        id: r.id,
        page_row_id: r.page_row_id,
        page_name: r.page_name || meta.page_name,
        account_id: meta.account_id || null,
        account_name: meta.account_name || null,
        meta_app_key: meta.meta_app_key || "app1",
        post_type: r.post_type,
        status: r.status,
        scheduled_publish_time: r.scheduled_publish_time,
        created_at: r.created_at,
        delivery_mode: r.delivery_mode || null,
        fb_post_id: r.fb_post_id,
        fb_post_url: normalizeFacebookPostUrl(r.fb_post_url, r.fb_post_id),
        media_name: r.media_path ? String(r.media_path).split(/[/\\]/).pop() : null,
        caption_preview: r.caption ? String(r.caption).slice(0, 80) : null,
        day_vn: day,
      });
    }

    const byDay = new Map();
    for (const r of items) {
      const day = r.day_vn || "unknown";
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    }
    const daysOut = [...byDay.entries()]
      .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
      .map(([day, rows]) => ({
        day,
        count: rows.length,
        sample_pages: [...new Set(rows.map((x) => x.page_name).filter(Boolean))].slice(0, 6),
        rows,
      }));

    const cells = [];
    const pushPubCell = (day) => {
      const pack = daysOut.find((x) => x.day === day);
      cells.push({
        day,
        count: pack?.count || 0,
        sample_pages: pack?.sample_pages || [],
      });
    };
    if (fromDay && toDay && fromDay <= toDay) {
      const cur = new Date(`${fromDay}T12:00:00Z`);
      const end = new Date(`${toDay}T12:00:00Z`);
      for (let i = 0; i < 40 && cur <= end; i++) {
        pushPubCell(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    } else {
      const dim = new Date(Date.UTC(calYear, calMonth, 0)).getUTCDate();
      for (let d = 1; d <= dim; d++) {
        pushPubCell(
          `${calYear}-${String(calMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`
        );
      }
    }

    const accountsMap = new Map();
    const appsMap = new Map();
    for (const meta of pageMeta.values()) {
      if (meta.account_id && !accountsMap.has(meta.account_id)) {
        accountsMap.set(meta.account_id, {
          id: meta.account_id,
          name: meta.account_name || `TK #${meta.account_id}`,
          meta_app_key: meta.meta_app_key,
        });
      }
      const ak = meta.meta_app_key || "app1";
      if (!appsMap.has(ak)) appsMap.set(ak, { meta_app_key: ak, name: ak });
    }
    let groups = { account_groups: [], page_groups: [] };
    try {
      groups = getSelectionGroups() || groups;
    } catch {
      /* */
    }

    res.json({
      ok: true,
      now: new Date().toISOString(),
      filters: {
        account_id: filterAccountId,
        meta_app_key: filterApp,
        page_group_id: pageGroupId,
        account_group_id: accountGroupId,
        day: dayExact,
        month: monthPrefix,
      },
      filter_options: {
        accounts: [...accountsMap.values()].sort((a, b) =>
          String(a.name).localeCompare(String(b.name), "vi")
        ),
        tokens: [...appsMap.values()],
        account_groups: groups.account_groups || [],
        page_groups: groups.page_groups || [],
        pages: [...pageMeta.entries()]
          .map(([id, m]) => ({
            id,
            name: m.page_name || `Page #${id}`,
            account_id: m.account_id,
            page_id: pageFbId.get(id) || null,
            meta_app_key: m.meta_app_key,
          }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name), "vi")),
      },
      calendar: { year: calYear, month: calMonth, cells },
      by_day: daysOut,
      summary: { total_in_view: items.length },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/posting/history?day=YYYY-MM-DD&limit= — log 1 ngày VN, phân 3 loại.
 */
router.get("/history", (req, res) => {
  const db = getDb();
  const day =
    typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
      ? req.query.day
      : todayVnKey();
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
  const rows = db
    .prepare(
      `SELECT id, page_row_id, page_name, post_type, status, error,
              fb_post_id, fb_post_url, caption, media_path,
              comment_text, comment_id,
              created_at, scheduled_publish_time,
              ${DELIVERY_MODE_SQL} AS delivery_mode
       FROM post_logs
       WHERE ${VN_DAY_SQL} = ?
       ORDER BY COALESCE(NULLIF(scheduled_publish_time,''), created_at) ASC
       LIMIT ?`
    )
    .all(day, limit);
  res.json({ day, count: rows.length, rows });
});

/** GET /api/posting/pages — pages with config summary */
router.get("/pages", (_req, res) => {
  const appNames = new Map(listMetaAppsPublic().map((a) => [a.key, a.name]));
  const db = getDb();
  const pages = db
    .prepare(
      `SELECT p.id, p.page_id, p.name, p.status, p.account_id,
              p.followers_count, p.fan_count, p.picture_url,
              p.enrich_error, p.enriched_at,
              a.name AS account_name, a.fb_user_id AS account_fb_user_id,
              a.meta_app_key, a.meta_app_id,
              c.enabled, c.max_posts_per_day, c.interval_minutes,
              c.posts_today, c.posts_today_date, c.last_post_at,
              c.media_folder, c.story_enabled, c.sequence_json
       FROM fb_pages p
       JOIN fb_accounts a ON a.id = p.account_id
       LEFT JOIN page_post_config c ON c.page_row_id = p.id
       WHERE p.status = 'active'
       ORDER BY p.name COLLATE NOCASE`
    )
    .all();
  const todayCounts = new Map(db.prepare(`
    SELECT page_row_id,
      SUM(CASE WHEN scheduled_publish_time IS NULL AND status IN ('ok','ok_comment_failed') THEN 1 ELSE 0 END) AS direct_today,
      SUM(CASE WHEN scheduled_publish_time IS NOT NULL AND status IN ('scheduled','published','schedule_overdue') THEN 1 ELSE 0 END) AS scheduled_today
    FROM post_logs
    WHERE date(COALESCE(NULLIF(scheduled_publish_time,''), created_at), '+7 hours') = date('now', '+7 hours')
    GROUP BY page_row_id
  `).all().map((x) => [Number(x.page_row_id), x]));
  const todayVn = todayVnKey();
  res.json({
    pages: pages.map((p) => {
      const cfg = getPagePostConfig(p.id);
      const counts = todayCounts.get(Number(p.id)) || {};
      // Ép số rõ ràng — UI chọn page đọc đúng field (tránh null/object lạ)
      const followers =
        p.followers_count != null && p.followers_count !== ""
          ? Number(p.followers_count)
          : null;
      const fans =
        p.fan_count != null && p.fan_count !== "" ? Number(p.fan_count) : null;
      return {
        id: Number(p.id),
        page_id: p.page_id != null ? String(p.page_id) : null,
        name: p.name || null,
        status: p.status,
        account_id: Number(p.account_id),
        account_name: p.account_name || null,
        account_fb_user_id: p.account_fb_user_id || null,
        meta_app_key: p.meta_app_key || "app1",
        meta_app_id: p.meta_app_id || null,
        picture_url: p.picture_url || null,
        enrich_error: p.enrich_error || null,
        enriched_at: p.enriched_at || null,
        followers_count: Number.isFinite(followers) ? followers : null,
        fan_count: Number.isFinite(fans) ? fans : null,
        enabled: cfg.enabled,
        max_posts_per_day: cfg.max_posts_per_day,
        interval_minutes: cfg.interval_minutes,
        posts_today: cfg.posts_today_date === todayVn ? cfg.posts_today : 0,
        posts_today_date: todayVn,
        last_post_at: cfg.last_post_at,
        media_folder: cfg.media_folder,
        posted_folder: cfg.posted_folder,
        captions_folder: cfg.captions_folder,
        story_enabled: cfg.story_enabled,
        sequence: cfg.sequence,
        config_ready: Boolean(cfg.media_folder && cfg.posted_folder && cfg.captions_folder),
        preferred_hours: getPreferredHours(p.id),
        direct_today: Number(counts.direct_today || 0),
        scheduled_today: Number(counts.scheduled_today || 0),
        total_planned_today: Number(counts.direct_today || 0) + Number(counts.scheduled_today || 0),
        follower_growth: getFollowerGrowth(
          p.id,
          Number.isFinite(followers) ? followers : null,
          todayVn
        ),
        meta_app_name: appNames.get(p.meta_app_key || "app1") || p.meta_app_key || "App 1",
      };
    }),
  });
});

/** Defaults for new config */
router.get("/defaults", (_req, res) => {
  res.json({ config: getDefaultConfig(0) });
});

/**
 * GET /api/posting/active-times/:pageRowId
 * Giờ tích cực: preferred hours (chính) → default VN; Graph legacy chỉ nếu bật env.
 * Query: force=1 bỏ cache insights 24h.
 */
router.get("/active-times/:pageRowId", async (req, res) => {
  try {
    const id = Number(req.params.pageRowId);
    if (!pageExists(id)) return res.status(404).json({ error: "Page not found" });
    const force =
      req.query.force === "1" ||
      req.query.force === "true" ||
      req.body?.force;
    const data = await getActiveTimesForPageRow(id, { force: !!force });
    res.json(data);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * PUT /api/posting/preferred-hours/bulk
 * Body: { page_row_ids: number[], hours: [9,12,19,21] }
 */
router.put("/preferred-hours/bulk", (req, res) => {
  try {
    const ids = Array.isArray(req.body?.page_row_ids)
      ? req.body.page_row_ids.map(Number).filter((n) => n > 0)
      : [];
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: "Chọn ít nhất 1 page (page_row_ids)" });
    }
    const hours =
      req.body?.hours ??
      req.body?.preferred_hours ??
      DEFAULT_PREFERRED_HOURS;
    const result = savePreferredHoursBulk(ids, hours);
    res.json({
      ok: true,
      ...result,
      note: "Đã gán giờ ưa thích cho các page — dùng cho mode Giờ tích cực (Meta không còn page_fans_online).",
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * PUT /api/posting/preferred-hours/:pageRowId
 * Body: { hours: [9,12,19,21] } — giờ ưa thích thủ công (0–23)
 * Route động phải đặt sau /bulk để Express không hiểu "bulk" là Page ID.
 */
router.put("/preferred-hours/:pageRowId", (req, res) => {
  try {
    const id = Number(req.params.pageRowId);
    if (!pageExists(id)) return res.status(404).json({ error: "Page not found" });
    const hours = req.body?.hours ?? req.body?.preferred_hours ?? [];
    const saved = savePreferredHours(id, hours);
    res.json({
      ok: true,
      preferred_hours: saved,
      note: "Giờ do bạn đặt — không phải insights Meta (page_fans_online đã deprecate).",
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/preferred-hours/:pageRowId", (req, res) => {
  const id = Number(req.params.pageRowId);
  if (!pageExists(id)) return res.status(404).json({ error: "Page not found" });
  res.json({ preferred_hours: getPreferredHours(id) });
});

/**
 * POST /api/posting/schedule/bulk
 * Hẹn giờ hàng loạt: mode active_times | fixed
 * (đặt trước /schedule/:id để "bulk" không bị nuốt)
 */
router.post("/schedule/bulk", async (req, res) => {
  try {
    const result = await scheduleBulk(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/posting/schedule/:pageRowId
 * Body: { scheduled_publish_time: unix|ISO, post_type?, caption? }
 */
router.post("/schedule/:pageRowId", async (req, res) => {
  try {
    const id = Number(req.params.pageRowId);
    if (!pageExists(id)) return res.status(404).json({ error: "Page not found" });
    let unix = req.body?.scheduled_publish_time ?? req.body?.unix;
    if (typeof unix === "string" && !/^\d+$/.test(unix.trim())) {
      const d = new Date(unix);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "scheduled_publish_time invalid" });
      }
      unix = Math.floor(d.getTime() / 1000);
    } else {
      unix = Number(unix);
    }
    const result = await scheduleOnePost(id, {
      scheduled_publish_time: unix,
      post_type: req.body?.post_type,
      caption: req.body?.caption,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, fb: e.fb || null });
  }
});

/** GET /api/posting/scheduled/:pageRowId — list từ Graph scheduled_posts */
router.get("/scheduled/:pageRowId", async (req, res) => {
  try {
    const id = Number(req.params.pageRowId);
    if (!pageExists(id)) return res.status(404).json({ error: "Page not found" });
    const data = await listFbScheduledForPage(id);
    res.json(data);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, fb: e.fb || null });
  }
});

export default router;
