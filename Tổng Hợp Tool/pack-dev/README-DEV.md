# PACK DEV — Máy admin / lập trình

> **Không zip cả folder này gửi khách.**  
> Gửi khách dùng `pack-customer\` hoặc ZIP `FB-Page-Studio-vX.Y.Z-Windows.zip`.

## Đường dẫn gốc

```
D:\fb-page-poster\
```

| Thành phần | Đường dẫn |
|------------|-----------|
| Source | `src\` · `public\` · `electron\` |
| Private key cấp license | `keys\license-private.pem` (**không ship**) |
| Key đã cấp | `keys\issued\` |
| `.env` Meta | `.env` / `FB-Page-Studio-App\.env` |
| DB / token | `data\` · `FB-Page-Studio-App\data\` |
| Build | `dist-desktop-oauth\` |
| Gói khách | `pack-customer\` |
| **Admin menu** | `Admin-Quan-Ly\MENU-ADMIN.bat` |
| **Lưu trữ bản cũ** | `Luu-Tru-Ban-Cu\` |

## Việc hàng ngày

```powershell
cd D:\fb-page-poster
npm test
npm run build:desktop
npm run pack:all              # customer + dev + ZIP khách
npm run release:asset
npm run release:verify

# Cấp key
npm run license:gen -- --type commercial --holder "KH" --days 365
npm run license:list
# hoặc double-click Admin-Quan-Ly\MENU-ADMIN.bat
```

## v1.2.21 (hiện tại)

- License commercial trên máy admin; trial chỉ khi chưa có key
- Direct Local vs Hẹn giờ Facebook tách rõ
- Retry task lỗi từ tiến trình job
- Active times: preferred/preset (Meta deprecate page_fans_online)
- Ngrok token import từ hệ thống; domain busy có hướng dẫn dashboard
- Gói khách sạch + ZIP Windows

## Quy tắc

1. Sửa code ở project root  
2. Build → `pack:all`  
3. **Push / Release GH** chỉ khi được đồng ý (lần này user đã yêu cầu)  
4. Không commit `.env`, `data`, private key, `Luu-Tru-Ban-Cu`, EXE lớn

## GitHub

- Repo: https://github.com/trumrename/fb-page-studio  
- Asset khách: `FB-Page-Studio-Desktop-vX.Y.Z.exe` + optional ZIP  
