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
import { listMetaAppsPublic } from "../services/metaApps.js";
import { getFollowerGrowth } from "../services/followerHistory.js";
import { getAppSetting, saveAppSetting } from "../services/appSettings.js";

const router = Router();
const POSTING_WORKSPACE_KEY = "posting_workspace_v1";

const DEFAULT_WORKSPACE = Object.freeze({
  selected_page_ids: [],
  active_page_id: null,
  active_view: "configure",
  bulk: {},
  rotation: {},
});

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
  const activeId = Number(input.active_page_id);
  const allowedViews = new Set(["configure", "run", "schedule", "monitor"]);
  return {
    selected_page_ids: selected,
    active_page_id: activeIds.has(activeId) ? activeId : selected[0] || null,
    active_view: allowedViews.has(input.active_view)
      ? input.active_view
      : "configure",
    bulk:
      input.bulk && typeof input.bulk === "object" && !Array.isArray(input.bulk)
        ? input.bulk
        : {},
    rotation:
      input.rotation &&
      typeof input.rotation === "object" &&
      !Array.isArray(input.rotation)
        ? input.rotation
        : {},
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
  };
  const state = normalizeWorkspaceState(merged);
  saveAppSetting(POSTING_WORKSPACE_KEY, state);
  res.json({ ok: true, state });
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
    for (const [k, v] of Object.entries(body.link_lists)) {
      out[k] = typeof v === "string"
        ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : (Array.isArray(v) ? v : []);
    }
    body.link_lists = out;
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
  const cfg = getPagePostConfig(id);
  res.json({
    page,
    config: cfg,
    media: mediaStats(cfg.media_folder),
    captions_pool: getCaptionStats(cfg),
    story_note:
      "story_enabled chỉ là cờ tùy chọn — API story chưa bật trong phase này (không gắn link).",
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
  const cfg = savePagePostConfig(id, body);
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
  const saved = getDb().transaction(() => ids.map((id) => savePagePostConfig(id, configBody)))();
  res.json({ ok: true, updated: saved.length, page_row_ids: ids });
});

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
  const pageRowId = req.query.page_row_id
    ? Number(req.query.page_row_id)
    : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json({ logs: listPostLogs({ pageRowId, limit }) });
});

/** POST /api/posting/reconcile-scheduled — verify overdue schedules with Facebook. */
router.post("/reconcile-scheduled", async (req, res) => {
  try {
    const result = await reconcileScheduledLogs({ limit: req.body?.limit || 50 });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** GET /api/posting/logs/csv — download post log CSV */
router.get("/logs/csv", (_req, res) => {
  const file = getPostLogCsvPath();
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "Chưa có log đăng bài" });
  }
  res.download(file, "post_logs.csv");
});

/** GET /api/posting/pages — pages with config summary */
router.get("/pages", (_req, res) => {
  const appNames = new Map(listMetaAppsPublic().map((a) => [a.key, a.name]));
  const db = getDb();
  const pages = db
    .prepare(
      `SELECT p.id, p.page_id, p.name, p.status, p.account_id,
              p.followers_count, p.fan_count, p.enrich_error, p.enriched_at,
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
  const todayVn = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  res.json({
    pages: pages.map((p) => {
      const cfg = getPagePostConfig(p.id);
      const counts = todayCounts.get(Number(p.id)) || {};
      return {
        ...p,
        enabled: cfg.enabled,
        max_posts_per_day: cfg.max_posts_per_day,
        interval_minutes: cfg.interval_minutes,
        posts_today: cfg.posts_today,
        posts_today_date: cfg.posts_today_date,
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
        follower_growth: getFollowerGrowth(p.id, p.followers_count, todayVn),
        meta_app_name: appNames.get(p.meta_app_key || "app1") || p.meta_app_key || "App 1",
        sequence_json: undefined,
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
 * PUT /api/posting/preferred-hours/:pageRowId
 * Body: { hours: [9,12,19,21] } — giờ ưa thích thủ công (0–23)
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
