#Requires -Version 5.1
# Fix missing cert.pem after cloudflared tunnel login failed to auto-save.
$ErrorActionPreference = 'Stop'
$CloudDir = Join-Path $env:USERPROFILE '.cloudflared'
$dest = Join-Path $CloudDir 'cert.pem'
New-Item -ItemType Directory -Force -Path $CloudDir | Out-Null

Write-Host ''
Write-Host '  FIX Cloudflare cert.pem' -ForegroundColor Cyan
Write-Host "  Target: $dest" -ForegroundColor DarkGray
Write-Host ''

if ((Test-Path -LiteralPath $dest) -and ((Get-Item $dest).Length -gt 100)) {
  Write-Host "  [OK] cert.pem already exists." -ForegroundColor Green
  $env:TUNNEL_ORIGIN_CERT = $dest
  Write-Host '  Testing: cloudflared tunnel list'
  & cloudflared tunnel list
  exit 0
}

Write-Host 'Searching Downloads/Desktop for cert...'
$candidates = @()
foreach ($d in @(
  (Join-Path $env:USERPROFILE 'Downloads'),
  [Environment]::GetFolderPath('Desktop'),
  $CloudDir
)) {
  if (-not (Test-Path $d)) { continue }
  $candidates += Get-ChildItem $d -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'cert|\.pem$' -and $_.Length -gt 100 -and $_.LastWriteTime -gt (Get-Date).AddDays(-2) }
}

$pick = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 5
if ($pick) {
  Write-Host 'Found:'
  $i = 1
  foreach ($f in $pick) {
    Write-Host "  [$i] $($f.FullName)  ($([math]::Round($f.Length/1KB,1)) KB)"
    $i++
  }
  $n = Read-Host 'Pick number to install (or Enter to paste path)'
  if ($n -match '^\d+$' -and [int]$n -ge 1 -and [int]$n -le $pick.Count) {
    Copy-Item $pick[[int]$n - 1].FullName $dest -Force
    Write-Host "[OK] Installed $dest" -ForegroundColor Green
  }
}

if (-not ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 100))) {
  $manual = Read-Host 'Full path to downloaded cert file'
  if ($manual) {
    $manual = $manual.Trim().Trim('"')
    if (Test-Path -LiteralPath $manual) {
      Copy-Item -LiteralPath $manual -Destination $dest -Force
      Write-Host "[OK] Installed $dest" -ForegroundColor Green
    } else {
      Write-Host 'Path not found.' -ForegroundColor Red
      exit 1
    }
  } else {
    Write-Host 'Run: cloudflared tunnel login' -ForegroundColor Yellow
    Write-Host 'Then re-run this script after browser downloads the cert.' -ForegroundColor Yellow
    $run = Read-Host 'Run cloudflared tunnel login now? [Y/n]'
    if ($run -eq '' -or $run -match '^[Yy]') {
      & cloudflared tunnel login
      # try find again
      Start-Sleep 2
      $again = Get-ChildItem (Join-Path $env:USERPROFILE 'Downloads') -File -EA SilentlyContinue |
        Where-Object { $_.Name -match 'cert|\.pem' -and $_.Length -gt 100 } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($again) {
        Copy-Item $again.FullName $dest -Force
        Write-Host "[OK] Copied from Downloads: $($again.Name)" -ForegroundColor Green
      }
    }
  }
}

if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 100)) {
  $env:TUNNEL_ORIGIN_CERT = $dest
  Write-Host ''
  Write-Host 'Testing tunnel list...' -ForegroundColor Cyan
  & cloudflared tunnel list
  if ($LASTEXITCODE -eq 0) {
    Write-Host '[OK] cert works. Re-run CAI-MAY-SERVER.bat or CHAY-SERVER-TAT-CA.bat' -ForegroundColor Green
  } else {
    Write-Host '[!] tunnel list still failed - re-login with correct Cloudflare account' -ForegroundColor Yellow
  }
} else {
  Write-Host '[FAIL] cert.pem still missing' -ForegroundColor Red
  exit 1
}
