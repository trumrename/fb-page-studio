/**
 * Deliverable packs live under "Tổng Hợp Tool/" for a clean project root.
 * Build artifacts: CHỈ ổ F: (không còn mirror E:/C).
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

/** Thư mục xuất Setup — chỉ F: */
export const DIST_DESKTOP_DEFAULT = "F:/FB-Page-Studio/dist-desktop-oauth";

/** Thư mục lấy Setup nhanh (1 chỗ) */
export const SETUP_HANDOFF_DIR = "F:/FB-Page-Studio/Setup";

export function distDesktopDir() {
  if (process.env.FBPS_BUILD_OUT) {
    return path.resolve(process.env.FBPS_BUILD_OUT);
  }
  const preferred = path.resolve(DIST_DESKTOP_DEFAULT);
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    return path.join(PROJECT_ROOT, "dist-desktop-oauth");
  }
}

/** Tìm file artifact theo tên (chỉ F: + project fallback) */
export function findDistArtifact(...names) {
  const dirs = [
    process.env.FBPS_BUILD_OUT && path.resolve(process.env.FBPS_BUILD_OUT),
    DIST_DESKTOP_DEFAULT,
    SETUP_HANDOFF_DIR,
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
