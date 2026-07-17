import fs from "fs";
import path from "path";
import { config } from "../config.js";

const LOG_DIR = path.resolve(path.dirname(config.databasePath), "exports");
const LOG_FILE = path.join(LOG_DIR, "post_logs.csv");

const HEADERS = [
  "id",
  "created_at",
  "page_id",
  "page_name",
  "post_type",
  "day_index",
  "status",
  "fb_post_id",
  "fb_post_url",
  "media_path",
  "caption",
  "comment_text",
  "comment_id",
  "error",
  "scheduled_publish_time",
];

function escape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function appendPostCsv(row) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const exists = fs.existsSync(LOG_FILE);
  if (!exists) {
    fs.writeFileSync(LOG_FILE, "\uFEFF" + HEADERS.join(",") + "\r\n", "utf8");
  }
  const line = HEADERS.map((h) => {
    if (h === "created_at") {
      return escape(row.created_at || new Date().toISOString());
    }
    return escape(row[h]);
  }).join(",");
  fs.appendFileSync(LOG_FILE, line + "\r\n", "utf8");

  // Mirror into detailed report CSV + Excel (async, non-blocking)
  import("./reportExport.js")
    .then((m) => m.appendFromPostLog(row))
    .catch((e) => console.warn("[report mirror]", e.message));
}

export function getPostLogCsvPath() {
  return LOG_FILE;
}
