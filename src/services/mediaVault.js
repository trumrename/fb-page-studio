/**
 * Kho media theo Via/Token → page_id
 * F:\FB-Media\{via}\{page_id}\ (+ posted\)
 */
import fs from "fs";
import path from "path";
import { getDb } from "../db/index.js";
import { getAppSetting, saveAppSetting } from "./appSettings.js";
import { getPagePostConfig, savePagePostConfig } from "./poster.js";
import { getSelectionGroups, resolveGroupToPageIds } from "./selectionGroups.js";

const SETTINGS_KEY = "media_vault_v1";

const DEFAULTS = Object.freeze({
  root: "F:\\FB-Media",
  auto_create_on_sync: false,
  auto_bind_on_sync: false,
  layout: "via_page",
});

function asBool(v, fallback = false) {
  if (v === true || v === 1 || v === "1" || v === "on" || v === "true") return true;
  if (v === false || v === 0 || v === "0" || v === "off" || v === "false") return false;
  return fallback;
}

export function getMediaVaultSettings() {
  const raw = getAppSetting(SETTINGS_KEY, {}) || {};
  const root = String(raw.root || DEFAULTS.root).trim() || DEFAULTS.root;
  return {
    root: path.resolve(root),
    auto_create_on_sync: asBool(raw.auto_create_on_sync, DEFAULTS.auto_create_on_sync),
    auto_bind_on_sync: asBool(raw.auto_bind_on_sync, DEFAULTS.auto_bind_on_sync),
    layout: String(raw.layout || DEFAULTS.layout) === "via_page" ? "via_page" : "via_page",
  };
}

export function saveMediaVaultSettings(input = {}) {
  const cur = getMediaVaultSettings();
  const next = {
    root: String(input.root != null ? input.root : cur.root).trim() || DEFAULTS.root,
    auto_create_on_sync: asBool(
      input.auto_create_on_sync != null ? input.auto_create_on_sync : cur.auto_create_on_sync,
      false
    ),
    auto_bind_on_sync: asBool(
      input.auto_bind_on_sync != null ? input.auto_bind_on_sync : cur.auto_bind_on_sync,
      false
    ),
    layout: "via_page",
  };
  saveAppSetting(SETTINGS_KEY, next);
  return getMediaVaultSettings();
}

