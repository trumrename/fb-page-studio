import fs from "fs";
import path from "path";
import os from "os";
import { spawn, spawnSync } from "child_process";
import { getExeDir, getEnvPath } from "../paths.js";

const DOWNLOAD_URL =
  "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip";
let child = null;
let starting = null;
let stopRequested = false;
const state = {
  status: "stopped",
  message: "Ngrok chưa chạy",
  domain: "",
  public_url: "",
  pid: null,
  executable: "",
  last_error: null,
  updated_at: new Date().toISOString(),
};

/** Read authtoken from official Ngrok config on this machine (agent already logged in). */
export function readSystemNgrokAuthtoken() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "ngrok", "ngrok.yml"),
    path.join(os.homedir(), ".ngrok2", "ngrok.yml"),
    path.join(os.homedir(), ".config", "ngrok", "ngrok.yml"),
  ].filter((p) => p && !p.startsWith(path.sep + path.sep) && p.length > 12);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      const m = text.match(/^\s*authtoken\s*:\s*(\S+)\s*$/m);
      const token = (m?.[1] || "").trim().replace(/^["']|["']$/g, "");
      if (token.length >= 20) return token;
    } catch {
      /* try next */
    }
  }
  return "";
}

/**
 * If .env has empty NGROK_AUTHTOKEN but the PC already has a system token,
 * import it once so admin/dev machines do not show "needs_token" forever.
 */
export function ensureNgrokTokenFromSystem() {
  if (String(process.env.NGROK_AUTHTOKEN || "").trim()) {
    return { ok: true, source: "env", token: process.env.NGROK_AUTHTOKEN };
  }
  const token = readSystemNgrokAuthtoken();
  if (!token) return { ok: false, source: "none", token: "" };
  process.env.NGROK_AUTHTOKEN = token;
  try {
    const envPath = getEnvPath();
    if (fs.existsSync(envPath)) {
      let body = fs.readFileSync(envPath, "utf8");
      if (/^NGROK_AUTHTOKEN=/m.test(body)) {
        body = body.replace(/^NGROK_AUTHTOKEN=.*$/m, `NGROK_AUTHTOKEN=${token}`);
      } else {
        body = body.trimEnd() + `\nNGROK_AUTHTOKEN=${token}\n`;
      }
      if (!/^NGROK_AUTOSTART=/m.test(body)) {
        body = body.trimEnd() + `\nNGROK_AUTOSTART=1\n`;
      }
      fs.writeFileSync(envPath, body, "utf8");
    }
  } catch (e) {
    console.warn("[ngrok] could not persist system token to .env:", e.message);
  }
  console.log("[ngrok] Imported Authtoken from system ngrok.yml");
  return { ok: true, source: "system", token };
}
const update = (v) =>
  Object.assign(state, v, { updated_at: new Date().toISOString() });
