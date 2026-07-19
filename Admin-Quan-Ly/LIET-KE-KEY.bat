@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
node scripts\list-licenses.mjs
echo.
pause
