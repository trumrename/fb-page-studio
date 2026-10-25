/**
 * Theo dõi follow theo ngày — 1 file cộng dồn:
 * follow-theo-doi.xlsx · sheet «Tất cả» + sheet nhóm page + sheet Via/Token
 * Cột động F YYYY-MM-DD; xuất lại cùng ngày → ghi đè cột đó.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import ExcelJS from "exceljs";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { enrichPageById } from "./enrich.js";
import {
  getFollowOnDay,
  saveFollowerSnapshot,
  snapshotFollowersForPages,
} from "./followerHistory.js";
import { getSelectionGroups, resolveGroupToPageIds } from "./selectionGroups.js";

const EXPORT_DIR = path.resolve(
  config.dataDir || path.dirname(config.databasePath),
  "exports"
);
const WORKBOOK_FILE = path.join(EXPORT_DIR, "follow-theo-doi.xlsx");

const FIXED_HEADERS = ["Page", "Page ID", "Via / Account", "Nhóm", "Link Page"];
const DATE_PREFIX = "F ";

function pageLinkOf(p) {
  const link = String(p?.link || "").trim();
  if (link) return link;
  const pid = String(p?.page_id || "").trim();
  if (!pid) return "";
  return `https://www.facebook.com/${pid}`;
}

function ensureDir() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

/** Mở Explorer đúng file đã ghi đè — không tải bản mới về Downloads. */
function revealFollowFile(file) {
  try {
    if (process.platform !== "win32") return;
    spawn("explorer.exe", [`/select,${file}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch {
    /* ignore */
  }
}

export function vnDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function vnYesterday() {
  const today = vnDay();
  const d = new Date(`${today}T12:00:00+07:00`);
  d.setDate(d.getDate() - 1);
  return vnDay(d);
}

export function vnNowDisplay(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace("T", " ");
}

function sanitizeSheetName(name) {
  let s = String(name || "nhom")
    .replace(/[\\/?*[\]]/g, "-")
    .replace(/'/g, "")
    .trim();
  if (!s) s = "nhom";
  return s.slice(0, 31);
}

function dateColHeader(day) {
  const [y, m, d] = String(day || "").split("-");
  if (!y || !m || !d) return String(day || "");
  return `${d}/${m}/${y}`;
}

function parseDateColHeader(header) {
  const s = String(header || "").trim();
  let m = s.match(/^F (\d{4}-\d{2}-\d{2})$/);
  if (m) return m[1];
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function loadPagesByIds(pageRowIds) {
  const ids = [
    ...new Set(
      (Array.isArray(pageRowIds) ? pageRowIds : [])
        .map(Number)
        .filter((n) => n > 0)
    ),
  ];
  if (!ids.length) return [];
  const db = getDb();
  const get = db.prepare(
    `SELECT p.id, p.page_id, p.name, p.followers_count, p.fan_count, p.status, p.link,
            a.name AS account_name, a.id AS account_id
     FROM fb_pages p
     LEFT JOIN fb_accounts a ON a.id = p.account_id
     WHERE p.id = ?`
  );
  const out = [];
  for (const id of ids) {
    const row = get.get(id);
    if (row && row.status === "active") out.push(row);
  }
  return out;
}

function groupNamesForPage(pageRowId, pageGroups) {
  const names = [];
  for (const g of pageGroups || []) {
    if ((g.page_row_ids || []).map(Number).includes(Number(pageRowId))) {
      names.push(g.name || g.id);
    }
  }
  return names.join("; ");
}

function resolveScope({ scope, page_group_id, page_row_ids, account_id } = {}) {
  const s = String(scope || "all").toLowerCase();
  if (s === "pages") {
    return {
      scope: "pages",
      page_row_ids: [
        ...new Set(
          (Array.isArray(page_row_ids) ? page_row_ids : [])
            .map(Number)
            .filter((n) => n > 0)
        ),
      ],
      page_group_id: null,
      account_id: null,
    };
  }
  if (s === "group") {
    const resolved = resolveGroupToPageIds({ page_group_id });
    return {
      scope: "group",
      page_row_ids: resolved.page_row_ids || [],
      page_group_id: page_group_id || null,
      group: resolved.group || null,
      account_id: null,
    };
  }
  if (s === "accounts" || s === "tokens") {
    const aids = [
      ...new Set(
        (Array.isArray(opts.account_ids) ? opts.account_ids : [])
          .map(Number)
          .filter((n) => n > 0)
      ),
    ];
    if (!aids.length) throw new Error("Tick ít nhất 1 token / via");
    const rows = getDb()
      .prepare(
        `SELECT id FROM fb_pages WHERE status = 'active' AND account_id IN (${aids.map(() => "?").join(",")}) ORDER BY name COLLATE NOCASE`
      )
      .all(...aids);
    let pageIds = rows.map((r) => Number(r.id));
    let group = null;
    if (page_group_id) {
      const resolved = resolveGroupToPageIds({ page_group_id });
      group = resolved.group || null;
      const allow = new Set(resolved.page_row_ids || []);
      pageIds = pageIds.filter((id) => allow.has(id));
    }
    return {
      scope: "accounts",
      page_row_ids: pageIds,
      page_group_id: page_group_id || null,
      group,
      account_id: null,
      account_ids: aids,
      account_name: `${aids.length} token`,
    };
  }
  if (s === "account" || s === "via" || s === "token") {
    const aid = Number(account_id);
    if (!Number.isFinite(aid) || aid <= 0) {
      throw new Error("Chọn via / token (account_id)");
    }
    const acc = getDb()
      .prepare(`SELECT id, name FROM fb_accounts WHERE id = ?`)
      .get(aid);
    if (!acc) throw new Error(`Account #${aid} không tồn tại`);
    const rows = getDb()
      .prepare(
        `SELECT id FROM fb_pages WHERE account_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE`
      )
      .all(aid);
    return {
      scope: "account",
      page_row_ids: rows.map((r) => Number(r.id)),
      page_group_id: null,
      account_id: aid,
      account_name: acc.name || `account_${aid}`,
    };
  }
  const rows = getDb()
    .prepare(`SELECT id FROM fb_pages WHERE status = 'active' ORDER BY name COLLATE NOCASE`)
    .all();
  return {
    scope: "all",
    page_row_ids: rows.map((r) => Number(r.id)),
    page_group_id: null,
    account_id: null,
  };
}

function listActiveAccountsWithPages() {
  return getDb()
    .prepare(
      `SELECT a.id, a.name,
              (SELECT COUNT(*) FROM fb_pages p WHERE p.account_id = a.id AND p.status = 'active') AS page_count
       FROM fb_accounts a
       WHERE a.status != 'deleted'
         AND EXISTS (SELECT 1 FROM fb_pages p WHERE p.account_id = a.id AND p.status = 'active')
       ORDER BY a.name COLLATE NOCASE, a.id`
    )
    .all();
}

function viaSheetName(accountName, accountId) {
  return sanitizeSheetName(`Via ${accountName || accountId || "token"}`);
}

async function enrichPages(pageRowIds, { delayMs = 150 } = {}) {
  const results = [];
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  for (const id of pageRowIds) {
    try {
      const r = await Promise.race([
        enrichPageById(id, { force: true, profileOnly: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout 20s")), 20000)
        ),
      ]);
      results.push(r);
      if (r.skipped) skipped += 1;
      else if (r.ok === false) fail += 1;
      else ok += 1;
      if (Number.isFinite(Number(r.followers_count))) {
        saveFollowerSnapshot(id, r.followers_count, null, vnDay());
      }
    } catch (e) {
      fail += 1;
      results.push({ id, ok: false, error: e.message || String(e) });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok, fail, skipped, results };
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF17365D" },
  };
}

/**
 * Đọc header hiện có → fixed + date cols đã có + summary.
 * Trả về map page_id → row values cho các cột F ngày cũ.
 */
function readExistingSheetMap(ws) {
  const map = new Map(); // page_id → { dates: {day: follow}, meta }
  if (!ws || ws.rowCount < 2) return { map, dateDays: [] };
  const header = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    header[col] = String(cell.value ?? "").trim();
  });
  const dateDays = [];
  const colDay = new Map(); // colNumber → day
  for (let c = 1; c <= header.length; c++) {
    const day = parseDateColHeader(header[c]);
    if (day) {
      dateDays.push(day);
      colDay.set(c, day);
    }
  }
  const pageIdCol = header.findIndex((h) => h === "Page ID") + 1 || 2;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const pageId = String(row.getCell(pageIdCol).value ?? "").trim();
    if (!pageId) continue;
    const dates = {};
    for (const [col, day] of colDay.entries()) {
      const v = row.getCell(col).value;
      if (v === null || v === undefined || v === "") continue;
      const n = Number(v);
      if (Number.isFinite(n)) dates[day] = n;
    }
    map.set(pageId, { dates, rowNumber: r });
  }
  return { map, dateDays: [...new Set(dateDays)].sort() };
}

