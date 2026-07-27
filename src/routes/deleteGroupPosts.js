/**
 * API: bulk delete Facebook Group posts (Admin/Mod user token).
 */
import { Router } from "express";
import { listAccounts } from "../services/accounts.js";
import {
  fetchManagedGroups,
  previewGroupPosts,
  startGroupDeleteJob,
  getGroupDeleteJob,
  listGroupDeleteJobs,
  stopGroupDeleteJob,
  onGroupDeleteJob,
  groupFailedPostsToCsv,
  analyzePostIdPaste,
  parsePostIdsFromText,
} from "../services/deleteGroupPosts.js";

const router = Router();

/**
 * POST /api/delete-group-posts/parse-ids
 * Body: { text, group_id? } — trích post_id từ link / HTML (khi Graph list fail)
 */
router.post("/parse-ids", (req, res) => {
  try {
    const text = String(req.body?.text || req.body?.html || "");
    const groupId = String(req.body?.group_id || req.body?.groupId || "").trim();
    if (!text.trim()) {
      return res.status(400).json({ ok: false, error: "Thiếu text/html để parse" });
    }
    const data = analyzePostIdPaste(text, groupId);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/accounts", (_req, res) => {
  try {
    const accounts = listAccounts().filter((a) => a.status === "active" || !a.status);
    res.json({
      ok: true,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        fb_user_id: a.fb_user_id,
        meta_app_key: a.meta_app_key,
        meta_app_name: a.meta_app_name,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** List groups Graph can see (may be empty if Groups API blocked) */
router.get("/groups", async (req, res) => {
  try {
    const data = await fetchManagedGroups({
      account_id: req.query.account_id || undefined,
      admin_only: req.query.admin_only !== "0",
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/preview", async (req, res) => {
  try {
    const data = await previewGroupPosts({
      group_id: req.query.group_id,
      account_id: req.query.account_id,
      max_posts: req.query.max_posts || 50,
      since: req.query.since || undefined,
      until: req.query.until || undefined,
      keyword: req.query.keyword || undefined,
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/start", (req, res) => {
  try {
    const body = req.body || {};
    let groups = body.groups || [];
    // Parse manual group ids: "id1,id2" + single account_id
    if (!groups.length && body.group_ids) {
      const accountId = Number(body.account_id);
      const ids = String(body.group_ids)
        .split(/[\s,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      groups = ids.map((id) => ({
        group_id: id,
        group_name: id,
        account_id: accountId,
      }));
    }
    const job = startGroupDeleteJob({
      ...body,
      groups,
      post_ids_text: body.post_ids_text || body.postIdsText || body.manual_posts || "",
      post_ids: body.post_ids || body.postIds,
    });
    res.json({ ok: true, job });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/jobs", (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  res.json({ ok: true, jobs: listGroupDeleteJobs(limit) });
});

router.get("/jobs/:id", (req, res) => {
  const job = getGroupDeleteJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, job });
});

router.get("/jobs/:id/report", (req, res) => {
  const job = getGroupDeleteJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, report: job.report || null, groups: job.groups || [] });
});

router.get("/jobs/:id/failed.csv", (req, res) => {
  const csv = groupFailedPostsToCsv(req.params.id);
  if (csv == null) return res.status(404).json({ ok: false, error: "Job not found" });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="group-delete-failed-${req.params.id}.csv"`
  );
  res.send("\uFEFF" + csv);
});

router.get("/jobs/:id/failed-links.txt", (req, res) => {
  const job = getGroupDeleteJob(req.params.id);
  if (!job) return res.status(404).type("text").send("Job not found");
  const links = [];
  for (const f of job.report?.failed_posts || []) {
    if (f.link) links.push(f.link);
  }
  if (!links.length) {
    for (const g of job.groups || []) {
      for (const f of g.failed_posts || []) {
        if (f.link) links.push(f.link);
      }
    }
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="group-delete-links-${req.params.id}.txt"`
  );
  res.send(links.join("\n"));
});

router.post("/jobs/:id/stop", (req, res) => {
  const job = stopGroupDeleteJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, job });
});

router.get("/jobs/:id/stream", (req, res) => {
  const job = getGroupDeleteJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (j) => {
    res.write(`data: ${JSON.stringify(j)}\n\n`);
  };
  send(job);
  const off = onGroupDeleteJob(req.params.id, (j) => {
    try {
      send(j);
      if (["ok", "fail", "partial", "stopped"].includes(j.status)) {
        res.write("event: done\ndata: {}\n\n");
      }
    } catch {
      /* gone */
    }
  });
  req.on("close", () => off());
});

export default router;
