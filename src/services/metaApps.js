/**
 * Multi Meta App profiles (App1 / App2 …).
 * Each profile has own FB_APP_ID + SECRET; accounts tagged meta_app_key on OAuth.
 *
 * Env:
 *   FB_APP_ID / FB_APP_SECRET / FB_REDIRECT_URI     → app1
 *   FB_APP_ID_2 / FB_APP_SECRET_2 / FB_REDIRECT_URI_2 → app2
 * Optional JSON: data/meta_apps.json for more labels.
 */
import fs from "fs";
import path from "path";
import { config } from "../config.js";

function scopesFromEnv(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return fallback || config.facebook.scopes;
}

/**
 * @returns {Array<{
 *   key: string,
 *   name: string,
 *   appId: string,
 *   appSecret: string,
 *   redirectUri: string,
 *   scopes: string[],
 *   configured: boolean
 * }>}
 */
export function listMetaApps() {
  const scopes = config.facebook.scopes;
  const apps = [];

  // App 1 — primary .env
  apps.push({
    key: "app1",
    name: process.env.FB_APP_NAME || process.env.FB_APP_NAME_1 || "App 1",
    appId: String(config.facebook.appId || process.env.FB_APP_ID || "").trim(),
    appSecret: String(
      config.facebook.appSecret || process.env.FB_APP_SECRET || ""
    ).trim(),
    redirectUri: String(
      config.facebook.redirectUri ||
        process.env.FB_REDIRECT_URI ||
        `http://localhost:${config.port}/auth/facebook/callback`
    ).trim(),
    scopes: scopesFromEnv("FB_SCOPES", scopes),
  });

  // App 2
  const id2 = String(process.env.FB_APP_ID_2 || "").trim();
  if (id2) {
    apps.push({
      key: "app2",
      name: process.env.FB_APP_NAME_2 || "App 2",
      appId: id2,
      appSecret: String(process.env.FB_APP_SECRET_2 || "").trim(),
      redirectUri: String(
        process.env.FB_REDIRECT_URI_2 ||
          config.facebook.redirectUri ||
          `http://localhost:${config.port}/auth/facebook/callback`
      ).trim(),
      scopes: scopesFromEnv("FB_SCOPES_2", scopes),
    });
  }

  // Optional extra apps from JSON (no secrets preferred — secrets still env)
  try {
    const f = path.join(config.dataDir, "meta_apps.json");
    if (fs.existsSync(f)) {
      const extra = JSON.parse(fs.readFileSync(f, "utf8"));
      const list = Array.isArray(extra) ? extra : extra.apps || [];
      for (const e of list) {
        const key = String(e.key || "").trim();
        if (!key || apps.some((a) => a.key === key)) continue;
        apps.push({
          key,
          name: e.name || key,
          appId: String(e.appId || e.app_id || "").trim(),
          appSecret: String(e.appSecret || e.app_secret || "").trim(),
          redirectUri: String(
            e.redirectUri || e.redirect_uri || config.facebook.redirectUri
          ).trim(),
          scopes: Array.isArray(e.scopes) ? e.scopes : scopes,
        });
      }
    }
  } catch (err) {
    console.warn("[metaApps] meta_apps.json:", err.message);
  }

  return apps.map((a) => ({
    ...a,
    configured: Boolean(a.appId && a.appSecret),
  }));
}

/**
 * Get app by key. Does NOT fall back to another key when requested key is missing
 * (prevents Connect App2 silently using App1 credentials).
 * Call with no key / null → default first configured app.
 */
export function getMetaApp(key) {
  const apps = listMetaApps();
  if (key != null && String(key).trim() !== "") {
    return apps.find((a) => a.key === String(key)) || null;
  }
  return apps.find((a) => a.configured) || apps[0] || null;
}

/** Public list — no secrets */
export function listMetaAppsPublic() {
  return listMetaApps().map((a) => ({
    key: a.key,
    name: a.name,
    app_id: a.appId ? `${a.appId.slice(0, 6)}…${a.appId.slice(-4)}` : null,
    app_id_full: a.appId || null, // needed to match Graph; UI can show masked
    redirect_uri: a.redirectUri,
    configured: a.configured,
    is_default: a.key === "app1",
  }));
}

export function assertMetaAppConfigured(key) {
  const want = key != null && String(key).trim() !== "" ? String(key) : "app1";
  const app = getMetaApp(want);
  if (!app) {
    throw new Error(
      want === "app2" || want.includes("2")
        ? `Meta App "${want}" chưa khai báo. Thêm FB_APP_ID_2 + FB_APP_SECRET_2 vào .env`
        : `Meta App "${want}" không tồn tại. Kiểm tra FB_APP_ID trong .env`
    );
  }
  if (!app.configured) {
    throw new Error(
      want === "app2" || want.includes("2")
        ? `Meta App "${want}" chưa cấu hình. Thêm FB_APP_ID_2 + FB_APP_SECRET_2 vào .env`
        : `Meta App "${want}" chưa cấu hình. Thêm FB_APP_ID + FB_APP_SECRET vào .env`
    );
  }
  return app;
}