function buildHeaders(allDateDays, today, yesterday) {
  // Cột ngày dạng 22/09/2026 (cộng dồn, cùng ngày thì ghi đè) + Ngày xuất
  const days = [...new Set([...(allDateDays || []), yesterday, today])]
    .filter(Boolean)
    .sort();
  return {
    days,
    headers: [...FIXED_HEADERS, ...days.map(dateColHeader), "Ngày xuất"],
  };
}

function followForPage(page, day, existingDates) {
  if (existingDates && Number.isFinite(Number(existingDates[day]))) {
    return Number(existingDates[day]);
  }
  const snap = getFollowOnDay(page.id, day);
  if (snap) return snap.followers;
  // Hôm nay: ưu tiên giá trị live trên fb_pages
  if (day === vnDay() && Number.isFinite(Number(page.followers_count))) {
    return Number(page.followers_count);
  }
  return null;
}

function rewriteSheet(wb, sheetName, pages, ctx) {
  const { today, yesterday, exportAt, pageGroups, existingMap, allDateDays } = ctx;
  const old = wb.getWorksheet(sheetName);
  const prior = old
    ? readExistingSheetMap(old)
    : { map: new Map(), dateDays: [] };
  // Merge date days from prior sheet + global
  const mergedDays = [
    ...new Set([
      ...(allDateDays || []),
      ...(prior.dateDays || []),
      yesterday,
      today,
    ]),
  ].sort();
  const { headers, days } = buildHeaders(mergedDays, today, yesterday);

  // Collect existing date values for pages not in this write (keep history on «Tất cả»)
  const byPageId = new Map();
  for (const [pid, data] of prior.map.entries()) {
    byPageId.set(pid, { ...data.dates });
  }
  if (existingMap) {
    for (const [pid, data] of existingMap.entries()) {
      const cur = byPageId.get(pid) || {};
      byPageId.set(pid, { ...cur, ...data.dates });
    }
  }

  // Update today's values for pages in this batch
  for (const p of pages) {
    const pid = String(p.page_id);
    const cur = byPageId.get(pid) || {};
    const todayVal = Number.isFinite(Number(p.followers_count))
      ? Number(p.followers_count)
      : followForPage(p, today, cur);
    if (Number.isFinite(todayVal)) cur[today] = todayVal;
    // Fill yesterday from history if missing in sheet
    if (!Number.isFinite(Number(cur[yesterday]))) {
      const y = followForPage(p, yesterday, cur);
      if (Number.isFinite(y)) cur[yesterday] = y;
    }
    byPageId.set(pid, cur);
  }

  // Rows: prefer current pages order, then any leftover page_ids from prior sheet that still exist in DB
  const pageByFbId = new Map(pages.map((p) => [String(p.page_id), p]));
  const orderedIds = [];
  for (const p of pages) orderedIds.push(String(p.page_id));
  for (const pid of byPageId.keys()) {
    if (!pageByFbId.has(pid) && !orderedIds.includes(pid)) {
      // keep historical row only if page still active
      const row = getDb()
        .prepare(
          `SELECT p.id, p.page_id, p.name, p.followers_count, p.link, a.name AS account_name, a.id AS account_id
           FROM fb_pages p LEFT JOIN fb_accounts a ON a.id = p.account_id
           WHERE p.page_id = ? AND p.status = 'active' LIMIT 1`
        )
        .get(pid);
      if (row) {
        pageByFbId.set(pid, row);
        orderedIds.push(pid);
      }
    }
  }

  if (old) wb.removeWorksheet(old.id);
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1, xSplit: 5 }],
  });
  ws.addRow(headers);
  styleHeader(ws.getRow(1));

  // Cột: 1–5 cố định · F ngày (số) · Cập nhật lúc
  const firstDateCol = FIXED_HEADERS.length + 1;
  const exportAtCol = headers.length;
  const lastNumCol = exportAtCol - 1;

  for (const pid of orderedIds) {
    const p = pageByFbId.get(pid);
    if (!p) continue;
    const dates = byPageId.get(pid) || {};
    const yVal = Number.isFinite(Number(dates[yesterday]))
      ? Number(dates[yesterday])
      : followForPage(p, yesterday, dates);
    const tVal = Number.isFinite(Number(dates[today]))
      ? Number(dates[today])
      : followForPage(p, today, dates);
    if (Number.isFinite(tVal)) dates[today] = tVal;
    if (Number.isFinite(yVal)) dates[yesterday] = yVal;

    const excelRow = ws.addRow([]);
    excelRow.getCell(1).value = String(p.name || "");
    // Page ID luôn text — Facebook ID dài bị Excel đổi thành 1.23E+14 nếu để Number
    excelRow.getCell(2).value = String(pid);
    excelRow.getCell(2).numFmt = "@";
    excelRow.getCell(3).value = String(p.account_name || "");
    excelRow.getCell(4).value = String(groupNamesForPage(p.id, pageGroups) || "");
    const link = pageLinkOf(p);
    if (link) {
      excelRow.getCell(5).value = { text: link, hyperlink: link };
      excelRow.getCell(5).font = {
        color: { argb: "FF0563C1" },
        underline: true,
      };
    } else {
      excelRow.getCell(5).value = "";
    }

    let col = firstDateCol;
    for (const d of days) {
      const v = dates[d];
      const cell = excelRow.getCell(col);
      if (Number.isFinite(Number(v))) {
        cell.value = Number(v);
        cell.numFmt = "#,##0";
      } else {
        cell.value = null;
      }
      col += 1;
    }
    excelRow.getCell(exportAtCol).value = String(exportAt || "");
  }

  // widths + numFmt cột số
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 22;
  ws.getColumn(2).numFmt = "@";
  ws.getColumn(3).width = 22;
  ws.getColumn(4).width = 24;
  ws.getColumn(5).width = 42;
  for (let c = firstDateCol; c <= lastNumCol; c++) {
    ws.getColumn(c).width = 14;
    ws.getColumn(c).numFmt = "#,##0";
  }
  ws.getColumn(exportAtCol).width = 20;

  return { sheetName, rows: orderedIds.length, days };
}

