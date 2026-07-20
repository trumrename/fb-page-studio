#Requires -Version 5.1
# Install OAuth Relay + Cloudflare Tunnel inside pack-server folder.
# Run via: CAI-MAY-SERVER.bat

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ProjectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$RelayScript = Join-Path $ProjectRoot 'oauth-relay\server.mjs'

# If user ran bat from wrong folder or extracted zip without oauth-relay, try parent
if (-not (Test-Path -LiteralPath $RelayScript)) {
  $alt = Join-Path $ProjectRoot 'pack-server\oauth-relay\server.mjs'
  if (Test-Path -LiteralPath $alt) {
    $ProjectRoot = Join-Path $ProjectRoot 'pack-server'
    $RelayScript = $alt
  }
}
if (-not (Test-Path -LiteralPath $RelayScript)) {
  Write-Host ''
  Write-Host 'ERROR: Missing oauth-relay\server.mjs' -ForegroundColor Red
  Write-Host "Current folder: $ProjectRoot" -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Ban can copy DAY DU folder pack-server, gom ca:' -ForegroundColor Yellow
  Write-Host '  pack-server\'
  Write-Host '    CAI-MAY-SERVER.bat'
  Write-Host '    CHAY-SERVER-TAT-CA.bat'
  Write-Host '    install-server.ps1'
  Write-Host '    oauth-relay\'
  Write-Host '      server.mjs'
  Write-Host '      .env.example'
  Write-Host ''
  Write-Host 'Cach dung zip dung:' -ForegroundColor Cyan
  Write-Host '  1. Copy FB-Page-Studio-pack-server.zip sang may server'
  Write-Host '  2. Giai nen (Extract All) - se co folder pack-server'
  Write-Host '  3. Vao trong pack-server, chay CAI-MAY-SERVER.bat'
  Write-Host ''
  Write-Host 'Files hien co trong folder nay:' -ForegroundColor DarkGray
  Get-ChildItem -LiteralPath $ProjectRoot -Force -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host ('  - ' + $_.Name) }
  exit 1
}

$DomainDefault = 'videoviral1.chainityai.com'
$RelayDir = Join-Path $ProjectRoot 'oauth-relay'
$CloudDir = Join-Path $env:USERPROFILE '.cloudflared'
$TunnelName = 'fb-oauth-relay'

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host "==== $Text ====" -ForegroundColor Cyan
}
function Write-Ok([string]$Text) {
  Write-Host "  [OK] $Text" -ForegroundColor Green
}
function Write-Warn([string]$Text) {
  Write-Host "  [!] $Text" -ForegroundColor Yellow
}
function Write-Info([string]$Text) {
  Write-Host "  $Text"
}
function Refresh-PathEnv {
  $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = $machine + ';' + $user
}

Write-Host ''
Write-Host '  FB Page Studio - pack-server (home server PC)' -ForegroundColor White
Write-Host "  Folder: $ProjectRoot" -ForegroundColor DarkGray
Write-Host ''

Write-Step '1 - Domain'
$DomainIn = Read-Host "Domain OAuth [Enter = $DomainDefault]"
if ([string]::IsNullOrWhiteSpace($DomainIn)) {
  $Domain = $DomainDefault
} else {
  $Domain = $DomainIn.Trim().ToLowerInvariant()
  $Domain = $Domain -replace '^https?://', ''
  $Domain = $Domain.TrimEnd('/')
}
$PublicUrl = 'https://' + $Domain
$RedirectUri = $PublicUrl + '/auth/facebook/callback'
Write-Ok "Public: $PublicUrl"
Write-Ok "Meta Redirect: $RedirectUri"

Write-Step '2 - Meta App (secret only on this PC)'
$AppId = Read-Host 'FB_APP_ID'
$AppSecret = Read-Host 'FB_APP_SECRET'
if ([string]::IsNullOrWhiteSpace($AppId) -or [string]::IsNullOrWhiteSpace($AppSecret)) {
  Write-Host 'Need FB_APP_ID and FB_APP_SECRET.' -ForegroundColor Red
  exit 1
}

