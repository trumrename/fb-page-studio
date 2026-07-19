# FB Page Studio — hướng dẫn máy mới (v1.2.20)

## 1. Chỉ cần EXE (hoặc ZIP gói khách)

Tải đúng asset GitHub:

- `FB-Page-Studio-Desktop-v1.2.20.exe` **hoặc**
- `FB-Page-Studio-v1.2.20-Windows.zip` (giải nén rồi chạy EXE)

**Không** tải `Source code.zip`.

```text
D:\FB-Page-Studio\
  FB-Page-Studio-Desktop-v1.2.20.exe
```

Lần đầu tool tự tạo `.env` và `data` cạnh EXE. Cập nhật: đặt EXE mới **cùng thư mục** để giữ license, token, lịch.

## 2. Thiết lập lần đầu trong tool

1. Mở EXE  
2. **Kết nối Meta → Bước 1** → App ID / App Secret  
3. **Lưu cấu hình máy mới**  
4. Dán **Authtoken Ngrok** → **Lưu token & mở server**  
5. Meta Developers: whitelist  
   `https://qgroup.ngrok.app/auth/facebook/callback`  
6. Chọn Chrome profile đã login Facebook → **Connect**  
7. **License** → dán key admin (hoặc trial)

Nếu Ngrok báo domain đang dùng máy khác: mở [dashboard.ngrok.com/endpoints](https://dashboard.ngrok.com/endpoints) → Stop endpoint → mở lại Ngrok trong app.

## 3. Hai kiểu đăng

| Chế độ | Ai canh giờ |
|--------|-------------|
| **Đăng trực tiếp Local** | Tool/PC phải bật; đến giờ gọi API đăng ngay |
| **Hẹn giờ Facebook** | Facebook giữ scheduled post; app có thể tắt sau khi tạo lịch |

## 4. Giờ từng page

Meta đã **gỡ** `page_fans_online`. Mode “giờ tích cực” dùng **giờ ưa thích** (preset VN 9,12,19,21 nếu chưa đặt). Có thể gán hàng loạt trong màn hẹn giờ.

## 5. Tiến trình & lỗi

- Theo dõi % job, từng task  
- Task lỗi hiện **đúng nội dung lỗi**  
- Nút **Đăng lại** từng task / cả list lỗi  

## 6. Cập nhật app

Banner / nút version → Cập nhật ngay. Chỉ thay EXE; giữ `data\`, license, `.env`.

## 7. File gói khách

Xem `MANIFEST.txt` và `README-KHACH.txt`. Không cần BAT Ngrok riêng.