function writeCsvSnapshot(pages, ctx) {
  const { today, yesterday, exportAt, pageGroups, days } = ctx;
  // 1 file CSV cố định (ghi đè) — cùng schema Excel, không nhân bản theo ngày
  const headers = [...FIXED_HEADERS, ...days.map(dateColHeader), "Ngày xuất"];
  // Excel tiếng Việt tách cột bằng dấu ; — dấu phẩy làm dồn 1 cột
  const esc = (v) => {
    const s = String(v ?? "");
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(";")];
  for (const p of pages) {
    const y = getFollowOnDay(p.id, yesterday)?.followers ?? "";
    const t = Number.isFinite(Number(p.followers_count))
      ? Number(p.followers_count)
      : getFollowOnDay(p.id, today)?.followers ?? "";
    const vals = [
      p.name || "",
      p.page_id || "",
      p.account_name || "",
      groupNamesForPage(p.id, pageGroups),
      pageLinkOf(p),
    ];
    for (const d of days) {
      if (d === today && Number.isFinite(Number(t))) vals.push(t);
      else if (d === yesterday && Number.isFinite(Number(y))) vals.push(y);
      else vals.push(getFollowOnDay(p.id, d)?.followers ?? "");
    }
    vals.push(exportAt);
    lines.push(vals.map(esc).join(";"));
  }
  const file = path.join(EXPORT_DIR, "follow-theo-doi.csv");
  fs.writeFileSync(file, "\uFEFF" + lines.join("\r\n"), "utf8");
  return file;
}

