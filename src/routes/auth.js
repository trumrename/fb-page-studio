import { Router } from "express";
import { nanoid } from "nanoid";
import { getDb, cleanupOldOauthStates } from "../db/index.js";
import { buildLoginUrl } from "../services/facebook.js";
import { connectFromOAuthCode } from "../services/accounts.js";
import { config } from "../config.js";

const router = Router();

function createOAuthSession(rerequest = false) {
  cleanupOldOauthStates();
  const state = nanoid(32);
  getDb().prepare(`INSERT INTO oauth_states (state) VALUES (?)`).run(state);
  const url = buildLoginUrl(state, { rerequest });
  return { state, url };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorPage(title, detail, tip) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
body{font-family:Segoe UI,sans-serif;background:#1a1010;color:#ffc0c7;padding:2rem;line-height:1.55;max-width:560px;margin:0 auto}
code{background:#2a1515;padding:.2rem .4rem;border-radius:4px;word-break:break-all}
a{color:#9ec1ff}
.btn{display:inline-block;margin-top:1rem;background:#1877f2;color:#fff;text-decoration:none;padding:.65rem 1rem;border-radius:8px;font-weight:700}
</style></head>
<body><h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
<p><b>Gợi ý:</b> ${escapeHtml(tip)}</p>
<p><a class="btn" href="/auth/facebook?external=1">Connect lại (Chrome/Edge + 2FA)</a>
 · <a href="/index.html">Về Pages</a></p></body></html>`;
}

/**
 * GET /auth/facebook
 * - ?external=1  HTML helper + redirect (dùng cho desktop / 2FA)
 * - ?json=1      { url } để shell.openExternal
 * - default      302 tới Facebook
 */
router.get("/facebook", (req, res) => {
  if (!config.facebook.appId || !config.facebook.appSecret) {
    return res
      .status(500)
      .type("html")
      .send(
        errorPage(
          "Thiếu FB_APP_ID / SECRET",
          "File .env chưa có credentials Meta.",
          "Đặt .env cạnh app, điền FB_APP_ID, FB_APP_SECRET, FB_REDIRECT_URI."
        )
      );
  }

  const rerequest =
    req.query.rerequest === "1" || req.query.rerequest === "true";
  const { url } = createOAuthSession(rerequest);

  if (req.query.json === "1" || req.query.format === "json") {
    return res.json({
      ok: true,
      url,
      redirect_uri: config.facebook.redirectUri,
      tip: "Mở URL trong Chrome/Edge. Nhập pass + mã 2FA nếu có.",
    });
  }

  if (req.query.external === "1" || req.query.desktop === "1") {
    return res.type("html").send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Connect Facebook · 2FA</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:460px;padding:2rem;border:1px solid #2a2f3a;border-radius:16px;background:#171a21}
h1{font-size:1.2rem;margin:0 0 .75rem;color:#1877f2}
p{line-height:1.55;color:#9aa0a6;font-size:.92rem}
a.btn{display:inline-block;margin-top:1rem;background:#1877f2;color:#fff;text-decoration:none;padding:.75rem 1.25rem;border-radius:10px;font-weight:700}
code{background:#1e2330;padding:.1rem .35rem;border-radius:4px;font-size:.78rem;word-break:break-all}
ol{color:#9aa0a6;line-height:1.6;padding-left:1.2rem}
</style></head><body>
<div class="card">
  <h1>Đăng nhập Facebook + 2FA</h1>
  <ol>
    <li>Mở bằng <b>Chrome / Edge</b> (không cửa sổ app nhúng)</li>
    <li>Nhập email / mật khẩu</li>
    <li>Nhập <b>mã 2FA</b> (Authenticator / SMS) nếu nick bật</li>
    <li>Cho phép quyền Page → đợi redirect về app</li>
  </ol>
  <p>Redirect: <code>${escapeHtml(config.facebook.redirectUri)}</code></p>
  <a class="btn" id="go" href="${escapeHtml(url)}">Tiếp tục Facebook →</a>
</div>
<script>setTimeout(function(){ location.href = ${JSON.stringify(url)}; }, 500);</script>
</body></html>`);
  }

  res.redirect(url);
});

/** OAuth callback — after password + 2FA */
router.get("/facebook/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).type("html").send(
        errorPage(
          "Facebook từ chối",
          `${error}: ${error_description || ""}`,
          "Thử lại từ đầu. Với 2FA: nhập đủ mã, không đóng tab giữa chừng. Bỏ scope business_management nếu chưa App Review."
        )
      );
    }
    if (!code || !state) {
      return res.status(400).type("html").send(
        errorPage(
          "OAuth chưa hoàn tất",
          "Thiếu code/state (có thể dừng ở bước 2FA).",
          "Connect lại → làm hết mật khẩu + 2FA → Approve."
        )
      );
    }

    const db = getDb();
    const st = db
      .prepare(`SELECT state FROM oauth_states WHERE state = ?`)
      .get(state);
    if (!st) {
      return res.status(400).type("html").send(
        errorPage(
          "Phiên hết hạn / state không khớp",
          "App restart giữa Connect, hoặc bấm Connect 2 lần.",
          "Mở lại app → Connect một lần → xong hẳn 2FA."
        )
      );
    }
    db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);

    const result = await connectFromOAuthCode(String(code));
    const q = new URLSearchParams({
      connected: "1",
      account: String(result.account.id),
      pages: String(result.pages.length),
    });
    const localUi = `http://127.0.0.1:${config.port}/index.html?${q}`;

    res.type("html").send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"/><title>Đã kết nối</title>
<style>
body{font-family:Segoe UI,sans-serif;background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:480px;padding:2rem;border-radius:16px;border:1px solid #2d5c45;background:#14301f}
h1{color:#8fd9a8;font-size:1.25rem;margin:0 0 .75rem}
p{color:#b8f0d0;line-height:1.5}a{color:#9ec1ff}
</style></head><body>
<div class="card">
  <h1>✓ Đã kết nối Facebook</h1>
  <p>Account #${result.account.id} · <b>${result.pages.length}</b> page(s).</p>
  <p>Đã qua mật khẩu + 2FA (nếu có). Quay lại cửa sổ <b>FB Page Studio</b>.</p>
  <p><a href="${localUi}">Mở Pages trong app →</a></p>
</div>
<script>setTimeout(function(){ location.href=${JSON.stringify(localUi)}; }, 900);</script>
</body></html>`);
  } catch (e) {
    console.error("[auth/callback]", e);
    res.status(500).type("html").send(
      errorPage(
        "OAuth thất bại",
        e.message || "unknown",
        "Kiểm tra App Secret, Redirect URI khớp 100%, scope không cần Review."
      )
    );
  }
});

export default router;
