@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set /p H=Ten nhan vien (holder): 
if "%H%"=="" set H=Employee
node scripts\gen-license.mjs --type employee --holder "%H%" --days 90 --max-accounts 10 --max-pages 40
echo.
pause
