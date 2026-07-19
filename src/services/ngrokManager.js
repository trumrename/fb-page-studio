import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { getExeDir } from "../paths.js";

const DOWNLOAD_URL = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip";
let child = null;
let starting = null;
let stopRequested = false;
const state = { status: "stopped", message: "Ngrok chưa chạy", domain: "", public_url: "", pid: null, executable: "", last_error: null, updated_at: new Date().toISOString() };
const update = (v) => Object.assign(state, v, { updated_at: new Date().toISOString() });
function domainOf(v) { try { return new URL(/^https?:\/\//i.test(String(v || "")) ? v : `https://${v}`).hostname; } catch { return ""; } }
function findExe() {
  const local = [path.join(getExeDir(), "ngrok.exe"), path.join(getExeDir(), "ngrok", "ngrok.exe")].find((p) => fs.existsSync(p));
  if (local) return local;
  const r = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["ngrok"], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? String(r.stdout || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) || "" : "";
}
function quotePs(v) { return String(v).replaceAll("'", "''"); }
async function ensureExe() {
  let exe = findExe(); if (exe) return exe;
  if (process.platform !== "win32") throw new Error("Chưa cài Ngrok trên máy này.");
  update({ status: "installing", message: "Đang tự tải Ngrok…" });
  const dir = path.join(getExeDir(), "ngrok"), zip = path.join(dir, "ngrok-win.zip"); fs.mkdirSync(dir, { recursive: true });
  const cmd = `$ErrorActionPreference='Stop';[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;Invoke-WebRequest -UseBasicParsing '${quotePs(DOWNLOAD_URL)}' -OutFile '${quotePs(zip)}';Expand-Archive -LiteralPath '${quotePs(zip)}' -DestinationPath '${quotePs(dir)}' -Force`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  exe = path.join(dir, "ngrok.exe"); if (r.status !== 0 || !fs.existsSync(exe)) throw new Error(`Không tự tải được Ngrok: ${String(r.stderr || r.stdout || "").trim()}`);
  try { fs.unlinkSync(zip); } catch {}
  return exe;
}
function configure(exe, token) { const r = spawnSync(exe, ["config", "add-authtoken", token], { encoding: "utf8", windowsHide: true, timeout: 30000 }); if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || "Token Ngrok không hợp lệ").trim()); }
async function waitTunnel(domain, proc) { const end = Date.now() + 15000; while (Date.now() < end && child === proc) { try { const r = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(1200) }); const j = await r.json(); const t = (j.tunnels || []).find((x) => domainOf(x.public_url) === domain); if (t?.public_url) return t.public_url; } catch {} await new Promise((r) => setTimeout(r, 500)); } return ""; }
export const getNgrokStatus = () => ({ ...state, token_configured: Boolean(String(process.env.NGROK_AUTHTOKEN || "").trim()) });
export async function stopNgrok() {
  stopRequested = true;
  const proc = child;
  child = null;
  if (proc && !proc.killed && proc.exitCode == null) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.once("exit", finish);
      try { proc.kill(); } catch { finish(); }
      setTimeout(finish, 1500);
    });
  }
  update({ status: "stopped", message: "Ngrok chưa chạy", pid: null, public_url: "" });
}
export async function startNgrok({ token = process.env.NGROK_AUTHTOKEN, origin = process.env.APP_BASE_URL, port = process.env.PORT || 3847 } = {}) {
  if (starting) return starting; starting = (async () => { const domain = domainOf(origin), auth = String(token || "").trim(); if (!domain) throw new Error("Chưa có domain Ngrok hợp lệ"); if (!auth) { update({ status: "needs_token", message: "Chưa có Authtoken Ngrok. Hãy nhập token mới.", domain, last_error: "Thiếu NGROK_AUTHTOKEN" }); return getNgrokStatus(); } await stopNgrok(); stopRequested = false; let output = []; try { update({ status: "starting", message: "Đang khởi động Ngrok…", domain, public_url: "", last_error: null }); const exe = await ensureExe(); configure(exe, auth); if (stopRequested) return getNgrokStatus(); const proc = spawn(exe, ["http", `127.0.0.1:${port}`, `--domain=${domain}`], { cwd: getExeDir(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); child = proc; update({ executable: exe, pid: proc.pid }); const capture = (d) => { const s = String(d || "").trim(); if (s) output.push(s); if (output.length > 20) output.shift(); }; proc.stdout.on("data", capture); proc.stderr.on("data", capture); proc.on("exit", (code) => { const current = child === proc; if (current) child = null; if (!stopRequested && current) { const detail = output.join("\n").slice(-1800) || `Ngrok dừng (exit ${code})`; const bad = /authtoken|authentication|ERR_NGROK_10[0-9]|invalid token/i.test(detail); update({ status: bad ? "needs_token" : "error", message: bad ? "Authtoken Ngrok sai hoặc đã bị thu hồi. Hãy nhập token mới." : "Ngrok đã dừng hoặc không mở được domain.", pid: null, public_url: "", last_error: detail }); } }); const url = await waitTunnel(domain, proc); if (!url) { const detail = output.join("\n").slice(-1800); throw Object.assign(new Error(detail || "Ngrok không tạo được tunnel cho domain đã chọn"), { tokenError: /authtoken|authentication|ERR_NGROK_10[0-9]|invalid token/i.test(detail) }); } update({ status: "running", message: "Ngrok đang chạy", public_url: url, pid: proc.pid, last_error: null }); return getNgrokStatus(); } catch (e) { await stopNgrok(); const bad = Boolean(e.tokenError) || /authtoken|authentication|ERR_NGROK_10[0-9]|invalid token/i.test(e.message); update({ status: bad ? "needs_token" : "error", message: bad ? "Authtoken Ngrok sai hoặc đã bị thu hồi. Hãy nhập token mới." : "Không thể tự mở Ngrok.", domain, last_error: e.message }); return getNgrokStatus(); } })(); try { return await starting; } finally { starting = null; }
}
