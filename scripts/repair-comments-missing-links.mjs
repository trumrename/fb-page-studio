/**
 * Sửa comment đã gửi thiếu URL:
 * - Tìm post_logs: có comment_text, không có http, có comment_id
 * - Lấy link từ kho page (comment_links / caption_lead_links)
 * - Cập nhật comment trên Graph (POST /{comment-id}) hoặc xóa + gửi comment mới
 * - Cập nhật comment_text local
 *
 * Chạy bằng Electron (better-sqlite3 native):
 *   set ELECTRON_RUN_AS_NODE=1
 *   "C:\Program Files\FB Page Studio\FB Page Studio.exe" scripts/repair-comments-missing-links.mjs
 *
 * Options:
 *   --dry-run   chỉ liệt kê
 *   --limit=N   tối đa N bản ghi
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Ensure data dir = desktop app data when run under Electron
if (!process.env.FBPS_DATA_DIR && process.env.APPDATA) {
  process.env.FBPS_DATA_DIR = path.join(
    process.env.APPDATA,
    "fb-page-studio",
    "data"
  );
}

const { getDb } = await import(pathToFileURL(path.join(root, "src/db/index.js")).href);
const { decryptToken } = await import(
  pathToFileURL(path.join(root, "src/services/crypto.js")).href
);
const { getPagePostConfig } = await import(
  pathToFileURL(path.join(root, "src/services/poster.js")).href
);
const { getCommentLinkPool, assignCommentForPost } = await import(
  pathToFileURL(path.join(root, "src/services/mediaLibrary.js")).href
);
const { graphBase } = await import(pathToFileURL(path.join(root, "src/config.js")).href);
const {
  appsecretProof,
  isInvalidAppSecretProofError,
  resolveAppSecret,
} = await import(pathToFileURL(path.join(root, "src/services/facebook.js")).href);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 200) : 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function graphPost(urlPath, pageToken, body) {
  const tryOnce = async (withProof) => {
    const url = new URL(`${graphBase()}${urlPath}`);
    url.searchParams.set("access_token", pageToken);
    if (withProof) {
      const secret = resolveAppSecret("", "");
      const proof = appsecretProof(pageToken, secret);
      if (proof) url.searchParams.set("appsecret_proof", proof);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  let data = await tryOnce(true);
  if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
    data = await tryOnce(false);
  }
  return data;
}

async function graphDelete(urlPath, pageToken) {
  const tryOnce = async (withProof) => {
    const url = new URL(`${graphBase()}${urlPath}`);
    url.searchParams.set("access_token", pageToken);
    if (withProof) {
      const secret = resolveAppSecret("", "");
      const proof = appsecretProof(pageToken, secret);
      if (proof) url.searchParams.set("appsecret_proof", proof);
    }
    const res = await fetch(url, { method: "DELETE" });
    return res.json();
  };
  let data = await tryOnce(true);
  if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
    data = await tryOnce(false);
  }
  return data;
}

function isRealPublicUrl(u) {
  const s = String(u || "").trim();
  if (!/^https?:\/\//i.test(s)) return false;
  // bỏ placeholder / test
  if (/persist\d*$/i.test(s)) return false;
  if (/example\.com|localhost|127\.0\.0\.1/i.test(s)) return false;
  try {
    const host = new URL(s).hostname;
    if (!host || !host.includes(".")) return false;
  } catch {
    return false;
  }
  return true;
}

/** Gộp mọi URL từ mọi page — fallback khi page thiếu kho link */
function loadGlobalLinkPool() {
  const db = getDb();
  const rows = db
    .prepare(`SELECT link_lists_json FROM page_post_config`)
    .all();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    let ll = {};
    try {
      ll = JSON.parse(row.link_lists_json || "{}") || {};
    } catch {
      continue;
    }
    for (const u of getCommentLinkPool(ll)) {
      if (!isRealPublicUrl(u)) continue;
      const k = String(u).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(u);
    }
  }
  return out;
}

const GLOBAL_LINKS = loadGlobalLinkPool();
console.log(`[repair] global link pool: ${GLOBAL_LINKS.length} URLs`);

function pickLinkForPage(pageRowId, usedIndex) {
  const cfg = getPagePostConfig(pageRowId);
  let links = getCommentLinkPool(cfg.link_lists || {});
  if (!links.length) {
    const a = assignCommentForPost(cfg);
    if (a.link) return { link: a.link, template: a.template, cfg };
    links = GLOBAL_LINKS;
  }
  if (!links.length) return { link: null, template: null, cfg, links: [] };
  const i = Math.abs(Number(usedIndex) || 0) % links.length;
  return { link: links[i], template: null, cfg, links, index: i };
}

function buildFixedText(oldText, link) {
  let base = String(oldText || "").trim() || "see more :";
  if (!link) return null;
  // bỏ URL placeholder/test nếu có
  base = base
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/persist\d*/i.test(l) && !/example\.com/i.test(l))
    .join("\n")
    .trim();
  // giữ dòng câu mẫu (không phải URL)
  const lines = base.split(/\n/).filter(Boolean);
  const phrase =
    lines.find((l) => !/^https?:\/\//i.test(l)) ||
    "see more :";
  if (phrase.includes(link)) return phrase;
  return `${phrase}\n${link}`.trim();
}

