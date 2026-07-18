import { Router } from "express";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import {
  startBulkPostJob,
  startBulkScheduleJob,
  startJob,
  listJobs,
  getJob,
  subscribeJob,
  stopJob,
  pauseJob,
  resumeJob,
} from "../services/jobRunner.js";
import { scheduleBulk } from "../services/schedule.js";
import { getReportPaths } from "../services/reportExport.js";
import {
  loadRotationSettings,
  saveRotationSettings,
  buildRotationPlan,
  buildRunNowPlan,
  planToScheduleSlots,
  loadAccountPageMatrix,
  resolveGroups,
  DEFAULT_ROTATION,
} from "../services/rotationPlan.js";
import { listAccounts } from "../services/accounts.js";

const router = Router();
const runNowPlans = new Map();
const RUN_NOW_PLAN_TTL_MS = 15 * 60 * 1000;

function saveRunNowPlan(plan) {
  const now = Date.now();
  for (const [id, item] of runNowPlans) {
    if (now - item.created_at > RUN_NOW_PLAN_TTL_MS) runNowPlans.delete(id);
  }
  const id = nanoid(12);
  runNowPlans.set(id, { plan, created_at: now });
  return id;
}

function pagesMeta(ids) {
  const db = getDb();
  if (!ids?.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, page_id, name FROM fb_pages WHERE id IN (${placeholders})`
    )
    .all(...ids);
}

/** GET /api/jobs */
router.get("/", (_req, res) => {
  res.json({ jobs: listJobs(30), reports: getReportPaths() });
});

/** Reports — before /:id */
router.get("/reports/info", (_req, res) => {
  res.json(getReportPaths());
});

router.get("/reports/csv", (_req, res) => {
  const p = getReportPaths();
  if (!p.csv_exists) {
    return res.status(404).json({ error: "Chưa có file CSV báo cáo" });
  }
  res.download(p.csv, "dang_bai_chi_tiet.csv");
});

router.get("/reports/xlsx", (_req, res) => {
  const p = getReportPaths();
  if (!p.xlsx_exists) {
    return res.status(404).json({ error: "Chưa có file Excel báo cáo" });
  }
  res.download(p.xlsx, "dang_bai_chi_tiet.xlsx");
});

/**
 * GET /api/jobs/rotation/settings
 * POST /api/jobs/rotation/settings  body = partial settings
 * GET /api/jobs/rotation/matrix     accounts + pages for group UI
 * POST /api/jobs/rotation/plan      dry-run plan (optional body overrides)
 * POST /api/jobs/rotation/run       build plan + start schedule job
 */
router.get("/rotation/settings", (_req, res) => {
  res.json({
    settings: loadRotationSettings(),
    defaults: DEFAULT_ROTATION,
  });
});

router.post("/rotation/settings", (req, res) => {
  try {
    const settings = saveRotationSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/rotation/matrix", (_req, res) => {
  try {
    const settings = loadRotationSettings();
    const matrix = loadAccountPageMatrix(settings);
    const groups = resolveGroups(settings, matrix);
    let accounts = [];
    try {
      accounts = listAccounts();
    } catch {
      accounts = matrix.map((a) => ({
        id: a.account_id,
        name: a.account_name,
        page_count: a.pages.length,
        meta_app_key: a.meta_app_key,
      }));
    }
    res.json({
      accounts: matrix.map((a) => ({
        id: a.account_id,
        name: a.account_name,
        fb_user_id: a.fb_user_id,
        page_count: a.pages.length,
        meta_app_key: a.meta_app_key || "app1",
        meta_app_name: a.meta_app_name || "App 1",
        pages: a.pages,
      })),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        meta_app_key: g.meta_app_key || g.id,
        admin_count: g.admin_count,
        max_pages: g.max_pages,
        account_ids: g.admins.map((x) => x.account_id),
      })),
      auto_groups_by_meta_app: settings.auto_groups_by_meta_app !== false,
      all_accounts: accounts,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/rotation/plan", (req, res) => {
  try {
    const body = req.body || {};
    // optional: persist when save=1
    if (body.save) {
      const { save, dry_run, run, ...rest } = body;
      saveRotationSettings(rest);
    }
    const plan = buildRotationPlan(body);
    res.json({ ok: true, dry_run: true, ...plan });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/rotation/run", (req, res) => {
  try {
    const body = req.body || {};
    if (body.save !== false) {
      const { save, dry_run, run, ...rest } = body;
      if (Object.keys(rest).length) saveRotationSettings(rest);
    }
    const plan = buildRotationPlan(body);
    const postType =
      body.post_type || plan.settings?.post_type || "auto";
    const slots = planToScheduleSlots(plan, postType);
    if (!slots.length) {
      return res.status(400).json({
        ok: false,
        error:
          "Không có slot hợp lệ (kiểm tra page/account, khung giờ, anti-spam bulk cap)",
        plan,
      });
    }
    const job = startBulkScheduleJob({
      slots,
      title: `Rotation so-le · ${slots.length} slot · ${plan.summary?.groups || 1} nhóm`,
    });
    res.json({
      ok: true,
      job,
      plan_summary: plan.summary,
      preview_order: plan.preview_order,
      reports: getReportPaths(),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/jobs/rotation/run-now — first round now, later rounds scheduled. */
router.post("/rotation/run-now", (req, res) => {
  try {
    const body = req.body || {};
    if (body.dry_run) {
      const plan = buildRunNowPlan(body);
      const planId = saveRunNowPlan(plan);
      return res.json({ ok: true, dry_run: true, plan_id: planId, ...plan });
    }
    const planId = String(body.plan_id || "");
    const saved = runNowPlans.get(planId);
    if (!saved || Date.now() - saved.created_at > RUN_NOW_PLAN_TTL_MS) {
      return res.status(400).json({ ok: false, error: "Kế hoạch đã hết hạn hoặc chưa preview. Hãy bấm Xem lịch chạy ngay lại." });
    }
    const plan = saved.plan;
    if (!plan.summary?.can_run || plan.blockers?.length) {
      return res.status(400).json({ ok: false, error: "Kế hoạch còn lỗi chặn; chưa thể chạy.", plan });
    }
    if (!plan.slots.length) return res.status(400).json({ ok: false, error: "Không có Page để chạy", plan });
    const tasks = plan.slots.map((s) => ({
      kind: s.immediate ? "post" : "schedule",
      page_row_id: s.page_row_id,
      page_name: s.page_name,
      page_id: s.page_id,
      label: s.immediate
        ? `Vòng ${s.post_round} · đăng ngay · ${s.account_name}`
        : `Vòng ${s.post_round} · hẹn ${s.local_label} VN · ${s.account_name}`,
      opts: s.immediate
        ? { ignore_quota: false, ignore_interval: false, post_type: s.planned_post_type }
        : { scheduled_publish_time: s.unix, post_type: s.planned_post_type },
    }));
    const job = startJob({
      type: "rotation_run_now",
      title: `Chạy ngay · ${plan.summary.posts_per_page_per_day} bài/page · ${plan.summary.accounts} admin`,
      tasks,
    });
    runNowPlans.delete(planId);
    res.json({ ok: true, job, ...plan });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/jobs/bulk-post
 */
router.post("/bulk-post", (req, res) => {
  try {
    const ids = (req.body?.page_row_ids || []).map(Number).filter((n) => n > 0);
    if (!ids.length) return res.status(400).json({ error: "Chọn ít nhất 1 page" });
    const job = startBulkPostJob({
      page_row_ids: ids,
      pagesMeta: pagesMeta(ids),
      ignore_quota: !!req.body?.ignore_quota,
      ignore_interval: !!req.body?.ignore_interval,
      title: req.body?.title,
    });
    res.json({ ok: true, job, reports: getReportPaths() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/jobs/bulk-schedule
 */
router.post("/bulk-schedule", async (req, res) => {
  try {
    const body = req.body || {};
    if (body.dry_run) {
      const plan = await scheduleBulk({ ...body, dry_run: true });
      return res.json(plan);
    }

    const planned = await scheduleBulk({ ...body, dry_run: true });
    const slots = [];
    for (const p of planned.plan || []) {
      if (p.error || !p.slots?.length) continue;
      const meta = pagesMeta([p.page_row_id])[0] || {};
      for (const s of p.slots) {
        slots.push({
          page_row_id: p.page_row_id,
          page_name: p.page_name || meta.name,
          page_id: meta.page_id,
          unix: s.unix,
          local_label: s.local_label,
          post_type: body.post_type === "auto" ? undefined : body.post_type,
        });
      }
    }
    if (!slots.length) {
      return res.status(400).json({
        ok: false,
        error: "Không có slot hợp lệ để hẹn (kiểm tra anti-spam / giờ / page)",
        plan: planned,
      });
    }

    const job = startBulkScheduleJob({
      slots,
      title: `Hẹn giờ · ${slots.length} slot · ${planned.mode}`,
    });
    res.json({
      ok: true,
      job,
      plan_preview: planned,
      reports: getReportPaths(),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/run-one", (req, res) => {
  try {
    const id = Number(req.body?.page_row_id);
    if (!id) return res.status(400).json({ error: "page_row_id required" });
    const meta = pagesMeta([id]);
    const job = startJob({
      type: "single_post",
      title: `Đăng 1 bài · ${meta[0]?.name || id}`,
      tasks: [
        {
          kind: "post",
          page_row_id: id,
          page_name: meta[0]?.name || `page#${id}`,
          page_id: meta[0]?.page_id,
          label: "Đăng 1 bài ngay",
          opts: {
            ignore_quota: !!req.body?.ignore_quota,
            ignore_interval: !!req.body?.ignore_interval,
          },
        },
      ],
    });
    res.json({ ok: true, job, reports: getReportPaths() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/jobs/:id/stop — dừng sau task hiện tại */
router.post("/:id/stop", (req, res) => {
  const job = stopJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ ok: true, job });
});

/** POST /api/jobs/:id/pause */
router.post("/:id/pause", (req, res) => {
  const job = pauseJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ ok: true, job });
});

/** POST /api/jobs/:id/resume */
router.post("/:id/resume", (req, res) => {
  const job = resumeJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ ok: true, job });
});

/** GET /api/jobs/:id */
router.get("/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ job, reports: getReportPaths() });
});

/** SSE progress */
router.get("/:id/stream", (req, res) => {
  const id = req.params.id;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (job) => {
    res.write(`data: ${JSON.stringify({ job })}\n\n`);
  };

  const cur = getJob(id);
  if (cur) send(cur);
  else res.write(`data: ${JSON.stringify({ error: "not found" })}\n\n`);

  const unsub = subscribeJob(id, send);
  const keep = setInterval(() => res.write(`: ping\n\n`), 15000);
  req.on("close", () => {
    clearInterval(keep);
    unsub();
  });
});

export default router;
