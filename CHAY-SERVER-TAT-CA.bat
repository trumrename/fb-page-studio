@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0Tổng Hợp Tool\pack-server\CHAY-SERVER-TAT-CA.bat" (
  cd /d "%~dp0Tổng Hợp Tool\pack-server"
  call CHAY-SERVER-TAT-CA.bat
  exit /b %ERRORLEVEL%
)
echo [LOI] Khong thay: Tong Hop Tool\pack-server\CHAY-SERVER-TAT-CA.bat
echo Chay: npm run pack:server
pause
exit /b 1
