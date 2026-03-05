/**
 * AsyncLocalStorage for the current agent runId. Used by browser tool to enforce
 * per-task action limits (MAX_BROWSER_ACTIONS_PER_TASK) without passing runId through the tool API.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type AgentRunStore = { runId: string };

const agentRunStorage = new AsyncLocalStorage<AgentRunStore>();

export function getAgentRunId(): string | undefined {
  return agentRunStorage.getStore()?.runId;
}

export function runWithAgentRunId<T>(runId: string, fn: () => T): T {
  return agentRunStorage.run({ runId }, fn);
}

export function runWithAgentRunIdAsync<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return agentRunStorage.run({ runId }, fn);
}
