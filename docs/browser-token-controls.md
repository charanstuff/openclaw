# Browser tool token controls

Measures to reduce LLM token burn from the browser tool: sanitized results, loop guards, and instrumentation.

## Env vars

| Env var                                   | Default | Description                                                                                                                                                             |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_BROWSER_SANITIZE_RESULTS`       | `1`     | When set to `1` (default), browser tool results are truncated/sanitized before being injected into the prompt. Set to `0` or `false` to disable and send full payloads. |
| `OPENCLAW_BROWSER_DEBUG_PAYLOAD_DIR`      | (unset) | If set to a directory path, full raw browser payloads (snapshot, act, console) are written to JSON files here. **Never** injected into the prompt. Use for debugging.   |
| `OPENCLAW_BROWSER_MAX_ACTIONS_PER_TASK`   | `50`    | Max browser tool invocations (snapshot, act, tabs, etc.) per agent run. When exceeded, the tool throws and the run fails fast with a short diagnostic.                  |
| `OPENCLAW_BROWSER_MAX_RETRIES_PER_ACTION` | `2`     | Max retries for a single `act` (e.g. click/type) on failure. Total attempts = 1 + this value.                                                                           |
| `OPENCLAW_BROWSER_LOG_RESULT_SIZE`        | (unset) | Set to `1` to log the size (chars) of each browser tool result before it is added to the conversation. Helps correlate token usage with tool payload size.              |

Token usage per LLM call is already recorded in session transcripts and (when enabled) in anthropic payload logs; use `scripts/top_llm_calls.ts` to report on it.

## What gets sanitized (when `OPENCLAW_BROWSER_SANITIZE_RESULTS=1`)

- **Snapshot (AI format):** URL, title, targetId, refs summary, and a **max 8,000‑char** visible text excerpt. Full DOM/HTML and oversized snapshot text are not injected.
- **Snapshot (ARIA format):** URL, targetId, and a compact list of interactive nodes (ref, role, name) up to ~8k chars.
- **Act result:** `ok`, `url`, `targetId`, and last error (up to 500 chars). Large response bodies are dropped.
- **Console:** Last 10 messages, total cap 2,000 chars. No full network/console dumps unless sanitize is off.

Full raw payloads can still be written to `OPENCLAW_BROWSER_DEBUG_PAYLOAD_DIR` for inspection; they are never sent to the model.

## Before/after estimate (baseline from current stats)

- **Baseline (before):** ~173.4M total tokens across 1,336 calls; browser tool ~137.6M tokens across 1,011 calls; prompt per call can exceed 260k tokens; input dominates output.
- **After (with defaults):**
  - **Sanitizer:** Snapshot and act results are capped to ~8k chars of main content plus metadata (url, title, refs, error). Assuming ~4 chars/token, that’s ~2k tokens per browser result instead of 65k+ (260k/4). For 1,011 browser calls with ~260k prompt tokens each, a rough upper bound for prompt from browser alone was ~260k × 1011 ≈ 262B token-calls; with ~2k tokens per browser result, same number of calls → ~2M token-calls from browser results. So **order-of-magnitude reduction** in tokens from browser payloads (e.g. 10–100× depending on how much of the prompt was browser content).
  - **Loop guards:** Cap of 50 browser actions per task and 2 retries per action limits runaway loops and retry storms, reducing total calls and tokens when the model would have kept retrying or taking many extra steps.
- **Summary:** Expect **large reduction in total tokens** (especially input) and **fewer browser-driven calls** when loops are hit. Exact numbers depend on session mix; run `scripts/top_llm_calls.ts` before and after to compare.

## Changed files

- `src/agents/tools/browser-tool-sanitizer.ts` — Sanitizer and debug payload writer.
- `src/agents/tools/browser-tool-limits.ts` — Action count and retry limits, limit check.
- `src/agents/tools/browser-tool.ts` — Uses sanitizer, limits, and optional result-size logging.
- `src/infra/agent-run-storage.ts` — AsyncLocalStorage for current runId (used by browser tool for per-task limits).
- `src/commands/agent.ts` — Runs agent inside `runWithAgentRunIdAsync`; clears browser action count on run end.
- `src/gateway/server-chat.ts` — Optional `clearBrowserActionCount` in agent event handler; clears count on lifecycle end/error.
- `src/gateway/server.impl.ts` — Passes `clearBrowserActionCount` into `createAgentEventHandler`.
- `docs/browser-token-controls.md` — This file.
