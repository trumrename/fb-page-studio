/**
 * Explorer-style folder picker for selecting media/caption libraries.
 * Works from Node server (including Electron child process).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execFileAsync = promisify(execFile);

/**
 * @param {{ title?: string, initialDir?: string }} opts
 * @returns {Promise<string|null>} absolute path or null if cancelled
 */
export async function pickFolder(opts = {}) {
  const title = String(opts.title || "Chọn thư mục").replace(/'/g, "''");
  let initial = opts.initialDir ? path.resolve(String(opts.initialDir)) : "";
  if (initial && !fs.existsSync(initial)) initial = path.dirname(initial);
  if (initial && !fs.existsSync(initial)) initial = "";

  if (process.platform === "win32") {
    const initLine = initial
      ? `$f.InitialDirectory = '${initial.replace(/'/g, "''")}';`
      : "";
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$f = New-Object System.Windows.Forms.OpenFileDialog",
      `$f.Title = '${title}'`,
      "$f.Filter = 'Thư mục|*.folder'",
      "$f.FileName = 'Chọn thư mục này'",
      "$f.CheckFileExists = $false",
      "$f.CheckPathExists = $true",
      "$f.ValidateNames = $false",
      "$f.DereferenceLinks = $true",
      "$f.RestoreDirectory = $true",
      initLine,
      "$r = $f.ShowDialog()",
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ([System.IO.Path]::GetDirectoryName($f.FileName)) }",
    ]
      .filter(Boolean)
      .join("; ");

    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-STA", "-Command", ps],
        { windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 }
      );
      const p = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
      if (p && fs.existsSync(p)) return path.resolve(p);
      return null;
    } catch (e) {
      throw new Error(`Không mở được hộp chọn thư mục: ${e.message}`);
    }
  }

  // Non-Windows: return null — UI keeps manual path
  throw new Error("Chọn thư mục GUI hiện hỗ trợ Windows. Gõ đường dẫn tay.");
}
