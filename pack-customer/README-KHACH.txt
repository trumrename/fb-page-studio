FB Page Studio — GÓI MÁY KHÁCH
================================
Phiên bản gói: xem file VERSION.txt (đồng bộ khi build)

QUAN TRONG — TAI TREN GITHUB:
-----------------------------
DUNG:  Assets → FB-Page-Studio-v1.2.x-Windows.zip  HOAC  FB-Page-Studio-Desktop.exe
SAI:   "Source code (zip)" / "Source code (tar.gz)"
       = ma nguon lap trinh, KHONG phai ban cai, co the thay file cu/hong, KHONG co app.exe

1) CÀI ĐẶT NHANH
----------------
- Copy cả thư mục này sang máy khách (hoặc chỉ file .exe + .env).
- Đặt file FB-Page-Studio-Desktop.exe vào folder riêng (vd D:\FB-Page-Studio\).
- Copy .env.example thành .env cạnh file .exe
- Điền FB_APP_ID, FB_APP_SECRET, FB_REDIRECT_URI (Meta App của chủ tool / khách).
- Chạy FB-Page-Studio-Desktop.exe
- Mở menu License → dán KEY do admin cấp (hoặc dùng trial).

2) CẤU TRÚC KHUYẾN NGHỊ TRÊN MÁY KHÁCH
--------------------------------------
  D:\FB-Page-Studio\
    FB-Page-Studio-Desktop.exe
    .env
    data\                 (tự tạo: DB, license.json, media…)
    license.backup.json   (tự tạo khi kích hoạt key)

3) CẬP NHẬT PHIÊN BẢN
---------------------
- App tự báo khi GitHub có bản mới (banner vàng).
- Bấm "Cập nhật ngay" → chỉ thay .exe.
- Key trong data\license.json GIỮ NGUYÊN nếu còn hạn / vĩnh viễn.

4) KHÔNG GỬI / KHÔNG CẦN
------------------------
- Không cần source code
- Không cần keys\license-private.pem
- Không cần node_modules
- Không copy data\ từ máy khác (token lộn xộn)

5) HỖ TRỢ
---------
- Machine ID: trong app → License (gửi admin nếu key gắn máy)
- Báo lỗi: version trên nút topbar (v1.x.x) + mô tả

Admin / chủ tool: xem pack-dev\README-DEV.md trên máy dev.
