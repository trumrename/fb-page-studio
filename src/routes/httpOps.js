import { Router } from "express";
import {
  listFeatures,
  listSessionsPublic,
  upsertSession,
  updateSessionCookie,
  deleteSession,
  getSessionPublic,
  mapSessionPage,
  listSessionPages,
  mapSessionGroup,
  listSessionGroups,
  checkSessionHealth,
  enqueueOp,
  listOps,
  queueStats,
  startHttpOpsWorkers,
  stopHttpOpsWorkers,
  getHttpOpsWorkerState,
  listStorySchedules,
  upsertStorySchedule,
  tickStorySchedules,
  listRegisteredSessionHandlers,
} from "../services/httpOps/index.js";
import {
  importLoginBatch,
  upsertLoginAccount,
  listLoginAccountsPublic,
  getLoginAccountPublic,
  ensureSessionForAccount,
  runAutoLogin,
  submitCheckpoint282Code,
  listLoginErrorCatalog,
  listRecentAttempts,
  previewTotp,
} from "../services/httpOps/accountLogin.js";

const router = Router();

router.get("/features", (_req, res) => {
  res.json({ ok: true, features: listFeatures() });
});

router.get("/status", (_req, res) => {
  res.json({
    ok: true,
    workers: getHttpOpsWorkerState(),
    queue: queueStats(),
    session_handlers: listRegisteredSessionHandlers(),
  });
});

router.post("/workers/start", (req, res) => {
  const concurrency = Number(req.body?.concurrency || 3);
  res.json({ ok: true, ...startHttpOpsWorkers({ concurrency }) });
});

router.post("/workers/stop", async (_req, res) => {
  res.json({ ok: true, ...(await stopHttpOpsWorkers()) });
});

// ── Sessions (cookie vault) ───────────────────────────
router.get("/sessions", (_req, res) => {
  res.json({ ok: true, sessions: listSessionsPublic() });
});

router.post("/sessions", (req, res) => {
  try {
    const s = upsertSession({
      label: req.body?.label,
      cookie: req.body?.cookie,
      userAgent: req.body?.user_agent,
      proxyUrl: req.body?.proxy_url,
      fbUserId: req.body?.fb_user_id,
      name: req.body?.name,
    });
    res.json({ ok: true, session: s });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/sessions/:id", (req, res) => {
  const s = getSessionPublic(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: "not found" });
  res.json({ ok: true, session: s });
});

