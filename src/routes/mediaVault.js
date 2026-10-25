import { Router } from "express";
import {
  getMediaVaultSettings,
  saveMediaVaultSettings,
  ensurePageFolders,
  bindPageFolders,
  listVaultTree,
  deleteVaultForAccount,
  deleteVaultForPages,
  pathsForPage,
} from "../services/mediaVault.js";

const router = Router();

router.get("/settings", (_req, res) => {
  try {
    res.json({ ok: true, settings: getMediaVaultSettings() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.put("/settings", (req, res) => {
  try {
    const settings = saveMediaVaultSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/tree", (_req, res) => {
  try {
    res.json(listVaultTree());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/ensure", (req, res) => {
  try {
    const body = req.body || {};
    const r = ensurePageFolders({
      page_row_ids: body.page_row_ids,
      account_id: body.account_id,
      page_group_id: body.page_group_id,
      account_group_id: body.account_group_id,
      layout: body.layout === "group" ? "group" : "via",
      group_name: body.group_name || null,
    });
    res.json({ ok: r.ok, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/bind", (req, res) => {
  try {
    const body = req.body || {};
    const overwrite = body.overwrite !== false && body.overwrite !== 0;
    const r = bindPageFolders(
      {
        page_row_ids: body.page_row_ids,
        account_id: body.account_id,
        page_group_id: body.page_group_id,
        account_group_id: body.account_group_id,
        layout: body.layout === "group" ? "group" : "via",
        group_name: body.group_name || null,
      },
      { overwrite }
    );
    res.json({ ok: r.ok, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** Preview path 1 page (không tạo) */
router.get("/preview/:pageRowId", (req, res) => {
  try {
    const paths = pathsForPage(Number(req.params.pageRowId));
    res.json({ ok: true, paths });
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message });
  }
});

router.post("/delete", (req, res) => {
  try {
    const body = req.body || {};
    if (!body.confirm && body.confirm !== true && body.confirm !== 1) {
      return res.status(400).json({
        ok: false,
        error: "Cần confirm: true để xóa thư mục media",
      });
    }
    const dryRun = !!body.dry_run;
    if (body.account_id) {
      const r = deleteVaultForAccount(Number(body.account_id), { dryRun });
      return res.json({ ok: true, ...r });
    }
    const ids = Array.isArray(body.page_row_ids) ? body.page_row_ids : [];
    if (!ids.length) {
      return res.status(400).json({
        ok: false,
        error: "Cần account_id hoặc page_row_ids",
      });
    }
    const r = deleteVaultForPages(ids, { dryRun });
    res.json({ ok: r.ok, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