/** Tên thư mục Windows-safe từ label via/token */
export function sanitizeFolderSegment(raw, fallback = "unknown") {
  let s = String(raw || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  // Windows reserved device names
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `${s}_dir`;
  s = s.slice(0, 80);
  return s || fallback;
}

function loadAccount(accountId) {
  return getDb().prepare(`SELECT * FROM fb_accounts WHERE id = ?`).get(Number(accountId));
}

function loadPage(pageRowId) {
  return getDb()
    .prepare(
      `SELECT p.id, p.page_id, p.name AS page_name, p.account_id, p.status,
              a.name AS account_name, a.fb_user_id, a.meta_app_key
       FROM fb_pages p
       JOIN fb_accounts a ON a.id = p.account_id
       WHERE p.id = ?`
    )
    .get(Number(pageRowId));
}

/**
 * Tên thư mục via: ưu tiên account.name; trùng tên với account khác → thêm _{id}.
 * viaByAccountId: cache 1 batch — CÙNG account luôn cùng 1 tên (tránh page 2 đổi folder).
 * usedNames: tên đã gán cho account khác trong batch (KHÔNG seed từ đĩa).
 */
export function viaFolderName(account, { usedNames, viaByAccountId } = {}) {
  const id = Number(account?.id) || 0;
  if (viaByAccountId instanceof Map && id && viaByAccountId.has(id)) {
    return viaByAccountId.get(id);
  }
  const base = sanitizeFolderSegment(
    account?.name || account?.account_name,
    id ? `account_${id}` : "account"
  );
  let name = base;
  const taken = usedNames instanceof Set ? usedNames : null;

  // Account khác (id nhỏ hơn) cùng base → thêm _{id} (ổn định, không phụ thuộc đĩa)
  if (id) {
    const rivals = getDb()
      .prepare(`SELECT id, name FROM fb_accounts WHERE id != ? AND status != 'deleted'`)
      .all(id);
    const clashOlder = rivals.some((r) => {
      const other = sanitizeFolderSegment(r.name, `account_${r.id}`).toLowerCase();
      return other === base.toLowerCase() && Number(r.id) < id;
    });
    if (clashOlder) name = sanitizeFolderSegment(`${base}_${id}`, `account_${id}`);
  }

  if (taken) {
    if (taken.has(name.toLowerCase())) {
      name = sanitizeFolderSegment(`${base}_${id}`, `account_${id}`);
    }
    let n = 2;
    while (taken.has(name.toLowerCase())) {
      name = sanitizeFolderSegment(`${base}_${id}_${n}`, `account_${id}_${n}`);
      n += 1;
    }
    taken.add(name.toLowerCase());
  }

  if (viaByAccountId instanceof Map && id) {
    viaByAccountId.set(id, name);
  }
  return name;
}

export function pathsForPage(pageOrIds, opts = {}) {
  const page =
    typeof pageOrIds === "object" && pageOrIds
      ? pageOrIds
      : loadPage(pageOrIds);
  if (!page?.page_id) throw new Error("Page không tồn tại");
  const account =
    opts.account ||
    (page.account_name != null
      ? {
          id: page.account_id,
          name: page.account_name,
          fb_user_id: page.fb_user_id,
        }
      : loadAccount(page.account_id));
  if (!account) throw new Error(`Thiếu account cho page ${page.page_id}`);
  const settings = opts.settings || getMediaVaultSettings();
  const via = viaFolderName(account, {
    usedNames: opts.usedNames,
    viaByAccountId: opts.viaByAccountId,
  });
  const pageSeg = sanitizeFolderSegment(page.page_id, String(page.page_id));
  let viaDir = path.join(settings.root, via);
  let pageDir = path.join(viaDir, pageSeg);
  let viaLabel = via;
  if (opts.groupName) {
    const g = sanitizeFolderSegment(opts.groupName, "nhom");
    viaLabel = `Nhom/${g}`;
    viaDir = path.join(settings.root, "Nhom", g);
    pageDir = path.join(viaDir, pageSeg);
  }
  const media = pageDir;
  const posted = path.join(pageDir, "posted");
  return {
    root: settings.root,
    via: viaLabel,
    viaDir,
    pageDir,
    media,
    posted,
    captions: null,
    page_row_id: Number(page.id) || null,
    page_id: String(page.page_id),
    page_name: page.page_name || page.name || null,
    account_id: Number(account.id),
    account_name: account.name || null,
  };
}

function assertUnderRoot(target, root) {
  const abs = path.resolve(target);
  const rootAbs = path.resolve(root);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (abs !== rootAbs && !abs.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error(`Path nằm ngoài kho media: ${abs}`);
  }
  return abs;
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolvePageRowIds({ page_row_ids, account_id, page_group_id, account_group_id } = {}) {
  let ids = Array.isArray(page_row_ids)
    ? page_row_ids.map(Number).filter((n) => n > 0)
    : [];
  if (!ids.length && (page_group_id || account_group_id)) {
    try {
      const resolved = resolveGroupToPageIds({ page_group_id, account_group_id });
      ids = Array.isArray(resolved?.page_row_ids) ? resolved.page_row_ids : [];
    } catch {
      ids = [];
    }
  }
  if (!ids.length && account_id) {
    ids = getDb()
      .prepare(
        `SELECT id FROM fb_pages WHERE account_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE`
      )
      .all(Number(account_id))
      .map((r) => Number(r.id));
  }
  return [...new Set(ids)];
}

/**
 * Tạo folder trên đĩa (chưa gắn config).
 */
export function ensurePageFolders(scope = {}) {
  const settings = getMediaVaultSettings();
  mkdirp(settings.root);
  const ids = resolvePageRowIds(scope);
  if (!ids.length) {
    return { ok: true, created: 0, existed: 0, pages: [], errors: [], root: settings.root };
  }

  const rows = [];
  const errors = [];
  for (const id of ids) {
    const row = loadPage(id);
    if (!row) errors.push({ page_row_id: id, error: "Page không tồn tại" });
    else rows.push(row);
  }

  // Gán tên via theo account id tăng dần — cùng account luôn 1 folder
  const viaByAccountId = new Map();
  const usedNames = new Set();
  const accountIds = [...new Set(rows.map((r) => Number(r.account_id)))].sort(
    (a, b) => a - b
  );
  for (const aid of accountIds) {
    const acc = loadAccount(aid);
    if (acc) viaFolderName(acc, { usedNames, viaByAccountId });
  }

  const pages = [];
  let created = 0;
  let existed = 0;

  let groupName = scope.group_name ? String(scope.group_name) : null;
  if (!groupName && scope.layout === "group" && scope.page_group_id) {
    const g = (getSelectionGroups().page_groups || []).find(
      (x) => String(x.id) === String(scope.page_group_id)
    );
    groupName = g?.name || String(scope.page_group_id);
  }

  for (const row of rows) {
    try {
      const paths = pathsForPage(row, {
        settings,
        usedNames,
        viaByAccountId,
        groupName: scope.layout === "group" ? groupName : null,
      });
      const hadPage = fs.existsSync(paths.pageDir);
      mkdirp(paths.media);
      mkdirp(paths.posted);
      if (hadPage) existed += 1;
      else created += 1;
      pages.push({
        page_row_id: Number(row.id),
        page_id: paths.page_id,
        page_name: paths.page_name,
        account_id: paths.account_id,
        via: paths.via,
        media: paths.media,
        posted: paths.posted,
        created: !hadPage,
      });
    } catch (e) {
      errors.push({ page_row_id: Number(row.id), error: e.message || String(e) });
    }
  }

  return {
    ok: errors.length === 0,
    created,
    existed,
    pages,
    errors,
    root: settings.root,
  };
}

/**
 * Gắn media_folder + posted_folder vào page_post_config.
 * Luôn ensure folder trước. overwrite=false: bỏ qua page đã có media_folder khác trống.
 */
export function bindPageFolders(scope = {}, { overwrite = true } = {}) {
  const ensured = ensurePageFolders(scope);
  const bound = [];
  const skipped = [];
  const errors = [...(ensured.errors || [])];

  for (const p of ensured.pages || []) {
    try {
      const cur = getPagePostConfig(p.page_row_id);
      const hasMedia = String(cur?.media_folder || "").trim();
      if (!overwrite && hasMedia) {
        skipped.push({
          page_row_id: p.page_row_id,
          reason: "đã có media_folder",
          media_folder: hasMedia,
        });
        continue;
      }
      savePagePostConfig(p.page_row_id, {
        media_folder: p.media,
        posted_folder: p.posted,
        // captions: để sau — không ghi đè nếu đang có
      });
      bound.push({
        page_row_id: p.page_row_id,
        page_id: p.page_id,
        media_folder: p.media,
        posted_folder: p.posted,
      });
    } catch (e) {
      errors.push({ page_row_id: p.page_row_id, error: e.message || String(e) });
    }
  }

  return {
    ok: errors.length === 0,
    bound: bound.length,
    skipped: skipped.length,
    pages: bound,
    skipped_pages: skipped,
    errors,
    ensured,
  };
}

export function listVaultTree() {
  const settings = getMediaVaultSettings();
  const accounts = getDb()
    .prepare(
      `SELECT id, name, fb_user_id, meta_app_key, page_count, status
       FROM fb_accounts
       WHERE status != 'deleted'
       ORDER BY id ASC`
    )
    .all();
  const usedNames = new Set();
  const viaByAccountId = new Map();
  for (const acc of accounts) {
    viaFolderName(acc, { usedNames, viaByAccountId });
  }

  const vias = [];
  // Hiển thị theo tên via
  const sorted = [...accounts].sort((a, b) =>
    String(viaByAccountId.get(a.id) || a.name || "").localeCompare(
      String(viaByAccountId.get(b.id) || b.name || ""),
      undefined,
      { sensitivity: "base" }
    )
  );
  for (const acc of sorted) {
    const via = viaByAccountId.get(acc.id) || viaFolderName(acc);
    const viaDir = path.join(settings.root, via);
    const pages = getDb()
      .prepare(
        `SELECT id, page_id, name, status FROM fb_pages
         WHERE account_id = ? AND status = 'active'
         ORDER BY name COLLATE NOCASE`
      )
      .all(acc.id)
      .map((p) => {
        const pageDir = path.join(viaDir, sanitizeFolderSegment(p.page_id, p.page_id));
        const postedDir = path.join(pageDir, "posted");
        let mediaCount = 0;
        try {
          if (fs.existsSync(pageDir)) {
            mediaCount = fs
              .readdirSync(pageDir)
              .filter((f) => {
                try {
                  return fs.statSync(path.join(pageDir, f)).isFile();
                } catch {
                  return false;
                }
              }).length;
          }
        } catch {
          mediaCount = 0;
        }
        return {
          page_row_id: p.id,
          page_id: p.page_id,
          name: p.name,
          page_dir: pageDir,
          media: pageDir,
          posted: postedDir,
          exists: fs.existsSync(pageDir),
          media_files: mediaCount,
        };
      });
    vias.push({
      account_id: acc.id,
      account_name: acc.name,
      meta_app_key: acc.meta_app_key,
      via,
      via_dir: viaDir,
      exists: fs.existsSync(viaDir),
      pages,
    });
  }
  return { ok: true, root: settings.root, settings, vias };
}

function rmDirRecursive(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function deleteVaultForPages(pageRowIds = [], { dryRun = false } = {}) {
  const settings = getMediaVaultSettings();
  const ids = [...new Set((pageRowIds || []).map(Number).filter((n) => n > 0))];
  const removed = [];
  const missing = [];
  const errors = [];
  for (const id of ids) {
    try {
      const row = loadPage(id);
      if (!row) {
        missing.push(id);
        continue;
      }
      const paths = pathsForPage(row, { settings });
      assertUnderRoot(paths.pageDir, settings.root);
      if (!fs.existsSync(paths.pageDir)) {
        missing.push(id);
        continue;
      }
      if (!dryRun) rmDirRecursive(paths.pageDir);
      removed.push({ page_row_id: id, page_dir: paths.pageDir });
    } catch (e) {
      errors.push({ page_row_id: id, error: e.message || String(e) });
    }
  }
  return { ok: errors.length === 0, dryRun, removed, missing, errors, root: settings.root };
}

export function deleteVaultForAccount(accountId, { dryRun = false } = {}) {
  const settings = getMediaVaultSettings();
  const acc = loadAccount(accountId);
  if (!acc) throw new Error("Account không tồn tại");
  // Tên deterministic (không seed đĩa) — tránh xóa nhầm / bỏ sót folder
  const via = viaFolderName(acc);
  const viaDir = path.join(settings.root, via);
  assertUnderRoot(viaDir, settings.root);
  const candidates = [viaDir];
  // Fallback: bản cũ từng bị đổi tên _{id} do bug seed đĩa
  const base = sanitizeFolderSegment(acc.name, `account_${acc.id}`);
  const alt = path.join(
    settings.root,
    sanitizeFolderSegment(`${base}_${acc.id}`, `account_${acc.id}`)
  );
  if (alt.toLowerCase() !== viaDir.toLowerCase()) candidates.push(alt);

  const removedDirs = [];
  for (const dir of candidates) {
    try {
      assertUnderRoot(dir, settings.root);
      if (!fs.existsSync(dir)) continue;
      if (!dryRun) rmDirRecursive(dir);
      removedDirs.push(dir);
    } catch (e) {
      return {
        ok: false,
        dryRun,
        account_id: Number(accountId),
        via,
        via_dir: viaDir,
        removed: false,
        error: e.message || String(e),
        root: settings.root,
      };
    }
  }
  return {
    ok: true,
    dryRun,
    account_id: Number(accountId),
    via,
    via_dir: viaDir,
    removed: removedDirs.length > 0,
    removed_dirs: removedDirs,
    root: settings.root,
  };
}

/** Gọi sau sync/import nếu bật auto_create_on_sync */
export function maybeAutoCreateAfterSync(accountId) {
  const s = getMediaVaultSettings();
  if (!s.auto_create_on_sync) {
    return { skipped: true, reason: "auto_create_on_sync=off" };
  }
  const ensured = ensurePageFolders({ account_id: Number(accountId) });
  let bound = null;
  if (s.auto_bind_on_sync) {
    bound = bindPageFolders({ account_id: Number(accountId) }, { overwrite: false });
  }
  return { skipped: false, ensured, bound };
}
