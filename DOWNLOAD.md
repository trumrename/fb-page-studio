# Tải FB Page Studio — bản mới nhất

**Hiện tại: v1.2.75** (chọn profile Chrome GỐC hoặc PORTABLE trên máy khách)

Bấm link dưới đây để **tải ngay** bản Setup.  
Link **không đổi** theo version — luôn trỏ **GitHub Release Latest**.

## Setup (khuyên dùng) — cài / cài đè

**[⬇ Tải FB-Page-Studio-Setup.exe (latest)](https://github.com/trumrename/fb-page-studio/releases/latest/download/FB-Page-Studio-Setup.exe)**

```
https://github.com/trumrename/fb-page-studio/releases/latest/download/FB-Page-Studio-Setup.exe
```

- Cài Start Menu + Desktop shortcut  
- Cài đè **giữ** data `%APPDATA%\fb-page-studio`  
- Không cần tạo lại `.env` nếu đã dùng trước  

## Portable (nếu có trên release)

**[⬇ Tải FB-Page-Studio-Desktop.exe (latest)](https://github.com/trumrename/fb-page-studio/releases/latest/download/FB-Page-Studio-Desktop.exe)**

*(Một số release chỉ ship Setup — dùng Setup nếu Portable 404.)*

## Trang release

https://github.com/trumrename/fb-page-studio/releases/latest

## SHA-256

- Setup: https://github.com/trumrename/fb-page-studio/releases/latest/download/FB-Page-Studio-Setup.exe.sha256.txt  

## Máy khách — chọn profile (GỐC hoặc PORTABLE)

Trên **mỗi máy** (AppData riêng):

1. Cài Setup v1.2.75+  
2. **Kết nối Meta** → **Quét Chrome (gốc + Portable)** (ô thư mục để trống = quét máy này)  
3. Chọn dòng `[GỐC] …` hoặc `[PORTABLE] …` → **Dùng profile này**  
4. **Connect App 1/2** — mở đúng browser + profile của **máy đó**

Hoặc ghi tay trong `%APPDATA%\fb-page-studio\.env`:

```env
# Chrome gốc
FB_BROWSER_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
FB_CHROME_USER_DATA_DIR=C:\Users\TEN\AppData\Local\Google\Chrome\User Data
FB_CHROME_PROFILE=Default

# hoặc Chrome Portable
FB_BROWSER_PATH=D:\ChromePortable\ChromePortable.exe
FB_CHROME_USER_DATA_DIR=D:\ChromePortable\Data\profile
FB_CHROME_PROFILE=Default
```

**Không** set `FB_CHROME_USER_DATA_DIR` / `FB_CHROME_PROFILE` (gây logout FB).

## Docs

- Tổng quan: `TONG-QUAN.md`  
- Check bug: `CHECK-BUG.md`  
- Trạng thái: `TRANG-THAI-HIEN-TAI.md`  
- Mục lục: `DOC-INDEX.md`  

---

*Mỗi release upload lại tên `FB-Page-Studio-Setup.exe` → link trên luôn là bản mới nhất.*
