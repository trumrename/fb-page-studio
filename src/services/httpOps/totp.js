/**
 * TOTP (RFC 6238) — pure Node crypto, no extra dependency.
 * Input: authenticator secret Base32 (not the 6-digit code).
 */
import crypto from "crypto";

function base32ToBuffer(secret) {
  const s = String(secret || "")
    .replace(/\s+/g, "")
    .replace(/=+$/g, "")
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "L")
    .replace(/8/g, "B");
  if (!s || !/^[A-Z2-7]+$/.test(s)) {
    throw new Error("INVALID_2FA_SECRET");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s) {
    const val = alphabet.indexOf(c);
    if (val < 0) throw new Error("INVALID_2FA_SECRET");
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * @param {string} secret Base32
 * @param {{ step?: number, digits?: number, t?: number }} [opts]
 * @returns {string} 6-digit code
 */
export function generateTotp(secret, opts = {}) {
  const step = opts.step || 30;
  const digits = opts.digits || 6;
  const t = opts.t != null ? opts.t : Math.floor(Date.now() / 1000);
  const counter = Math.floor(t / step);
  const key = base32ToBuffer(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

export function isLikelyTotpSecret(s) {
  const t = String(s || "").replace(/\s+/g, "");
  if (/^\d{6}$/.test(t)) return false; // user pasted code not secret
  return t.length >= 16 && /^[A-Za-z2-7=]+$/.test(t);
}