router.put("/sessions/:id/cookie", (req, res) => {
  try {
    const s = updateSessionCookie(req.params.id, req.body?.cookie, {
      userAgent: req.body?.user_agent,
      proxyUrl: req.body?.proxy_url,
      label: req.body?.label,
    });
    res.json({ ok: true, session: s });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.delete("/sessions/:id", (req, res) => {
  res.json(deleteSession(req.params.id));
});

router.post("/sessions/:id/health", async (req, res) => {
  try {
    const r = await checkSessionHealth(Number(req.params.id));
    res.json({ ok: true, ...r, session: getSessionPublic(req.params.id) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/sessions/:id/pages", (req, res) => {
  mapSessionPage(req.params.id, req.body?.page_id, req.body?.page_name);
  res.json({ ok: true, pages: listSessionPages(req.params.id) });
});

router.get("/sessions/:id/pages", (req, res) => {
  res.json({ ok: true, pages: listSessionPages(req.params.id) });
});

router.post("/sessions/:id/groups", (req, res) => {
  mapSessionGroup(req.params.id, req.body?.group_id, req.body?.group_name);
  res.json({ ok: true, groups: listSessionGroups(req.params.id) });
});

router.get("/sessions/:id/groups", (req, res) => {
  res.json({ ok: true, groups: listSessionGroups(req.params.id) });
});

// ── Queue ─────────────────────────────────────────────
router.get("/queue", (req, res) => {
  res.json({
    ok: true,
    stats: queueStats(),
    items: listOps({
      status: req.query.status || null,
      limit: Number(req.query.limit || 50),
    }),
  });
});

router.post("/queue", (req, res) => {
  try {
    const body = req.body || {};
    if (!body.op) throw new Error("op bắt buộc");
    const job = enqueueOp({
      op: body.op,
      engine: body.engine,
      targetType: body.target_type,
      targetId: body.target_id,
      sessionId: body.session_id,
      pageRowId: body.page_row_id,
      payload: body.payload || body,
      runAfter: body.run_after,
      priority: body.priority,
      maxAttempts: body.max_attempts,
    });
    res.json({ ok: true, ...job });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Story schedule ────────────────────────────────────
router.get("/story-schedules", (_req, res) => {
  res.json({ ok: true, schedules: listStorySchedules() });
});

router.post("/story-schedules", (req, res) => {
  try {
    const s = upsertStorySchedule(req.body || {});
    res.json({ ok: true, schedule: s });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/story-schedules/tick", (_req, res) => {
  res.json({ ok: true, ...tickStorySchedules() });
});

// ── Auto login id|pass|2fa + checkpoint 282 ───────────
router.get("/login/error-catalog", (_req, res) => {
  res.json({ ok: true, errors: listLoginErrorCatalog() });
});

router.get("/login/accounts", (_req, res) => {
  res.json({ ok: true, accounts: listLoginAccountsPublic() });
});

router.post("/login/accounts", (req, res) => {
  try {
    if (req.body?.batch_text) {
      return res.json({ ok: true, ...importLoginBatch(req.body.batch_text) });
    }
    const acc = upsertLoginAccount({
      loginId: req.body?.login_id || req.body?.id,
      password: req.body?.password || req.body?.pass,
      totpSecret: req.body?.totp_secret || req.body?.["2fa"] || req.body?.two_fa,
      emailFor282: req.body?.email_for_282,
      emailImap: req.body?.email_imap,
      label: req.body?.label,
      proxyUrl: req.body?.proxy_url,
    });
    res.json({ ok: true, account: acc });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message,
      login_error: e.loginError || null,
    });
  }
});

router.get("/login/accounts/:id", (req, res) => {
  const a = getLoginAccountPublic(req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: "not found" });
  res.json({
    ok: true,
    account: a,
    attempts: listRecentAttempts(req.params.id, 30),
  });
});

router.post("/login/accounts/:id/ensure", async (req, res) => {
  try {
    const r = await ensureSessionForAccount(Number(req.params.id), {
      forceLogin: !!req.body?.force,
      headless: !!req.body?.headless,
      pollEmail: req.body?.poll_email !== false,
    });
    res.json({ ok: !!r.ok, ...r, account: getLoginAccountPublic(req.params.id) });
  } catch (e) {
    res.status(500).json({ ok: false, code: "UNKNOWN", message_vi: e.message });
  }
});

router.post("/login/accounts/:id/login", async (req, res) => {
  try {
    const r = await runAutoLogin(Number(req.params.id), {
      headless: !!req.body?.headless,
      pollEmail: req.body?.poll_email !== false,
    });
    res.json({ ok: !!r.ok, ...r, account: getLoginAccountPublic(req.params.id) });
  } catch (e) {
    res.status(500).json({ ok: false, code: "UNKNOWN", message_vi: e.message });
  }
});

router.post("/login/accounts/:id/submit-282-code", async (req, res) => {
  try {
    const code = req.body?.code || req.body?.ma;
    const r = await submitCheckpoint282Code(Number(req.params.id), code, {
      headless: !!req.body?.headless,
    });
    res.json({ ok: !!r.ok, ...r, account: getLoginAccountPublic(req.params.id) });
  } catch (e) {
    res.status(500).json({ ok: false, code: "UNKNOWN", message_vi: e.message });
  }
});

router.get("/login/accounts/:id/totp-preview", (req, res) => {
  res.json(previewTotp(Number(req.params.id)));
});

export default router;
