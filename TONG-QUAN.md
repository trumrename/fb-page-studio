# FB Page Studio — Tổng quan tool

**1 app desktop** quản lý nhiều tài khoản Facebook + nhiều fanpage, đăng bài / hẹn giờ qua **Graph API chính thức** (không cookie, không giả Chrome, không emulator).

| | |
|--|--|
| **Tên** | FB Page Studio |
| **Phiên bản** | 1.1.0 |
| **Loại** | Desktop Windows (Electron) + server nội bộ |
| **GitHub** | https://github.com/trumrename/fb-page-studio |
| **Exe desktop** | `dist-desktop\FB-Page-Studio-Desktop.exe` |
| **Docs** | `SETUP.md` · `HUONG-DAN.md` · `GITHUB.md` |

---

## 1. Mục tiêu sản phẩm

| Làm được | Không làm |
|----------|-----------|
| Multi-account OAuth official | Auto-login / cookie developers.facebook.com |
| List page, followers, +7 ngày | Bịa data admin/BM/quốc gia khi API không có |
| Đăng feed text / ảnh / video | Story đăng API (chỉ cờ flag) |
| Hẹn giờ FB (`scheduled_publish_time`) | Spam đa luồng song song |
| Caption random từ `.txt`/`.csv` | Scrap UI Facebook |
| Anti-spam + báo cáo CSV/Excel | Vượt limit / né Meta |

---

## 2. Kiến trúc 1 app

```
┌─────────────────────────────────────────────┐
│  FB Page Studio Desktop (cửa sổ + logo)     │
│  Electron shell                             │
└──────────────────┬──────────────────────────┘
                   │  UI nội bộ (không cần Chrome)
                   ▼
┌─────────────────────────────────────────────┐
│  Express server (localhost:3847)            │
│  · OAuth  · Pages  · Publish  · Jobs        │
│  · Anti-spam  · Reports  · Scheduler 60s    │
└──────────────────┬──────────────────────────┘
                   │  Graph API (HTTPS)
                   ▼
            Facebook / Meta
```

- **1 process** · **1 DB** · nhiều account · nhiều page  
- Đăng bài **tuần tự** (an toàn rate), UI hiện **% tiến trình** từng page/task  

---

## 3. Module chức năng

### 3.1 Accounts & Pages
- Connect Facebook (OAuth cửa sổ login chuẩn Meta)
- Lưu **long-lived user token** + **page token** (mã hóa SQLite)
- Sync list: `/me/accounts` (phân trang)
- Sync details: followers, tăng follow 7 ngày (insights)
- Export danh sách page: Excel (nhiều sheet theo ngày) / CSV
- Hiển thị App API usage %

### 3.2 Publish (đăng ngay)
- Loại: **text · photo · video** (sequence lặp)
- Media: `data/media/inbox` → sau OK → `data/media/posted`
- Caption: kho file **random** (`.txt` dòng / `.csv` cột caption)
- Optional: auto comment sau đăng (template + link list)
- Config **từng page**: max/ngày, interval, bật scheduler local

### 3.3 Hẹn giờ Facebook
- Graph: `published=false` + `scheduled_publish_time` (10 phút – 30 ngày)
- Bulk nhiều page
- Mode **giờ ưa thích** từng page (Meta đã deprecate `page_fans_online` → user lưu giờ)
- Mode **giờ cố định** / start + interval
- Jitter chống pattern cứng

### 3.4 App Console — Vận hành
- Chọn nhiều page → **job**
- Progress: **% tổng · % từng page · từng nhiệm vụ**
- Toast **OK / FAIL** + panel thông báo
- 1 job = hàng đợi tuần tự an toàn

### 3.5 Anti-spam / Safety (tùy chỉnh + preset)
| Rule | Mặc định Recommended |
|------|----------------------|
| 1 media hash = 1 lần đời (mọi page) | ON → move posted ngay |
| Caption trùng (cửa sổ giờ) | 48h |
| Global max bài/giờ | 12 |
| Global max bài/24h | 40 |
| Page cooldown | 90 phút |
| Interval sàn page | ≥ 60 phút |
| Cap max/ngày page | ≤ 8 |
| Bulk hard limit | 15 page · 10 slot · 40 total |
| Force bỏ quota | OFF |
| Pause App usage ≥ | 45% |
| Backoff Graph lỗi spam/rate | base 90s → x2 |

Preset: **Recommended · Strict · Loose**

### 3.6 Báo cáo
Mỗi lần đăng/hẹn (OK hoặc FAIL) ghi:

```
data/exports/dang_bai_chi_tiet.csv
data/exports/dang_bai_chi_tiet.xlsx
```

Cột chính: ngày giờ · success · tên page · page_id · loại · link bài · post_id · caption · media · lỗi · message…

---

