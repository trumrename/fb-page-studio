FB Page Studio — GÓI KHÁCH (an toàn)
====================================

CÁCH 1 — BẢN CÀI (khuyến nghị, ghim taskbar):
  1) Chạy FB-Page-Studio-Setup-v1.2.65.exe
  2) Cài xong → Start Menu / Desktop: FB Page Studio
  3) Chuột phải icon thanh taskbar → Ghim vào thanh tác vụ

  .env tự tạo (HTTPS OAuth relay) tại:
    %APPDATA%\fb-page-studio\.env
  Redirect chuẩn: https://modelswiki.top/auth/facebook/callback

CÁCH 2 — Portable (không cài):
  1) Copy EXE (+ .env.public nếu có)
  2) Mở EXE — tự tạo .env cạnh EXE (OAUTH_RELAY + HTTPS domain)
  3) Connect Facebook

META APP ID — TỰ ĐIỀN (gói này KHÔNG kèm sẵn):
  · Mở tool → tab "Cấu hình lần đầu" → nhập App ID (+ App Secret nếu có)
    App Secret sẽ được đẩy lên server relay, KHÔNG lưu trên máy bạn.
  · Hoặc bỏ trống: nếu server relay đã khai App thì tool tự đồng bộ App ID
    khi mở (lấy từ /api/apps — server không trả secret).

KHÔNG dùng http://localhost làm FB_REDIRECT_URI (Facebook chặn).
KHÔNG cần Ngrok. KHÔNG cần App Secret trên máy bạn.
Login Facebook qua domain relay HTTPS của nhà cung cấp.

Gói này KHÔNG chứa: FB_APP_ID, FB_APP_SECRET, Ngrok token, license-private.pem

version 1.2.65
oauth_relay_url=https://modelswiki.top