Write-Step '3 - Node.js'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Warn 'Node not found. Trying winget install...'
  try {
    winget install OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  } catch {
    Write-Host 'Install Node failed. Download LTS from https://nodejs.org then re-run.' -ForegroundColor Red
    exit 1
  }
  Refresh-PathEnv
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
}
if (-not $nodeCmd) {
  Write-Host 'node still not in PATH. Open a new terminal after install.' -ForegroundColor Red
  exit 1
}
Write-Ok ('Node: ' + (& node -v))

Write-Step '4 - Create oauth-relay\.env'
$envLines = @(
  'PORT=8080',
  'LISTEN_HOST=127.0.0.1',
  '',
  ('RELAY_PUBLIC_URL=' + $PublicUrl),
  ('FB_REDIRECT_URI=' + $RedirectUri),
  '',
  'RELAY_EXCHANGE=1',
  ('FB_APP_ID=' + $AppId),
  ('FB_APP_SECRET=' + $AppSecret),
  '',
  'FB_GRAPH_VERSION=v21.0',
  'DEFAULT_LOCAL_PORT=3847',
  ''
)
$envPath = Join-Path $RelayDir '.env'
[System.IO.File]::WriteAllText($envPath, ($envLines -join "`r`n"), [System.Text.UTF8Encoding]::new($false))
Write-Ok "Wrote: $envPath"

