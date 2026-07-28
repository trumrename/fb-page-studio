/**
 * API: bulk delete Fanpage posts (Graph official).
 */
import { Router } from "express";
import {
  previewPagePosts,
  startDeleteJob,
  getDeleteJob,
  listDeleteJobs,
  stopDeleteJob,
  onDeleteJob,
  failedPostsToCsv,
} from "../services/deletePosts.js";
import { listPages } from "../services/accounts.js";

const router = Router();

/** Pages available for delete UI */
router.get("/pages", (_req, res) => {
  try {
    const pages = listPages({ limit: 5000 });
    res.json({
      ok: true,
      pages: pages.map((p) => ({
        id: p.id,
        page_id: p.page_id,
        name: p.name,
        account_id: p.account_id,
        category: p.category,
        status: p.status,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Preview posts (không xóa).
 * Query: page_row_id, max_posts, since, until, keyword
 */
router.get("/preview", async (req, res) => {
  try {
    const pageRowId = Number(req.query.page_row_id || req.query.pageRowId);
    if (!Number.isFinite(pageRowId) || pageRowId <= 0) {
      return res.status(400).json({ ok: false, error: "Thiếu page_row_id" });
    }
    const data = await previewPagePosts(pageRowId, {
      max_posts: req.query.max_posts || req.query.maxPosts || 100,
      since: req.query.since || undefined,
      until: req.query.until || undefined,
      keyword: req.query.keyword || undefined,
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** Start bulk delete job */
router.post("/start", (req, res) => {
  try {
    const body = req.body || {};
    let pageRowIds = body.page_row_ids || body.pageRowIds || [];
    if (!pageRowIds.length && body.page_row_id != null) {
      pageRowIds = [body.page_row_id];
    }
    if (!pageRowIds.length && body.pageRowId != null) {
      pageRowIds = [body.pageRowId];
    }
    const job = startDeleteJob({
      ...body,
      page_row_ids: pageRowIds,
    });
    res.json({ ok: true, job });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/jobs", (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  res.json({ ok: true, jobs: listDeleteJobs(limit) });
});

router.get("/jobs/:id", (req, res) => {
  const job = getDeleteJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, job });
});

/** Report tóm tắt + list bài lỗi (JSON) */
router.get("/jobs/:id/report", (req, res) => {
  const job = getDeleteJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({
    ok: true,
    report: job.report || null,
    pages: (job.pages || []).map((p) => ({
      page_row_id: p.page_row_id,
      page_id: p.page_id,
      page_name: p.page_name,
      status: p.status,
      ok: p.ok,
      fail: p.fail,
      listed: p.listed,
      matched: p.matched,
      error: p.error,
      error_summary: p.error_summary,
      failed_posts: p.failed_posts || [],
      failed_truncated: p.failed_truncated || false,
    })),
  });
});

/** Tải CSV các bài lỗi + link */
router.get("/jobs/:id/failed.csv", (req, res) => {
  const csv = failedPostsToCsv(req.params.id);
  if (csv == null) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }
  const name = `delete-failed-${req.params.id}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  // BOM for Excel
  res.send("\uFEFF" + csv);
});

/** Chỉ list link fail (text/plain, 1 link / dòng) */
router.get("/jobs/:id/failed-links.txt", (req, res) => {
  const job = getDeleteJob(req.params.id);
  if (!job) return res.status(404).type("text").send("Job not found");
  const report = job.report;
  const links = (report?.failed_posts || [])
    .map((f) => f.link)
    .filter(Boolean);
  // also from pages if report missing
  if (!links.length) {
    for (const p of job.pages || []) {
      for (const f of p.failed_posts || []) {
        if (f.link) links.push(f.link);
      }
    }
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="delete-failed-links-${req.params.id}.txt"`
  );
  res.send(links.join("\n"));
});

router.post("/jobs/:id/stop", (req, res) => {
  const job = stopDeleteJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, job });
});

/** SSE progress stream */
router.get("/jobs/:id/stream", (req, res) => {
  const job = getDeleteJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (j) => {
    res.write(`data: ${JSON.stringify(j)}\n\n`);
  };
  send(job);

  const off = onDeleteJob(req.params.id, (j) => {
    try {
      send(j);
      if (["ok", "fail", "partial", "stopped"].includes(j.status)) {
        res.write("event: done\ndata: {}\n\n");
      }
    } catch {
      /* client gone */
    }
  });

  req.on("close", () => {
    off();
  });
});

export default router;
