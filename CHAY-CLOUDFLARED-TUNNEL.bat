@echo off
chcp 65001 >nul
title Cloudflare Tunnel - modelswiki.top
echo.
echo  Domain: modelswiki.top
echo  Can: cloudflared + tunnel login + config.yml
echo  Goi server: Tong Hop Tool\pack-server
echo.
cloudflared tunnel run fb-oauth-relay
if errorlevel 1 (
  echo.
  echo [LOI] Kiem tra cloudflared / hostname modelswiki.top
)
pause
