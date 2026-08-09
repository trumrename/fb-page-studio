# Full HTTP Ops — Fanpage · Group · Story · Delete

**Hướng đã chốt:** mọi job = **HTTP request** (không Chrome UI).  
Chạy **ẩn** trong process EXE · **đa luồng** worker pool · **hẹn giờ** queue SQLite.

## Hai engine

| Engine | Auth | Dùng cho |
|--------|------|----------|
| **graph** | Page Access Token + appsecret_proof | Feed page, story media/combo, xóa bài page |
| **session** | Cookie nick (encrypted vault) | Story link sticker, group post/xóa, health |

## Feature matrix

| Op | Engine | Status |
|----|--------|--------|
| `page_feed_post` | graph | **ready** |
| `page_story_media` | graph | **ready** |
| `page_story_combo_link` | graph | **ready** (story + feed link) |
| `page_story_schedule` | hybrid→graph | **ready** (slot + max/day) |
| `page_story_link_sticker` | session | **scaffold** (cần map endpoint) |
| `page_story_delete_schedule` | hybrid | **scaffold** |
| `page_delete_posts` | graph | **ready** (module cũ) |
| `group_post` / `group_list` | session | **scaffold** (Groups API official chết) |
| `group_delete_posts` | session | **partial** |
| `session_health` | session | **ready** |

## API (local)

Base: `/api/http-ops`

| Method | Path | Mô tả |
|--------|------|--------|
| GET | `/features` | Ma trận chức năng |
| GET | `/status` | Workers + queue |
| POST | `/workers/start` | `{ concurrency: 3 }` |
| POST | `/workers/stop` | Dừng pool |
| GET/POST | `/sessions` | List / import cookie |
| PUT | `/sessions/:id/cookie` | Đổi cookie |
| POST | `/sessions/:id/health` | Check cookie sống |
| POST | `/sessions/:id/pages` | Map page_id |
| POST | `/sessions/:id/groups` | Map group_id |
| GET/POST | `/queue` | List / enqueue job |
| GET/POST | `/story-schedules` | Lịch story slot |
| POST | `/story-schedules/tick` | Force tick |

### Ví dụ import cookie

```http
POST /api/http-ops/sessions
Content-Type: application/json

{
  "label": "nick-ban-hang",
  "cookie": "c_user=...; xs=...; fr=...",
  "user_agent": "Mozilla/5.0 ...",
  "proxy_url": ""
}
```

### Ví dụ lịch story (5 lần/ngày · 5 khung giờ · combo link)

```http
POST /api/http-ops/story-schedules
Content-Type: application/json

{
  "page_id": "123456789",
  "page_row_id": 1,
  "enabled": true,
  "max_per_day": 5,
  "slots": [
    { "time": "08:00", "count": 1 },
    { "time": "12:00", "count": 1 },
    { "time": "18:00", "count": 1 },
    { "time": "20:00", "count": 1 },
    { "time": "22:00", "count": 1 }
  ],
  "link_url": "https://example.com/sp",
  "link_mode": "combo",
  "media_folder": "C:\\\\data\\\\media\\\\inbox",
  "delete_after_hours": 23
}
```

`link_mode`:

- `combo` / `overlay` / `media_only` → **Graph** (ready)
- `sticker` → queue `page_story_link_sticker` **session** (cần map endpoint)

### Ví dụ enqueue tay

```http
POST /api/http-ops/queue
{
  "op": "page_story_schedule",
  "engine": "graph",
  "page_row_id": 1,
  "target_id": "123456789",
  "payload": {
    "page_row_id": 1,
    "media_path": "C:\\\\data\\\\a.jpg",
    "link_url": "https://example.com",
    "link_mode": "combo"
  }
}
```

## Env

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `HTTP_OPS_CONCURRENCY` | `3` | Số worker HTTP song song |

## Map session op (story sticker / group)

1. Bắt request khi làm tay trên Facebook (mitmproxy / Charles / DevTools).  
2. Implement handler và đăng ký:

```js
import { registerSessionHandler } from "./services/httpOps/index.js";

registerSessionHandler("page_story_link_sticker", async (payload, job) => {
  // sessionFetch(sessionId, url, { method, headers, body })
  // return { story_id, ... }
});
```

Repo **không** ship GraphQL mutation private (tránh payload RE đóng băng / ToS dump).  
Infrastructure cookie + queue + worker **đã sẵn** để cắm handler.

## Chạy ẩn · đa luồng

- Worker pool chạy trong `server.js` khi EXE/start — **không mở cửa sổ browser**.  
- Nhiều job `pending` → N worker claim song song.  
- Delay giữa job + retry khi rate-limit.

## Code map

```
src/services/httpOps/
  featureMatrix.js   — ma trận
  cookieVault.js     — cookie mã hóa SQLite
  sessionClient.js   — fetch + cookie header
  sessionOps.js      — session executors + plugin register
  graphOps.js        — graph executors
  registry.js        — route engine
  opsQueue.js        — queue durable
  workerPool.js      — multi worker
  storyScheduler.js  — slot + max/day
  index.js
src/routes/httpOps.js
```

## Lộ trình hoàn thiện “full”

1. ~~Queue + workers + cookie vault + story slots Graph~~  
2. UI màn Sessions / Story schedule / Queue board  
3. Map `page_story_link_sticker` (session)  
4. Map `group_post` / group delete (session)  
5. Lifecycle xóa story theo `delete_at`  
6. Proxy agent cho session (undici ProxyAgent)
