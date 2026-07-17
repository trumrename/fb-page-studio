# Hướng dẫn dùng FB Page Studio

**1 app duy nhất** quản lý nhiều tài khoản FB + nhiều fanpage.  
Không cần mở nhiều tool — mọi page chạy chung 1 process, 1 DB, 1 bộ anti-spam.

---

## 1. Mở app

| Cách | Địa chỉ / file |
|------|----------------|
| **Desktop App (có logo, cửa sổ riêng)** | `dist-desktop\FB-Page-Studio-Desktop.exe` |
| Chạy dev desktop | `npm run desktop` |
| App Console (trong cửa sổ app) | tự load, không cần mở Chrome |
| File exe (web-server only, cũ) | `dist\FB-Page-Studio.exe` |
| Connect / Pages | http://localhost:3847/index.html |
| Cấu hình đăng | http://localhost:3847/posting.html |
| Anti-spam | http://localhost:3847/antispam.html |
| **Báo cáo CSV** | `data/exports/dang_bai_chi_tiet.csv` |
| **Báo cáo Excel** | `data/exports/dang_bai_chi_tiet.xlsx` |
| GitHub Release | https://github.com/trumrename/fb-page-studio/releases |

### App Console làm gì?
1. Tick nhiều page  
2. **Đăng 1 bài / page** hoặc **Hẹn giờ**  
3. Xem **% tổng · % từng page · từng nhiệm vụ**  
4. Toast **OK / FAIL** rõ  
5. Tự ghi CSV + Excel (ngày giờ, page, success, link, lỗi…) |

Lần đầu chạy **exe**: copy `.env.example` → `.env` cạnh exe, điền:

```env
FB_APP_ID=...
FB_APP_SECRET=...
FB_REDIRECT_URI=https://YOUR-NGROK/auth/facebook/callback
APP_BASE_URL=https://YOUR-NGROK
GITHUB_REPO=trumrename/fb-page-studio
PORT=3847
```

OAuth Facebook **bắt buộc HTTPS** (ngrok) khi app Live.

---

## 2. Flow dùng hàng ngày

### Bước A — Kết nối nick FB
1. Trang **Pages** → **+ Connect**  
2. Login Facebook (cửa sổ OAuth)  
3. App lưu **page token** (mã hóa)  
4. Lặp lại cho **mỗi nick** cần quản lý (vẫn 1 app)

Dev mode Meta: nick phải là **Admin / Developer / Tester** của App.

### Bước B — Sync page
1. Chọn account bên trái  
2. **Sync list** → lấy danh sách page  
3. **Sync details** → followers + tăng 7 ngày (có delay, tránh spam API)

### Cước C — Chuẩn bị media & caption
```
data/media/inbox/      ← bỏ ảnh/video chờ đăng
data/media/posted/     ← app tự chuyển sau khi đăng OK
data/media/captions/   ← .txt / .csv (mỗi dòng 1 caption)
```

- Caption: **random** từ kho  
- **1 file media = đăng 1 lần duy nhất** (hash) → sang `posted`, không đăng lại page nào

### Bước D — Đăng / hẹn giờ
1. Vào **Publish** (`/posting.html`)  
2. Chọn page (hoặc tick nhiều page cho bulk)  
3. Cấu hình: sequence photo/video/text, interval, max/ngày  
4. **Đăng ngay** hoặc **Hẹn giờ FB** (bulk)  
5. Xem log dưới trang / CSV

### Bước E — Anti-spam
1. Vào **Anti-spam**  
2. Giữ preset **Recommended** (hoặc Strict nếu nhiều page)  
3. Mọi số đều chỉnh được → **Lưu**

---

## 3. 1 app · nhiều page — limit xử lý thế nào?

App **không** mở 1 process/page. Tất cả page chia sẻ:

