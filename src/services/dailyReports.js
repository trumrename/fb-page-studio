import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { listPages } from "./accounts.js";
import { listMetaAppsPublic } from "./metaApps.js";
import { snapshotCurrentFollowers, getFollowerGrowth } from "./followerHistory.js";

const DIR = path.resolve(config.dataDir || path.dirname(config.databasePath), "exports", "daily");

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }
function safeName(v) { return String(v || "App").normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "App"; }
function esc(v) { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function vnDay(date = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function yesterdayVn() { return vnDay(new Date(Date.now() - 24 * 60 * 60 * 1000)); }
function writeCsv(file, columns, rows) {
  const lines = [columns.map((c) => esc(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => esc(row[c.key])).join(","));
  fs.writeFileSync(file, "\uFEFF" + lines.join("\r\n"), "utf8");
}
async function writeDailySheet(file, day, columns, rows) {
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(file)) await wb.xlsx.readFile(file);
  const old = wb.getWorksheet(day);
  if (old) wb.removeWorksheet(old.id);
  const ws = wb.addWorksheet(day, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17365D" } };
  for (const row of rows) ws.addRow(row);
  await wb.xlsx.writeFile(file);
  return wb.worksheets.map((x) => x.name);
}

const PAGE_COLUMNS = [
  { header: "Ngày báo cáo", key: "report_day", width: 14 },
  { header: "Meta App", key: "app_name", width: 20 },
  { header: "App key", key: "app_key", width: 12 },
  { header: "App ID", key: "app_id", width: 22 },
  { header: "Admin / Profile", key: "admin_name", width: 28 },
  { header: "Admin Facebook ID", key: "admin_fb_id", width: 24 },
  { header: "Page", key: "page_name", width: 32 },
  { header: "Page ID", key: "page_id", width: 24 },
  { header: "Trạng thái Page", key: "page_status", width: 16 },
  { header: "Danh mục", key: "category", width: 20 },
  { header: "Followers", key: "followers", width: 14 },
  { header: "Fans", key: "fans", width: 14 },
  { header: "Tăng/giảm 1 ngày", key: "follow_delta_1d", width: 18 },
  { header: "Tỷ lệ 1 ngày (%)", key: "follow_pct_1d", width: 17 },
  { header: "Mốc so sánh 1 ngày", key: "follow_base_1d", width: 20 },
  { header: "Tăng/giảm 3 ngày", key: "follow_delta_3d", width: 18 },
  { header: "Tỷ lệ 3 ngày (%)", key: "follow_pct_3d", width: 17 },
  { header: "Mốc so sánh 3 ngày", key: "follow_base_3d", width: 20 },
  { header: "Tăng/giảm 7 ngày", key: "follow_delta_7d", width: 18 },
  { header: "Tỷ lệ 7 ngày (%)", key: "follow_pct_7d", width: 17 },
  { header: "Mốc so sánh 7 ngày", key: "follow_base_7d", width: 20 },
  { header: "Tăng/giảm 30 ngày", key: "follow_delta_30d", width: 19 },
  { header: "Tỷ lệ 30 ngày (%)", key: "follow_pct_30d", width: 18 },
  { header: "Mốc so sánh 30 ngày", key: "follow_base_30d", width: 21 },
  { header: "Link Page", key: "page_link", width: 42 },
  { header: "Quyền của tài khoản", key: "tasks", width: 42 },
  { header: "Cập nhật thông tin lúc", key: "enriched_at", width: 22 },
];

export async function exportPageInfoDaily({ day = vnDay() } = {}) {
  ensureDir();
  snapshotCurrentFollowers(day);
  const appMap = new Map(listMetaAppsPublic().map((a) => [a.key, a]));
  const pages = listPages({ limit: 10000, offset: 0 });
  const groups = new Map();
  for (const p of pages) {
    const key = p.account_meta_app_key || "app1";
    const app = appMap.get(key) || { key, name: key, app_id_full: p.account_meta_app_id || "" };
    if (!groups.has(key)) groups.set(key, { app, rows: [] });
    const growth = getFollowerGrowth(p.id, p.followers_count, day);
    groups.get(key).rows.push({
      report_day: day, app_name: app.name || key, app_key: key,
      app_id: app.app_id_full || p.account_meta_app_id || "",
      admin_name: p.account_name || "", admin_fb_id: p.account_fb_user_id || "",
      page_name: p.name || "", page_id: p.page_id || "", page_status: p.status || "",
      category: p.category || "", followers: p.followers_count ?? "", fans: p.fan_count ?? "",
      follow_delta_1d: growth.d1?.delta ?? "Chưa đủ dữ liệu", follow_pct_1d: growth.d1?.percent ?? "", follow_base_1d: growth.d1?.baseline_day || "",
      follow_delta_3d: growth.d3?.delta ?? "Chưa đủ dữ liệu", follow_pct_3d: growth.d3?.percent ?? "", follow_base_3d: growth.d3?.baseline_day || "",
      follow_delta_7d: growth.d7?.delta ?? "Chưa đủ dữ liệu", follow_pct_7d: growth.d7?.percent ?? "", follow_base_7d: growth.d7?.baseline_day || "",
      follow_delta_30d: growth.d30?.delta ?? "Chưa đủ dữ liệu", follow_pct_30d: growth.d30?.percent ?? "", follow_base_30d: growth.d30?.baseline_day || "",
      page_link: p.link || "", tasks: (p.tasks || []).join("; "), enriched_at: p.enriched_at || "",
    });
  }
  const files = [];
  for (const { app, rows } of groups.values()) {
    const base = `${safeName(app.name)}-thong-tin-page`;
    const xlsx = path.join(DIR, `${base}.xlsx`);
    const csv = path.join(DIR, `${base}-${day}.csv`);
    writeCsv(csv, PAGE_COLUMNS, rows);
    const sheets = await writeDailySheet(xlsx, day, PAGE_COLUMNS, rows);
    files.push({ app: app.name, rows: rows.length, csv, xlsx, sheets });
  }
  return { type: "page_info", day, dir: DIR, files };
}

const HISTORY_COLUMNS = [
  { header: "Ngày", key: "report_day", width: 14 },
  { header: "Meta App", key: "app_name", width: 18 },
  { header: "Admin / Profile", key: "admin_name", width: 28 },
  { header: "Admin Facebook ID", key: "admin_fb_id", width: 24 },
  { header: "Page", key: "page_name", width: 30 },
  { header: "Page ID", key: "page_id", width: 24 },
  { header: "Chế độ", key: "delivery_mode", width: 20 },
  { header: "Loại bài", key: "post_type", width: 14 },
  { header: "Tool thực hiện (VN)", key: "created_vn", width: 22 },
  { header: "Facebook đăng dự kiến (VN)", key: "scheduled_vn", width: 26 },
  { header: "Trạng thái", key: "status", width: 24 },
  { header: "Post ID", key: "fb_post_id", width: 26 },
  { header: "Link bài", key: "fb_post_url", width: 48 },
  { header: "Media", key: "media_path", width: 44 },
  { header: "Caption", key: "caption", width: 60 },
  { header: "Lỗi", key: "error", width: 50 },
];

export async function exportPostingHistoryDaily({ day = vnDay() } = {}) {
  ensureDir();
  const appMap = new Map(listMetaAppsPublic().map((a) => [a.key, a.name]));
  const rows = getDb().prepare(`
    SELECT l.*, a.name AS admin_name, a.fb_user_id AS admin_fb_id, a.meta_app_key
    FROM post_logs l
    LEFT JOIN fb_pages p ON p.id=l.page_row_id
    LEFT JOIN fb_accounts a ON a.id=p.account_id
    WHERE date(COALESCE(NULLIF(l.scheduled_publish_time,''), l.created_at), '+7 hours') = ?
    ORDER BY COALESCE(NULLIF(l.scheduled_publish_time,''), l.created_at), l.id
  `).all(day).map((r) => ({
    report_day: day, app_name: appMap.get(r.meta_app_key || "app1") || r.meta_app_key || "App 1",
    admin_name: r.admin_name || "", admin_fb_id: r.admin_fb_id || "",
    page_name: r.page_name || "", page_id: r.page_id || "",
    delivery_mode: r.scheduled_publish_time ? "Hẹn giờ Facebook" : "Đăng trực tiếp",
    post_type: r.post_type || "", created_vn: r.created_at ? getDb().prepare("SELECT datetime(?, '+7 hours') AS v").get(r.created_at).v : "",
    scheduled_vn: r.scheduled_publish_time ? getDb().prepare("SELECT datetime(?, '+7 hours') AS v").get(r.scheduled_publish_time).v : "",
    status: r.status || "", fb_post_id: r.fb_post_id || "", fb_post_url: r.fb_post_url || "",
    media_path: r.media_path || "", caption: r.caption || "", error: r.error || "",
  }));
  const xlsx = path.join(DIR, "lich-su-dang.xlsx");
  const csv = path.join(DIR, `lich-su-dang-${day}.csv`);
  writeCsv(csv, HISTORY_COLUMNS, rows);
  const sheets = await writeDailySheet(xlsx, day, HISTORY_COLUMNS, rows);
  return { type: "posting_history", day, dir: DIR, rows: rows.length, csv, xlsx, sheets };
}

export async function exportAllDailyReports({ day = vnDay() } = {}) {
  const pages = await exportPageInfoDaily({ day });
  const history = await exportPostingHistoryDaily({ day });
  return { day, pages, history };
}

export function dailyReportInfo() {
  ensureDir();
  return { dir: DIR, files: fs.readdirSync(DIR).filter((x) => /\.(csv|xlsx)$/i.test(x)).sort() };
}

export function getDailyReportFile(name) {
  ensureDir();
  const base = path.basename(String(name || ""));
  if (base !== name || !/\.(csv|xlsx)$/i.test(base)) return null;
  const file = path.join(DIR, base);
  return fs.existsSync(file) ? file : null;
}

export { vnDay, yesterdayVn };
