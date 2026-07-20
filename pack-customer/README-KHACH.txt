FB Page Studio — GÓI MÁY KHÁCH
================================
Phiên bản: xem VERSION.txt (đồng bộ khi build)

TẢI ĐÚNG TRÊN GITHUB
--------------------
ĐÚNG:  Assets → FB-Page-Studio-Desktop-vX.Y.Z.exe
   hoặc FB-Page-Studio-vX.Y.Z-Windows.zip (gói này)
SAI:   "Source code (zip)" = mã nguồn, KHÔNG phải bản cài

1) CÀI ĐẶT NHANH
----------------
- Giải nén ZIP (nếu có) vào thư mục riêng, ví dụ D:\FB-Page-Studio\
- Chạy: FB-Page-Studio-Desktop-vX.Y.Z.exe
- Lần đầu: Kết nối Meta → Bước 1 → nhập App ID / App Secret (tool tự tạo .env)
- Dán Authtoken Ngrok → "Lưu token & mở server" (domain mặc định qgroup.ngrok.app)
- License → dán KEY do admin cấp (hoặc dùng trial 7 ngày)

2) CẤU TRÚC KHUYẾN NGHỊ
-----------------------
  D:\FB-Page-Studio\
    FB-Page-Studio-Desktop-v1.2.21.exe
    .env                 (tự tạo)
    data\                (tự tạo: DB, license, media, báo cáo)
    license.backup.json  (khi kích hoạt key)

3) CẬP NHẬT
-----------
- App báo bản mới từ GitHub → "Cập nhật ngay" (chỉ thay .exe)
- Giữ nguyên data\, license, .env

4) KHÔNG CẦN / KHÔNG GỬI
------------------------
- Source code, node_modules
- keys\license-private.pem
- data\ copy từ máy khác

5) TÍNH NĂNG CHÍNH (v1.2.21)
----------------------------
- Multi Meta App + rotation so le / từng App
- Đăng trực tiếp Local: tool treo máy, đến giờ gọi API (không hẹn FB)
- Hẹn giờ Facebook: scheduled_publish_time
- Tiến trình job + danh sách lỗi + nút Đăng lại task lỗi
- Giờ từng page = preferred / preset VN (Meta đã gỡ page_fans_online)
- Anti-spam, báo cáo daily (follower 1/3/7/30 ngày)
- Updater tải EXE có % tiến trình

6) FILE TRONG GÓI
-----------------
- FB-Page-Studio-Desktop-vX.Y.Z.exe (+ .sha256.txt)
- HUONG-DAN-MAY-MOI.md
- .env.example
- media-sample\captions\captions.txt (mẫu)
- VERSION.txt · MANIFEST.txt · README-KHACH.txt

Hỗ trợ: tab License (Machine ID) · version trên topbar app.