const db = getDb();
const alsoBadPlaceholder = args.includes("--fix-placeholder");
const rows = db
  .prepare(
    alsoBadPlaceholder
      ? `SELECT l.id, l.page_row_id, l.page_name, l.status, l.comment_id, l.comment_text,
            l.fb_post_id, p.page_token_enc
     FROM post_logs l
     JOIN fb_pages p ON p.id = l.page_row_id
     WHERE l.comment_text IS NOT NULL AND trim(l.comment_text) != ''
       AND (
         lower(l.comment_text) NOT LIKE '%http%'
         OR l.comment_text LIKE '%persist%'
         OR l.comment_text LIKE '%example.com%'
       )
       AND l.comment_text NOT LIKE '[comment failed]%'
       AND l.comment_id IS NOT NULL AND trim(l.comment_id) != ''
       AND l.fb_post_id IS NOT NULL AND trim(l.fb_post_id) != ''
     ORDER BY l.id DESC
     LIMIT ?`
      : `SELECT l.id, l.page_row_id, l.page_name, l.status, l.comment_id, l.comment_text,
            l.fb_post_id, p.page_token_enc
     FROM post_logs l
     JOIN fb_pages p ON p.id = l.page_row_id
     WHERE l.comment_text IS NOT NULL AND trim(l.comment_text) != ''
       AND lower(l.comment_text) NOT LIKE '%http%'
       AND l.comment_text NOT LIKE '[comment failed]%'
       AND l.comment_id IS NOT NULL AND trim(l.comment_id) != ''
       AND l.fb_post_id IS NOT NULL AND trim(l.fb_post_id) != ''
     ORDER BY l.id DESC
     LIMIT ?`
  )
  .all(limit);

console.log(
  `[repair] found ${rows.length} comments missing URL (limit ${limit})${dryRun ? " DRY-RUN" : ""}`
);

let ok = 0;
let fail = 0;
let skip = 0;
const pageLinkCursor = new Map();

for (const row of rows) {
  const cursor = pageLinkCursor.get(row.page_row_id) || 0;
  const pick = pickLinkForPage(row.page_row_id, cursor);
  pageLinkCursor.set(row.page_row_id, cursor + 1);

  if (!pick.link) {
    console.warn(`[skip #${row.id}] ${row.page_name}: no links in page pool`);
    skip++;
    continue;
  }

  const newText = buildFixedText(row.comment_text, pick.link);
  if (!newText || !/https?:\/\//i.test(newText)) {
    console.warn(`[skip #${row.id}] could not build text`);
    skip++;
    continue;
  }

  console.log(
    `[#${row.id}] ${row.page_name} | ${JSON.stringify(row.comment_text)} → ${JSON.stringify(newText.slice(0, 100))}`
  );

  if (dryRun) {
    ok++;
    continue;
  }

  let token;
  try {
    token = decryptToken(row.page_token_enc);
  } catch (e) {
    console.error(`  FAIL decrypt: ${e.message}`);
    fail++;
    continue;
  }

  // 1) Try update existing comment
  let newCommentId = row.comment_id;
  let updated = false;
  try {
    const data = await graphPost(`/${row.comment_id}`, token, { message: newText });
    if (data?.success || data?.id || !data?.error) {
      if (!data?.error) {
        updated = true;
        console.log(`  OK update comment ${row.comment_id}`);
      }
    }
    if (data?.error) {
      console.warn(`  update fail: ${data.error.message}`);
    }
  } catch (e) {
    console.warn(`  update throw: ${e.message}`);
  }

  // 2) Fallback: delete old + post new
  if (!updated) {
    try {
      await graphDelete(`/${row.comment_id}`, token);
    } catch (e) {
      console.warn(`  delete old: ${e.message}`);
    }
    try {
      const data = await graphPost(`/${row.fb_post_id}/comments`, token, {
        message: newText,
      });
      if (data?.error) {
        console.error(`  FAIL new comment: ${data.error.message}`);
        fail++;
        await sleep(400);
        continue;
      }
      newCommentId = data.id || row.comment_id;
      console.log(`  OK new comment ${newCommentId}`);
      updated = true;
    } catch (e) {
      console.error(`  FAIL new comment: ${e.message}`);
      fail++;
      await sleep(400);
      continue;
    }
  }

  if (updated) {
    db.prepare(
      `UPDATE post_logs SET comment_text = ?, comment_id = ?, error = NULL WHERE id = ?`
    ).run(newText, newCommentId, row.id);
    ok++;
  }

  // polite Graph pacing
  await sleep(350);
}

console.log(`[repair] done ok=${ok} fail=${fail} skip=${skip} dry=${dryRun}`);
process.exit(fail ? 1 : 0);
