# Admin-Quan-Ly — Gói quản trị FB Page Studio

Thư mục **chỉ dành cho admin** (máy cấp key / build / lưu trữ).

## Nội dung

| File | Công dụng |
|------|-----------|
| `MENU-ADMIN.bat` | Menu: cấp key, list, verify, mở thư mục |
| `CAP-KEY-COMMERCIAL.bat` | Cấp key thương mại nhanh |
| `CAP-KEY-EMPLOYEE.bat` | Cấp key nhân viên nhanh |
| `CAP-KEY-LIFETIME.bat` | Cấp key vĩnh viễn |
| `LIET-KE-KEY.bat` | Danh sách key đã cấp |
| `KIEM-TRA-KEY.bat` | Verify 1 key (dán hoặc file) |
| `HUONG-DAN-CAP-KEY.md` | Hướng dẫn chi tiết |
| `DANH-SACH-KHACH.md` | Sổ theo dõi khách |
| `TRANG-THAI-HE-THONG.md` | Snapshot kiểm tra gần nhất |

## Cấu trúc project liên quan

```
D:\fb-page-poster\
  Admin-Quan-Ly\          ← bạn đang ở đây
  FB-Page-Studio-App\     ← EXE + data chạy thật (v1.2.20)
  pack-customer\          ← gói gửi khách
  Luu-Tru-Ban-Cu\         ← bản EXE/zip/build cũ
  keys\                   ← private + issued (tuyệt mật)
  scripts\gen-license.mjs
  scripts\list-licenses.mjs
  scripts\verify-license-key.mjs
```

## Lệnh npm (từ gốc project)

```powershell
cd D:\fb-page-poster
npm run license:gen -- --type commercial --holder "ABC" --days 365
npm run license:list
npm run license:verify -- --file keys\issued\xxx.txt
npm test
npm run build:customer
```
