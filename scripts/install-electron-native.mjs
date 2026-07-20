import path from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const electronPackage = require("electron/package.json");
const sqlitePackagePath = require.resolve("better-sqlite3/package.json");
const prebuildInstall = require.resolve("prebuild-install/bin.js");
const sqliteDir = path.dirname(sqlitePackagePath);

const result = spawnSync(
  process.execPath,
  [
    prebuildInstall,
    "--runtime=electron",
    `--target=${electronPackage.version}`,
    `--arch=${process.arch}`,
    "--verbose",
  ],
  {
    cwd: sqliteDir,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Không cài được better-sqlite3 prebuilt cho Electron ${electronPackage.version} (${process.arch}). ` +
      "Không tự rơi về node-gyp/Visual Studio vì gói khách phải build lặp lại được trên máy DEV sạch.",
  );
}

console.log(
  `[native] better-sqlite3 prebuilt ready for Electron ${electronPackage.version} (${process.arch})`,
);
