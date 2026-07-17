import crypto from "crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function keyBytes() {
  // Derive 32-byte key from configured secret
  return crypto
    .createHash("sha256")
    .update(String(config.tokenEncryptionKey))
    .digest();
}

/** Encrypt plaintext token → base64 payload (iv + tag + cipher) */
export function encryptToken(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, keyBytes(), iv);
  const enc = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt base64 payload → plaintext token */
export function decryptToken(payload) {
  if (!payload) return null;
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8"
  );
}

/** Mask token for API responses */
export function maskToken(token) {
  if (!token || token.length < 12) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
