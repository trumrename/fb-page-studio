# Fix Desktop (2026-07-17)

## Bugs đã tìm ra

1. **Màn hình đen** — server backend không start → UI không load  
2. **Connect fail** — không load `.env` (FB_APP_ID trống) vì app tìm `.env` cạnh exe, file chỉ có ở project root  
3. **better-sqlite3 ABI** — module build cho Node 22 (127) nhưng Electron cần (130)

## Đã sửa

- `electron/main.cjs`: spawn server bằng Electron-as-Node + log `desktop-startup.log`  
- `src/paths.js`: tìm `.env` walk-up, debug `/api/debug/paths`  
- OAuth callback → `/index.html`  
- Rebuild native cho Electron + package lại  

## Chạy bản đã fix

```
D:\fb-page-poster\dist-desktop-v4\FB-Page-Studio-Desktop.exe
```

hoặc:

```
D:\fb-page-poster\dist-desktop-v4\win-unpacked\FB Page Studio.exe
```

**Bắt buộc:** file `.env` cạnh exe (đã copy sẵn vào folder v4).

**Connect:** bật ngrok `http 3847` và URL khớp `APP_BASE_URL` / Meta redirect.
