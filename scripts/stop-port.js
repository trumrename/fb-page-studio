/**
 * Free PORT (default 3847) on Windows / Unix so npm start can bind again.
 */
import { execSync } from "child_process";
import dotenv from "dotenv";

dotenv.config();
const port = Number(process.env.PORT || 3847);

function killPort(p) {
  if (process.platform === "win32") {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
        { encoding: "utf8" }
      );
      const pids = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
          console.log(`Stopped PID ${pid} (port ${p})`);
        } catch {
          /* already gone */
        }
      }
      if (!pids.length) console.log(`Port ${p} is free`);
    } catch {
      console.log(`Port ${p} is free (or could not query)`);
    }
  } else {
    try {
      execSync(`lsof -ti:${p} | xargs -r kill -9`, { stdio: "ignore" });
      console.log(`Freed port ${p}`);
    } catch {
      console.log(`Port ${p} is free`);
    }
  }
}

killPort(port);
