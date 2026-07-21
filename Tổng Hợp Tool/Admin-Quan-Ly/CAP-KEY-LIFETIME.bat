@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set /p H=Ten VIP (holder): 
if "%H%"=="" set H=VIP
node scripts\gen-license.mjs --type lifetime --holder "%H%" --lifetime --max-accounts 0 --max-pages 0
echo.
pause
