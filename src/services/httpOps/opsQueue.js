/**
 * Durable HTTP ops queue (SQLite).
 * All multi-thread workers pull from here — Graph or Session.
 */
import { getDb } from "../../db/index.js";
import { nanoid } from "nanoid";

export function ensureOpsQueueTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS http_ops_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_key TEXT NOT NULL UNIQUE,
      op TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'graph',
      target_type TEXT,
      target_id TEXT,
      session_id INTEGER,
      page_row_id INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 100,
      run_after TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      result_json TEXT,
      locked_by TEXT,
      locked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_http_ops_status_run
      ON http_ops_queue(status, run_after, priority, id);

    CREATE TABLE IF NOT EXISTS story_schedule_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_row_id INTEGER,
      page_id TEXT NOT NULL,
      session_id INTEGER,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_per_day INTEGER NOT NULL DEFAULT 5,
      slots_json TEXT NOT NULL DEFAULT '[]',
      link_url TEXT,
      link_sticker_text TEXT,
      link_mode TEXT NOT NULL DEFAULT 'combo',
      media_folder TEXT,
      delete_after_hours REAL,
      posts_today INTEGER NOT NULL DEFAULT 0,
      posts_today_date TEXT,
      last_run_at TEXT,
      meta_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(page_id)
    );

    CREATE TABLE IF NOT EXISTS story_lifecycle (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id TEXT,
      page_row_id INTEGER,
      session_id INTEGER,
      story_fb_id TEXT,
      story_url TEXT,
      link_url TEXT,
      media_path TEXT,
      engine TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      delete_at TEXT,
      deleted_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_story_lifecycle_delete
      ON story_lifecycle(status, delete_at);
  `);
}

/**
 * @param {{
 *   op: string,
 *   engine?: string,
 *   targetType?: string,
 *   targetId?: string,
 *   sessionId?: number|null,
 *   pageRowId?: number|null,
 *   payload?: object,
 *   runAfter?: string|null,
 *   priority?: number,
 *   maxAttempts?: number
 * }} job
 */
export function enqueueOp(job) {
  ensureOpsQueueTables();
  const jobKey = `j_${nanoid(12)}`;
  getDb()
    .prepare(
      `INSERT INTO http_ops_queue
        (job_key, op, engine, target_type, target_id, session_id, page_row_id,
         payload_json, status, priority, run_after, max_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .run(
      jobKey,
      job.op,
      job.engine || "graph",
      job.targetType || null,
      job.targetId || null,
      job.sessionId ?? null,
      job.pageRowId ?? null,
      JSON.stringify(job.payload || {}),
      Number(job.priority ?? 100),
      job.runAfter || null,
      Number(job.maxAttempts ?? 5)
    );
  return { job_key: jobKey, op: job.op };
}

/** Claim next runnable job (atomic-ish for single process multi-worker). */
export function claimNextOp(workerId) {
  ensureOpsQueueTables();
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `SELECT * FROM http_ops_queue
       WHERE status = 'pending'
         AND (run_after IS NULL OR run_after <= ?)
         AND attempts < max_attempts
       ORDER BY priority ASC, id ASC
       LIMIT 1`
    )
    .get(now);
  if (!row) return null;

  const r = db
    .prepare(
      `UPDATE http_ops_queue
       SET status = 'running', locked_by = ?, locked_at = ?, started_at = ?,
           attempts = attempts + 1
       WHERE id = ? AND status = 'pending'`
    )
    .run(workerId, now, now, row.id);
  if (r.changes === 0) return null;
  return db.prepare(`SELECT * FROM http_ops_queue WHERE id = ?`).get(row.id);
}

export function completeOp(id, result) {
  ensureOpsQueueTables();
  getDb()
    .prepare(
      `UPDATE http_ops_queue
       SET status = 'done', result_json = ?, finished_at = datetime('now'),
           last_error = NULL, locked_by = NULL
       WHERE id = ?`
    )
    .run(JSON.stringify(result || {}), Number(id));
}

export function failOp(id, error, { retry = true, retryAfterIso = null } = {}) {
  ensureOpsQueueTables();
  const row = getDb()
    .prepare(`SELECT attempts, max_attempts FROM http_ops_queue WHERE id = ?`)
    .get(Number(id));
  const canRetry = retry && row && row.attempts < row.max_attempts;
  getDb()
    .prepare(
      `UPDATE http_ops_queue
       SET status = ?, last_error = ?, run_after = ?, finished_at = CASE WHEN ? THEN NULL ELSE datetime('now') END,
           locked_by = NULL
       WHERE id = ?`
    )
    .run(
      canRetry ? "pending" : "failed",
      String(error || "error").slice(0, 2000),
      canRetry ? retryAfterIso || new Date(Date.now() + 60_000).toISOString() : null,
      canRetry ? 1 : 0,
      Number(id)
    );
}

export function listOps({ status = null, limit = 50 } = {}) {
  ensureOpsQueueTables();
  if (status) {
    return getDb()
      .prepare(
        `SELECT id, job_key, op, engine, target_type, target_id, session_id,
                status, priority, run_after, attempts, max_attempts, last_error,
                created_at, started_at, finished_at
         FROM http_ops_queue WHERE status = ? ORDER BY id DESC LIMIT ?`
      )
      .all(status, Number(limit));
  }
  return getDb()
    .prepare(
      `SELECT id, job_key, op, engine, target_type, target_id, session_id,
              status, priority, run_after, attempts, max_attempts, last_error,
              created_at, started_at, finished_at
       FROM http_ops_queue ORDER BY id DESC LIMIT ?`
    )
    .all(Number(limit));
}

export function queueStats() {
  ensureOpsQueueTables();
  const rows = getDb()
    .prepare(
      `SELECT status, COUNT(*) AS n FROM http_ops_queue GROUP BY status`
    )
    .all();
  const out = { pending: 0, running: 0, done: 0, failed: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}
