/**
 * One video/photo inbox per Facebook user token, per token list, and per page group.
 * A run may mix tokens and page groups that are on (own folder) with ones that are off
 * (shared folder, only after Áp dụng). Two different folders for the same page is an error.
 */
import fs from "fs";
import path from "path";
import { getDb } from "../db/index.js";
import { getSelectionGroups, upsertAccountGroup, upsertPageGroup } from "./selectionGroups.js";
import { savePagePostConfig } from "./poster.js";

export function cleanMediaPath(value) {
  const s = String(value || "")
    .replace(/[\u0000\r\n]/g, "")
    .trim()
    .slice(0, 400);
  if (!s) return "";
  return s.replace(/[\\/]+$/g, "") || s;
}

export function sameMediaPath(a, b) {
  const left = cleanMediaPath(a);
  const right = cleanMediaPath(b);
  if (!left || !right) return false;
  try {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  } catch {
    return left.toLowerCase() === right.toLowerCase();
  }
}

export function postedBeside(mediaFolder, postedFolder) {
  const posted = cleanMediaPath(postedFolder);
  if (posted) return posted;
  const media = cleanMediaPath(mediaFolder);
  if (!media) return "";
  return path.join(media, "posted");
}

/**
 * @param {{ id?: string, name?: string, media_folder?: string, posted_folder?: string }[]} lists
 * lists = selected token lists that contain this token
 * @returns {{ source: "list"|"token"|"page", media_folder: string, posted_folder: string, list_name?: string, error?: string }}
 */
export function pickMediaSource({ lists = [], tokenFolder = "", tokenPosted = "", tokenName = "", pageFolder = "" } = {}) {
  const named = String(tokenName || "token").trim() || "token";
  const withFolder = (Array.isArray(lists) ? lists : []).filter((list) =>
    cleanMediaPath(list?.media_folder)
  );
  const unique = [];
  for (const list of withFolder) {
    if (!unique.some((item) => sameMediaPath(item.media_folder, list.media_folder))) {
      unique.push(list);
    }
  }
  if (unique.length > 1) {
    const detail = unique
      .map((list) => `${list.name || list.id} (${cleanMediaPath(list.media_folder)})`)
      .join(" · ");
    return {
      source: "list",
      media_folder: "",
      posted_folder: "",
      error: `Token «${named}» đang ở ${unique.length} list đã chọn, mỗi list một ổ khác nhau: ${detail}. Bỏ bớt list, hoặc đặt cùng một ổ.`,
    };
  }
  if (unique.length === 1) {
    const list = unique[0];
    const media = cleanMediaPath(list.media_folder);
    return {
      source: "list",
      media_folder: media,
      posted_folder: postedBeside(media, list.posted_folder),
      list_name: list.name || "",
    };
  }
  const tokenMedia = cleanMediaPath(tokenFolder);
  if (tokenMedia) {
    return {
      source: "token",
      media_folder: tokenMedia,
      posted_folder: postedBeside(tokenMedia, tokenPosted),
    };
  }
  return {
    source: "page",
    media_folder: cleanMediaPath(pageFolder),
    posted_folder: "",
  };
}

function groupLabel(group) {
  return String(group?.name || group?.id || "nhóm").trim() || "nhóm";
}

/**
 * Folder for one page in this run.
 * Token switch off and no page-group switch on → leave the page folder alone.
 * Both on with the same path → that path. Different paths → error, no write.
 * @returns {{ chosen: { media_folder: string, posted_folder: string }|null, tokenMissing: boolean, missingGroups: string[], error?: string, code?: string }}
 */
