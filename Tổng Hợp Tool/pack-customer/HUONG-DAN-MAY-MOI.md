# FB Page Studio — hướng dẫn máy mới

## 1. Cài / chạy EXE

- **Setup (khuyên dùng):** `FB-Page-Studio-Setup-v*.exe`
- **Portable:** `FB-Page-Studio-Desktop-v*.exe`

Lần đầu tool tự tạo `.env` + `data` (Setup: `%APPDATA%\fb-page-studio`).

## 2. Thiết lập Meta (không dùng Ngrok)

1. Mở tool  
2. **Bước 1 · Thiết lập Meta App** → nhập **App ID** (+ Secret để đẩy lên server relay)  
3. **Lưu**  
4. Meta Developers → Valid OAuth Redirect URIs **chỉ**:

   ```text
   https://modelswiki.top/auth/facebook/callback
   ```

5. Chọn Chrome profile đã login Facebook → **Connect App 1 / App 2**  
6. Giữ app mở khi Connect; làm hết 2FA **một lần** (không F5 / không bấm Connect 2 lần)

OAuth đi qua **server relay** `modelswiki.top` — **không** cần Ngrok trên máy khách.

## 3. Domain / env cũ (đã bỏ)

Không còn dùng:

- `*.ngrok-free.dev` / `qgroup.ngrok.app`
- `videoviral1.chainityai.com` / handcraft tunnel
- `http://localhost/.../callback` làm redirect Facebook Live

Tool tự **purge** domain cũ trong `.env` về `modelswiki.top` khi mở app.

## 4. Hai kiểu đăng

| Chế độ | Ghi chú |
|--------|---------|
| **Đăng trực tiếp Local** | PC/tool phải bật |
| **Hẹn giờ Facebook** | Facebook giữ lịch sau khi tạo |

## 5. Cập nhật

Tải Setup/Portable mới cùng thư mục (portable) hoặc cài đè Setup — data/license giữ nguyên.
