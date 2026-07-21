@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Cai may SERVER - FB Page Studio
echo.
echo  ============================================================
echo   FB Page Studio — Cai dat may SERVER (treo nha)
echo   Domain mac dinh: modelswiki.top
echo   Goi: Tong Hop Tool\pack-server
echo  ============================================================
echo.
echo  Nen chay "Run as administrator" neu winget/cloudflared can quyen.
echo.
if exist "%~dp0Tổng Hợp Tool\pack-server\CAI-MAY-SERVER.bat" (
  cd /d "%~dp0Tổng Hợp Tool\pack-server"
  call CAI-MAY-SERVER.bat
  goto :eof
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-setup\install-server.ps1"
echo.
pause
