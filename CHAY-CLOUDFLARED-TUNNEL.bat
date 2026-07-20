@echo off
chcp 65001 >nul
title Cloudflare Tunnel - videoviral1.chainityai.com
echo.
echo  Can: cloudflared da cai + tunnel login + config.yml
echo  Xem: HUONG-DAN-DOMAIN-MAY-TREO-NHA.md
echo  Giu cua so nay MO 24/7 cung voi CHAY-OAUTH-RELAY.bat
echo.
cloudflared tunnel run fb-oauth-relay
if errorlevel 1 (
  echo.
  echo [LOI] cloudflared that bai. Kiem tra:
  echo  - winget install Cloudflare.cloudflared
  echo  - cloudflared tunnel login
  echo  - cloudflared tunnel create fb-oauth-relay
  echo  - file config.yml dung hostname videoviral1.chainityai.com
)
pause
