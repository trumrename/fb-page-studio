# Trạng thái hiện tại — FB Page Studio v1.2.21

**Cập nhật:** 2026-07-20

## Chạy thật

| | |
|--|--|
| EXE mới | `FB-Page-Studio-App\FB-Page-Studio-Desktop-v1.2.21.exe` |
| Runtime đang mở lúc build | v1.2.20 · cần đóng rồi mở v1.2.21 để nạp code mới |
| License | commercial · Owner-Dev · unlimited |
| Test | **209/209 PASS** |
| release:verify | **PASS** |
| EXE SHA-256 | `A8DE714F3B68A6D827084EBC7E87F33EABD67BBFA4115A51D799A2C93F48D662` |
| ZIP SHA-256 | `3A29B9AA21B287F9ED11B5AE5704D530EEA104149B99C75BE5ED5B5BA64C4DF6` |

## Gói phân phối

| Gói | Path |
|-----|------|
| Khách (folder) | `pack-customer\` |
| **ZIP máy khách** | `pack-customer\FB-Page-Studio-v1.2.21-Windows.zip` |
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
