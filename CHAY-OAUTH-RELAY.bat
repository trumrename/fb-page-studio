@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0Tổng Hợp Tool\pack-server\CHAY-RELAY-ONLY.bat" (
  cd /d "%~dp0Tổng Hợp Tool\pack-server"
  call CHAY-RELAY-ONLY.bat
  exit /b %ERRORLEVEL%
)
if exist "%~dp0Tổng Hợp Tool\pack-server\oauth-relay\server.mjs" (
  cd /d "%~dp0Tổng Hợp Tool\pack-server"
  title OAuth Relay - modelswiki.top
  node oauth-relay\server.mjs
  pause
  exit /b %ERRORLEVEL%
)
echo [LOI] Khong thay pack-server. Chay: npm run pack:server
pause
exit /b 1
