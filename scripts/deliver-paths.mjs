/**
 * Deliverable packs live under "Tổng Hợp Tool/" for a clean project root.
 */
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
