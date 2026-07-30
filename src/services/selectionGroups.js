/**
 * Custom account groups + page groups for posting selection.
 * Stored in app_settings (survives restarts / EXE update).
 */
import { getDb } from "../db/index.js";
import { getAppSetting, saveAppSetting } from "./appSettings.js";

const KEY = "posting_selection_groups_v1";

const EMPTY = Object.freeze({
  account_groups: [],
  page_groups: [],
});

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function cleanName(name, fallback) {
  const s = String(name || "")
    .replace(/[\r\n]/g, " ")
    .trim()
    .slice(0, 80);
  return s || fallback;
}

function activeAccountIds() {
  return new Set(
    getDb()
      .prepare(`SELECT id FROM fb_accounts`)
      .all()
      .map((r) => Number(r.id))
      .filter((id) => id > 0)
  );
}

function activePageIds() {
  return new Set(
    getDb()
      .prepare(`SELECT id FROM fb_pages WHERE status = 'active'`)
      .all()
      .map((r) => Number(r.id))
      .filter((id) => id > 0)
  );
}

function normalizeAccountGroup(g, validAccounts) {
  if (!g || typeof g !== "object") return null;
  const account_ids = [
    ...new Set(
      (Array.isArray(g.account_ids) ? g.account_ids : [])
        .map(Number)
        .filter((id) => id > 0 && validAccounts.has(id))
    ),
  ];
  return {
    id: String(g.id || uid("acc")).slice(0, 64),
    name: cleanName(g.name, "Nhóm tài khoản"),
    account_ids,
    color: String(g.color || "").slice(0, 20) || null,
    updated_at: g.updated_at || new Date().toISOString(),
  };
}

function normalizePageGroup(g, validPages) {
  if (!g || typeof g !== "object") return null;
  const page_row_ids = [
    ...new Set(
      (Array.isArray(g.page_row_ids) ? g.page_row_ids : Array.isArray(g.page_ids) ? g.page_ids : [])
        .map(Number)
        .filter((id) => id > 0 && validPages.has(id))
    ),
  ];
  return {
    id: String(g.id || uid("pg")).slice(0, 64),
    name: cleanName(g.name, "Nhóm page"),
    page_row_ids,
    color: String(g.color || "").slice(0, 20) || null,
    updated_at: g.updated_at || new Date().toISOString(),
  };
}

export function getSelectionGroups() {
  const raw = getAppSetting(KEY, EMPTY) || EMPTY;
  const validAccounts = activeAccountIds();
  const validPages = activePageIds();
  const account_groups = (Array.isArray(raw.account_groups) ? raw.account_groups : [])
    .map((g) => normalizeAccountGroup(g, validAccounts))
    .filter(Boolean)
    .slice(0, 80);
  const page_groups = (Array.isArray(raw.page_groups) ? raw.page_groups : [])
    .map((g) => normalizePageGroup(g, validPages))
    .filter(Boolean)
    .slice(0, 80);
  return { account_groups, page_groups };
}

export function saveSelectionGroups(input = {}) {
  const validAccounts = activeAccountIds();
  const validPages = activePageIds();
  const account_groups = (Array.isArray(input.account_groups) ? input.account_groups : [])
    .map((g) => normalizeAccountGroup(g, validAccounts))
    .filter(Boolean)
    .slice(0, 80);
  const page_groups = (Array.isArray(input.page_groups) ? input.page_groups : [])
    .map((g) => normalizePageGroup(g, validPages))
    .filter(Boolean)
    .slice(0, 80);
  const next = { account_groups, page_groups };
  saveAppSetting(KEY, next);
  return next;
}

/** Upsert one account group by id (or create). */
export function upsertAccountGroup(body = {}) {
  const data = getSelectionGroups();
  const validAccounts = activeAccountIds();
  const id = body.id ? String(body.id) : uid("acc");
  const group = normalizeAccountGroup(
    {
      ...body,
      id,
      updated_at: new Date().toISOString(),
    },
    validAccounts
  );
  if (!group) throw new Error("Nhóm tài khoản không hợp lệ");
  if (!group.account_ids.length && body.require_members !== false) {
    // allow empty while building, but warn via name only
  }
  const idx = data.account_groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) data.account_groups[idx] = group;
  else data.account_groups.push(group);
  return saveSelectionGroups(data);
}

export function upsertPageGroup(body = {}) {
  const data = getSelectionGroups();
  const validPages = activePageIds();
  const id = body.id ? String(body.id) : uid("pg");
  const group = normalizePageGroup(
    {
      ...body,
      id,
      updated_at: new Date().toISOString(),
    },
    validPages
  );
  if (!group) throw new Error("Nhóm page không hợp lệ");
  const idx = data.page_groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) data.page_groups[idx] = group;
  else data.page_groups.push(group);
  return saveSelectionGroups(data);
}

export function deleteAccountGroup(id) {
  const data = getSelectionGroups();
  data.account_groups = data.account_groups.filter((g) => g.id !== String(id));
  return saveSelectionGroups(data);
}

export function deletePageGroup(id) {
  const data = getSelectionGroups();
  data.page_groups = data.page_groups.filter((g) => g.id !== String(id));
  return saveSelectionGroups(data);
}

/** Expand groups → page_row_ids for selection. */
export function resolveGroupToPageIds({ account_group_id, page_group_id } = {}) {
  const data = getSelectionGroups();
  if (page_group_id) {
    const g = data.page_groups.find((x) => x.id === String(page_group_id));
    return {
      kind: "page_group",
      group: g || null,
      page_row_ids: g ? [...g.page_row_ids] : [],
    };
  }
  if (account_group_id) {
    const g = data.account_groups.find((x) => x.id === String(account_group_id));
    if (!g) return { kind: "account_group", group: null, page_row_ids: [] };
    const placeholders = g.account_ids.map(() => "?").join(",");
    if (!placeholders) return { kind: "account_group", group: g, page_row_ids: [] };
    const rows = getDb()
      .prepare(
        `SELECT id FROM fb_pages WHERE status = 'active' AND account_id IN (${placeholders})`
      )
      .all(...g.account_ids);
    return {
      kind: "account_group",
      group: g,
      page_row_ids: rows.map((r) => Number(r.id)),
    };
  }
  return { kind: null, group: null, page_row_ids: [] };
}
