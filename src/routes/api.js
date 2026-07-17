import { Router } from "express";
import {
  listAccounts,
  listPages,
  countPages,
  syncPagesForAccount,
  deleteAccount,
  getAccountPublic,
  getUserToken,
  getPagePublic,
} from "../services/accounts.js";
import {
  enrichPageById,
  enrichAccountPages,
  enrichAllPages,
} from "../services/enrich.js";
import {
  exportPagesToWorkbook,
  exportPagesToCsvString,
  listExportSheets,
  getWorkbookPath,
} from "../services/export.js";
import fs from "fs";
import {
  getLastUsage,
  usageWarning,
  refreshAppUsageFromMeta,
} from "../services/rateLimit.js";
import { config } from "../config.js";
import { isPackaged, getExeDir, debugPaths } from "../paths.js";
import {
  checkForUpdate,
  applyUpdate,
  getUpdateConfig,
  scheduleRestart,
} from "../services/updater.js";
import {
  getAntiSpamSettings,
  saveAntiSpamSettings,
  applyPreset,
  getAntiSpamStats,
  getRecommendations,
  listRecentBlocks,
  ensureAntiSpamTables,
} from "../services/antiSpam.js";

const router = Router();

/** GET /api/health */
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "fb-page-studio",
    version: config.version,
    phase: "auth+pages+enrich+publish",
    fb_configured: !!(config.facebook.appId && config.facebook.appSecret),
  });
});

/** GET /api/debug/paths — diagnose packaged .env / data */
router.get("/debug/paths", (_req, res) => {
  res.json({
    ...debugPaths(),
    fb_app_id_set: !!config.facebook.appId,
    redirect_uri: config.facebook.redirectUri,
    app_base_url: config.appBaseUrl,
  });
});

/** GET /api/anti-spam — settings + live stats + tips */
router.get("/anti-spam", (_req, res) => {
  ensureAntiSpamTables();
  res.json(getAntiSpamStats());
});

