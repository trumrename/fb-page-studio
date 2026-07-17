import { Router } from "express";
import { nanoid } from "nanoid";
import { getDb, cleanupOldOauthStates } from "../db/index.js";
import { buildLoginUrl } from "../services/facebook.js";
import { connectFromOAuthCode } from "../services/accounts.js";
import { config } from "../config.js";

const router = Router();

/** Start Facebook OAuth — open in browser to add another account */
router.get("/facebook", (req, res) => {
  if (!config.facebook.appId || !config.facebook.appSecret) {
    return res.status(500).send(
      "Missing FB_APP_ID / FB_APP_SECRET. Copy .env.example → .env and fill Meta App credentials."
    );
  }

  cleanupOldOauthStates();
  const state = nanoid(24);
  getDb()
    .prepare(`INSERT INTO oauth_states (state) VALUES (?)`)
    .run(state);

  res.redirect(buildLoginUrl(state));
});

/** OAuth callback from Meta */
router.get("/facebook/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).send(
        `Facebook OAuth error: ${error} — ${error_description || ""}`
      );
    }
    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }

    const db = getDb();
    const st = db
      .prepare(`SELECT state FROM oauth_states WHERE state = ?`)
      .get(state);
    if (!st) {
      return res.status(400).send("Invalid or expired OAuth state. Try again.");
    }
    db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);

    const result = await connectFromOAuthCode(String(code));

    // Redirect to UI with flash query
    const q = new URLSearchParams({
      connected: "1",
      account: String(result.account.id),
      pages: String(result.pages.length),
    });
    res.redirect(`/?${q}`);
  } catch (e) {
    console.error("[auth/callback]", e);
    const msg = encodeURIComponent(e.message || "OAuth failed");
    res.redirect(`/?error=${msg}`);
  }
});

export default router;
