@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set /p H=Ten khach (holder): 
if "%H%"=="" set H=Customer
node scripts\gen-license.mjs --type commercial --holder "%H%" --days 365 --max-accounts 0 --max-pages 0
echo.
pause
