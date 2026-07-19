import crypto from "crypto";
import path from "path";
import { getDb } from "../db/index.js";

function inlineHash(captions) {
  const list = Array.isArray(captions)
    ? captions.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return crypto.createHash("sha256").update(JSON.stringify(list)).digest("hex");
}

export function captionPoolIdentity({ captionsFolder = "", captions = [], pageRowId = 0 } = {}) {
  const folder = String(captionsFolder || "").trim();
  if (folder) {
    const resolved = path.resolve(folder).toLowerCase();
    return { key: `folder:${resolved}`, source: resolved };
  }
  const hash = inlineHash(captions);
  return {
    key: hash ? `inline:${hash}` : `page:${Number(pageRowId) || 0}`,
    source: hash ? `inline:${hash.slice(0, 12)}` : `page:${Number(pageRowId) || 0}`,
  };
}

function seedSlot({ captionsFolder = "", pageRowId = 0 } = {}) {
  const db = getDb();
  const folder = String(captionsFolder || "").trim();
  if (folder) {
    const row = db
      .prepare(
        `SELECT MAX(caption_slot_index) AS slot
         FROM page_post_config
         WHERE lower(trim(captions_folder)) = lower(trim(?))`
      )
      .get(path.resolve(folder));
    return Math.max(0, Number(row?.slot) || 0);
  }
  const row = db
    .prepare(`SELECT caption_slot_index AS slot FROM page_post_config WHERE page_row_id = ?`)
    .get(Number(pageRowId));
  return Math.max(0, Number(row?.slot) || 0);
}

/**
 * Atomically reserve the next caption position for a shared pool.
 * A failed Graph call may consume one position, which is preferable to two
 * simultaneous Pages receiving the same caption. Successful captions are
 * still recorded separately by antiSpam.recordCaption().
 */
export function reserveCaptionSlot(input = {}) {
  const db = getDb();
  const identity = captionPoolIdentity(input);
  return db.transaction(() => {
    const initial = seedSlot(input);
    db.prepare(
      `INSERT OR IGNORE INTO caption_pool_state
       (pool_key, source_label, next_slot_index, updated_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run(identity.key, identity.source, initial);
    const row = db
      .prepare(`SELECT next_slot_index FROM caption_pool_state WHERE pool_key = ?`)
      .get(identity.key);
    const slot = Math.max(0, Number(row?.next_slot_index) || 0);
    db.prepare(
      `UPDATE caption_pool_state
       SET next_slot_index = ?, source_label = ?, updated_at = datetime('now')
       WHERE pool_key = ?`
    ).run(slot + 1, identity.source, identity.key);
    return { pool_key: identity.key, source: identity.source, slot_index: slot };
  })();
}
