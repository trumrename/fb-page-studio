/**
 * Story schedule: max/day + time slots → enqueue HTTP ops.
 * Default publisher = Graph combo/media; force_session for sticker path later.
 */
import { getDb } from "../../db/index.js";
import { ensureOpsQueueTables, enqueueOp } from "./opsQueue.js";
import fs from "fs";
import path from "path";

function vnNowParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function parseSlots(slotsJson) {
  try {
    const arr = JSON.parse(slotsJson || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s) => ({
        time: String(s.time || s.at || "").trim(),
        count: Math.max(1, Number(s.count || 1)),
      }))
      .filter((s) => /^\d{1,2}:\d{2}$/.test(s.time));
  } catch {
    return [];
  }
}

/** Minutes since midnight for "HH:MM" */
function hmToMin(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Slot fires if current time within ±windowMin of slot (default 8 min).
 */
function slotDue(slotHm, nowMin, windowMin = 8) {
  const t = hmToMin(slotHm);
  let d = Math.abs(nowMin - t);
  if (d > 12 * 60) d = 24 * 60 - d;
  return d <= windowMin;
}

function pickMedia(folder) {
  if (!folder || !fs.existsSync(folder)) return null;
  const exts = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".mp4",
    ".mov",
    ".m4v",
  ]);
  const files = fs
    .readdirSync(folder)
    .filter((f) => exts.has(path.extname(f).toLowerCase()))
    .sort();
  if (!files.length) return null;
  // simple rotate by mtime-ish name order + day salt
  const idx = Math.floor(Date.now() / 60000) % files.length;
  return path.join(folder, files[idx]);
}

export function listStorySchedules() {
  ensureOpsQueueTables();
  return getDb()
    .prepare(`SELECT * FROM story_schedule_config ORDER BY id DESC`)
    .all()
    .map((r) => ({
      ...r,
      enabled: !!r.enabled,
      slots: parseSlots(r.slots_json),
    }));
}

/**
 * @param {object} input
 */
export function upsertStorySchedule(input) {
  ensureOpsQueueTables();
  const pageId = String(input.page_id || "").trim();
  if (!pageId) throw new Error("page_id bắt buộc");
  const slots = Array.isArray(input.slots) ? input.slots : [];
  getDb()
    .prepare(
      `INSERT INTO story_schedule_config
        (page_row_id, page_id, session_id, enabled, max_per_day, slots_json,
         link_url, link_sticker_text, link_mode, media_folder, delete_after_hours)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET
         page_row_id = excluded.page_row_id,
         session_id = excluded.session_id,
         enabled = excluded.enabled,
         max_per_day = excluded.max_per_day,
         slots_json = excluded.slots_json,
         link_url = excluded.link_url,
         link_sticker_text = excluded.link_sticker_text,
         link_mode = excluded.link_mode,
         media_folder = excluded.media_folder,
         delete_after_hours = excluded.delete_after_hours,
         updated_at = datetime('now')`
    )
    .run(
      input.page_row_id ?? null,
      pageId,
      input.session_id ?? null,
      input.enabled ? 1 : 0,
      Number(input.max_per_day ?? 5),
      JSON.stringify(slots),
      input.link_url || null,
      input.link_sticker_text || null,
      input.link_mode || "combo",
      input.media_folder || null,
      input.delete_after_hours ?? null
    );
  return listStorySchedules().find((s) => s.page_id === pageId);
}

/**
 * Tick: enqueue due story jobs. Call from server interval.
 * @returns {{ enqueued: object[], skipped: string[] }}
 */
