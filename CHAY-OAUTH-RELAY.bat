@echo off
chcp 65001 >nul
cd /d "%~dp0"
title FB Page Studio - OAuth Relay
echo.
echo  Relay domain: https://videoviral1.chainityai.com
echo  Can co file: oauth-relay\.env
echo  Giu cua so nay MO 24/7 (may treo).
echo.
if not exist "oauth-relay\.env" (
  echo [LOI] Chua co oauth-relay\.env
  echo Copy oauth-relay\.env.example thanh .env va dien FB_APP_ID / SECRET.
  pause
  exit /b 1
)
node oauth-relay\server.mjs
echo.
echo Relay da dung.
pause
