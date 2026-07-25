@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\..\.."
title FB Page Studio — Admin

:menu
cls
echo ============================================
echo   FB PAGE STUDIO — MENU ADMIN
echo   Project: %CD%
echo ============================================
echo.
echo   1. Cap key THUONG MAI (commercial 365 ngay, unlimited)
echo   2. Cap key NHAN VIEN (90 ngay, 10 acc / 40 page)
echo   3. Cap key VINH VIEN (lifetime)
echo   4. Cap key TUY CHINH (nhap tham so)
echo   5. Liet ke key da cap
echo   6. Kiem tra 1 key (verify)
echo   7. Mo thu muc keys\issued
echo   8. Mo goi khach pack-customer
echo   9. Mo thu muc Luu-Tru-Ban-Cu
echo   0. Thoat
echo.
set /p c=Chon: 

if "%c%"=="1" goto commercial
if "%c%"=="2" goto employee
if "%c%"=="3" goto lifetime
if "%c%"=="4" goto custom
if "%c%"=="5" goto list
if "%c%"=="6" goto verify
if "%c%"=="7" goto openIssued
if "%c%"=="8" goto openCustomer
if "%c%"=="9" goto openArchive
if "%c%"=="0" exit /b 0
goto menu

rem cmd tach "&" o top level nen "if ... start ... & goto menu" lam goto chay
rem vo dieu kien =^> cac lua chon 8/9/0 khong bao gio toi duoc. Dung goto rieng.
rem Dung %~dp0.. (thu muc cha cua Admin-Quan-Ly) thay vi go ten thu muc co dau,
rem tranh phu thuoc code page khi cmd doc duong dan Unicode.
:openIssued
start "" "%CD%\keys\issued"
goto menu

:openCustomer
start "" "%~dp0..\pack-customer"
goto menu

:openArchive
start "" "%~dp0..\Luu-Tru-Ban-Cu"
goto menu

:commercial
set /p H=Ten khach/holder: 
if "%H%"=="" set H=Customer
node scripts\gen-license.mjs --type commercial --holder "%H%" --days 365 --max-accounts 0 --max-pages 0
pause
goto menu

:employee
set /p H=Ten NV/holder: 
if "%H%"=="" set H=Employee
node scripts\gen-license.mjs --type employee --holder "%H%" --days 90 --max-accounts 10 --max-pages 40
pause
goto menu

:lifetime
set /p H=Ten VIP/holder: 
if "%H%"=="" set H=VIP
node scripts\gen-license.mjs --type lifetime --holder "%H%" --lifetime --max-accounts 0 --max-pages 0
pause
goto menu

:custom
echo Vi du: --type commercial --holder "Shop" --days 180 --max-accounts 5 --max-pages 20
set /p ARGS=Tham so gen-license: 
node scripts\gen-license.mjs %ARGS%
pause
goto menu

:list
node scripts\list-licenses.mjs
pause
goto menu

:verify
set "F="
set "K="
set /p F=Duong dan file .txt key (hoac de trong de dan KEY):
if not "%F%"=="" (
  node scripts\verify-license-key.mjs --file "%F%"
  pause
  goto menu
)
rem KHONG dat "set /p K" va "%K%" trong cung mot khoi ( ) — cmd expand %K%
rem ngay luc parse khoi nen se luon rong. Tach ra ngoai khoi.
set /p K=Dan KEY:
if "%K%"=="" (
  echo Chua nhap KEY.
  pause
  goto menu
)
node scripts\verify-license-key.mjs "%K%"
pause
goto menu
