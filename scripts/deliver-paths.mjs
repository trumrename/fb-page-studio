/**
 * Deliverable packs live under "Tổng Hợp Tool/" for a clean project root.
 * Desktop build artifacts: prefer F:/ then E:/ (ổ C hay đầy).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** One folder for Admin + customer + internal + dev + release zips */
export const DELIVER_ROOT = path.join(PROJECT_ROOT, "Tổng Hợp Tool");

export const packCustomerDir = () => path.join(DELIVER_ROOT, "pack-customer");
export const packInternalDir = () => path.join(DELIVER_ROOT, "pack-internal");
export const packDevDir = () => path.join(DELIVER_ROOT, "pack-dev");
export const packServerDir = () => path.join(DELIVER_ROOT, "pack-server");
export const releaseAssetsDir = () => path.join(DELIVER_ROOT, "release-assets");
export const adminDir = () => path.join(DELIVER_ROOT, "Admin-Quan-Ly");
/** Một ổ gom mọi EXE/ZIP phiên bản cũ (không rải trong pack-*) */
export const archiveVaultDir = () => path.join(DELIVER_ROOT, "Luu-Tru-Ban-Cu");

/** Thư mục chứa Setup/Portable (F → E → project) */
export function distDesktopDir() {
  if (process.env.FBPS_BUILD_OUT) {
    return path.resolve(process.env.FBPS_BUILD_OUT);
  }
  const candidates = [
    "F:/FB-Page-Studio/dist-desktop-oauth",
    "E:/FB-Page-Studio/dist-desktop-oauth",
    path.join(PROJECT_ROOT, "dist-desktop-oauth"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return path.resolve(c);
    } catch {
      /* */
    }
  }
  // default preferred write target
  return path.resolve("F:/FB-Page-Studio/dist-desktop-oauth");
}

/** Tìm file artifact theo tên (thử nhiều ổ) */
export function findDistArtifact(...names) {
  const dirs = [
    process.env.FBPS_BUILD_OUT && path.resolve(process.env.FBPS_BUILD_OUT),
    "F:/FB-Page-Studio/dist-desktop-oauth",
    "E:/FB-Page-Studio/dist-desktop-oauth",
    path.join(PROJECT_ROOT, "dist-desktop-oauth"),
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
