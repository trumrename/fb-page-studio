import { getDb } from "../src/db/index.js";
import { decryptToken } from "../src/services/crypto.js";
import { config } from "../src/config.js";

const p = getDb()
  .prepare(`SELECT page_id, page_token_enc, name FROM fb_pages WHERE name LIKE ?`)
  .get("%One More%");
console.log("page", p?.name, p?.page_id);
const t = decryptToken(p.page_token_enc);
const ut = decryptToken(
  getDb().prepare(`SELECT user_token_enc FROM fb_accounts LIMIT 1`).get()
    .user_token_enc
);

async function tryPath(label, path, token, q = {}) {
  const url = new URL(
    `https://graph.facebook.com/${config.facebook.graphVersion}${path}`
  );
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));
  url.searchParams.set("access_token", token);
  const j = await fetch(url).then((r) => r.json());
  console.log("\n" + label, JSON.stringify(j).slice(0, 400));
}

const id = p.page_id;
await tryPath("roles", `/${id}/roles`, t, {
  limit: 100,
  fields: "id,name,tasks",
});
await tryPath("roles deact", `/${id}/roles`, t, {
  limit: 100,
  include_deactivated: true,
});
await tryPath("fields roles+npe", `/${id}`, t, {
  fields:
    "id,name,has_transitioned_to_new_page_experience,roles.limit(50){id,name,tasks}",
});

// Business assigned for all BMs
const bizUrl = new URL(
  `https://graph.facebook.com/${config.facebook.graphVersion}/me/businesses`
);
bizUrl.searchParams.set("fields", "id,name");
bizUrl.searchParams.set("access_token", ut);
const biz = await fetch(bizUrl).then((r) => r.json());
console.log("\nBMs", JSON.stringify(biz.data || biz));
for (const b of biz.data || []) {
  await tryPath(`assigned ${b.name}`, `/${id}/assigned_users`, t, {
    business: b.id,
    limit: 50,
    fields: "id,name,tasks",
  });
}
