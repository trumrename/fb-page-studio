# FB Page Studio — hướng dẫn máy mới

## 1. Chỉ cần một EXE

Tải đúng asset GitHub có dạng:

`FB-Page-Studio-Desktop-vX.Y.Z.exe`

Không tải `Source code.zip`. Không cần chạy BAT, CMD hoặc server riêng.

Tạo một thư mục riêng, ví dụ:

```text
D:\FB-Page-Studio\
  FB-Page-Studio-Desktop-v1.2.16.exe
  .env
  data\
```

Luôn đặt EXE mới cạnh `.env` và `data` để giữ cấu hình, license, token Facebook và lịch đăng.

## 2. Tạo `.env`

Copy `.env.example` thành `.env`, sau đó điền tối thiểu:

```env
PORT=3847
APP_BASE_URL=https://qgroup.ngrok.app
NGROK_AUTHTOKEN=
NGROK_AUTOSTART=1

FB_APP_ID=
FB_APP_SECRET=
FB_REDIRECT_URI=https://qgroup.ngrok.app/auth/facebook/callback
TOKEN_ENCRYPTION_KEY=doi-chuoi-ngau-nhien-dai-hon-32-ky-tu!!
```

Có thể để trống `NGROK_AUTHTOKEN` và nhập token trên giao diện khi mở tool.

## 3. Ngrok đã tích hợp trong EXE

1. Mở EXE.
2. Vào **Kết nối Meta**.
3. Kiểm tra domain OAuth.
4. Dán Authtoken Ngrok.
5. Bấm **Lưu token & mở server**.

Tool sẽ tự:

- tìm `ngrok.exe` cạnh EXE, trong thư mục `ngrok`, hoặc PATH;
- tải Ngrok Windows amd64 nếu máy chưa có;
- lưu token vào `.env`;
- mở tunnel đúng domain và port `3847`;
- đóng Ngrok khi thoát tool;
- yêu cầu token mới nếu token sai hoặc bị thu hồi.

Không mở thêm `ngrok.exe`, BAT hoặc CMD. Một domain cố định chỉ nên chạy trên một máy tại thời điểm Connect Facebook.

## 4. Cấu hình Meta App

Trong Meta for Developers, thêm đúng URI:

```text
https://qgroup.ngrok.app/auth/facebook/callback
```

URI trên Meta phải trùng hoàn toàn `FB_REDIRECT_URI` trong `.env` và domain hiển thị trong tool.

## 5. Kết nối Facebook bằng Chrome/ChromePortable

- Chrome thường: chọn profile trong danh sách.
- ChromePortable: chọn thư mục gốc `GoogleChromePortable` hoặc `Data\profile`, sau đó bấm **Quét profile**.
- Chọn profile đang đăng nhập Facebook rồi bấm Connect App.

Tool mở tab OAuth mới bằng cookie của profile đã chọn; không chiếm tab Facebook đang mở.

## 6. Cập nhật phiên bản

- Nút version trong tool kiểm tra GitHub và tải trực tiếp.
- EXE tải thủ công luôn có version trong tên.
- Nếu còn bản cũ chạy nền, EXE mới sẽ cảnh báo. Hãy Thoát tool ở khay hệ thống hoặc tắt các tiến trình FB Page Studio trong Task Manager rồi mở lại.
- Không xóa `.env`, `data` hoặc `license.json` khi cập nhật.

## 7. Kiểm tra nhanh

- Nút version hiển thị đúng bản vừa tải.
- Ngrok hiển thị **Ngrok đang chạy** và đúng Public URL.
- Meta App, Admin/Profile và Page hiển thị đúng.
- Thư mục media/caption đúng ổ máy này.
- Giờ hiển thị theo Việt Nam.

## 8. Lỗi thường gặp

### Token Ngrok sai hoặc bị thu hồi

Dán token mới tại **Kết nối Meta → Ngrok Authtoken**. Tool tự ghi lại `.env` và mở lại tunnel.

### Domain đã chạy trên máy khác — ERR_NGROK_334

Tắt Ngrok/tool trên máy đang giữ domain, sau đó bấm **Mở lại Ngrok** trên máy cần Connect.

### ERR_NGROK_8012

Đảm bảo tool đang chạy port `3847`. Ngrok tích hợp luôn trỏ về `127.0.0.1:3847`.

### Mở EXE mới nhưng vẫn thấy version cũ

Bản cũ còn chạy trong RAM. Thoát ở khay hệ thống hoặc Task Manager rồi mở lại EXE có version mới.

### Không lấy được Page

Kiểm tra quyền Meta App, vai trò Tester/Developer khi App đang Development và các quyền Facebook Page đã được cấp.

## 9. Không gửi cho khách

- `.env` đã chứa App Secret/token;
- thư mục `data` từ máy DEV;
- private license key;
- source code và `node_modules`.

Gói khách chỉ cần EXE versioned, `.env.example`, hướng dẫn và media mẫu.
