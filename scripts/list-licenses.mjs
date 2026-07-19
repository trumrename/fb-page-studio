/**
 * List issued license key files (admin).
 * Usage: node scripts/list-licenses.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const issued = path.join(root, "keys", "issued");

if (!fs.existsSync(issued)) {
  console.log("Chưa có keys/issued — chạy gen-license trước.");
  process.exit(0);
}

const files = fs
  .readdirSync(issued)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => {
    const full = path.join(issued, f);
    const st = fs.statSync(full);
    const text = fs.readFileSync(full, "utf8");
    const type = (text.match(/^Type:\s*(.+)$/m) || [])[1] || "?";
    const holder = (text.match(/^Holder:\s*(.+)$/m) || [])[1] || "?";
    const exp = (text.match(/^Expires:\s*(.+)$/m) || [])[1] || "?";
    const acc = (text.match(/^Accounts:\s*(.+)$/m) || [])[1] || "?";
    const pages = (text.match(/^Pages:\s*(.+)$/m) || [])[1] || "?";
    const machine = (text.match(/^Machine:\s*(.+)$/m) || [])[1] || "?";
    return { f, type, holder, exp, acc, pages, machine, mtime: st.mtime.toISOString(), bytes: st.size };
  })
  .sort((a, b) => b.mtime.localeCompare(a.mtime));

console.log(`Đã cấp: ${files.length} key\n`);
console.log(
  [
    "STT".padEnd(4),
    "TYPE".padEnd(12),
    "HOLDER".padEnd(22),
    "EXPIRES".padEnd(28),
    "ACC".padEnd(10),
    "PAGE".padEnd(10),
    "MACHINE".padEnd(10),
    "FILE",
  ].join(" ")
);
console.log("-".repeat(120));
files.forEach((r, i) => {
  console.log(
    [
      String(i + 1).padEnd(4),
      r.type.slice(0, 11).padEnd(12),
      r.holder.slice(0, 21).padEnd(22),
      r.exp.slice(0, 27).padEnd(28),
      String(r.acc).slice(0, 9).padEnd(10),
      String(r.pages).slice(0, 9).padEnd(10),
      String(r.machine).slice(0, 9).padEnd(10),
      r.f,
    ].join(" ")
  );
});
console.log(`\nThư mục: ${issued}`);
