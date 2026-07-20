@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Cai may SERVER - FB Page Studio
echo.
echo  ============================================================
echo   FB Page Studio — Cai dat may SERVER (treo nha)
echo   Domain mac dinh: videoviral1.chainityai.com
echo  ============================================================
echo.
echo  Nen chay "Run as administrator" neu winget/cloudflared can quyen.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-setup\install-server.ps1"
echo.
pause
