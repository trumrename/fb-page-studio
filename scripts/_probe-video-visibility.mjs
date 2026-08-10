/**
 * Probe: page restrictions + recent video/post visibility flags via Graph.
 */
import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (r) => import(pathToFileURL(path.join(root, r)).href);

const { getDb } = await imp("src/db/index.js");
const { decryptToken } = await imp("src/services/crypto.js");
const { graphBase } = await imp("src/config.js");

const db = getDb();
const pages = db
  .prepare(
    `SELECT id, page_id, name, page_token_enc FROM fb_pages WHERE status='active' ORDER BY id LIMIT 5`
  )
  .all();

async function g(pathStr, token, fields) {
  const url = new URL(graphBase() + pathStr);
  url.searchParams.set("access_token", token);
  if (fields) url.searchParams.set("fields", fields);
  const res = await fetch(url);
  return res.json();
}

console.log("Probing", pages.length, "pages…\n");

for (const p of pages) {
  const token = decryptToken(p.page_token_enc);
  if (!token) {
    console.log(p.name, "— no token");
    continue;
  }
  console.log("========", p.name, p.page_id, "========");

  const prof = await g(
    `/${p.page_id}`,
    token,
    "id,name,is_published,verification_status,followers_count,category"
  );
  console.log(
    "page:",
    prof.error
      ? "ERR " + prof.error.message
      : JSON.stringify({
          is_published: prof.is_published,
          followers: prof.followers_count,
          category: prof.category,
        })
  );

  // Common restriction-related fields (many need extra perms)
  for (const f of [
    "restriction",
    "is_unclaimed",
    "is_permanently_closed",
    "is_community_page",
  ]) {
    const r = await g(`/${p.page_id}`, token, f);
    if (r.error) console.log(`  ${f}: ERR ${String(r.error.message).slice(0, 90)}`);
    else console.log(`  ${f}:`, JSON.stringify(r[f] ?? r));
  }

  const posts = await g(
    `/${p.page_id}/published_posts`,
    token,
    "id,message,is_published,is_hidden,permalink_url,created_time,privacy,status_type,scheduled_publish_time"
  );
  if (posts.error) console.log("published_posts ERR", posts.error.message);
  else {
    for (const x of (posts.data || []).slice(0, 3)) {
      console.log("  post", {
        id: x.id,
        pub: x.is_published,
        hid: x.is_hidden,
        privacy: x.privacy,
        type: x.status_type,
        t: x.created_time,
      });
    }
  }

  const vids = await g(
    `/${p.page_id}/videos`,
    token,
    "id,title,description,published,scheduled_publish_time,permalink_url,created_time,privacy,status,embeddable,content_category"
  );
  if (vids.error) console.log("videos ERR", vids.error.message);
  else {
    for (const x of (vids.data || []).slice(0, 5)) {
      console.log("  video", {
        id: x.id,
        published: x.published,
        sched: x.scheduled_publish_time,
        privacy: x.privacy,
        status: x.status,
        embed: x.embeddable,
        t: x.created_time,
        url: x.permalink_url,
      });
    }
  }

  const sch = await g(
    `/${p.page_id}/scheduled_posts`,
    token,
    "id,message,is_published,is_hidden,permalink_url,scheduled_publish_time"
  );
  if (sch.error) console.log("scheduled ERR", sch.error.message);
  else console.log("  scheduled_posts:", (sch.data || []).length);

  const logs = db
    .prepare(
      `SELECT id, post_type, status, fb_post_id, scheduled_publish_time, error
       FROM post_logs WHERE page_row_id=? AND (post_type='video' OR status LIKE 'schedule%')
       ORDER BY id DESC LIMIT 6`
    )
    .all(p.id);
  console.log("  local logs:", logs.length);
  for (const L of logs.slice(0, 3)) {
    if (!L.fb_post_id) {
      console.log("   log", L.id, L.status, L.post_type, "no fb id");
      continue;
    }
    const st = await g(
      `/${L.fb_post_id}`,
      token,
      "id,is_published,is_hidden,permalink_url,privacy,status_type,created_time,scheduled_publish_time,from"
    );
    console.log("   log", L.id, L.status, L.post_type, "→", {
      graph_err: st.error?.message?.slice(0, 100),
      pub: st.is_published,
      hid: st.is_hidden,
      privacy: st.privacy,
      sched: st.scheduled_publish_time,
      url: st.permalink_url,
      type: st.status_type,
    });
  }
  console.log("");
}