### A. Limit theo **từng page** (config Publish)
| Tham số | Mặc định (sau anti-spam sàn) | Ý nghĩa |
|---------|------------------------------|---------|
| `max_posts_per_day` | ≤ 8 | Tối đa bài/ngày **1 page** |
| `interval_minutes` | ≥ 60 | Cách nhau tối thiểu giữa 2 bài **1 page** |
| `page_cooldown` | 90 phút | Cooldown thêm sau mỗi bài OK |

Scheduler local (60s/tick): page nào **đến giờ** mới đăng, không đụng cùng lúc hết page.

### B. Limit **toàn app** (Anti-spam — mọi page cộng dồn)
| Tham số | Recommended | Ý nghĩa |
|---------|-------------|---------|
| Max bài / **giờ** global | **12** | 28 page cũng chỉ ≤ 12 bài/giờ tổng |
| Max bài / **24h** global | **40** | Tổng cả app |
| Bulk schedule | 15 page · 10 slot · **40 total**/lần | Cắt cứng 1 lần hẹn |
| Jitter | 3–18 phút | Tránh giờ trùng pattern |
| Pause App usage ≥ | **45%** | Meta API nóng → dừng publish |
| Backoff Graph | 90s → x2 | Lỗi spam/rate → nghỉ |

→ **Nhiều page không = spam nhanh hơn.**  
Page 20–50 vẫn bị **cửa global** + **cooldown từng page** chặn.

### C. Media / caption
- Hash media: 1 file → 1 lần đời (mọi page)  
- Caption trùng trong 48h → chặn, pick caption khác  
- Keyword / page block list (tùy chỉnh)

### D. Enrich (sync followers)
- Delay giữa page + TTL 12h  
- Không sync details ồ ạt liên tục

### E. Meta phía server
Dù app giới hạn, **Facebook** vẫn có rate limit / spam filter riêng.  
App chỉ **giảm rủi ro**, không “né” 100% Meta.

---

## 4. Gợi ý khi chạy SLL page (20–100+)

1. Anti-spam: **Strict** nếu > 30 page  
2. Chỉ **bật scheduler** page cần chạy (checkbox ON) — đừng bật hết 50 page cùng lúc  
3. Hẹn giờ bulk: chia **nhiều đợt** (sáng / chiều), mỗi đợt ≤ 10–15 page  
4. Interval page ≥ 2–3 giờ nếu content giống nhau  
5. Kho caption **lớn**, media **unique** mỗi bài  
6. Nhìn dashboard: **App API usage %** + Anti-spam “bài/giờ”  
7. **Không** bật Force / ignore quota khi production  

Ví dụ 28 page, Recommended:  
~12 bài/giờ global → trung bình **không** page nào spam; nhiều page sẽ **xếp hàng** theo interval/cooldown.

---

## 5. Sơ đồ 1 app

```
[FB Page Studio — 1 process]
        │
        ├── Account 1 ──► Page A, B, C
        ├── Account 2 ──► Page D, E, …
        │
        ├── Scheduler 60s  → chỉ page enabled + đủ giờ
        ├── Anti-spam global → chặn vượt giờ/ngày
        ├── Media hash DB  → 1 file 1 lần
        └── Graph API      → token từng page
```

---

## 6. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|------------|------------|
| Connect fail / redirect | Ngrok + whitelist `FB_REDIRECT_URI` |
| “Tester” only | Add nick vào App Roles |
| Anti-spam GLOBAL_HOUR_CAP | Chờ hết giờ hoặc nới setting (cẩn thận) |
| MEDIA_DUP | File đã đăng — dùng ảnh khác |
| CAPTION_DUP | Thêm caption vào kho |
| App usage cao | Dừng sync/publish, chờ ~1h |
| Port 3847 bận | Đổi `PORT` trong `.env` hoặc tắt process cũ |

---

## 7. File tài liệu khác

- `README.md` — tổng quan + build  
- `GITHUB.md` — đẩy GitHub + release exe  
- `dist/README-CHAY-APP.txt` — chạy portable  
- UI: menu sidebar trong app  

Có thắc mắc thao tác cụ thể: nói bước đang kẹt (Connect / Publish / Hẹn giờ / Anti-spam).
