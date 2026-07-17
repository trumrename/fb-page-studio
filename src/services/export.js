import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { listPages } from "./accounts.js";

/**
 * Export schema = UI hiện tại only.
 * Không cột admin/BTV/BM/quốc gia (đã gỡ — Graph không đủ).
 * Ô trống = không có data (không bịa số).
 */

const EXPORT_DIR = path.resolve(path.dirname(config.databasePath), "exports");
const WORKBOOK_FILE = path.join(EXPORT_DIR, "pages_history.xlsx");

function ensureDir() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

export function exportDateParts(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return {
    day: `${y}-${m}-${d}`,
    dayTime: `${y}-${m}-${d}_${hh}-${mm}`,
    dayTimeSec: `${y}-${m}-${d}_${hh}-${mm}-${ss}`,
    iso: date.toISOString(),
    display: `${y}-${m}-${d} ${hh}:${mm}:${ss}`,
  };
}

function sanitizeSheetName(name) {
  let s = String(name).replace(/[\\/?*[\]]/g, "-").trim();
  if (!s) s = "export";
  return s.slice(0, 31);
}

function uniqueSheetName(workbook, parts) {
  const candidates = [parts.day, parts.dayTime, parts.dayTimeSec];
  for (const c of candidates) {
    const name = sanitizeSheetName(c);
    if (!workbook.getWorksheet(name)) return name;
  }
  let i = 2;
  while (i < 100) {
    const name = sanitizeSheetName(`${parts.day} (${i})`);
    if (!workbook.getWorksheet(name)) return name;
    i++;
  }
  return sanitizeSheetName(parts.dayTimeSec + "_x");
}

/** Empty string if null/undefined — never invent numbers */
function cell(v) {
  if (v === null || v === undefined || v === "") return "";
  return v;
}

function pageToRow(page, exportMeta) {
  const g = page.insights?.growth_7d || null;
  const hasGrowth = g && typeof g.absolute === "number";

  return {
    ngay_xuat: exportMeta.display,
    ten_page: cell(page.name),
    page_id: cell(page.page_id),
    followers: cell(page.followers_count),
    fans: cell(page.fan_count),
    tang_7d_nguoi: hasGrowth ? g.absolute : "",
    tang_7d_phan_tram: hasGrowth && g.percent != null ? g.percent : "",
    followers_dau_7d: hasGrowth && g.start != null ? g.start : "",
    followers_cuoi_7d: hasGrowth && g.end != null ? g.end : "",
    category: cell(page.category),
    verification: cell(page.verification_status),
    link: cell(page.link),
    account: cell(page.account_name),
    account_fb_id: cell(page.account_fb_user_id),
    // Quyền của user đang Connect trên page (từ /me/accounts) — không phải list admin
    quyen_cua_toi: (page.tasks || []).join("; "),
    enriched_at: cell(page.enriched_at),
    about: cell((page.about || "").replace(/\r?\n/g, " ").slice(0, 500)),
    export_iso: exportMeta.iso,
  };
}

/** Headers tiếng Việt — khớp tool hiện tại */
const COLUMNS = [
  { header: "Ngay xuat", key: "ngay_xuat", width: 20 },
  { header: "Ten page", key: "ten_page", width: 28 },
  { header: "Page ID", key: "page_id", width: 22 },
  { header: "Followers", key: "followers", width: 12 },
  { header: "Fans", key: "fans", width: 10 },
  { header: "Tang 7 ngay (nguoi)", key: "tang_7d_nguoi", width: 18 },
  { header: "Tang 7 ngay (%)", key: "tang_7d_phan_tram", width: 16 },
  { header: "Followers dau 7d", key: "followers_dau_7d", width: 16 },
  { header: "Followers cuoi 7d", key: "followers_cuoi_7d", width: 16 },
  { header: "Category", key: "category", width: 16 },
  { header: "Verified", key: "verification", width: 14 },
  { header: "Link", key: "link", width: 40 },
  { header: "Account", key: "account", width: 16 },
  { header: "Account FB ID", key: "account_fb_id", width: 22 },
  { header: "Quyen cua toi (tasks)", key: "quyen_cua_toi", width: 36 },
  { header: "Enriched at", key: "enriched_at", width: 20 },
  { header: "About", key: "about", width: 40 },
  { header: "Export ISO", key: "export_iso", width: 24 },
];

async function loadOrCreateWorkbook() {
  ensureDir();
  const wb = new ExcelJS.Workbook();
  wb.creator = "fb-page-poster";
  if (fs.existsSync(WORKBOOK_FILE)) {
    await wb.xlsx.readFile(WORKBOOK_FILE);
  }
  return wb;
}

export async function exportPagesToWorkbook({ accountId, q } = {}) {
  const parts = exportDateParts();
  const pages = listPages({
    accountId: accountId || undefined,
    q: q || undefined,
    limit: 10000,
    offset: 0,
  });

  const wb = await loadOrCreateWorkbook();
  const sheetName = uniqueSheetName(wb, parts);
  const sheet = wb.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = COLUMNS;
  sheet.getRow(1).font = { bold: true, color: { argb: "FFE8EAED" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1A2740" },
  };
  for (const p of pages) sheet.addRow(pageToRow(p, parts));
  await wb.xlsx.writeFile(WORKBOOK_FILE);

  const sheetNames = [];
  wb.eachSheet((ws) => sheetNames.push(ws.name));
  return {
    filePath: WORKBOOK_FILE,
    sheetName,
    rowCount: pages.length,
    exportDate: parts.display,
    exportDay: parts.day,
    sheets: sheetNames,
    downloadName: `pages_export_${parts.dayTime}.xlsx`,
  };
}

export async function listExportSheets() {
  ensureDir();
  if (!fs.existsSync(WORKBOOK_FILE)) {
    return { file: WORKBOOK_FILE, exists: false, sheets: [] };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK_FILE);
  const sheets = [];
  wb.eachSheet((ws) => {
    sheets.push({
      name: ws.name,
      rowCount: Math.max(0, (ws.rowCount || 1) - 1),
    });
  });
  return { file: WORKBOOK_FILE, exists: true, sheets };
}

export function getWorkbookPath() {
  return WORKBOOK_FILE;
}

/**
 * CSV snapshot — cùng schema COLUMNS với Excel (chuẩn hiện tại).
 * UTF-8 BOM để Excel mở đúng tiếng Việt / số.
 */
export function exportPagesToCsvString({ accountId, q } = {}) {
  const parts = exportDateParts();
  const pages = listPages({
    accountId: accountId || undefined,
    q: q || undefined,
    limit: 10000,
    offset: 0,
  });
  const headers = COLUMNS.map((c) => c.header);
  const keys = COLUMNS.map((c) => c.key);
  const escape = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(escape).join(",")];
  for (const p of pages) {
    const row = pageToRow(p, parts);
    lines.push(keys.map((k) => escape(row[k])).join(","));
  }
  return {
    csv: lines.join("\r\n"),
    rowCount: pages.length,
    exportDate: parts.display,
    columns: headers,
    downloadName: `pages_${parts.dayTime}.csv`,
  };
}