export function resolvePageRunFolder({
  pageName = "page",
  tokenName = "token",
  tokenOn = false,
  tokenFolder = "",
  tokenPosted = "",
  lists = [],
  ownGroups = [],
} = {}) {
  const pageLabel = String(pageName || "page").trim() || "page";
  const tokenLabel = String(tokenName || "token").trim() || "token";
  let tokenPick = null;
  let tokenMissing = false;
  if (tokenOn) {
    const picked = pickMediaSource({
      lists,
      tokenFolder,
      tokenPosted,
      tokenName: tokenLabel,
    });
    if (picked.error) return { chosen: null, tokenMissing: false, missingGroups: [], error: picked.error, code: "MEDIA_LIST_CONFLICT" };
    if (picked.source === "page" || !picked.media_folder) tokenMissing = true;
    else {
      tokenPick = { media_folder: picked.media_folder, posted_folder: picked.posted_folder };
    }
  }
  const groups = Array.isArray(ownGroups) ? ownGroups : [];
  const withFolder = groups.filter((group) => cleanMediaPath(group?.media_folder));
  const unique = [];
  for (const group of withFolder) {
    if (!unique.some((item) => sameMediaPath(item.media_folder, group.media_folder))) unique.push(group);
  }
  if (unique.length > 1) {
    const detail = unique
      .map((group) => `${groupLabel(group)} (${cleanMediaPath(group.media_folder)})`)
      .join(" · ");
    return {
      chosen: null,
      tokenMissing,
      missingGroups: [],
      error: `Page «${pageLabel}» đang ở ${unique.length} nhóm đang bật, mỗi nhóm một ổ khác nhau: ${detail}. Tắt bớt nhóm, hoặc đặt cùng một ổ.`,
      code: "MEDIA_PAGE_GROUP_CONFLICT",
    };
  }
  const missingGroups = groups
    .filter((group) => !cleanMediaPath(group?.media_folder))
    .map((group) => groupLabel(group));
  let groupPick = null;
  if (unique.length === 1) {
    const group = unique[0];
    const media = cleanMediaPath(group.media_folder);
    groupPick = {
      media_folder: media,
      posted_folder: postedBeside(media, group.posted_folder),
      group_name: groupLabel(group),
    };
    const postedClash = withFolder.some(
      (item) => !sameMediaPath(postedBeside(media, item.posted_folder), groupPick.posted_folder)
    );
    if (postedClash) {
      return {
        chosen: null,
        tokenMissing,
        missingGroups,
        error: `Page «${pageLabel}» đang ở nhiều nhóm đang bật nhưng kho đã đăng khác nhau. Đặt cùng một ổ.`,
        code: "MEDIA_PAGE_GROUP_CONFLICT",
      };
    }
  }
  if (tokenPick && groupPick) {
    const same =
      sameMediaPath(tokenPick.media_folder, groupPick.media_folder) &&
      sameMediaPath(tokenPick.posted_folder, groupPick.posted_folder);
    if (!same) {
      return {
        chosen: null,
        tokenMissing,
        missingGroups,
        error: `Page «${pageLabel}»: token «${tokenLabel}» và nhóm «${groupPick.group_name}» đang bật hai ổ khác nhau. Tắt một bên, hoặc đặt cùng một ổ.`,
        code: "MEDIA_FOLDER_CONFLICT",
      };
    }
  }
  if (tokenMissing || missingGroups.length) {
    return { chosen: null, tokenMissing, missingGroups };
  }
  return { chosen: tokenPick || groupPick, tokenMissing: false, missingGroups: [] };
}

function pageRows(pageRowIds) {
  const ids = [...new Set((pageRowIds || []).map(Number).filter((id) => id > 0))];
  if (!ids.length) return [];
  return getDb()
    .prepare(
      `SELECT p.id, p.account_id, p.name AS page_name, a.name AS account_name,
              a.media_folder AS token_media, a.posted_folder AS token_posted,
              a.use_own_media AS use_own_media
       FROM fb_pages p
       JOIN fb_accounts a ON a.id = p.account_id
       WHERE p.status = 'active' AND p.id IN (${ids.map(() => "?").join(",")})`
    )
    .all(...ids);
}

