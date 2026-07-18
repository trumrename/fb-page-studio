@echo off
chcp 65001 >nul
setlocal EnableExtensions
title FB Page Studio - Cai dat Ngrok tu dong
cd /d "%~dp0"

:: ============================================================
::  CHI CAN DIEN TOKEN VAO DONG DUOI (giua dau = va het dong)
::  Lay token: https://dashboard.ngrok.com/get-started/your-authtoken
:: ============================================================
set "NGROK_TOKEN=DAN_TOKEN_NGROK_VAO_DAY"

:: Cong app FB Page Studio (doi neu .env dung PORT khac)
set "APP_PORT=3847"

:: Domain ngrok co dinh (goi tra phi)
set "NGROK_DOMAIN=qgroup.ngrok.app"

:: Thu muc cai ngrok (mac dinh canh file .bat)
set "NGROK_DIR=%~dp0ngrok"
set "NGROK_EXE=%NGROK_DIR%\ngrok.exe"

echo.
echo  ============================================
echo   FB Page Studio - Cai Ngrok tu dong
echo  ============================================
echo.

:: --- Kiem tra token ---
if "%NGROK_TOKEN%"=="" goto :bad_token
if /i "%NGROK_TOKEN%"=="DAN_TOKEN_NGROK_VAO_DAY" goto :bad_token
if /i "%NGROK_TOKEN%"=="PASTE_YOUR_TOKEN_HERE" goto :bad_token

:: --- Tim ngrok.exe: thu muc local, PATH, hoac tai ve ---
where ngrok >nul 2>&1
if %ERRORLEVEL%==0 (
  for /f "delims=" %%I in ('where ngrok') do (
    set "NGROK_EXE=%%I"
    goto :have_ngrok
  )
)

if exist "%NGROK_EXE%" goto :have_ngrok

echo  [1/3] Chua co ngrok.exe - dang tai ban Windows amd64...
if not exist "%NGROK_DIR%" mkdir "%NGROK_DIR%"
set "ZIP=%TEMP%\ngrok-win.zip"
set "URL=https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 (
  echo  [LOI] Khong tai duoc ngrok. Kiem tra mang hoac tai tay:
  echo        https://ngrok.com/download
  echo  Giai nen ngrok.exe vao: %NGROK_DIR%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Expand-Archive -Path '%ZIP%' -DestinationPath '%NGROK_DIR%' -Force"
if not exist "%NGROK_EXE%" (
  echo  [LOI] Giai nen xong van khong thay ngrok.exe
  pause
  exit /b 1
)
echo  [OK] Da tai: %NGROK_EXE%

:have_ngrok
echo  [OK] Dung ngrok: %NGROK_EXE%
echo.
echo  [2/3] Dang luu authtoken...
"%NGROK_EXE%" config add-authtoken %NGROK_TOKEN%
if errorlevel 1 (
  echo  [LOI] add-authtoken that bai. Kiem tra token dung chua.
  pause
  exit /b 1
)
echo  [OK] Da luu token.
echo.
echo  [3/3] Huong dan chay:
echo.
echo     1. Mo FB-Page-Studio-Desktop.exe TRUOC
echo     2. Kiem tra: http://127.0.0.1:%APP_PORT%/app.html
echo     3. Roi chay tunnel ^(cua so nay se mo ngrok^)
echo.
echo  Nhan phim bat ky de BAT NGROK tro toi 127.0.0.1:%APP_PORT%
echo  ^(Ctrl+C de dung ngrok^)
echo.
pause

echo.
echo  Dang chay: ngrok http 127.0.0.1:%APP_PORT%
echo  Copy dong Forwarding https://.... vao .env:
echo    APP_BASE_URL=https://....
echo    FB_REDIRECT_URI=https://..../auth/facebook/callback
echo  Roi them URI do tren Meta Developers + restart app.
echo.
"%NGROK_EXE%" http 127.0.0.1:%APP_PORT% --domain=%NGROK_DOMAIN%
goto :eof

:bad_token
echo  [LOI] Ban chua dien NGROK_TOKEN trong file CAI-NGROK.bat
echo.
echo  1. Mo file nay bang Notepad
echo  2. Tim dong: set "NGROK_TOKEN=DAN_TOKEN_NGROK_VAO_DAY"
echo  3. Thay bang token lay tai:
echo     https://dashboard.ngrok.com/get-started/your-authtoken
echo  4. Luu file roi chay lai CAI-NGROK.bat
echo.
pause
exit /b 1