export function getFollowTrackWorkbookPath() {
  return WORKBOOK_FILE;
}

/**
 * @param {{ scope?: string, page_group_id?: string, page_row_ids?: number[], account_id?: number, refresh?: boolean, delayMs?: number }} opts
 */
export async function exportFollowersTrack(opts = {}) {
  ensureDir();
  const today = vnDay();
  const yDay = vnYesterday();
  const exportAt = vnNowDisplay();
  const resolved = resolveScope(opts);
  const pageRowIds = resolved.page_row_ids || [];
  if (!pageRowIds.length) {
    throw new Error(
      resolved.scope === "group"
        ? "Nhóm page trống hoặc không tồn tại"
        : resolved.scope === "account"
          ? `Via/token «${resolved.account_name || resolved.account_id}» không có page active`
          : "Không có page nào để xuất"
    );
  }

  let enrichSummary = { ok: 0, fail: 0, skipped: 0, results: [], error: null };
  if (opts.refresh !== false) {
    try {
      enrichSummary = await enrichPages(pageRowIds, {
        delayMs: opts.delayMs ?? 40,
      });
    } catch (e) {
      enrichSummary.error = e.message || String(e);
    }
  }
  snapshotFollowersForPages(pageRowIds, today);

  const pages = loadPagesByIds(pageRowIds);
  const { page_groups } = getSelectionGroups();

  const wb = new ExcelJS.Workbook();
  wb.creator = "FB Page Studio";
  if (fs.existsSync(WORKBOOK_FILE)) {
    await wb.xlsx.readFile(WORKBOOK_FILE);
  }

  // Collect all date columns already in workbook
  const allDateDays = new Set([yDay, today]);
  wb.eachSheet((ws) => {
    const { dateDays } = readExistingSheetMap(ws);
    for (const d of dateDays) allDateDays.add(d);
  });

  const ctxBase = {
    today,
    yesterday: yDay,
    exportAt,
    pageGroups: page_groups,
    allDateDays: [...allDateDays].sort(),
  };

  const sheetResults = [];
  sheetResults.push(
    rewriteSheet(wb, sanitizeSheetName("Tất cả"), pages, ctxBase)
  );

  // Sheets per page group
  const groupsToWrite =
    resolved.scope === "group" && resolved.group
      ? [resolved.group]
      : resolved.scope === "account"
        ? (page_groups || []).filter((g) =>
            (g.page_row_ids || []).some((id) => pageRowIds.includes(Number(id)))
          )
        : page_groups || [];

  for (const g of groupsToWrite) {
    const gIds = (g.page_row_ids || []).map(Number).filter((n) => n > 0);
    const ids =
      resolved.scope === "all"
        ? gIds
        : gIds.filter((id) => pageRowIds.includes(id));
    const gPages =
      resolved.scope === "all" ? loadPagesByIds(gIds) : loadPagesByIds(ids);
    if (!gPages.length) continue;
    const name = sanitizeSheetName(g.name || g.id);
    sheetResults.push(rewriteSheet(wb, name, gPages, ctxBase));
  }

  // Sheets per Via / Token (account name)
  const accounts =
    resolved.scope === "account" && resolved.account_id
      ? [
          {
            id: resolved.account_id,
            name: resolved.account_name,
          },
        ]
      : listActiveAccountsWithPages().filter((a) => {
          if (resolved.scope === "all") return true;
          // group/pages: chỉ via có page trong phạm vi xuất
          return pages.some((p) => Number(p.account_id) === Number(a.id));
        });

  for (const acc of accounts) {
    const aPages = pages.filter((p) => Number(p.account_id) === Number(acc.id));
    const viaPages =
      resolved.scope === "all"
        ? loadPagesByIds(
            getDb()
              .prepare(
                `SELECT id FROM fb_pages WHERE account_id = ? AND status = 'active'`
              )
              .all(acc.id)
              .map((r) => Number(r.id))
          )
        : aPages;
    if (!viaPages.length) continue;
    const name = viaSheetName(acc.name, acc.id);
    sheetResults.push(rewriteSheet(wb, name, viaPages, ctxBase));
  }

  // CSV tạo trước (kể cả lần đầu) — 1 file cố định, ghi đè lần sau
  const csvDays = [...allDateDays].sort();
  // CSV ghi đè đúng phạm vi lần này (token/nhóm đang chọn), không nhân bản file mới
  const csv = writeCsvSnapshot(pages, {
    ...ctxBase,
    days: csvDays,
  });

  try {
    await wb.xlsx.writeFile(WORKBOOK_FILE);
  } catch (e) {
    revealFollowFile(csv);
    throw new Error(
      `Đã tạo CSV: ${csv}. Không ghi được Excel ${WORKBOOK_FILE}. Đóng Excel nếu đang mở. ${e.message || e}`
    );
  }
  revealFollowFile(WORKBOOK_FILE);

  return {
    ok: true,
    file: WORKBOOK_FILE,
    csv,
    day: today,
    yesterday: yDay,
    export_at: exportAt,
    pages: pages.length,
    scope: resolved.scope,
    page_group_id: resolved.page_group_id || null,
    account_id: resolved.account_id || null,
    account_name: resolved.account_name || null,
    enrich: {
      ok: enrichSummary.ok,
      fail: enrichSummary.fail,
      skipped: enrichSummary.skipped,
    },
    sheets: sheetResults.map((s) => s.sheetName),
    download_url: "/api/export/followers-track/file",
    download_name: "follow-theo-doi.xlsx",
  };
}

export { listActiveAccountsWithPages };
