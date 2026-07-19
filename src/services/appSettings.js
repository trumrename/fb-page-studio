import { getDb } from "../db/index.js";

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function getAppSetting(key, fallback = {}) {
  const row = getDb()
    .prepare(`SELECT value_json FROM app_settings WHERE key = ?`)
    .get(String(key));
  return parseJson(row?.value_json, fallback);
}

export function saveAppSetting(key, value) {
  const normalized = value && typeof value === "object" ? value : {};
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value_json, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = datetime('now')`
    )
    .run(String(key), JSON.stringify(normalized));
  return normalized;
}
