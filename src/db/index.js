import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "../config.js";

let db;

export function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS fb_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fb_user_id TEXT NOT NULL UNIQUE,
      name TEXT,
      email TEXT,
      picture_url TEXT,
      user_token_enc TEXT NOT NULL,
      user_token_expires_at TEXT,
      scopes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_sync_at TEXT,
      last_error TEXT,
      page_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fb_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      name TEXT,
      category TEXT,
      tasks_json TEXT,
      page_token_enc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, page_id),
      FOREIGN KEY (account_id) REFERENCES fb_accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pages_account ON fb_pages(account_id);
    CREATE INDEX IF NOT EXISTS idx_pages_page_id ON fb_pages(page_id);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON fb_accounts(status);

    -- OAuth state CSRF (short-lived)
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Incremental columns for page enrichment (safe on existing DBs)
  const cols = database
    .prepare(`PRAGMA table_info(fb_pages)`)
    .all()
    .map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) {
      database.exec(`ALTER TABLE fb_pages ADD COLUMN ${ddl}`);
    }
  };
  add("followers_count", "followers_count INTEGER");
  add("fan_count", "fan_count INTEGER");
  add("overall_star_rating", "overall_star_rating REAL");
  add("rating_count", "rating_count INTEGER");
  add("verification_status", "verification_status TEXT");
  add("link", "link TEXT");
  add("about", "about TEXT");
  add("picture_url", "picture_url TEXT");
  add("business_id", "business_id TEXT");
  add("business_name", "business_name TEXT");
  add("roles_json", "roles_json TEXT");
  add("assigned_users_json", "assigned_users_json TEXT");
  add("insights_json", "insights_json TEXT");
  add("enrich_error", "enrich_error TEXT");
  add("enriched_at", "enriched_at TEXT");

  // Post config extra columns (existing DBs)
  const cfgCols = database
    .prepare(`PRAGMA table_info(page_post_config)`)
    .all()
    .map((c) => c.name);
  if (cfgCols.length && !cfgCols.includes("captions_folder")) {
    database.exec(
      `ALTER TABLE page_post_config ADD COLUMN captions_folder TEXT`
    );
  }
  if (cfgCols.length && !cfgCols.includes("active_hours_json")) {
    database.exec(
      `ALTER TABLE page_post_config ADD COLUMN active_hours_json TEXT`
    );
  }
  if (cfgCols.length && !cfgCols.includes("active_hours_at")) {
    database.exec(
      `ALTER TABLE page_post_config ADD COLUMN active_hours_at TEXT`
    );
  }
  if (cfgCols.length && !cfgCols.includes("preferred_hours_json")) {
    database.exec(
      `ALTER TABLE page_post_config ADD COLUMN preferred_hours_json TEXT`
    );
  }

  // post_logs: scheduled time
  const logCols = database
    .prepare(`PRAGMA table_info(post_logs)`)
    .all()
    .map((c) => c.name);
  if (logCols.length && !logCols.includes("scheduled_publish_time")) {
    database.exec(
      `ALTER TABLE post_logs ADD COLUMN scheduled_publish_time TEXT`
    );
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS page_post_config (
      page_row_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_posts_per_day INTEGER NOT NULL DEFAULT 3,
      interval_minutes INTEGER NOT NULL DEFAULT 120,
      sequence_json TEXT NOT NULL DEFAULT '["photo","video","text"]',
      media_folder TEXT,
      posted_folder TEXT,
      captions_folder TEXT,
      captions_json TEXT NOT NULL DEFAULT '[]',
      pick_mode TEXT NOT NULL DEFAULT 'sequential',
      comment_enabled INTEGER NOT NULL DEFAULT 0,
      comment_templates_json TEXT NOT NULL DEFAULT '[]',
      link_lists_json TEXT NOT NULL DEFAULT '{}',
      story_enabled INTEGER NOT NULL DEFAULT 0,
      next_slot_index INTEGER NOT NULL DEFAULT 0,
      last_post_at TEXT,
      posts_today INTEGER NOT NULL DEFAULT 0,
      posts_today_date TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (page_row_id) REFERENCES fb_pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS post_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_row_id INTEGER,
      page_id TEXT,
      page_name TEXT,
      post_type TEXT,
      media_path TEXT,
      caption TEXT,
      fb_post_id TEXT,
      fb_post_url TEXT,
      day_index INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      comment_text TEXT,
      comment_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_post_logs_page ON post_logs(page_row_id);
    CREATE INDEX IF NOT EXISTS idx_post_logs_created ON post_logs(created_at);
  `);
}

export function cleanupOldOauthStates() {
  getDb()
    .prepare(
      `DELETE FROM oauth_states WHERE created_at < datetime('now', '-2 hour')`
    )
    .run();
}
