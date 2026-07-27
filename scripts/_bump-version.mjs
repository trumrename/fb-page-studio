import fs from "fs";
const ver = process.argv[2] || "1.2.50";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
console.log("was", pkg.version, "→", ver);
pkg.version = ver;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
let lock = fs.readFileSync("package-lock.json", "utf8");
lock = lock.replace(/^  "version": "1\.\d+\.\d+",/m, `  "version": "${ver}",`);
lock = lock.replace(
  /("packages": \{\s*"": \{\s*"name": "fb-page-studio",\s*"version": ")[^"]+/,
  `$1${ver}`
);
fs.writeFileSync("package-lock.json", lock);
console.log("ok", JSON.parse(fs.readFileSync("package.json", "utf8")).version);
