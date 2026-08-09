# Hai tool tách rời (bắt buộc)

**Không gộp** login an toàn với login rủi ro.

## 1) FB Page Studio — AN TOÀN

| | |
|--|--|
| Code | `C:\Users\NCpc\fb-page-poster` |
| Login | **OAuth Meta App** + Page Access Token |
| API | **Graph** (feed, story media/combo, xóa page) |
| Port | **3847** |
| Setup | `F:\FB-Page-Studio\dist-desktop-oauth\FB-Page-Studio-Setup-v*.exe` |
| UI | Connect Meta, Page hub, posting, delete… |
| **Không có** | Menu Auto Login id\|pass\|2fa |

## 2) PageForge — RỦI RO (tên + logo riêng)

| | |
|--|--|
| Code | `F:\FB-Page-Studio\projects\fb-session-ops` |
| Brand | **PageForge** (logo PF amber/red) |
| Login | **cookie / id\|pass\|2fa** + checkpoint 282 |
| Port | **3857** |
| Setup | `F:\FB-Page-Studio\pageforge-dist\PageForge-Setup-v0.1.0.exe` |
| Portable + update | `PageForge-Desktop.exe` |
| GitHub | `trumrename/pageforge` (release asset) |

## Quy tắc

1. Hai Setup · hai shortcut · hai data folder.  
2. Khách an toàn → chỉ Page Studio.  
3. Khách chấp nhận risk → PageForge + cảnh báo.
