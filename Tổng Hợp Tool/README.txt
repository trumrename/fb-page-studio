TỔNG HỢP TOOL — FB Page Studio
================================
Một chỗ chứa toàn bộ gói giao / quản trị / server (không lẫn source code).

Cấu trúc:

  Tổng Hợp Tool\
    Admin-Quan-Ly\     ← Cấp license key (MENU-ADMIN.bat)
    pack-customer\     ← Gói KHÁCH (không secret) + ZIP Windows
    pack-internal\     ← Gói NỘI BỘ (CÓ secret) — chỉ máy tin cậy
    pack-dev\          ← EXE dev / admin test
    pack-server\       ← Máy server OAuth (CAI-MAY-SERVER.bat)
    release-assets\    ← ZIP sẵn sàng copy / GitHub
    README.txt

Build từ gốc project (D:\fb-page-poster):
  npm run pack:customer
  npm run pack:internal
  npm run pack:dev
  npm run pack:server
  npm run pack:customer:zip

Máy server:
  Copy folder  pack-server  → máy treo
  Chạy CAI-MAY-SERVER.bat (1 lần) rồi CHAY-SERVER-TAT-CA.bat

Source code, git, node_modules vẫn ở thư mục gốc project.
