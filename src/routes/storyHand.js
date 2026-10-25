import { Router } from "express";
import { startStoryHand, stopStoryHand, storyHandStatus } from "../services/storyHand.js";

const router = Router();

router.get("/status", (_req, res) => {
  res.json(storyHandStatus());
});

router.post("/stop", (_req, res) => {
  res.json(stopStoryHand());
});

router.post("/run", (req, res) => {
  const body = req.body || {};
  const result = startStoryHand({
    pageIdsText: body.pageIds || body.page_ids || "",
    filePath: body.filePath || body.file_path || "",
    link: body.link || "",
    mode: body.mode || "now",
    scheduleLocal: body.scheduleLocal || body.schedule_local || "",
  });
  res.status(result.ok ? 200 : 400).json(result);
});

export default router;
