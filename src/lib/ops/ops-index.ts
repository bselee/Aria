/**
 * @file    src/lib/ops/ops-index.ts
 * @purpose Barrel exports for the ops module. All extracted OpsManager utilities
 *          are available through this single import point.
 * @author  Hermia
 * @created 2026-05-28
 *
 * Phase 2.2 of OpsManager decomposition:
 *   safe-runner.ts         — Task execution wrapper (error handling, observability)
 *   reconciliation-runner.ts — Vendor reconciliation child process management
 *   crash-loop-detector.ts   — PM2 crash loop detection + Telegram alert
 *   (existing) control-plane.ts, control-plane-db.ts, bot-control-plane.ts
 *
 * Future extractions:
 *   summaries.ts           — Daily/weekly summary generation
 *   purchasing-watch.ts    — Calendar sync, build completions, PO receivings
 *   email-cycle.ts         — AP polling orchestration
 */

export { safeRun, cronHookSuccess, cronHookFailure, type SafeRunDeps } from "./safe-runner";
export { runReconciliation } from "./reconciliation-runner";
export { detectAndAlertCrashLoop } from "./crash-loop-detector";
