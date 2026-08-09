# Hướng dẫn máy mới / máy khách

**Bản Setup:** v1.2.72+  
**Tải:** https://github.com/trumrename/fb-page-studio/releases/latest/download/FB-Page-Studio-Setup.exe  

---

## 1. Cài đặt

1. Tải Setup (link trên).  
2. **Thoát** bản FB Page Studio cũ (khay + Task Manager).  
3. Chạy Setup → cài / **cài đè** cùng thư mục.  
4. Mở app từ Start Menu / Desktop.  

### Data giữ ở đâu?

```
%APPDATA%\fb-page-studio\
  .env
  data\app.db
  data\license.json
  data\media\...
```

Cài đè **không xóa** folder này → page token / license thường còn.

---

## 2. Lần đầu (máy chưa từng cài)

1. Mở app → nhập **License key** (nếu có).  
2. Connect Facebook (App 1 / App 2).  
3. Chọn page → dùng đăng / xóa.  

OAuth qua domain: `https://modelswiki.top` (không cần ngrok trên máy khách).

---

## 3. Chrome Portable (quan trọng)

Nếu máy dùng **Chrome Portable** (không Chrome hệ thống):

Trong `%APPDATA%\fb-page-studio\.env` (hoặc màn setup browser trong app):

```env
FB_BROWSER_PATH=D:\ChromePortable\ChromePortable.exe
```

**Đúng:** path tới file **`ChromePortable.exe`**.

**Sai / bỏ:**

```env
# KHÔNG set
FB_CHROME_USER_DATA_DIR=...
FB_CHROME_PROFILE=...
```

(Các cờ đó gây đăng xuất FB, captcha, trông như mất extension.)

Cách dùng:

1. Mở Portable, login Facebook sẵn.  
2. Mở tool → Connect → tab mở **trên Portable** đó.  

---

## 4. Xóa bài Fanpage

- **Full wipe:** để trống Từ/Đến ngày.  
- **Theo ngày:** «Đến hết ngày» = xóa đến 23:59:59 ngày đó.  
- Bài **page share** (`shared_story`) xóa được.  
- Fail `#200` (not by app / same app photo) = **Meta chặn**, không phải tool hỏng.  
- Tải CSV/TXT danh sách fail trong màn xóa.  

Chi tiết: `TONG-QUAN.md` § xóa + `CHECK-BUG.md` §8.

---

## 5. Lỗi thường gặp

| Hiện tượng | Làm gì |
|------------|--------|
| App version cũ sau cài | Thoát tray hết → mở lại shortcut Setup |
| Mất page sau cài | Kiểm tra `%APPDATA%\fb-page-studio\data` |
| Logout FB sau Connect | Cài ≥1.2.72 · chỉ `FB_BROWSER_PATH` Portable |
| Captcha sau bulk | Chia nhỏ job · đợi · tin cậy thiết bị 1 lần |
| #4 rate limit | Tool tự pause; giảm list// page song song |

---

## 6. Docs thêm

- `DOC-INDEX.md` — mục lục  
- `CHECK-BUG.md` — checklist đầy đủ  
- `TRANG-THAI-HIEN-TAI.md` — version đang ship  

---

*Máy mới = Setup latest + AppData + (tuỳ chọn) ChromePortable path.*
