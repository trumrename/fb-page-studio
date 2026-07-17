@echo off
echo Xoa ban desktop hong...
taskkill /F /IM "FB Page Studio.exe" 2>nul
timeout /t 2 /nobreak >nul
rd /s /q "D:\fb-page-poster\dist-desktop" 2>nul
rd /s /q "D:\fb-page-poster\dist-desktop-v2" 2>nul
rd /s /q "D:\fb-page-poster\dist-desktop-v3" 2>nul
rd /s /q "D:\fb-page-poster\dist-desktop-v4" 2>nul
echo Xong. Chi giu FB-Page-Studio-App
dir "D:\fb-page-poster" /ad
pause
