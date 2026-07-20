#Requires -Version 5.1
<#
  Cài OAuth Relay + Cloudflare Tunnel trên máy Windows treo 24/7.
  Chạy:  CAI-MAY-SERVER.bat  (Run as Administrator khuyến nghị)
#>
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# script is in project\server-setup → parent is project root
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not (Test-Path (Join-Path $ProjectRoot "oauth-relay\server.mjs"))) {
  Write-Host "ERROR: Khong tim thay oauth-relay\server.mjs tai $ProjectRoot" -ForegroundColor Red
  exit 1
}

$DomainDefault = "modelswiki.top"
$RelayDir = Join-Path $ProjectRoot "oauth-relay"
$SetupDir = Join-Path $ProjectRoot "server-setup"
$CloudDir = Join-Path $env:USERPROFILE ".cloudflared"
$TunnelName = "fb-oauth-relay"

function Write-Title($t) {
  Write-Host ""
  Write-Host "==== $t ====" -ForegroundColor Cyan
}
function Write-Ok($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Write-Warn($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Write-Info($t) { Write-Host "  $t" }

Write-Host ""
Write-Host "  FB Page Studio — Cai may SERVER (treo nha)" -ForegroundColor White
Write-Host "  Project: $ProjectRoot" -ForegroundColor DarkGray
Write-Host ""

# --- Domain ---
Write-Title "1) Domain"
$Domain = Read-Host "Domain OAuth [Enter = $DomainDefault]"
if ([string]::IsNullOrWhiteSpace($Domain)) { $Domain = $DomainDefault }
$Domain = $Domain.Trim().ToLower().Replace("https://", "").Replace("http://", "").TrimEnd("/")
$PublicUrl = "https://$Domain"
$RedirectUri = "$PublicUrl/auth/facebook/callback"
Write-Ok "Public: $PublicUrl"
Write-Ok "Meta Redirect URI: $RedirectUri"

# --- Meta ---
Write-Title "2) Meta App (secret chi luu tren may nay)"
$AppId = Read-Host "FB_APP_ID"
$AppSecret = Read-Host "FB_APP_SECRET"
if ([string]::IsNullOrWhiteSpace($AppId) -or [string]::IsNullOrWhiteSpace($AppSecret)) {
  Write-Host "Can FB_APP_ID va FB_APP_SECRET. Thoat." -ForegroundColor Red
  exit 1
}

# --- Node ---
Write-Title "3) Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warn "Chua co Node. Thu cai bang winget..."
  try {
    winget install OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  } catch {
    Write-Host "Cai Node that bai. Tai https://nodejs.org (LTS) roi chay lai script." -ForegroundColor Red
    exit 1
  }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  $node = Get-Command node -ErrorAction SilentlyContinue
}
if (-not $node) {
  Write-Host "Van khong thay node trong PATH. Mo lai PowerShell sau khi cai Node." -ForegroundColor Red
  exit 1
}
Write-Ok "Node: $(node -v)"

# --- Write oauth-relay .env ---
Write-Title "4) Tao oauth-relay\.env"
$envPath = Join-Path $RelayDir ".env"
$envBody = @"
PORT=8080
LISTEN_HOST=127.0.0.1

RELAY_PUBLIC_URL=$PublicUrl
FB_REDIRECT_URI=$RedirectUri

RELAY_EXCHANGE=1
FB_APP_ID=$AppId
FB_APP_SECRET=$AppSecret

FB_GRAPH_VERSION=v21.0
DEFAULT_LOCAL_PORT=3847
"@
Set-Content -Path $envPath -Value $envBody -Encoding UTF8
try { icacls $envPath /inheritance:r /grant:r "$env:USERNAME:(R,W)" | Out-Null } catch { }
Write-Ok "Da ghi $envPath"

# --- Test relay start briefly ---
Write-Title "5) Kiem tra relay local"
$job = Start-Job -ScriptBlock {
  param($root)
  Set-Location $root
  node oauth-relay\server.mjs
} -ArgumentList $ProjectRoot
Start-Sleep -Seconds 2
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 5
  if ($h.ok) { Write-Ok "Relay health OK (exchange=$($h.exchange))" }
  else { Write-Warn "Health tra ve bat thuong" }
} catch {
  Write-Warn "Chua ping duoc health (se thu lai sau khi chay CHAY-SERVER). $_"
}
Stop-Job $job -ErrorAction SilentlyContinue
Remove-Job $job -Force -ErrorAction SilentlyContinue
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
  try { $_.Path -like "*node*" } catch { $false }
} | ForEach-Object {
  # don't kill all node - only if we can match
}

