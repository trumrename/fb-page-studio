import { getDb } from "../src/db/index.js";
import { decryptToken } from "../src/services/crypto.js";
import { graphGetSoft } from "../src/services/facebook.js";
import { config } from "../src/config.js";

const pages = getDb()
  .prepare(
    `SELECT id, page_id, name, page_token_enc, account_id FROM fb_pages WHERE status = 'active'`
  )
  .all();
const acc = getDb().prepare(`SELECT user_token_enc FROM fb_accounts LIMIT 1`).get();
const ut = decryptToken(acc.user_token_enc);

async function getWithHeaders(path, token, query = {}) {
  const url = new URL(
    `https://graph.facebook.com/${config.facebook.graphVersion}${path}`
  );
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  url.searchParams.set("access_token", token);
  const res = await fetch(url);
  const headers = {
    "x-app-usage": res.headers.get("x-app-usage"),
    "x-page-usage": res.headers.get("x-page-usage"),
    "x-business-use-case-usage": res.headers.get("x-business-use-case-usage"),
  };
  const data = await res.json();
  return { headers, data, status: res.status };
}

const pt0 = decryptToken(pages[0].page_token_enc);
const h = await getWithHeaders(`/${pages[0].page_id}`, pt0, {
  fields: "id,name",
});
console.log("HEADERS", JSON.stringify(h.headers, null, 2));

// App token usage
const appToken = `${config.facebook.appId}|${config.facebook.appSecret}`;
const h2 = await getWithHeaders(`/${config.facebook.appId}`, appToken, {
  fields: "id,name",
});
console.log("APP TOKEN HEADERS", JSON.stringify(h2.headers, null, 2));

const biz = await graphGetSoft("/me/businesses", ut, {
  fields: "id,name",
  limit: 20,
});
console.log("BMs", JSON.stringify(biz.data?.data || biz));

for (const p of pages) {
  const token = decryptToken(p.page_token_enc);
  const roles = await graphGetSoft(`/${p.page_id}/roles`, token, {
    limit: 100,
    fields: "id,name,tasks,is_active",
  });
  const rolePeople = roles.ok ? roles.data.data || [] : [];
  const assignedAll = [];
  if (biz.ok) {
    for (const b of biz.data.data || []) {
      const a = await graphGetSoft(`/${p.page_id}/assigned_users`, token, {
        business: b.id,
        limit: 100,
        fields: "id,name,tasks,user_type",
      });
      if (a.ok && a.data.data?.length) {
        for (const u of a.data.data) {
          assignedAll.push({
            ...u,
            bm: b.name,
            bm_id: b.id,
          });
        }
      }
    }
  }
  console.log(
    "\nPAGE",
    p.name,
    "\n  roles",
    rolePeople.length,
    rolePeople.map(
      (x) =>
        `${x.name}/${(x.tasks || []).includes("MANAGE") ? "ADMIN" : "other"}`
    )
  );
  console.log(
    "  assigned",
    assignedAll.length,
    assignedAll.map((x) => `${x.name}@${x.bm} tasks=${(x.tasks || []).join(",")}`)
  );
}
