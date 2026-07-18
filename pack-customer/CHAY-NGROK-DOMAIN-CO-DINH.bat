@echo off
setlocal EnableExtensions
chcp 65001 >nul
title FB Page Studio - Ngrok domain co dinh

rem ============================================================
rem CHI SUA 1 DONG DUOI DAY: dan Authtoken Ngrok cua may moi.
rem Lay token: https://dashboard.ngrok.com/get-started/your-authtoken
rem ============================================================
set "NGROK_TOKEN=DAN_TOKEN_NGROK_VAO_DAY"

rem Domain co dinh dung chung voi may hien tai.
set "NGROK_DOMAIN=qgroup.ngrok.app"
set "APP_PORT=3847"

if "%NGROK_TOKEN%"=="" goto :token_error
if /i "%NGROK_TOKEN%"=="DAN_TOKEN_NGROK_VAO_DAY" goto :token_error

where ngrok.exe >nul 2>&1
if errorlevel 1 (
  if exist "%~dp0ngrok.exe" (
    set "NGROK_EXE=%~dp0ngrok.exe"
  ) else if exist "%~dp0ngrok\ngrok.exe" (
    set "NGROK_EXE=%~dp0ngrok\ngrok.exe"
  ) else (
    goto :ngrok_error
  )
) else (
  set "NGROK_EXE=ngrok.exe"
)

echo.
echo ============================================================
echo  FB PAGE STUDIO - NGROK DOMAIN CO DINH
echo ============================================================
echo  Domain : https://%NGROK_DOMAIN%
echo  App    : http://127.0.0.1:%APP_PORT%
echo.

echo [1/3] Dang luu Authtoken cho tai khoan Ngrok...
"%NGROK_EXE%" config add-authtoken "%NGROK_TOKEN%"
if errorlevel 1 goto :config_error

echo [2/3] Dang kiem tra FB Page Studio...
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%APP_PORT%/api/meta' -TimeoutSec 3 ^| Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo [CANH BAO] Tool chua phan hoi tai 127.0.0.1:%APP_PORT%.
  echo Hay mo FB-Page-Studio-Desktop.exe truoc, sau do quay lai day.
  echo.
  pause
)

echo [3/3] Dang mo domain CO DINH...
echo.
echo Ket qua dung phai hien:
echo Forwarding  https://%NGROK_DOMAIN% -^> http://127.0.0.1:%APP_PORT%
echo.
echo Neu hien domain khac, bam Ctrl+C va bao lai admin.
echo ============================================================
echo.

"%NGROK_EXE%" http 127.0.0.1:%APP_PORT% --domain=%NGROK_DOMAIN%
goto :end

:token_error
echo.
echo [LOI] Chua dan token Ngrok.
echo Chuot phai file nay ^> Edit, tim dong:
echo set "NGROK_TOKEN=DAN_TOKEN_NGROK_VAO_DAY"
echo Sau do thay DAN_TOKEN_NGROK_VAO_DAY bang token that va Save.
echo Lay token tai:
echo https://dashboard.ngrok.com/get-started/your-authtoken
echo.
pause
exit /b 1

:ngrok_error
echo.
echo [LOI] Khong tim thay ngrok.exe.
echo Cai Ngrok bang lenh:
echo winget install ngrok.ngrok
echo.
echo Hoac dat ngrok.exe cung thu muc voi file BAT nay.
echo Tai tai: https://ngrok.com/download
echo.
pause
exit /b 1

:config_error
echo.
echo [LOI] Token khong hop le hoac khong ket noi duoc Ngrok.
echo Kiem tra token thuoc dung tai khoan dang so huu domain %NGROK_DOMAIN%.
echo.
pause
exit /b 1

:end
echo.
echo Ngrok da dung.
pause
endlocal