Write-Step '5 - Test relay local'
$relayProc = $null
try {
  $relayProc = Start-Process -FilePath 'node' -ArgumentList @('oauth-relay\server.mjs') `
    -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 5
  if ($health.ok) {
    Write-Ok ('Relay health OK exchange=' + $health.exchange)
  } else {
    Write-Warn 'Health returned unexpected body'
  }
} catch {
  Write-Warn ('Health ping failed: ' + $_.Exception.Message)
} finally {
  if ($null -ne $relayProc -and -not $relayProc.HasExited) {
    Stop-Process -Id $relayProc.Id -Force -ErrorAction SilentlyContinue
  }
  try {
    Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch {}
}

function Get-CloudflaredCertPath {
  return (Join-Path $CloudDir 'cert.pem')
}

function Test-CloudflaredCert {
  $p = Get-CloudflaredCertPath
  return (Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p).Length -gt 100)
}

function Find-DownloadedCertPem {
  $names = @('cert.pem', 'cert.pem.crdownload')
  $dirs = @(
    [Environment]::GetFolderPath('UserProfile') + '\Downloads',
    [Environment]::GetFolderPath('Desktop'),
    $CloudDir,
    $ProjectRoot,
    (Join-Path $env:USERPROFILE 'Downloads')
  ) | Select-Object -Unique

  $found = @()
  foreach ($d in $dirs) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    foreach ($n in $names) {
      $p = Join-Path $d $n
      if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p).Length -gt 100)) {
        $found += Get-Item -LiteralPath $p
      }
    }
    # Browser may save as random name containing pem
    Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue |
      Where-Object {
        ($_.Extension -eq '.pem' -or $_.Name -match 'cert') -and
        $_.Length -gt 100 -and
        $_.LastWriteTime -gt (Get-Date).AddHours(-24)
      } |
      ForEach-Object { $found += $_ }
  }
  return $found | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Ensure-CloudflaredCert {
  New-Item -ItemType Directory -Force -Path $CloudDir | Out-Null
  $dest = Get-CloudflaredCertPath

  if (Test-CloudflaredCert) {
    Write-Ok ("cert.pem OK: " + $dest)
    $env:TUNNEL_ORIGIN_CERT = $dest
    return $true
  }

  Write-Warn 'cert.pem missing - trying to find downloaded cert...'
  $src = Find-DownloadedCertPem
  if ($src) {
    Copy-Item -LiteralPath $src.FullName -Destination $dest -Force
    Write-Ok ("Copied cert from: " + $src.FullName)
    Write-Ok ("To: " + $dest)
    $env:TUNNEL_ORIGIN_CERT = $dest
    return (Test-CloudflaredCert)
  }

  Write-Host ''
  Write-Host '  Cloudflare could not auto-save cert.pem.' -ForegroundColor Yellow
  Write-Host '  If browser DOWNLOADED a file, paste full path below.' -ForegroundColor Yellow
  Write-Host '  Example: C:\Users\PC\Downloads\cert.pem' -ForegroundColor DarkGray
  Write-Host ''
  $manual = Read-Host 'Full path to downloaded cert file (or Enter to skip)'
  if (-not [string]::IsNullOrWhiteSpace($manual)) {
    $manual = $manual.Trim().Trim('"')
    if (Test-Path -LiteralPath $manual) {
      Copy-Item -LiteralPath $manual -Destination $dest -Force
      Write-Ok ("Installed cert.pem -> " + $dest)
      $env:TUNNEL_ORIGIN_CERT = $dest
      return (Test-CloudflaredCert)
    }
    Write-Warn 'Path not found.'
  }
  return $false
}

function Invoke-Cloudflared {
  param([string[]]$CfArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = & cloudflared @CfArgs 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  $text = ($out | Out-String)
  return @{ Code = $code; Text = $text; Lines = $out }
}

Write-Step '6 - Cloudflare Tunnel'
$cfCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cfCmd) {
  Write-Info 'Installing cloudflared via winget...'
  try {
    winget install --id Cloudflare.cloudflared -e --accept-package-agreements --accept-source-agreements
  } catch {
    Write-Warn 'winget failed. Install cloudflared manually then re-run.'
  }
  Refresh-PathEnv
  $cfCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
}

if (-not $cfCmd) {
  Write-Warn 'cloudflared not in PATH. Install it then re-run CAI-MAY-SERVER.bat'
} else {
  $cfVer = (Invoke-Cloudflared @('--version')).Text.Trim()
  Write-Ok ("cloudflared: " + $cfVer)

  New-Item -ItemType Directory -Force -Path $CloudDir | Out-Null
  $env:TUNNEL_ORIGIN_CERT = (Get-CloudflaredCertPath)

  $needLogin = -not (Test-CloudflaredCert)
  if ($needLogin) {
    Write-Host ''
    Write-Host '  Cloudflare login required (browser will open).' -ForegroundColor Yellow
    Write-Host '  1. Login Cloudflare account that owns your domain DNS' -ForegroundColor Yellow
    Write-Host '  2. Authorize the domain zone' -ForegroundColor Yellow
    Write-Host '  3. If browser DOWNLOADS a file, come back here - script will install it' -ForegroundColor Yellow
    Write-Host ''
    $doLogin = Read-Host 'Run cloudflared tunnel login now? [Y/n]'
    if ($doLogin -eq '' -or $doLogin -match '^[Yy]') {
      Write-Info 'Starting login (wait for browser)...'
      $loginRes = Invoke-Cloudflared @('tunnel', 'login')
      Write-Host $loginRes.Text
      if ($loginRes.Text -match 'cert\.pem|Successful|You have successfully') {
        Write-Info 'Login command finished - checking cert.pem...'
      }
    }
  } else {
    Write-Ok 'cert.pem already present - skip login (optional re-login below)'
    $reLogin = Read-Host 'Re-run cloudflared tunnel login? [y/N]'
    if ($reLogin -match '^[Yy]') {
      Invoke-Cloudflared @('tunnel', 'login') | ForEach-Object { Write-Host $_.Text }
    }
  }

  $certOk = Ensure-CloudflaredCert
  if (-not $certOk) {
    Write-Host ''
    Write-Host '  LOGIN CHUA XONG - thieu cert.pem' -ForegroundColor Red
    Write-Host '  Fix:' -ForegroundColor Yellow
    Write-Host '    1. Chay: cloudflared tunnel login' -ForegroundColor White
    Write-Host '    2. Neu browser tai file, copy vao:' -ForegroundColor White
    Write-Host ('       ' + (Get-CloudflaredCertPath)) -ForegroundColor Cyan
    Write-Host '    3. Chay lai CAI-MAY-SERVER.bat' -ForegroundColor White
    Write-Host '    4. Hoac chay: FIX-CLOUDFLARE-CERT.bat' -ForegroundColor White
    Write-Host ''
    Write-Warn 'Bo qua tao tunnel. Relay .env van da tao - co the chay CHAY-RELAY-ONLY.bat'
  } else {
    $env:TUNNEL_ORIGIN_CERT = (Get-CloudflaredCertPath)

    $listRes = Invoke-Cloudflared @('tunnel', 'list')
    Write-Host $listRes.Text
    if ($listRes.Code -ne 0 -and $listRes.Text -match 'cert|originCert|origincert') {
      Write-Warn 'tunnel list failed - cert still invalid. Re-login.'
    } else {
      if ($listRes.Text -notmatch [regex]::Escape($TunnelName)) {
        Write-Info ("Create tunnel: " + $TunnelName)
        $createRes = Invoke-Cloudflared @('tunnel', 'create', $TunnelName)
        Write-Host $createRes.Text
        if ($createRes.Code -ne 0) {
          Write-Warn 'tunnel create failed - see output above'
        } else {
          Write-Ok ("Tunnel created: " + $TunnelName)
        }
      } else {
        Write-Ok ("Tunnel exists: " + $TunnelName)
      }

      $cred = Get-ChildItem -LiteralPath $CloudDir -Filter '*.json' -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -match '^[0-9a-f]{8}-' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

      if (-not $cred) {
        Write-Warn ("No tunnel credentials json in " + $CloudDir)
        Write-Warn 'Run: cloudflared tunnel create fb-oauth-relay'
      } else {
        $configPath = Join-Path $CloudDir 'config.yml'
        $configText = @(
          ('tunnel: ' + $TunnelName),
          ('credentials-file: ' + $cred.FullName),
          ('origincert: ' + (Get-CloudflaredCertPath)),
          '',
          'ingress:',
          ('  - hostname: ' + $Domain),
          '    service: http://127.0.0.1:8080',
          '  - service: http_status:404',
          ''
        ) -join "`r`n"
        [System.IO.File]::WriteAllText($configPath, $configText, [System.Text.UTF8Encoding]::new($false))
        Write-Ok ("Wrote " + $configPath)

        Write-Info ("Route DNS " + $Domain + " ...")
        $routeRes = Invoke-Cloudflared @('tunnel', 'route', 'dns', $TunnelName, $Domain)
        Write-Host $routeRes.Text
        if ($routeRes.Code -eq 0 -or $routeRes.Text -match 'already|success|CNAME|added|Updated') {
          Write-Ok 'route dns OK (or already exists)'
        } else {
          Write-Warn 'route dns may need manual CNAME in Cloudflare Dashboard'
        }
      }
    }
  }
}

Write-Step '7 - Windows Startup optional'
$runAll = Join-Path $ProjectRoot 'CHAY-SERVER-TAT-CA.bat'
$doStart = Read-Host 'Add to Windows Startup? [Y/n]'
if ($doStart -eq '' -or $doStart -match '^[Yy]') {
  $startup = [Environment]::GetFolderPath('Startup')
  $lnkPath = Join-Path $startup 'FB-OAuth-Server.lnk'
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($lnkPath)
  $sc.TargetPath = $runAll
  $sc.WorkingDirectory = $ProjectRoot
  $sc.Save()
  Write-Ok ("Startup shortcut: " + $lnkPath)
}

Write-Step '8 - Meta Developers (do this on website)'
Write-Host ''
Write-Host ('  Valid OAuth Redirect URIs  =  ' + $RedirectUri) -ForegroundColor Yellow
Write-Host '  Facebook Login -> Settings -> Save' -ForegroundColor Yellow
Write-Host ''

Write-Step 'DONE'
Write-Info '1. Run: CHAY-SERVER-TAT-CA.bat'
Write-Info ('2. Wait ~30s, open on 4G: ' + $PublicUrl + '/health')
Write-Info '3. Meta: add Redirect URI above'
Write-Info '4. Other PCs: open internal/customer EXE -> Connect FB'
Write-Host ''

$runNow = Read-Host 'Start server now (relay + tunnel)? [Y/n]'
if ($runNow -eq '' -or $runNow -match '^[Yy]') {
  if (Test-Path -LiteralPath $runAll) {
    Start-Process -FilePath $runAll
  }
}

Write-Host 'Finished.' -ForegroundColor Green
