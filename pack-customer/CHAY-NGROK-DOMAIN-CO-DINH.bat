@echo off
if /i not "%~1"=="__RUN__" (
  start "FB Page Studio - Ngrok" "%ComSpec%" /d /k ""%~f0" __RUN__"
  exit /b 0
)
setlocal EnableExtensions
chcp 65001 >nul
title FB Page Studio - Ngrok domain co dinh

set "NGROK_LOG=%~dp0ngrok-startup.log"
echo ============================================================ >> "%NGROK_LOG%"
echo [%date% %time%] Bat dau khoi dong Ngrok >> "%NGROK_LOG%"

rem Token se duoc hoi truc tiep trong CMD, khong luu trong file BAT.
set "NGROK_TOKEN="

rem Domain co dinh dung chung voi may hien tai.
set "NGROK_DOMAIN=qgroup.ngrok.app"
set "APP_PORT=3847"

echo.
echo Lay Authtoken tai:
echo https://dashboard.ngrok.com/get-started/your-authtoken
echo.
set /p "NGROK_TOKEN=Dan Authtoken Ngrok vao day roi nhan Enter: "
if "%NGROK_TOKEN%"=="" goto :token_error

where ngrok.exe >nul 2>&1
if errorlevel 1 (
  if exist "%~dp0ngrok.exe" (
    set "NGROK_EXE=%~dp0ngrok.exe"
  ) else if exist "%~dp0ngrok\ngrok.exe" (
    set "NGROK_EXE=%~dp0ngrok\ngrok.exe"
  ) else (
    set "NGROK_EXE=%~dp0ngrok\ngrok.exe"
    set "NGROK_ZIP=%TEMP%\ngrok-v3-windows-amd64.zip"
    echo.
    echo [0/4] May chua co Ngrok. Dang tu dong tai...
    if not exist "%~dp0ngrok" mkdir "%~dp0ngrok"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile '%TEMP%\ngrok-v3-windows-amd64.zip'; Expand-Archive -LiteralPath '%TEMP%\ngrok-v3-windows-amd64.zip' -DestinationPath '%~dp0ngrok' -Force; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
    if errorlevel 1 goto :download_error
    if not exist "%~dp0ngrok\ngrok.exe" goto :download_error
    echo [OK] Da tai Ngrok vao: %~dp0ngrok\ngrok.exe
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

echo [1/4] Dang luu Authtoken cho tai khoan Ngrok...
"%NGROK_EXE%" config add-authtoken "%NGROK_TOKEN%" >> "%NGROK_LOG%" 2>&1
if errorlevel 1 goto :config_error

echo [2/4] Dang kiem tra FB Page Studio...
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%APP_PORT%/api/meta' -TimeoutSec 3 ^| Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo [CANH BAO] Tool chua phan hoi tai 127.0.0.1:%APP_PORT%.
  echo Hay mo FB-Page-Studio-Desktop.exe truoc, sau do quay lai day.
  echo.
  pause
)

echo [3/4] Dang kiem tra domain co dinh...
"%NGROK_EXE%" config check >> "%NGROK_LOG%" 2>&1
if errorlevel 1 goto :config_error

echo [4/4] Dang mo domain CO DINH...
echo.
echo Ket qua dung phai hien:
echo Forwarding  https://%NGROK_DOMAIN% -^> http://127.0.0.1:%APP_PORT%
echo.
echo Neu hien domain khac, bam Ctrl+C va bao lai admin.
echo ============================================================
echo.

echo [%date% %time%] Chay domain https://%NGROK_DOMAIN% >> "%NGROK_LOG%"
"%NGROK_EXE%" http 127.0.0.1:%APP_PORT% --domain=%NGROK_DOMAIN%
echo [%date% %time%] Ngrok dung, exit=%errorlevel% >> "%NGROK_LOG%"
goto :end

:token_error
echo.
echo [LOI] Ban chua dan token Ngrok vao cua so CMD.
echo Chay lai file BAT, dan token tai dong yeu cau roi nhan Enter.
echo Lay token tai:
echo https://dashboard.ngrok.com/get-started/your-authtoken
echo Chi tiet: %NGROK_LOG%
echo.
pause
exit /b 1

:download_error
echo.
echo [LOI] Khong tu dong tai duoc ngrok.exe.
echo Thu cai bang lenh:
echo winget install ngrok.ngrok
echo.
echo Hoac tai va dat ngrok.exe vao thu muc ngrok canh file BAT.
echo Tai tai: https://ngrok.com/download
echo Chi tiet: %NGROK_LOG%
echo.
pause
exit /b 1

:config_error
echo.
echo [LOI] Token khong hop le hoac khong ket noi duoc Ngrok.
echo Kiem tra token thuoc dung tai khoan dang so huu domain %NGROK_DOMAIN%.
echo Chi tiet: %NGROK_LOG%
echo.
pause
exit /b 1

:end
echo.
echo Ngrok da dung.
pause
endlocal
