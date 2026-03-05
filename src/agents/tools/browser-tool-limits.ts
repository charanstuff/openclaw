/**
 * Loop guards for the browser tool: max actions per task, max retries per action.
 * Enable via env (defaults on).
 *
 * OPENCLAW_BROWSER_MAX_ACTIONS_PER_TASK=50  — fail fast after N browser tool calls in one run
 * OPENCLAW_BROWSER_MAX_RETRIES_PER_ACTION=2 — retry act (e.g. click) up to N times on failure
 */

import { getAgentRunId } from "../../infra/agent-run-storage.js";

const DEFAULT_MAX_ACTIONS_PER_TASK = 50;
const DEFAULT_MAX_RETRIES_PER_ACTION = 2;

function readEnvInt(name: string, defaultVal: number): number {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") {
    return defaultVal;
  }
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultVal;
}

export function getMaxBrowserActionsPerTask(): number {
  return readEnvInt("OPENCLAW_BROWSER_MAX_ACTIONS_PER_TASK", DEFAULT_MAX_ACTIONS_PER_TASK);
}

export function getMaxRetriesPerAction(): number {
  return readEnvInt("OPENCLAW_BROWSER_MAX_RETRIES_PER_ACTION", DEFAULT_MAX_RETRIES_PER_ACTION);
}

const actionCountByRunId = new Map<string, number>();

function getOrCreateCount(runId: string): number {
  const cur = actionCountByRunId.get(runId) ?? 0;
  actionCountByRunId.set(runId, cur);
  return cur;
}

export function incrementBrowserActionCount(runId: string | undefined): number {
  if (!runId) {
    return 0;
  }
  const cur = getOrCreateCount(runId);
  const next = cur + 1;
  actionCountByRunId.set(runId, next);
  return next;
}

export function getBrowserActionCount(runId: string | undefined): number {
  if (!runId) {
    return 0;
  }
  return getOrCreateCount(runId);
}

/** Call when a run ends so we can clear the counter (optional; avoids unbounded map growth). */
export function clearBrowserActionCount(runId: string): void {
  actionCountByRunId.delete(runId);
}

export function checkBrowserActionLimit(
  runId: string | undefined,
): { ok: true } | { ok: false; message: string } {
  const max = getMaxBrowserActionsPerTask();
  if (max <= 0) {
    return { ok: true };
  }
  const run = runId ?? getAgentRunId();
  if (!run) {
    return { ok: true };
  }
  const count = getBrowserActionCount(run);
  if (count < max) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `Browser action limit exceeded: ${count} >= ${max} (OPENCLAW_BROWSER_MAX_ACTIONS_PER_TASK). Fail fast to reduce token burn.`,
  };
}
