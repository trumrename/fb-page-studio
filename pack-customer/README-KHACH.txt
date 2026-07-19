FB Page Studio — GÓI MÁY KHÁCH
================================
Phiên bản gói: xem file VERSION.txt (đồng bộ khi build)

QUAN TRONG — TAI TREN GITHUB:
-----------------------------
DUNG:  Assets → FB-Page-Studio-Desktop-vX.Y.Z.exe
SAI:   "Source code (zip)" / "Source code (tar.gz)"
       = ma nguon lap trinh, KHONG phai ban cai, co the thay file cu/hong, KHONG co app.exe

1) CÀI ĐẶT NHANH
----------------
- Copy cả thư mục này sang máy khách (hoặc chỉ file .exe + .env).
- Đặt file FB-Page-Studio-Desktop-vX.Y.Z.exe vào folder riêng (vd D:\FB-Page-Studio\).
- Copy .env.example thành .env cạnh file .exe
- Điền FB_APP_ID, FB_APP_SECRET, FB_REDIRECT_URI (Meta App của chủ tool / khách).
- Chạy duy nhất file FB-Page-Studio-Desktop-vX.Y.Z.exe.
- Vào Kết nối Meta, dán Authtoken Ngrok rồi bấm "Lưu token & mở server".
- Tool tự tải Ngrok nếu máy chưa có, tự mở tunnel theo domain và tự đóng khi thoát EXE.
- Nếu token sai hoặc bị thu hồi, giao diện sẽ yêu cầu nhập token mới.
- Mở menu License → dán KEY do admin cấp (hoặc dùng trial).

2) CẤU TRÚC KHUYẾN NGHỊ TRÊN MÁY KHÁCH
--------------------------------------
  D:\FB-Page-Studio\
    FB-Page-Studio-Desktop-vX.Y.Z.exe
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

6) CÁC KHU VỰC CHÍNH (v1.2.16)
--------------------------------
- Tổng quan: tình trạng app, lịch và cảnh báo.
- Kết nối: phân biệt App, Admin/Profile và danh sách Page.
- Cấu hình Page: media, caption, số bài/ngày, giờ hoạt động.
- Xoay vòng / Chạy: chạy ngay hoặc hẹn giờ, từng App hoặc hai App so le.
- Tiến trình: phần trăm, tác vụ đang chạy, thành công và lỗi.
- Báo cáo: Page, lịch sử đăng, follower tăng/giảm 1/3/7/30 ngày.

File báo cáo được lưu trong data\exports\daily. Tool tự chốt lịch sử ngày lúc
23:59 giờ Việt Nam. Nếu một Page không có follower, cần cấp lại quyền Facebook
Page cho tài khoản đã Connect; tool không tự điền số giả.

Quy tắc tài nguyên: media được chọn ngẫu nhiên và tránh các file gần lần chọn
trước; caption chạy lần lượt đến hết kho, sau đó trộn và xoay vòng tiếp.

Setup domain: vào Connect & chọn Page, dán domain HTTPS + Authtoken rồi lưu.
Tool tự ghi Redirect URI, tự tải/chạy Ngrok; không cần CMD hoặc BAT.

Nếu Connect mở Chrome chưa đăng nhập: trong cùng khu Setup, chọn đúng Chrome
Profile đang có Facebook đã login, lưu rồi bấm Connect ngay.

Cập nhật: bấm nút version trong app. Tool tải file EXE trực tiếp, hiển thị tiến
trình và tự khởi động lại; giữ nguyên data, key license và .env.

Admin / chủ tool: xem pack-dev\README-DEV.md trên máy dev.