# Kill anything on 8080 from test
try {
  $c = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
  if ($c) {
    $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
} catch { }

# --- cloudflared ---
Write-Title "6) Cloudflare Tunnel (cloudflared)"
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
  Write-Info "Dang cai cloudflared bang winget..."
  try {
    winget install --id Cloudflare.cloudflared -e --accept-package-agreements --accept-source-agreements
  } catch {
    Write-Warn "winget that bai. Tai cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
  }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  $cf = Get-Command cloudflared -ErrorAction SilentlyContinue
}
if (-not $cf) {
  Write-Warn "Chua co cloudflared trong PATH. Cai xong mo lai script hoac them vao PATH."
  Write-Info "Bo qua buoc tunnel — anh cai cloudflared roi chay: server-setup\setup-tunnel-only.ps1"
} else {
  Write-Ok "cloudflared: $(cloudflared --version 2>&1 | Select-Object -First 1)"

  Write-Host ""
  Write-Host "  Buoc bat buoc 1 lan: dang nhap Cloudflare (mo trinh duyet)." -ForegroundColor Yellow
  Write-Host "  Chon domain chainityai.com khi duoc hoi." -ForegroundColor Yellow
  $doLogin = Read-Host "Chay 'cloudflared tunnel login' bay gio? [Y/n]"
  if ($doLogin -eq "" -or $doLogin -match '^[Yy]') {
    cloudflared tunnel login
    Write-Ok "Login xong (neu khong loi)"
  }

  New-Item -ItemType Directory -Force -Path $CloudDir | Out-Null

  # Create tunnel if missing
  $list = cloudflared tunnel list 2>&1 | Out-String
  if ($list -notmatch [regex]::Escape($TunnelName)) {
    Write-Info "Tao tunnel: $TunnelName"
    cloudflared tunnel create $TunnelName
  } else {
    Write-Ok "Tunnel '$TunnelName' da ton tai"
  }

  # Find credentials json (newest in .cloudflared)
  $cred = Get-ChildItem $CloudDir -Filter "*.json" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "cert.pem" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $cred) {
    Write-Warn "Khong thay file credentials .json trong $CloudDir — chay lai tunnel create / login."
  } else {
    # Prefer json that is not cert
    $allJson = Get-ChildItem $CloudDir -Filter "*.json" -ErrorAction SilentlyContinue
    # tunnel id files look like uuid.json
    $cred = $allJson | Where-Object { $_.BaseName -match '^[0-9a-f]{8}-' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $cred) { $cred = $allJson | Select-Object -First 1 }

    $configPath = Join-Path $CloudDir "config.yml"
    $credPath = $cred.FullName.Replace("\", "/")
    # Windows path in yaml often backslash - use quoted windows path
    $configYaml = @"
tunnel: $TunnelName
credentials-file: $($cred.FullName)

ingress:
  - hostname: $Domain
    service: http://127.0.0.1:8080
  - service: http_status:404
"@
    Set-Content -Path $configPath -Value $configYaml -Encoding UTF8
    Write-Ok "Da ghi $configPath"

    Write-Info "Gan DNS $Domain vao tunnel..."
    try {
      cloudflared tunnel route dns $TunnelName $Domain 2>&1 | Write-Host
      Write-Ok "route dns OK (hoac da ton tai)"
    } catch {
      Write-Warn "route dns: $_ — co the tao CNAME thu cong tren Cloudflare: $Domain -> <tunnel-id>.cfargotunnel.com"
    }
  }
}

# --- Startup scripts ---
Write-Title "7) File chay 1 nut + Startup"
$runAll = Join-Path $ProjectRoot "CHAY-SERVER-TAT-CA.bat"
$runAllBody = @"
@echo off
chcp 65001 >nul
cd /d "$ProjectRoot"
title FB Page Studio SERVER - Relay + Tunnel
echo.
echo  Domain: $PublicUrl
echo  1) OAuth Relay  :8080
echo  2) Cloudflare Tunnel
echo  Giu cua so nay / 2 process chay 24/7
echo.

start "OAuth-Relay" cmd /k "cd /d `"$ProjectRoot`" && node oauth-relay\server.mjs"
timeout /t 2 /nobreak >nul
where cloudflared >nul 2>&1
if errorlevel 1 (
  echo [CANH BAO] Chua co cloudflared trong PATH.
  echo Chi chay relay local. Cai cloudflared roi chay lai.
  pause
  exit /b 1
)
start "Cloudflare-Tunnel" cmd /k "cloudflared tunnel run $TunnelName"
echo.
echo Da mo 2 cua so. Kiem tra: $PublicUrl/health
echo Meta Redirect: $RedirectUri
pause
"@
Set-Content -Path $runAll -Value $runAllBody -Encoding ASCII
Write-Ok "Tao $runAll"

# Startup folder shortcuts
$startup = [Environment]::GetFolderPath("Startup")
$doStart = Read-Host "Tu chay khi bat Windows (them vao Startup)? [Y/n]"
if ($doStart -eq "" -or $doStart -match '^[Yy]') {
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut((Join-Path $startup "FB-Page-Studio-Server.lnk"))
  $sc.TargetPath = $runAll
  $sc.WorkingDirectory = $ProjectRoot
  $sc.Save()
  Write-Ok "Da them shortcut Startup: $startup"
}

# --- Meta reminder ---
Write-Title "8) Meta Developers (anh lam 1 phut tren web)"
Write-Host ""
Write-Host "  Valid OAuth Redirect URIs  =  $RedirectUri" -ForegroundColor Yellow
Write-Host "  (Facebook Login → Settings → Save)" -ForegroundColor Yellow
Write-Host ""

# --- Summary ---
Write-Title "XONG CAI DAT"
Write-Info "1. Chay:  CHAY-SERVER-TAT-CA.bat"
Write-Info "2. Doi 30s, mo dien thoai 4G:  $PublicUrl/health"
Write-Info "3. Meta: them Redirect URI o tren"
Write-Info "4. May admin: npm run pack:both  (FB_REDIRECT_URI=$RedirectUri)"
Write-Info "5. Khach: mo EXE → Connect FB"
Write-Host ""
Write-Host "  File huong dan: HUONG-DAN-DOMAIN-MAY-TREO-NHA.md" -ForegroundColor DarkGray
Write-Host ""

$runNow = Read-Host "Chay server (relay + tunnel) ngay bay gio? [Y/n]"
if ($runNow -eq "" -or $runNow -match '^[Yy]') {
  Start-Process -FilePath $runAll
}

Write-Host "Xong." -ForegroundColor Green
