/**
 * Optional IMAP poll for Facebook verification emails (checkpoint 282).
 * Requires: npm i imapflow
 *
 * Config example:
 * {
 *   host: "imap.gmail.com",
 *   port: 993,
 *   secure: true,
 *   user: "you@gmail.com",
 *   pass: "app-password-not-gmail-password"
 * }
 */
import { loginError } from "./loginErrors.js";

const CODE_RE =
  /(?:FB-)?(\d{5,8})(?:\s|$|[^\d])|(?:code|mã|confirmation)[^\d]{0,40}(\d{5,8})/i;

/**
 * @param {object} imapCfg
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
export async function pollFacebookEmailCode(imapCfg, opts = {}) {
  let ImapFlow;
  try {
    ({ ImapFlow } = await import("imapflow"));
  } catch {
    throw Object.assign(new Error("EMAIL_IMAP_FAIL"), {
      loginError: loginError(
        "EMAIL_IMAP_FAIL",
        "Chưa cài imapflow — npm i imapflow (hoặc dán mã tay)"
      ),
    });
  }

  const timeoutMs = opts.timeoutMs || 45000;
  const client = new ImapFlow({
    host: imapCfg.host,
    port: Number(imapCfg.port || 993),
    secure: imapCfg.secure !== false,
    auth: {
      user: imapCfg.user,
      pass: imapCfg.pass,
    },
    logger: false,
  });

  const deadline = Date.now() + timeoutMs;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(imapCfg.mailbox || "INBOX");
    try {
      while (Date.now() < deadline) {
        // last 15 messages
        const since = new Date(Date.now() - 2 * 3600 * 1000);
        for await (const msg of client.fetch(
          { seen: false, since },
          { envelope: true, source: true }
        )) {
          const from = JSON.stringify(msg.envelope?.from || []).toLowerCase();
          const subj = String(msg.envelope?.subject || "").toLowerCase();
          if (
            !/facebook|meta|facebooks?mail|security@facebook/i.test(from + subj)
          ) {
            continue;
          }
          const body = msg.source?.toString?.() || "";
          const m = body.match(CODE_RE) || subj.match(CODE_RE);
          const code = m?.[1] || m?.[2];
          if (code) return code;
        }
        // also search recent regardless of seen
        const uids = await client.search({ since });
        const slice = (uids || []).slice(-12);
        if (slice.length) {
          for await (const msg of client.fetch(slice, {
            envelope: true,
            source: true,
          })) {
            const from = JSON.stringify(msg.envelope?.from || []).toLowerCase();
            const subj = String(msg.envelope?.subject || "");
            if (!/facebook|meta/i.test(from + subj.toLowerCase())) continue;
            const body = msg.source?.toString?.() || "";
            const m = (body + "\n" + subj).match(CODE_RE);
            const code = m?.[1] || m?.[2];
            if (code) return code;
          }
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* */
    }
  }
  return null;
}