function domainOf(v) {
  try {
    return new URL(/^https?:\/\//i.test(String(v || "")) ? v : `https://${v}`)
      .hostname;
  } catch {
    return "";
  }
}
function isLocalHostname(domain) {
  const host = String(domain || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}
function findExe() {
  const local = [
    path.join(getExeDir(), "ngrok.exe"),
    path.join(getExeDir(), "ngrok", "ngrok.exe"),
  ].find((p) => fs.existsSync(p));
  if (local) return local;
  const r = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["ngrok"],
    { encoding: "utf8", windowsHide: true },
  );
  return r.status === 0
    ? String(r.stdout || "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .find(Boolean) || ""
    : "";
}
function quotePs(v) {
  return String(v).replaceAll("'", "''");
}
async function ensureExe() {
  let exe = findExe();
  if (exe) return exe;
  if (process.platform !== "win32")
    throw new Error("Chưa cài Ngrok trên máy này.");
  update({ status: "installing", message: "Đang tự tải Ngrok…" });
  const dir = path.join(getExeDir(), "ngrok"),
    zip = path.join(dir, "ngrok-win.zip");
  fs.mkdirSync(dir, { recursive: true });
  const cmd = `$ErrorActionPreference='Stop';[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;Invoke-WebRequest -UseBasicParsing '${quotePs(DOWNLOAD_URL)}' -OutFile '${quotePs(zip)}';Expand-Archive -LiteralPath '${quotePs(zip)}' -DestinationPath '${quotePs(dir)}' -Force`;
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
    { encoding: "utf8", windowsHide: true, timeout: 120000 },
  );
  exe = path.join(dir, "ngrok.exe");
  if (r.status !== 0 || !fs.existsSync(exe))
    throw new Error(
      `Không tự tải được Ngrok: ${String(r.stderr || r.stdout || "").trim()}`,
    );
  try {
    fs.unlinkSync(zip);
  } catch {}
  return exe;
}
function configure(exe, token) {
  const r = spawnSync(exe, ["config", "add-authtoken", token], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  if (r.status !== 0)
    throw new Error(
      String(r.stderr || r.stdout || "Token Ngrok không hợp lệ").trim(),
    );
}
async function inspectLocalTunnel(domain, port) {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(1200),
    });
    const body = await response.json();
    const tunnel = (body.tunnels || []).find(
      (item) => domainOf(item.public_url) === domain,
    );
    if (!tunnel?.public_url) return null;
    const addr = String(tunnel.config?.addr || "");
    const match = addr.match(/:(\d+)(?:\/)?$/);
    return {
      public_url: tunnel.public_url,
      addr,
      same_port: match ? Number(match[1]) === Number(port) : false,
    };
  } catch {
    return null;
  }
}
async function waitTunnel(domain, proc) {
  const end = Date.now() + 15000;
  while (Date.now() < end && child === proc) {
    const tunnel = await inspectLocalTunnel(domain, null);
    if (tunnel?.public_url) return tunnel.public_url;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}
function classifyFailure(detail, domain) {
  const text = String(detail || "").trim();
  if (/authtoken|authentication|ERR_NGROK_10[0-9]|invalid token/i.test(text)) {
    return {
      status: "needs_token",
      message: "Authtoken Ngrok sai hoặc đã bị thu hồi. Hãy nhập token mới.",
      last_error: "Ngrok từ chối Authtoken trên máy này.",
    };
  }
  if (/ERR_NGROK_334|endpoint.+already online/i.test(text)) {
    return {
      status: "domain_busy",
      message:
        "Domain " + domain + " đang online ở máy/phiên Ngrok khác (ERR_NGROK_334).",
      last_error:
        "Vào https://dashboard.ngrok.com/endpoints → Stop endpoint " +
        domain +
        " (hoặc tắt app/ngrok trên máy kia) rồi bấm Mở lại Ngrok. Không bật pooling cho OAuth vì callback có thể về sai máy.",
    };
  }
  if (/ERR_NGROK_314|custom hostname.+localhost|only paid plans may create endpoints/i.test(text)) {
    return {
      status: "needs_domain",
      message: "APP_BASE_URL đang là localhost; hãy nhập domain Ngrok công khai trước khi mở tunnel.",
      last_error: "Không được dùng localhost làm custom hostname Ngrok. Ví dụ: https://qgroup.ngrok.app",
    };
  }
  return {
    status: "error",
    message: "Không thể tự mở Ngrok.",
    last_error: text.slice(-900) || "Ngrok không tạo được tunnel.",
  };
}
export const getNgrokStatus = () => ({
  ...state,
  token_configured: Boolean(String(process.env.NGROK_AUTHTOKEN || "").trim()),
});
export async function stopNgrok() {
  stopRequested = true;
  const proc = child;
  child = null;
  if (proc && !proc.killed && proc.exitCode == null) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      proc.once("exit", finish);
      try {
        proc.kill();
      } catch {
        finish();
      }
      setTimeout(finish, 1500);
    });
  }
  update({
    status: "stopped",
    message: "Ngrok chưa chạy",
    pid: null,
    public_url: "",
  });
}
export async function startNgrok({
  token = process.env.NGROK_AUTHTOKEN,
  origin = process.env.APP_BASE_URL,
  port = process.env.PORT || 3847,
} = {}) {
  if (starting) return starting;
  starting = (async () => {
    const domain = domainOf(origin);
    let auth = String(token || process.env.NGROK_AUTHTOKEN || "").trim();
    if (!auth) {
      const boot = ensureNgrokTokenFromSystem();
      auth = String(boot.token || "").trim();
    }
    if (!domain) throw new Error("Chưa có domain Ngrok hợp lệ");
    if (isLocalHostname(domain)) {
      update({
        status: "needs_domain",
        message: "Chưa cấu hình domain Ngrok công khai; không thể mở tunnel với localhost.",
        domain,
        public_url: "",
        last_error: "APP_BASE_URL đang là localhost. Vào Kết nối Meta → Domain OAuth và nhập domain HTTPS của Ngrok.",
      });
      return getNgrokStatus();
    }
    if (!auth) {
      update({
        status: "needs_token",
        message: "Chưa có Authtoken Ngrok. Hãy nhập token mới.",
        domain,
        last_error: "Thiếu NGROK_AUTHTOKEN",
      });
      return getNgrokStatus();
    }
    const local = await inspectLocalTunnel(domain, port);
    if (local?.same_port) {
      update({
        status: "running",
        message: "Ngrok đang chạy · đã dùng lại tunnel cục bộ",
        domain,
        public_url: local.public_url,
        pid: null,
        last_error: null,
      });
      return getNgrokStatus();
    }
    if (local) {
      update({
        status: "domain_busy",
        message: "Domain " + domain + " đang chạy ở cổng khác trên máy này.",
        domain,
        public_url: local.public_url,
        pid: null,
        last_error:
          "Tunnel hiện tại đang trỏ tới " +
          (local.addr || "cổng khác") +
          ". Hãy tắt tiến trình Ngrok cũ rồi mở lại.",
      });
      return getNgrokStatus();
    }
    await stopNgrok();
    stopRequested = false;
    let output = [];
    try {
      update({
        status: "starting",
        message: "Đang khởi động Ngrok…",
        domain,
        public_url: "",
        last_error: null,
      });
      const exe = await ensureExe();
      configure(exe, auth);
      if (stopRequested) return getNgrokStatus();
      const proc = spawn(
        exe,
        ["http", `127.0.0.1:${port}`, `--url=https://${domain}`],
        {
          cwd: getExeDir(),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child = proc;
      update({ executable: exe, pid: proc.pid });
      const capture = (d) => {
        const s = String(d || "").trim();
        if (s) output.push(s);
        if (output.length > 20) output.shift();
      };
      proc.stdout.on("data", capture);
      proc.stderr.on("data", capture);
      proc.on("exit", (code) => {
        const current = child === proc;
        if (current) child = null;
        if (!stopRequested && current) {
          const detail =
            output.join("\n").slice(-1800) || `Ngrok dừng (exit ${code})`;
          const failure = classifyFailure(detail, domain);
          update({
            ...failure,
            pid: null,
            public_url: "",
          });
        }
      });
      const url = await waitTunnel(domain, proc);
      if (!url) {
        const detail = output.join("\n").slice(-1800);
        throw new Error(
          detail || "Ngrok không tạo được tunnel cho domain đã chọn",
        );
      }
      update({
        status: "running",
        message: "Ngrok đang chạy",
        public_url: url,
        pid: proc.pid,
        last_error: null,
      });
      return getNgrokStatus();
    } catch (e) {
      const failure = classifyFailure(e.message, domain);
      await stopNgrok();
      update({
        ...failure,
        domain,
      });
      return getNgrokStatus();
    }
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}
