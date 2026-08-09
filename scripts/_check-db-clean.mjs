import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(pathToFileURL(path.join(root, "src/db/index.js")).href);
const db = getDb();
const leftover = db
  .prepare(`SELECT id, name, fb_user_id FROM fb_accounts WHERE fb_user_id LIKE 'test_user_%'`)
  .all();
const all = db
  .prepare(`SELECT id, name, fb_user_id, page_count, status FROM fb_accounts`)
  .all();
console.log("leftover test accounts:", leftover.length, leftover);
console.log("all accounts:", all.length);
for (const a of all) console.log(`  #${a.id} ${a.name} pages=${a.page_count} ${a.status}`);
if (leftover.length) {
  console.error("CLEANING leftover test accounts…");
  for (const a of leftover) {
    db.prepare(`DELETE FROM fb_accounts WHERE id = ?`).run(a.id);
  }
  console.log("cleaned");
}
process.exit(leftover.length ? 1 : 0);
