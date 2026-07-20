@echo off
chcp 65001 >nul
cd /d "%~dp0"
title FB Page Studio SERVER
echo.
echo  Neu chua cai: chay CAI-MAY-SERVER.bat truoc.
echo  Domain: https://videoviral1.chainityai.com
echo.

if not exist "oauth-relay\.env" (
  echo [LOI] Chua co oauth-relay\.env — chay CAI-MAY-SERVER.bat truoc.
  pause
  exit /b 1
)

echo [1/2] Mo OAuth Relay...
start "OAuth-Relay" cmd /k "cd /d "%~dp0" && node oauth-relay\server.mjs"
timeout /t 2 /nobreak >nul

where cloudflared >nul 2>&1
if errorlevel 1 (
  echo [CANH BAO] Chua co cloudflared. Chi chay relay local.
  echo Cai: winget install Cloudflare.cloudflared
  echo Hoac chay lai CAI-MAY-SERVER.bat
  pause
  exit /b 0
)

echo [2/2] Mo Cloudflare Tunnel...
start "Cloudflare-Tunnel" cmd /k "cloudflared tunnel run fb-oauth-relay"
echo.
echo  Da mo 2 cua so. De mo 24/7: khong tat may, tat Sleep.
echo  Kiem tra 4G: https://videoviral1.chainityai.com/health
echo.
pause
