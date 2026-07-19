# Trạng thái hiện tại — FB Page Studio v1.2.20

**Cập nhật:** 2026-07-19

## Chạy thật

| | |
|--|--|
| EXE | `FB-Page-Studio-App\FB-Page-Studio-Desktop-v1.2.20.exe` |
| Version API | 1.2.20 · packaged |
| License | commercial · Owner-Dev · unlimited |
| Test | **189/189 PASS** |
| release:verify | **PASS** |

## Gói phân phối

| Gói | Path |
|-----|------|
| Khách (folder) | `pack-customer\` |
| **ZIP máy khách** | `pack-customer\FB-Page-Studio-v1.2.20-Windows.zip` |
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
# rồi commit + tag v1.2.20 + gh release
```

## Còn phụ thuộc ngoài

- Ngrok domain busy nếu endpoint online máy khác  
- Meta App (redirect / Basic settings)  
- App 2 chưa cấu hình  

## Không còn (đã xử lý)

- Trial nhầm trên máy admin (đã commercial)  
- EXE cũ rải App folder (đã vào Luu-Tru)  
- Active times spam metric deprecate  