/** PUT /api/anti-spam — update settings (all numbers customizable) */
router.put("/anti-spam", (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.blocked_keywords === "string") {
      body.blocked_keywords = body.blocked_keywords
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (typeof body.blocked_page_ids === "string") {
      body.blocked_page_ids = body.blocked_page_ids
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const settings = saveAntiSpamSettings(body);
    res.json({ ok: true, settings, stats: getAntiSpamStats() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/anti-spam/preset { name: 'safe'|'strict'|'loose' } */
router.post("/anti-spam/preset", (req, res) => {
  try {
    const settings = applyPreset(req.body?.name || "safe");
    res.json({
      ok: true,
      settings,
      tips: getRecommendations().tips,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/anti-spam/events", (req, res) => {
  res.json({ events: listRecentBlocks(Number(req.query.limit) || 40) });
});

/** GET /api/version — current build + update config */
router.get("/version", (_req, res) => {
  const u = getUpdateConfig();
  res.json({
    version: u.current_version,
    name: "FB Page Studio",
    packaged: u.packaged,
    github_repo: u.github_repo || null,
    asset_name: u.asset_name,
    exe_dir: getExeDir(),
  });
});

/** GET /api/update/check — compare with GitHub Releases latest */
router.get("/update/check", async (_req, res) => {
  try {
    const result = await checkForUpdate();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/update/apply
 * Download latest .exe from GitHub Release and restart (Windows).
 * Body: { restart?: true }
 */
router.post("/update/apply", async (req, res) => {
  try {
    if (process.platform !== "win32") {
      return res.status(400).json({
        ok: false,
        error: "Auto-update .exe hiện hỗ trợ Windows. Tải thủ công từ GitHub Releases.",
      });
    }
    const restart = req.body?.restart !== false;
    // Download only first so client gets JSON before process exits
    const result = await applyUpdate({ restart: false });
    res.json(result);
    if (result.ok && result.updated && restart && result.bat) {
      setTimeout(() => scheduleRestart(result.bat), 500);
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/accounts — all connected Facebook users */
router.get("/accounts", (_req, res) => {
  res.json({ accounts: listAccounts() });
});

/** GET /api/accounts/:id */
router.get("/accounts/:id", (req, res) => {
  const acc = getAccountPublic(Number(req.params.id));
  if (!acc) return res.status(404).json({ error: "Account not found" });
  res.json({ account: acc });
});

/** POST /api/accounts/:id/sync — re-fetch pages via Graph /me/accounts */
router.post("/accounts/:id/sync", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const acc = getAccountPublic(id);
    if (!acc) return res.status(404).json({ error: "Account not found" });

    const token = getUserToken(id);
    if (!token) return res.status(400).json({ error: "No user token stored" });

    const pages = await syncPagesForAccount(id, token);
    res.json({
      account: getAccountPublic(id),
      page_count: pages.length,
      pages: pages.map((p) => ({
        id: p.id,
        page_id: p.page_id,
        name: p.name,
        category: p.category,
        status: p.status,
      })),
    });
  } catch (e) {
    console.error("[sync]", e);
    res.status(502).json({
      error: e.message,
      fb: e.fb || null,
      hint: "Token may be expired — click Connect Facebook again for this account.",
    });
  }
});

/** DELETE /api/accounts/:id */
router.delete("/accounts/:id", (req, res) => {
  const id = Number(req.params.id);
  deleteAccount(id);
  res.json({ ok: true, deleted: id });
});

/**
 * GET /api/pages
 * Query: account_id, q, limit, offset
 * Large scale: paginate with limit/offset
 */
router.get("/pages", (req, res) => {
  const accountId = req.query.account_id
    ? Number(req.query.account_id)
    : undefined;
  const q = req.query.q ? String(req.query.q) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 500;
  const offset = req.query.offset ? Number(req.query.offset) : 0;

  const total = countPages({ accountId, q });
  const pages = listPages({ accountId, q, limit, offset });

  res.json({
    total,
    limit,
    offset,
    pages,
  });
});

/** POST /api/pages/enrich-all — all accounts (can take a while) */
router.post("/pages/enrich-all", async (req, res) => {
  try {
    const delayMs = req.body?.delay_ms ? Number(req.body.delay_ms) : undefined;
    const force = req.body?.force === true;
    const summary = await enrichAllPages({ delayMs, force });
    res.json(summary);
  } catch (e) {
    console.error("[enrich all]", e);
    res.status(502).json({ error: e.message });
  }
});

/**
 * POST /api/accounts/:id/enrich — enrich all pages of account (rate-limited)
 */
router.post("/accounts/:id/enrich", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!getAccountPublic(id)) {
      return res.status(404).json({ error: "Account not found" });
    }
    const delayMs = req.body?.delay_ms ? Number(req.body.delay_ms) : undefined;
    const force = req.body?.force === true;
    const summary = await enrichAccountPages(id, { delayMs, force });
    res.json(summary);
  } catch (e) {
    console.error("[enrich account]", e);
    res.status(502).json({ error: e.message, fb: e.fb || null });
  }
});

/** GET /api/pages/:id — one page with full enrich payload */
router.get("/pages/:id", (req, res) => {
  const page = getPagePublic(Number(req.params.id));
  if (!page) return res.status(404).json({ error: "Page not found" });
  res.json({ page });
});

/**
 * POST /api/pages/:id/enrich — followers, roles, BM field, insights for one page
 * Uses stored page token (no manual API paste).
 */
router.post("/pages/:id/enrich", async (req, res) => {
  try {
    const force = req.body?.force === true || req.query.force === "1";
    const result = await enrichPageById(Number(req.params.id), { force });
    const page = getPagePublic(Number(req.params.id));
    res.json({
      result,
      page,
      app_usage: getLastUsage(),
      usage_warning: usageWarning(),
    });
  } catch (e) {
    console.error("[enrich page]", e);
    res.status(502).json({ error: e.message, fb: e.fb || null });
  }
});

/** Summary stats for dashboard */
router.get("/stats", async (_req, res) => {
  // Refresh app-level % (dashboard) via App Access Token — page tokens don't send x-app-usage
  await refreshAppUsageFromMeta();
  const accounts = listAccounts();
  const totalPages = countPages({});
  const pages = listPages({ limit: 5000 });
  const withFollowers = pages.filter((p) => p.followers_count != null).length;
  res.json({
    account_count: accounts.length,
    page_count: totalPages,
    accounts_error: accounts.filter((a) => a.status === "error").length,
    pages_enriched: withFollowers,
    app_usage: getLastUsage(),
    usage_warning: usageWarning(),
  });
});

/** GET /api/usage — force poll Meta app usage % */
router.get("/usage", async (_req, res) => {
  const usage = await refreshAppUsageFromMeta();
  res.json({
    app_usage: usage,
    usage_warning: usageWarning(),
    note: "call_count ≈ % limit app trên Meta dashboard (rolling window)",
  });
});

/**
 * POST /api/export/xlsx
 * Body: { account_id?, q? }
 * Adds a NEW sheet named by export date into master workbook, then downloads file.
 */
router.post("/export/xlsx", async (req, res) => {
  try {
    const accountId = req.body?.account_id
      ? Number(req.body.account_id)
      : undefined;
    const q = req.body?.q ? String(req.body.q) : undefined;
    const result = await exportPagesToWorkbook({ accountId, q });
    res.setHeader("X-Export-Sheet", encodeURIComponent(result.sheetName));
    res.setHeader("X-Export-Rows", String(result.rowCount));
    res.setHeader("X-Export-Date", encodeURIComponent(result.exportDate));
    res.download(result.filePath, result.downloadName, (err) => {
      if (err) {
        console.error("[export download]", err);
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        }
      }
    });
  } catch (e) {
    console.error("[export xlsx]", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/export/xlsx/meta — same append but return JSON (no download)
 * for UI toast: sheet name, list of sheets
 */
router.post("/export/xlsx/meta", async (req, res) => {
  try {
    const accountId = req.body?.account_id
      ? Number(req.body.account_id)
      : undefined;
    const q = req.body?.q ? String(req.body.q) : undefined;
    const result = await exportPagesToWorkbook({ accountId, q });
    res.json({
      ok: true,
      sheetName: result.sheetName,
      rowCount: result.rowCount,
      exportDate: result.exportDate,
      exportDay: result.exportDay,
      sheets: result.sheets,
      downloadUrl: "/api/export/xlsx/file",
    });
  } catch (e) {
    console.error("[export meta]", e);
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/export/xlsx/file — download master workbook (all sheets) */
router.get("/export/xlsx/file", (req, res) => {
  const file = getWorkbookPath();
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "Chưa có file export. Bấm Xuất Excel trước." });
  }
  res.download(file, "pages_history.xlsx");
});

/** GET /api/export/sheets — list sheets in master file */
router.get("/export/sheets", async (_req, res) => {
  try {
    const info = await listExportSheets();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/export/csv — one-shot CSV (single snapshot; no multi-sheet)
 */
router.get("/export/csv", (req, res) => {
  try {
    const accountId = req.query.account_id
      ? Number(req.query.account_id)
      : undefined;
    const q = req.query.q ? String(req.query.q) : undefined;
    const { csv, downloadName, rowCount, exportDate } = exportPagesToCsvString({
      accountId,
      q,
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadName}"`
    );
    res.setHeader("X-Export-Rows", String(rowCount));
    res.setHeader("X-Export-Date", exportDate);
    // BOM for Excel UTF-8
    res.send("\uFEFF" + csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
