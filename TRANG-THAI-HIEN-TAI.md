# Trạng thái hiện tại — FB Page Studio v1.2.22

**Cập nhật:** 2026-07-20

## Chạy thật

| | |
|--|--|
| EXE mới | `dist-desktop-oauth\FB-Page-Studio-Desktop-v1.2.22.exe` / `pack-customer\FB-Page-Studio-Desktop-v1.2.22.exe` |
| Runtime đang mở lúc build | v1.2.20 · cần đóng rồi mở v1.2.22 để nạp code mới |
| License | commercial · Owner-Dev · unlimited |
| Test | **218/218 PASS** |
| release:verify | **PASS** |
| EXE SHA-256 | `2B6FFFB9352317C0A7320E72F1A8EA497BB9A44D71087D5F6D09087794B3A995` |
| ZIP SHA-256 | `161C1961181EA5533EEF5E0558EE205158928BE76429C087A9E9F63E5B6C570D` |

## Gói phân phối

| Gói | Path |
|-----|------|
| Khách (folder) | `pack-customer\` |
| **ZIP máy khách** | `pack-customer\FB-Page-Studio-v1.2.22-Windows.zip` |
| Release staging | `release-assets\` (EXE + ZIP + sha256) |
| DEV | `pack-dev\` |
| Admin key | `Admin-Quan-Ly\MENU-ADMIN.bat` |
| Bản cũ | `Luu-Tru-Ban-Cu\` |

## Lệnh ship

```powershell
cd D:\fb-page-poster
npm test
npm run build:desktop
npm run pack:all
npm run release:asset
npm run release:verify
# rồi commit + tag v1.2.21 + gh release khi người dùng đồng ý
```

## Còn phụ thuộc ngoài

- Ngrok domain busy nếu endpoint online máy khác  
- Meta App (redirect / Basic settings)  
- App 2 chưa cấu hình  

## Không còn (đã xử lý)

- Trial nhầm trên máy admin (đã commercial)  
- EXE cũ rải App folder (đã vào Luu-Tru)  
- Active times spam metric deprecate  
