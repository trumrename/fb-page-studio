import dotenv from "dotenv";
import path from "path";
import {
  getDataDir,
  getEnvPath,
  getBundleRoot,
  getPackageJson,
} from "./paths.js";

// Load .env from beside .exe (portable) or project root
dotenv.config({ path: getEnvPath() });

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    console.warn(`[config] Missing ${name}`);
  }
  return v;
}

const pkg = getPackageJson();
const dataDir = getDataDir();

export const config = {
  port: Number(process.env.PORT || 3847),
  appBaseUrl: required("APP_BASE_URL", `http://localhost:${process.env.PORT || 3847}`),
  databasePath: process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(dataDir, "app.db"),
  dataDir,
  bundleRoot: getBundleRoot(),
  version: pkg.version || "0.0.0",
  /** GitHub repo for updates: owner/name */
  githubRepo: process.env.GITHUB_REPO || pkg.githubRepo || "",
  tokenEncryptionKey: required(
    "TOKEN_ENCRYPTION_KEY",
    "dev-only-change-me-32-characters!!"
  ),
  enrichTtlHours: Number(process.env.ENRICH_TTL_HOURS || 12),
  enrichDelayMs: Number(process.env.ENRICH_DELAY_MS || 200),
  facebook: {
    appId: required("FB_APP_ID", ""),
    appSecret: required("FB_APP_SECRET", ""),
    redirectUri: required(
      "FB_REDIRECT_URI",
      `http://localhost:${process.env.PORT || 3847}/auth/facebook/callback`
    ),
    graphVersion: process.env.FB_GRAPH_VERSION || "v21.0",
    scopes: (process.env.FB_SCOPES ||
      "pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

export function graphBase() {
  return `https://graph.facebook.com/${config.facebook.graphVersion}`;
}
