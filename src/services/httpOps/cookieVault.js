/**
 * Encrypted cookie / session vault for HTTP session engine.
 * Cookies never leave the machine unencrypted at rest.
 */
import { getDb } from "../../db/index.js";
import { encryptToken, decryptToken, maskToken } from "../crypto.js";

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS fb_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT '',
      fb_user_id TEXT,
      name TEXT,
      cookie_enc TEXT NOT NULL,
      user_agent TEXT,
      proxy_url TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_check_at TEXT,
      last_error TEXT,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fb_sessions_status ON fb_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_fb_sessions_uid ON fb_sessions(fb_user_id);

    CREATE TABLE IF NOT EXISTS session_page_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      page_name TEXT,
      UNIQUE(session_id, page_id),
      FOREIGN KEY (session_id) REFERENCES fb_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS session_group_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      group_name TEXT,
      UNIQUE(session_id, group_id),
      FOREIGN KEY (session_id) REFERENCES fb_sessions(id) ON DELETE CASCADE
    );
  `);
}

/** Normalize raw cookie header or browser export → Cookie request header value */
export function normalizeCookieHeader(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  // Already a Cookie header: "a=1; b=2"
  if (!s.startsWith("[") && !s.startsWith("{")) {
    return s.replace(/\r?\n/g, "; ").replace(/;\s*;/g, "; ").trim();
  }
  try {
    const parsed = JSON.parse(s);
    const list = Array.isArray(parsed) ? parsed : parsed.cookies || [];
    return list
      .map((c) => {
        if (typeof c === "string") return c;
        if (c?.name && c?.value != null) return `${c.name}=${c.value}`;
        return "";
      })
      .filter(Boolean)
      .join("; ");
  } catch {
    return s;
  }
}

export function listSessionsPublic() {
  ensureTable();
  const rows = getDb()
    .prepare(
      `SELECT id, label, fb_user_id, name, user_agent, proxy_url, status,
              last_check_at, last_error, created_at, updated_at,
              length(cookie_enc) AS cookie_len
       FROM fb_sessions ORDER BY id DESC`
    )
    .all();
  return rows.map((r) => ({
    ...r,
    cookie_preview: r.cookie_len ? `enc:${r.cookie_len}b` : null,
    has_cookie: !!r.cookie_len,
  }));
}

export function getSessionRow(id) {
  ensureTable();
  return (
    getDb().prepare(`SELECT * FROM fb_sessions WHERE id = ?`).get(Number(id)) ||
    null
  );
}

/** @returns {{ cookieHeader: string, userAgent: string, proxyUrl: string, row: object }|null} */
export function loadSessionSecrets(id) {
  const row = getSessionRow(id);
  if (!row) return null;
  const cookieHeader = normalizeCookieHeader(decryptToken(row.cookie_enc) || "");
  return {
    cookieHeader,
    userAgent:
      row.user_agent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    proxyUrl: row.proxy_url || "",
    row,
  };
}

/**
 * @param {{ label?: string, cookie: string, userAgent?: string, proxyUrl?: string, fbUserId?: string, name?: string }} input
 */
export function upsertSession(input) {
  ensureTable();
  const cookieHeader = normalizeCookieHeader(input.cookie);
  if (!cookieHeader || cookieHeader.length < 20) {
    throw new Error("Cookie quá ngắn hoặc rỗng");
  }
  // Prefer c_user from cookie when present
  const m = cookieHeader.match(/(?:^|;\s*)c_user=(\d+)/);
  const fbUserId = String(input.fbUserId || m?.[1] || "").trim() || null;
  const label = String(input.label || fbUserId || "session").trim();
  const enc = encryptToken(cookieHeader);
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO fb_sessions (label, fb_user_id, name, cookie_enc, user_agent, proxy_url, status)
       VALUES (?, ?, ?, ?, ?, ?, 'unknown')`
    )
    .run(
      label,
      fbUserId,
      input.name || null,
      enc,
      input.userAgent || null,
      input.proxyUrl || null
    );
  return getSessionPublic(info.lastInsertRowid);
}

export function updateSessionCookie(id, cookie, extras = {}) {
  ensureTable();
  const cookieHeader = normalizeCookieHeader(cookie);
  if (!cookieHeader || cookieHeader.length < 20) {
    throw new Error("Cookie quá ngắn hoặc rỗng");
  }
  const m = cookieHeader.match(/(?:^|;\s*)c_user=(\d+)/);
  const db = getDb();
  db.prepare(
    `UPDATE fb_sessions SET
       cookie_enc = ?,
       fb_user_id = COALESCE(?, fb_user_id),
       user_agent = COALESCE(?, user_agent),
       proxy_url = COALESCE(?, proxy_url),
       label = COALESCE(?, label),
       status = 'unknown',
       last_error = NULL,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    encryptToken(cookieHeader),
    m?.[1] || extras.fbUserId || null,
    extras.userAgent || null,
    extras.proxyUrl || null,
    extras.label || null,
    Number(id)
  );
  return getSessionPublic(id);
}

export function deleteSession(id) {
  ensureTable();
  getDb().prepare(`DELETE FROM fb_sessions WHERE id = ?`).run(Number(id));
  return { ok: true };
}

export function getSessionPublic(id) {
  const row = getSessionRow(id);
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    fb_user_id: row.fb_user_id,
    name: row.name,
    user_agent: row.user_agent,
    proxy_url: row.proxy_url,
    status: row.status,
    last_check_at: row.last_check_at,
    last_error: row.last_error,
    has_cookie: !!row.cookie_enc,
    cookie_preview: row.cookie_enc ? maskToken(decryptToken(row.cookie_enc) || "") : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function markSessionStatus(id, status, error = null) {
  ensureTable();
  getDb()
    .prepare(
      `UPDATE fb_sessions SET status = ?, last_error = ?, last_check_at = datetime('now'),
       updated_at = datetime('now') WHERE id = ?`
    )
    .run(status, error, Number(id));
}

export function mapSessionPage(sessionId, pageId, pageName = null) {
  ensureTable();
  getDb()
    .prepare(
      `INSERT INTO session_page_map (session_id, page_id, page_name)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id, page_id) DO UPDATE SET page_name = excluded.page_name`
    )
    .run(Number(sessionId), String(pageId), pageName);
}

export function listSessionPages(sessionId) {
  ensureTable();
  return getDb()
    .prepare(
      `SELECT * FROM session_page_map WHERE session_id = ? ORDER BY page_name`
    )
    .all(Number(sessionId));
}

export function mapSessionGroup(sessionId, groupId, groupName = null) {
  ensureTable();
  getDb()
    .prepare(
      `INSERT INTO session_group_map (session_id, group_id, group_name)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id, group_id) DO UPDATE SET group_name = excluded.group_name`
    )
    .run(Number(sessionId), String(groupId), groupName);
}

export function listSessionGroups(sessionId) {
  ensureTable();
  return getDb()
    .prepare(
      `SELECT * FROM session_group_map WHERE session_id = ? ORDER BY group_name`
    )
    .all(Number(sessionId));
}

export function ensureSessionTables() {
  ensureTable();
}
