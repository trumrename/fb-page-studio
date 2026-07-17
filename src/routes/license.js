import { Router } from "express";
import {
  activateLicense,
  clearLicense,
  getLicenseStatus,
  getMachineId,
  verifyLicenseKey,
} from "../services/license.js";

const router = Router();

/** GET /api/license/status */
router.get("/status", (_req, res) => {
  res.json({ ok: true, ...getLicenseStatus() });
});

/** GET /api/license/machine */
router.get("/machine", (_req, res) => {
  res.json({ machine_id: getMachineId() });
});

/** POST /api/license/activate  { key } */
router.post("/activate", (req, res) => {
  try {
    const key = req.body?.key || req.body?.license_key;
    if (!key) return res.status(400).json({ ok: false, error: "Thiếu key" });
    const r = activateLicense(String(key));
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/license/verify  { key } — dry check without saving */
router.post("/verify", (req, res) => {
  const key = req.body?.key || "";
  res.json(verifyLicenseKey(String(key)));
});

/** POST /api/license/clear — remove local key (back to trial if any) */
router.post("/clear", (_req, res) => {
  clearLicense();
  res.json({ ok: true, status: getLicenseStatus() });
});

export default router;
