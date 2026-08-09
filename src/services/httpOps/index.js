export { FEATURES, listFeatures, getFeature, featuresByEngine } from "./featureMatrix.js";
export {
  ensureSessionTables,
  listSessionsPublic,
  upsertSession,
  updateSessionCookie,
  deleteSession,
  getSessionPublic,
  mapSessionPage,
  listSessionPages,
  mapSessionGroup,
  listSessionGroups,
  loadSessionSecrets,
} from "./cookieVault.js";
export { checkSessionHealth, sessionFetch } from "./sessionClient.js";
export {
  ensureOpsQueueTables,
  enqueueOp,
  listOps,
  queueStats,
} from "./opsQueue.js";
export {
  startHttpOpsWorkers,
  stopHttpOpsWorkers,
  getHttpOpsWorkerState,
} from "./workerPool.js";
export {
  listStorySchedules,
  upsertStorySchedule,
  tickStorySchedules,
  recordStoryLifecycle,
  listStoriesDueDelete,
} from "./storyScheduler.js";
export {
  registerSessionHandler,
  listRegisteredSessionHandlers,
} from "./sessionOps.js";
export { executeJob } from "./registry.js";
export {
  importLoginBatch,
  upsertLoginAccount,
  listLoginAccountsPublic,
  ensureSessionForAccount,
  runAutoLogin,
  submitCheckpoint282Code,
  listLoginErrorCatalog,
} from "./accountLogin.js";
export { LOGIN_ERRORS, loginError } from "./loginErrors.js";

import { ensureSessionTables } from "./cookieVault.js";
import { ensureOpsQueueTables } from "./opsQueue.js";
import { startHttpOpsWorkers } from "./workerPool.js";
import { tickStorySchedules } from "./storyScheduler.js";

/** Boot tables + optional worker pool */
export function initHttpOps({ startWorkers = true, concurrency = 3 } = {}) {
  ensureSessionTables();
  ensureOpsQueueTables();
  // login tables lazy-init on first use
  if (startWorkers) {
    startHttpOpsWorkers({ concurrency });
  }
  return { ok: true };
}

/** Call from main scheduler tick */
export function httpOpsSchedulerTick() {
  return tickStorySchedules();
}
