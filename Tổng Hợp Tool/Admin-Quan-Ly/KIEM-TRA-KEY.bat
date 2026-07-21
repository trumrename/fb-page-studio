@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set /p F=Duong dan file key .txt: 
if "%F%"=="" (
  echo Thieu file.
  pause
  exit /b 1
)
node scripts\verify-license-key.mjs --file "%F%"
echo.
pause
