/** When to send the auto-comment. Shared by direct posts and Facebook scheduled posts. */

const MAX_DELAY_MIN = 7 * 24 * 60;
const COMMENT_GRACE_MS = 20 * 1000;

export function readCommentTiming(linkLists) {
  const ll = linkLists && typeof linkLists === "object" ? linkLists : {};
  const whenRaw = String(ll.comment_when || "after_publish").trim().toLowerCase();
  const immediate =
    whenRaw === "immediate" ||
    whenRaw === "now" ||
    whenRaw === "ngay" ||
    whenRaw === "right_after_schedule";
  const delayMin = Math.max(0, Math.min(MAX_DELAY_MIN, Number(ll.comment_delay_minutes) || 0));
  const minLikes = Math.max(0, Math.min(1_000_000, Number(ll.comment_min_likes) || 0));
  // Số phút hoặc số like luôn nghĩa là chờ sau khi bài publish, kể cả radio còn «ngay».
  const afterPublish = !immediate || delayMin > 0 || minLikes > 0;
  return {
    when: afterPublish ? "after_publish" : "immediate",
    delayMin: afterPublish ? delayMin : 0,
    minLikes: afterPublish ? minLikes : 0,
    afterPublish,
  };
}

/**
 * ISO time the comment may be sent.
 * A delay of 0 still waits a short grace after the post is actually live.
 */
export function commentDueIso(publishMs, delayMin) {
  const base = Number(publishMs);
  if (!Number.isFinite(base) || base <= 0) return null;
  const minutes = Math.max(0, Number(delayMin) || 0);
  const waitMs = Math.max(COMMENT_GRACE_MS, minutes * 60 * 1000);
  return new Date(base + waitMs).toISOString();
}

/** SQLite datetime('now') is UTC with no zone. ISO strings that already have a zone pass through. */
export function parseDbTime(value) {
  const s = String(value || "").trim();
  if (!s) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const parsed = Date.parse(`${iso}Z`);
  return Number.isFinite(parsed) ? parsed : NaN;
}