function ensurePostedDir(mediaFolder, postedFolder) {
  const media = cleanMediaPath(mediaFolder);
  const posted = cleanMediaPath(postedFolder);
  if (!media || !posted) return;
  try {
    if (fs.existsSync(media) && fs.statSync(media).isDirectory()) {
      fs.mkdirSync(posted, { recursive: true });
    }
  } catch {
    /* drive can be unplugged; the path is still saved */
  }
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function activePageIdsForAccounts(accountIds) {
  const ids = [...new Set(asList(accountIds).map(Number).filter((id) => id > 0))];
  if (!ids.length) return [];
  return getDb()
    .prepare(
      `SELECT id FROM fb_pages WHERE status = 'active' AND account_id IN (${ids.map(() => "?").join(",")})`
    )
    .all(...ids)
    .map((row) => Number(row.id))
    .filter((id) => id > 0);
}

/**
 * Tokens and page groups with the switch on use their installed inbox
 * (a selected list inbox still wins over that token's own inbox).
 * Switches that are off keep the folder already on the page — the shared
 * inbox, after Áp dụng ổ chung. One run can contain both.
 * An empty page list (rotation «all pages») still applies to pages of the selected lists.
 * A page whose token and page group are both on must resolve to the same folder.
 */
export function applyRunMedia(pageRowIds, accountGroupIds) {
  const selection = getSelectionGroups();
  const groupIds = [...new Set(asList(accountGroupIds).map(String).filter(Boolean))];
  const groups = groupIds.length
    ? (selection.account_groups || []).filter((group) => groupIds.includes(group.id))
    : [];
  const pageGroups = selection.page_groups || [];
  let targetIds = [...new Set(asList(pageRowIds).map(Number).filter((id) => id > 0))];
  if (!targetIds.length) {
    if (!groups.length) return { applied: 0, folders: [] };
    targetIds = activePageIdsForAccounts(groups.flatMap((group) => group.account_ids || []));
  }
  if (!targetIds.length) return { applied: 0, folders: [] };
  const pages = pageRows(targetIds);
  const updates = [];
  const missingTokens = [];
  const missingGroups = [];
  for (const page of pages) {
    const tokenOn = Number(page.use_own_media) === 1;
    const lists = tokenOn
      ? groups.filter((group) =>
          (group.account_ids || []).map(Number).includes(Number(page.account_id))
        )
      : [];
    const ownGroups = pageGroups
      .filter(
        (group) =>
          Number(group.use_own_media) === 1 &&
          (group.page_row_ids || []).map(Number).includes(Number(page.id))
      )
      .map((group) => ({
        id: group.id,
        name: group.name,
        media_folder: group.media_folder,
        posted_folder: group.posted_folder,
      }));
    const resolved = resolvePageRunFolder({
      pageName: page.page_name,
      tokenName: page.account_name,
      tokenOn,
      tokenFolder: page.token_media,
      tokenPosted: page.token_posted,
      lists,
      ownGroups,
    });
    if (resolved.error) {
      const err = new Error(resolved.error);
      err.code = resolved.code || "MEDIA_FOLDER_CONFLICT";
      throw err;
    }
    if (resolved.tokenMissing) {
      const name = String(page.account_name || page.page_name || "token").trim() || "token";
      if (!missingTokens.includes(name)) missingTokens.push(name);
    }
    for (const name of resolved.missingGroups || []) {
      if (!missingGroups.includes(name)) missingGroups.push(name);
    }
    if (!resolved.chosen) continue;
    updates.push({
      page_row_id: Number(page.id),
      media_folder: resolved.chosen.media_folder,
      posted_folder: resolved.chosen.posted_folder,
    });
  }
  if (missingTokens.length || missingGroups.length) {
    const parts = [];
    if (missingTokens.length) {
      parts.push(`Token đang bật nhưng chưa có ổ: ${missingTokens.join(", ")}`);
    }
    if (missingGroups.length) {
      parts.push(`Nhóm page đang bật nhưng chưa có ổ: ${missingGroups.join(", ")}`);
    }
    const err = new Error(`${parts.join(". ")}. Cài ổ rồi bật lại.`);
    err.code = missingTokens.length ? "MEDIA_TOKEN_MISSING" : "MEDIA_PAGE_GROUP_MISSING";
    throw err;
  }
  for (const row of updates) {
    savePagePostConfig(row.page_row_id, {
      media_folder: row.media_folder,
      posted_folder: row.posted_folder,
    });
    ensurePostedDir(row.media_folder, row.posted_folder);
  }
  const folders = [];
  for (const row of updates) {
    if (!folders.some((folder) => sameMediaPath(folder, row.media_folder))) {
      folders.push(row.media_folder);
    }
  }
  return { applied: updates.length, folders };
}

function accountPages(accountId) {
  return getDb()
    .prepare(`SELECT id FROM fb_pages WHERE status = 'active' AND account_id = ?`)
    .all(accountId);
}

function writePagesFolder(pages, mediaFolder, postedFolder) {
  for (const page of pages) {
    savePagePostConfig(page.id, { media_folder: mediaFolder, posted_folder: postedFolder });
  }
  ensurePostedDir(mediaFolder, postedFolder);
}

/**
 * Refuse to stamp a folder when another switched-on token or page group
 * already owns a different folder for the same page. exceptAccountId skips
 * the token being installed. exceptGroupId skips the group being installed.
 */
function assertSharedFolderOk(pageRowIds, mediaFolder, { exceptGroupId = null, exceptAccountId = null } = {}) {
  const media = cleanMediaPath(mediaFolder);
  if (!media) return;
  const pages = pageRows(pageRowIds);
  const others = (getSelectionGroups().page_groups || []).filter(
    (group) => String(group.id) !== String(exceptGroupId || "") && Number(group.use_own_media) === 1
  );
  for (const page of pages) {
    const skipToken = exceptAccountId != null && Number(page.account_id) === Number(exceptAccountId);
    if (!skipToken && Number(page.use_own_media) === 1) {
      const tokenMedia = cleanMediaPath(page.token_media);
      const tokenLabel = String(page.account_name || "token").trim() || "token";
      if (!tokenMedia) {
        const err = new Error(
          `Token «${tokenLabel}» đang bật nhưng chưa có ổ. Cài ổ token hoặc tắt token trước.`
        );
        err.code = "MEDIA_TOKEN_MISSING";
        throw err;
      }
      if (!sameMediaPath(tokenMedia, media)) {
        const err = new Error(
          `Page «${page.page_name || page.id}»: token «${tokenLabel}» đang bật ổ khác. Tắt một bên, hoặc đặt cùng một ổ.`
        );
        err.code = "MEDIA_FOLDER_CONFLICT";
        throw err;
      }
    }
    for (const group of others) {
      const member = (group.page_row_ids || []).map(Number).includes(Number(page.id));
      if (!member) continue;
      const other = cleanMediaPath(group.media_folder);
      const label = groupLabel(group);
      if (!other || !sameMediaPath(other, media)) {
        const err = new Error(
          `Page «${page.page_name || page.id}» đang ở nhóm «${label}» đang bật ổ khác. Tắt một bên, hoặc đặt cùng một ổ.`
        );
        err.code = "MEDIA_PAGE_GROUP_CONFLICT";
        throw err;
      }
    }
  }
}

function writeAccountFolder(accountId, mediaFolder, postedFolder) {
  const id = Number(accountId);
  if (!id) throw new Error("Thiếu token");
  const media = cleanMediaPath(mediaFolder);
  if (!media) throw new Error("Chọn ổ media (ảnh/video) trước");
  const posted = postedBeside(media, postedFolder);
  const db = getDb();
  const account = db
    .prepare(`SELECT id, name, use_own_media FROM fb_accounts WHERE id = ?`)
    .get(id);
  if (!account) throw new Error("Không thấy token");
  const pages = accountPages(id);
  const own = Number(account.use_own_media) === 1;
  if (own) assertSharedFolderOk(pages.map((page) => page.id), media, { exceptAccountId: id });
  db.prepare(
    `UPDATE fb_accounts SET media_folder = ?, posted_folder = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(media, posted, id);
  if (own) writePagesFolder(pages, media, posted);
  return {
    account_id: id,
    account_name: account.name || "",
    media_folder: media,
    posted_folder: posted,
    use_own_media: own ? 1 : 0,
    pages: own ? pages.length : 0,
  };
}

/** Switch one token between its own inbox and the shared inbox. */
export function setTokenMediaEnabled(accountId, enabled) {
  const id = Number(accountId);
  if (!id) throw new Error("Thiếu token");
  const on =
    enabled === true || enabled === 1 || enabled === "1" || enabled === "true";
  const db = getDb();
  const account = db
    .prepare(`SELECT id, name, media_folder, posted_folder FROM fb_accounts WHERE id = ?`)
    .get(id);
  if (!account) throw new Error("Không thấy token");
  const media = cleanMediaPath(account.media_folder);
  if (on && !media) throw new Error("Cài ổ ảnh/video cho token này trước khi bật");
  const pages = accountPages(id);
  if (on) assertSharedFolderOk(pages.map((page) => page.id), media, { exceptAccountId: id });
  db.prepare(
    `UPDATE fb_accounts SET use_own_media = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(on ? 1 : 0, id);
  if (on) writePagesFolder(pages, media, postedBeside(media, account.posted_folder));
  return {
    account_id: id,
    account_name: account.name || "",
    use_own_media: on ? 1 : 0,
    media_folder: media,
    pages: pages.length,
  };
}

export function installTokenMedia(accountId, mediaFolder, postedFolder) {
  return writeAccountFolder(accountId, mediaFolder, postedFolder);
}

export function installListMedia(accountGroupId, mediaFolder, postedFolder) {
  const media = cleanMediaPath(mediaFolder);
  if (!media) throw new Error("Chọn ổ media cho list trước");
  const known = getSelectionGroups().account_groups.find(
    (group) => group.id === String(accountGroupId || "")
  );
  if (!known) throw new Error("Không thấy list token");
  const posted = postedBeside(media, postedFolder);
  for (const accountId of known.account_ids || []) {
    const account = getDb()
      .prepare(`SELECT id, use_own_media FROM fb_accounts WHERE id = ?`)
      .get(Number(accountId));
    if (!account || Number(account.use_own_media) !== 1) continue;
    const pages = accountPages(account.id);
    assertSharedFolderOk(pages.map((page) => page.id), media, { exceptAccountId: account.id });
  }
  const data = upsertAccountGroup({
    id: String(accountGroupId || ""),
    media_folder: media,
    posted_folder: posted,
  });
  const group = (data.account_groups || []).find((item) => item.id === String(accountGroupId));
  if (!group) throw new Error("Không thấy list token");
  const tokens = [];
  for (const accountId of group.account_ids || []) {
    tokens.push(writeAccountFolder(accountId, media, posted));
  }
  return {
    group_id: group.id,
    group_name: group.name,
    media_folder: media,
    posted_folder: posted,
    tokens: tokens.length,
    pages: tokens.reduce((sum, token) => sum + token.pages, 0),
  };
}

function onFlag(enabled) {
  return enabled === true || enabled === 1 || enabled === "1" || enabled === "true";
}

function requirePageGroup(pageGroupId) {
  const id = String(pageGroupId || "");
  if (!id) throw new Error("Thiếu nhóm page");
  const group = getSelectionGroups().page_groups.find((item) => item.id === id);
  if (!group) throw new Error("Không thấy nhóm page");
  return group;
}

/** Save a page group's inbox. Pages change only while that group's switch is on. */
export function installPageGroupMedia(pageGroupId, mediaFolder, postedFolder) {
  const media = cleanMediaPath(mediaFolder);
  if (!media) throw new Error("Chọn ổ media cho nhóm page trước");
  const known = requirePageGroup(pageGroupId);
  const posted = postedBeside(media, postedFolder);
  const own = Number(known.use_own_media) === 1;
  if (own) {
    assertSharedFolderOk(known.page_row_ids || [], media, { exceptGroupId: known.id });
  }
  const data = upsertPageGroup({
    id: known.id,
    media_folder: media,
    posted_folder: posted,
  });
  const group = (data.page_groups || []).find((item) => item.id === known.id);
  if (!group) throw new Error("Không thấy nhóm page");
  let pages = 0;
  if (Number(group.use_own_media) === 1) {
    writePagesFolder((group.page_row_ids || []).map((pid) => ({ id: pid })), media, posted);
    pages = (group.page_row_ids || []).length;
  }
  return {
    group_id: group.id,
    group_name: group.name,
    media_folder: media,
    posted_folder: posted,
    use_own_media: Number(group.use_own_media) === 1 ? 1 : 0,
    pages,
  };
}

/** On writes the group folder onto its pages. Off does not rewrite pages. */
export function setPageGroupMediaEnabled(pageGroupId, enabled) {
  const known = requirePageGroup(pageGroupId);
  const on = onFlag(enabled);
  const media = cleanMediaPath(known.media_folder);
  if (on && !media) throw new Error("Cài ổ ảnh/video cho nhóm này trước khi bật");
  if (on) assertSharedFolderOk(known.page_row_ids || [], media, { exceptGroupId: known.id });
  const data = upsertPageGroup({ id: known.id, use_own_media: on ? 1 : 0 });
  const group = (data.page_groups || []).find((item) => item.id === known.id);
  if (!group) throw new Error("Không thấy nhóm page");
  const members = group.page_row_ids || [];
  if (on) {
    writePagesFolder(
      members.map((pid) => ({ id: pid })),
      media,
      postedBeside(media, group.posted_folder)
    );
  }
  return {
    group_id: group.id,
    group_name: group.name,
    use_own_media: on ? 1 : 0,
    media_folder: media,
    pages: members.length,
  };
}

/** Add ticked pages to an existing group. Members already there stay. */
export function addPagesToPageGroup(pageGroupId, pageRowIds) {
  const known = requirePageGroup(pageGroupId);
  const incoming = [...new Set(asList(pageRowIds).map(Number).filter((id) => id > 0))];
  if (!incoming.length) throw new Error("Tick ít nhất 1 page");
  const found = pageRows(incoming);
  if (!found.length) throw new Error("Không thấy page đang tick");
  const media = cleanMediaPath(known.media_folder);
  const own = Number(known.use_own_media) === 1;
  if (own && !media) throw new Error("Nhóm đang bật nhưng chưa có ổ. Cài ổ rồi thêm page.");
  if (own) {
    const union = [...new Set([...(known.page_row_ids || []).map(Number), ...found.map((page) => page.id)])];
    assertSharedFolderOk(union, media, { exceptGroupId: known.id });
  }
  const before = new Set((known.page_row_ids || []).map(Number));
  const data = upsertPageGroup({
    id: known.id,
    page_row_ids: found.map((page) => page.id),
    merge_pages: true,
  });
  const group = (data.page_groups || []).find((item) => item.id === known.id);
  if (!group) throw new Error("Không thấy nhóm page");
  let written = 0;
  const folder = cleanMediaPath(group.media_folder);
  if (Number(group.use_own_media) === 1 && folder) {
    writePagesFolder(
      (group.page_row_ids || []).map((pid) => ({ id: pid })),
      folder,
      postedBeside(folder, group.posted_folder)
    );
    written = (group.page_row_ids || []).length;
  }
  const added = (group.page_row_ids || []).filter((pid) => !before.has(Number(pid))).length;
  return {
    group_id: group.id,
    group_name: group.name,
    added,
    pages: (group.page_row_ids || []).length,
    use_own_media: Number(group.use_own_media) === 1 ? 1 : 0,
    written,
  };
}
