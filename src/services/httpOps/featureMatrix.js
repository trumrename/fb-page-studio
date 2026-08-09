/**
 * Full HTTP-ops feature matrix (no browser UI automation).
 *
 * engine:
 *  - graph   → Official Graph API (Page access token / appsecret_proof)
 *  - session → Cookie session HTTP (web/mobile-style requests)
 *  - hybrid  → Prefer graph; fall back to session when Graph cannot
 *
 * status:
 *  - ready     → Implemented and callable now
 *  - partial   → Core path works; some options missing
 *  - scaffold  → Queue/API ready; session endpoint map TBD (self-RE)
 *  - blocked   → Meta removed official API; session-only forever
 */

/** @typedef {'graph'|'session'|'hybrid'} Engine */
/** @typedef {'ready'|'partial'|'scaffold'|'blocked'} Status */

/**
 * @type {Record<string, {
 *   id: string,
 *   label: string,
 *   engine: Engine,
 *   status: Status,
 *   hidden: boolean,
 *   multiThread: boolean,
 *   notes: string
 * }>}
 */
export const FEATURES = {
  page_feed_post: {
    id: "page_feed_post",
    label: "Đăng feed Fanpage",
    engine: "graph",
    status: "ready",
    hidden: true,
    multiThread: true,
    notes: "Graph /{page-id}/feed|photos|videos",
  },
  page_story_media: {
    id: "page_story_media",
    label: "Đăng Story media (ảnh/video)",
    engine: "graph",
    status: "ready",
    hidden: true,
    multiThread: true,
    notes: "Page Stories API photo/video only",
  },
  page_story_combo_link: {
    id: "page_story_combo_link",
    label: "Story + feed link (combo/overlay)",
    engine: "graph",
    status: "ready",
    hidden: true,
    multiThread: true,
    notes: "Workaround hợp lệ khi không có sticker API",
  },
  page_story_link_sticker: {
    id: "page_story_link_sticker",
    label: "Story + link sticker (swipe-up)",
    engine: "session",
    status: "scaffold",
    hidden: true,
    multiThread: true,
    notes: "Graph không có; cần session HTTP map endpoint",
  },
  page_story_schedule: {
    id: "page_story_schedule",
    label: "Hẹn giờ đăng story (slot + max/ngày)",
    engine: "hybrid",
    status: "ready",
    hidden: true,
    multiThread: true,
    notes: "Local scheduler → graph hoặc session publisher",
  },
  page_story_delete_schedule: {
    id: "page_story_delete_schedule",
    label: "Hẹn giờ xóa story",
    engine: "hybrid",
    status: "scaffold",
    hidden: true,
    multiThread: true,
    notes: "Cần story_id sau publish; xóa qua graph/session",
  },
  page_delete_posts: {
    id: "page_delete_posts",
    label: "Xóa bài Fanpage (filter ngày/multipass)",
    engine: "graph",
    status: "ready",
    hidden: true,
    multiThread: true,
    notes: "deletePosts service hiện có",
  },
  group_post: {
    id: "group_post",
    label: "Đăng bài Group",
    engine: "session",
    status: "scaffold",
    hidden: true,
    multiThread: true,
    notes: "Groups API official đã deprecate (2024+)",
  },
  group_delete_posts: {
    id: "group_delete_posts",
    label: "Xóa bài Group",
    engine: "session",
    status: "partial",
    hidden: true,
    multiThread: true,
    notes: "Có UI/service delete-group; hoàn thiện session HTTP",
  },
  group_list: {
    id: "group_list",
    label: "List group của nick",
    engine: "session",
    status: "scaffold",
    hidden: true,
    multiThread: false,
    notes: "Cookie session",
  },
  session_health: {
    id: "session_health",
    label: "Check cookie còn sống",
    engine: "session",
    status: "ready",
    hidden: true,
    multiThread: true,
    notes: "HTTP GET me / homepage probe",
  },
};

export function listFeatures() {
  return Object.values(FEATURES);
}

export function getFeature(id) {
  return FEATURES[id] || null;
}

export function featuresByEngine(engine) {
  return listFeatures().filter((f) => f.engine === engine || f.engine === "hybrid");
}
