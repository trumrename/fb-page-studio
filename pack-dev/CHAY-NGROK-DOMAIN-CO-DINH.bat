@echo off
chcp 65001 >nul
title FB Page Studio DEV - Ngrok da tich hop
echo.
echo  Ngrok da duoc src/services/ngrokManager.js quan ly trong EXE/server.
echo  Khong dan token vao CMD va khong chay tunnel thu hai bang BAT.
echo.
echo  Cau hinh tai giao dien Ket noi Meta hoac .env DEV:
echo    NGROK_AUTHTOKEN=...
echo    NGROK_AUTOSTART=1
echo    APP_BASE_URL=https://domain-cua-ban
echo.
echo  Neu ERR_NGROK_334, dung endpoint cu truoc khi mo lai trong tool.
echo.
pause
