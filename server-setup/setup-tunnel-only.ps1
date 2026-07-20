# Chi cau hinh cloudflared (khi Node/relay .env da co)
$ErrorActionPreference = "Stop"
$Domain = "videoviral1.chainityai.com"
$TunnelName = "fb-oauth-relay"
$CloudDir = Join-Path $env:USERPROFILE ".cloudflared"

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  winget install --id Cloudflare.cloudflared -e --accept-package-agreements --accept-source-agreements
}

Write-Host "Login Cloudflare (chon domain chainityai.com)..."
cloudflared tunnel login

$list = cloudflared tunnel list 2>&1 | Out-String
if ($list -notmatch [regex]::Escape($TunnelName)) {
  cloudflared tunnel create $TunnelName
}

$cred = Get-ChildItem $CloudDir -Filter "*.json" -ErrorAction SilentlyContinue |
  Where-Object { $_.BaseName -match '^[0-9a-f]{8}-' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $cred) { throw "Khong thay credentials json trong $CloudDir" }

@"
tunnel: $TunnelName
credentials-file: $($cred.FullName)

ingress:
  - hostname: $Domain
    service: http://127.0.0.1:8080
  - service: http_status:404
"@ | Set-Content (Join-Path $CloudDir "config.yml") -Encoding UTF8

cloudflared tunnel route dns $TunnelName $Domain
Write-Host "OK. Chay: cloudflared tunnel run $TunnelName" -ForegroundColor Green
