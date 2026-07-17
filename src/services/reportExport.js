/**
 * Detailed post reports → CSV + Excel (every success/fail).
 * Columns: datetime, page, success, link, type, caption, error, ...
 */
import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
import { config } from "../config.js";

const EXPORT_DIR = path.resolve(
  config.dataDir || path.dirname(config.databasePath),
  "exports"
);

export const REPORT_CSV = path.join(EXPORT_DIR, "dang_bai_chi_tiet.csv");
export const REPORT_XLSX = path.join(EXPORT_DIR, "dang_bai_chi_tiet.xlsx");

const HEADERS = [
  "datetime_local",
  "created_at",
  "success",
  "status",
  "page_name",
  "page_id",
  "page_row_id",
  "task_kind",
  "task_label",
  "post_type",
  "fb_post_url",
  "fb_post_id",
  "scheduled_publish_time",
  "caption",
  "media_path",
  "error",
  "message",
  "job_task_id",
];

function ensureDir() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

function escapeCsv(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Append one row to CSV + Excel. Returns paths. */
export async function appendPostReport(row) {
  ensureDir();
  const data = { ...row };
  if (!data.datetime_local) {
    const d = new Date(data.created_at || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    data.datetime_local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  if (!data.created_at) data.created_at = new Date().toISOString();

  // CSV
  const exists = fs.existsSync(REPORT_CSV);
  if (!exists) {
    fs.writeFileSync(REPORT_CSV, "\uFEFF" + HEADERS.join(",") + "\r\n", "utf8");
  }
  const line = HEADERS.map((h) => escapeCsv(data[h])).join(",");
  fs.appendFileSync(REPORT_CSV, line + "\r\n", "utf8");

  // Excel
  await writePostExcelRow(data);

  return { csv: REPORT_CSV, xlsx: REPORT_XLSX };
}

export async function writePostExcelRow(row) {
  ensureDir();
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(REPORT_XLSX)) {
    await wb.xlsx.readFile(REPORT_XLSX);
  }
  let sheet = wb.getWorksheet("DangBai");
  if (!sheet) {
    sheet = wb.addWorksheet("DangBai");
    sheet.addRow(HEADERS);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }
  sheet.addRow(HEADERS.map((h) => row[h] ?? ""));
  // autosize light
  sheet.columns.forEach((col, i) => {
    const key = HEADERS[i];
    if (!key) return;
    const w =
      key === "caption" || key === "error" || key === "message"
        ? 40
        : key === "fb_post_url"
          ? 36
          : 16;
    col.width = Math.max(col.width || 10, w);
  });
  await wb.xlsx.writeFile(REPORT_XLSX);
  return REPORT_XLSX;
}

/** Also sync from post_logs row shape */
export async function appendFromPostLog(logRow) {
  return appendPostReport({
    datetime_local: null,
    created_at: logRow.created_at || new Date().toISOString(),
    success:
      logRow.status === "ok" ||
      logRow.status === "ok_comment_failed" ||
      logRow.status === "scheduled"
        ? "YES"
        : "NO",
    status: logRow.status,
    page_name: logRow.page_name,
    page_id: logRow.page_id,
    page_row_id: logRow.page_row_id,
    task_kind: logRow.scheduled_publish_time ? "schedule" : "post",
    task_label: logRow.post_type || "",
    post_type: logRow.post_type,
    fb_post_url: logRow.fb_post_url,
    fb_post_id: logRow.fb_post_id,
    scheduled_publish_time: logRow.scheduled_publish_time || "",
    caption: logRow.caption,
    media_path: logRow.media_path,
    error: logRow.error,
    message: "",
    job_task_id: logRow.id,
  });
}

export function getReportPaths() {
  return {
    dir: EXPORT_DIR,
    csv: REPORT_CSV,
    xlsx: REPORT_XLSX,
    csv_exists: fs.existsSync(REPORT_CSV),
    xlsx_exists: fs.existsSync(REPORT_XLSX),
  };
}
