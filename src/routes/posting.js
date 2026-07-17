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
  getPreferredHours,
} from "../services/activeTimes.js";
import {
  scheduleOnePost,
  scheduleBulk,
  listFbScheduledForPage,
} from "../services/schedule.js";

const router = Router();

function pageExists(id) {
  return getDb()
    .prepare(`SELECT id, page_id, name, status FROM fb_pages WHERE id = ?`)
    .get(id);
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
  const body = req.body || {};
  // Normalize arrays from UI
  if (typeof body.captions === "string") {
    body.captions = body.captions
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof body.comment_templates === "string") {
    body.comment_templates = body.comment_templates
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof body.sequence === "string") {
    body.sequence = body.sequence
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  // link lists: { see_more: "a\nb", full_album: "..." }
  if (body.link_lists && typeof body.link_lists === "object") {
    const out = {};
    for (const [k, v] of Object.entries(body.link_lists)) {
      if (typeof v === "string") {
        out[k] = v
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (Array.isArray(v)) {
        out[k] = v;
      }
    }
    body.link_lists = out;
  }
  const cfg = savePagePostConfig(id, body);
  res.json({
    config: cfg,
    media: mediaStats(cfg.media_folder),
    captions_pool: getCaptionStats(cfg),
  });
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
  const pages = getDb()
    .prepare(
      `SELECT p.id, p.page_id, p.name, p.status,
              c.enabled, c.max_posts_per_day, c.interval_minutes,
              c.posts_today, c.posts_today_date, c.last_post_at,
              c.media_folder, c.story_enabled, c.sequence_json
       FROM fb_pages p
       LEFT JOIN page_post_config c ON c.page_row_id = p.id
       WHERE p.status = 'active'
       ORDER BY p.name COLLATE NOCASE`
    )
    .all();
  res.json({
    pages: pages.map((p) => ({
      ...p,
      sequence: p.sequence_json
        ? JSON.parse(p.sequence_json)
        : ["photo", "video", "text"],
      sequence_json: undefined,
    })),
  });
});

/** Defaults for new config */
router.get("/defaults", (_req, res) => {
  res.json({ config: getDefaultConfig(0) });
});

/**
 * GET /api/posting/active-times/:pageRowId
 * Giờ tích cực: Graph insights nếu còn; fallback preferred_hours.
 * Query: force=1 bỏ cache 24h.
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