## 4. Giao diện (menu)

| Màn | URL / entry | Việc |
|-----|-------------|------|
| **Vận hành (App)** | `/app.html` | Job, progress %, toast, báo cáo |
| **Pages / Connect** | `/index.html` | OAuth, sync, export page |
| **Cấu hình đăng** | `/posting.html` | Config page, caption, hẹn lẻ |
| **Anti-spam** | `/antispam.html` | Limit, preset, keyword |

Desktop mở thẳng **Vận hành** trong cửa sổ app + logo.

---

## 5. Dữ liệu & folder

```
[project hoặc folder cạnh exe]
  .env
  data/
    app.db                 # tokens + config + logs + anti-spam
    media/
      inbox/               # chờ đăng
      posted/              # đã đăng (hash 1 lần)
      captions/            # .txt / .csv
    exports/
      dang_bai_chi_tiet.csv
      dang_bai_chi_tiet.xlsx
      pages_history.xlsx   # export list page
      post_logs.csv        # log kỹ thuật
  assets/ · build/         # logo icon
  dist-desktop/            # FB-Page-Studio-Desktop.exe
```

---

## 6. Bảo mật & compliance

- Token mã hóa local (`TOKEN_ENCRYPTION_KEY`)
- **Không** commit `.env` / `data/` lên Git
- OAuth user tự login — không bot pass
- Tôn trọng rate Meta + anti-spam app
- Multi-account: mỗi nick phải có role App (Dev mode) hoặc App Live + review

---

## 7. Giới hạn kỹ thuật (biết trước)

| Hạng mục | Trạng thái |
|----------|------------|
| Story đăng + sticker link | Chưa (flag only) |
| Giờ “fans online” từ Graph | Deprecated → giờ ưa thích user |
| List admin NPE đầy đủ như UI | Không đủ API → đã gỡ |
| Đa luồng publish song song | Không (cố ý, an toàn hơn) |
| OAuth | Cần HTTPS (ngrok) khi Live |

---

## 8. Stack kỹ thuật

| Lớp | Công nghệ |
|-----|-----------|
| Desktop | Electron 33 + icon Windows |
| Backend | Node.js 18+ · Express |
| DB | better-sqlite3 |
| FB API | Graph v21 · OAuth · Page token |
| Export | ExcelJS · CSV UTF-8 BOM |
| Build desktop | electron-builder → portable exe |
| Build portable server (cũ) | caxa → `dist/FB-Page-Studio.exe` |

---

## 9. Flow dùng chuẩn

```
1. Setup Meta App + .env + ngrok (SETUP.md)
2. Mở Desktop exe
3. Connect từng nick FB (OAuth)
4. Sync list / details
5. Chuẩn bị inbox + captions
6. Anti-spam: Recommended (hoặc Strict)
7. Cấu hình từng page (4 bài/ngày, interval 3h…)
8. Vận hành: tick page → Đăng / Hẹn giờ
9. Xem % · toast · CSV/Excel
```

---

## 10. Gợi ý vận hành nhiều page

| Nhu cầu | Gợi ý |
|---------|--------|
| 1 page · 4 bài/ngày (2 sáng 2 tối) | Interval ≥ 3h · max 4/ngày |
| Nhiều page cùng buổi | Cùng đợt, app xếp hàng vài giây–phút |
| 20–50 page | Anti-spam Strict · đừng bật ON hết |
| An toàn media | 1 file 1 lần · không copy lại hash |
| Global | ≤ 12 bài/giờ cả app (Recommended) |

---

## 11. Lệnh nhanh

```powershell
cd C:\Users\NCpc\fb-page-poster

npm run desktop              # dev cửa sổ app
npm run build:desktop        # build FB-Page-Studio-Desktop.exe
npm start                    # chỉ server (mở browser)
npm run build:exe            # bản caxa (mở browser)
```

---

## 12. Tài liệu liên quan

| File | Nội dung |
|------|----------|
| **TONG-QUAN.md** | File này — big picture |
| **SETUP.md** | Cài Meta · ngrok · .env · lần đầu |
| **HUONG-DAN.md** | Dùng hàng ngày · limit · lỗi |
| **GITHUB.md** | Push repo · Release · update |
| **README.md** | Overview ngắn + dev |

---

## 13. Tóm tắt 5 dòng

1. **1 app desktop** logo + cửa sổ riêng, multi-account/page.  
2. **Graph API official** — OAuth, đăng feed, hẹn giờ FB.  
3. **Caption random + media 1 lần** + anti-spam siết.  
4. **Job có % tiến trình**, toast OK/FAIL, **CSV + Excel** chi tiết.  
5. **Không** cookie bot / scrap UI / spam đa luồng.

*— FB Page Studio · Official Graph path · Local data, cloud Facebook publish —*