export function tickStorySchedules() {
  ensureOpsQueueTables();
  const { day, hm } = vnNowParts();
  const nowMin = hmToMin(hm);
  const enqueued = [];
  const skipped = [];
  const rows = getDb()
    .prepare(`SELECT * FROM story_schedule_config WHERE enabled = 1`)
    .all();

  for (const cfg of rows) {
    // reset daily counter
    if (cfg.posts_today_date !== day) {
      getDb()
        .prepare(
          `UPDATE story_schedule_config SET posts_today = 0, posts_today_date = ? WHERE id = ?`
        )
        .run(day, cfg.id);
      cfg.posts_today = 0;
      cfg.posts_today_date = day;
    }

    const maxDay = Number(cfg.max_per_day || 5);
    if (cfg.posts_today >= maxDay) {
      skipped.push(`${cfg.page_id}: max_per_day`);
      continue;
    }

    const slots = parseSlots(cfg.slots_json);
    if (!slots.length) {
      skipped.push(`${cfg.page_id}: no slots`);
      continue;
    }

    const due = slots.filter((s) => slotDue(s.time, nowMin, 8));
    if (!due.length) continue;

    // one enqueue per tick per page (avoid burst)
    const media = pickMedia(cfg.media_folder);
    if (!media) {
      skipped.push(`${cfg.page_id}: no media`);
      continue;
    }

    // de-dupe: if pending/running same page story in last 15 min skip
    const recent = getDb()
      .prepare(
        `SELECT id FROM http_ops_queue
         WHERE op IN ('page_story_schedule','page_story_combo_link','page_story_link_sticker')
           AND target_id = ?
           AND status IN ('pending','running')
           AND created_at >= datetime('now', '-15 minutes')
         LIMIT 1`
      )
      .get(cfg.page_id);
    if (recent) {
      skipped.push(`${cfg.page_id}: already queued`);
      continue;
    }

    const useSticker = cfg.link_mode === "sticker";
    const job = enqueueOp({
      op: useSticker ? "page_story_link_sticker" : "page_story_schedule",
      engine: useSticker ? "session" : "graph",
      targetType: "page",
      targetId: cfg.page_id,
      sessionId: cfg.session_id,
      pageRowId: cfg.page_row_id,
      payload: {
        page_id: cfg.page_id,
        page_row_id: cfg.page_row_id,
        session_id: cfg.session_id,
        media_path: media,
        link_url: cfg.link_url,
        link_sticker_text: cfg.link_sticker_text,
        link_mode: cfg.link_mode || "combo",
        force_session: useSticker,
        delete_after_hours: cfg.delete_after_hours,
      },
      priority: 50,
    });

    getDb()
      .prepare(
        `UPDATE story_schedule_config
         SET posts_today = posts_today + 1, last_run_at = datetime('now')
         WHERE id = ?`
      )
      .run(cfg.id);

    enqueued.push({ page_id: cfg.page_id, ...job, slot: due[0].time });
  }

  return { enqueued, skipped, day, hm };
}

/**
 * Register published story for later delete.
 */
export function recordStoryLifecycle(entry) {
  ensureOpsQueueTables();
  const deleteAt =
    entry.delete_after_hours != null
      ? new Date(
          Date.now() + Number(entry.delete_after_hours) * 3600 * 1000
        ).toISOString()
      : entry.delete_at || null;
  getDb()
    .prepare(
      `INSERT INTO story_lifecycle
        (page_id, page_row_id, session_id, story_fb_id, story_url, link_url,
         media_path, engine, status, delete_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`
    )
    .run(
      entry.page_id || null,
      entry.page_row_id ?? null,
      entry.session_id ?? null,
      entry.story_fb_id || null,
      entry.story_url || null,
      entry.link_url || null,
      entry.media_path || null,
      entry.engine || "graph",
      deleteAt
    );
}

export function listStoriesDueDelete(limit = 20) {
  ensureOpsQueueTables();
  return getDb()
    .prepare(
      `SELECT * FROM story_lifecycle
       WHERE status = 'published' AND delete_at IS NOT NULL AND delete_at <= datetime('now')
       ORDER BY delete_at ASC LIMIT ?`
    )
    .all(Number(limit));
}
