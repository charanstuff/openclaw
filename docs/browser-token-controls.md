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
- **Tabs:** Max 30 tabs; each title truncated to 80 chars, each URL to 120 chars. Prevents huge tab lists from burning tokens.

**Not sanitized (by design):** Screenshot and snapshot-with-labels return **images** (base64). Vision models need the image; those tool results still add significant tokens. Status, start, stop, profiles, open, focus, close, navigate, pdf, upload, dialog return small JSON and are left as-is.

Full raw payloads can still be written to `OPENCLAW_BROWSER_DEBUG_PAYLOAD_DIR` for inspection; they are never sent to the model.

## Before/after estimate (baseline from current stats)

- **Baseline (before):** ~173.4M total tokens across 1,336 calls; browser tool ~137.6M tokens across 1,011 calls; prompt per call can exceed 260k tokens; input dominates output.
- **After (with defaults):**
  - **Sanitizer:** Snapshot and act results are capped to ~8k chars of main content plus metadata (url, title, refs, error). Assuming ~4 chars/token, that’s ~2k tokens per browser result instead of 65k+ (260k/4). For 1,011 browser calls with ~260k prompt tokens each, a rough upper bound for prompt from browser alone was ~260k × 1011 ≈ 262B token-calls; with ~2k tokens per browser result, same number of calls → ~2M token-calls from browser results. So **order-of-magnitude reduction** in tokens from browser payloads (e.g. 10–100× depending on how much of the prompt was browser content).
  - **Loop guards:** Cap of 50 browser actions per task and 2 retries per action limits runaway loops and retry storms, reducing total calls and tokens when the model would have kept retrying or taking many extra steps.
- **Summary:** Expect **large reduction in total tokens** (especially input) and **fewer browser-driven calls** when loops are hit. Exact numbers depend on session mix; run `scripts/top_llm_calls.ts` before and after to compare.

## Why is token usage still high? (checklist, verified in code)

If you still see high token usage after this change, work through this (each checked against the codebase):

1. **New code running?**  
   The sanitizer only runs in builds that include the browser-tool-sanitizer and limits. If the process/image was started before the update, or you’re on a branch without this code, you’re still sending full payloads. **Restart/redeploy** with the commit that has the token controls.

2. **Sanitizer disabled?**  
   If `OPENCLAW_BROWSER_SANITIZE_RESULTS=0` or `false`, full browser results are sent. **Check env** (gateway, systemd, Docker, etc.) and remove or set to `1`.

3. **Conversation history**  
   The _latest_ tool result might be small, but the **whole conversation** (all previous turns + tool results) is sent each time. Old turns may still contain large tool results from before the fix, or from other tools (exec, read, web_fetch). **Start a new session** or **reset the session** to drop old context and see the effect of sanitized browser-only turns.

4. **Other tools**  
   Only **browser** results are sanitized. Large `exec`, `read`, `web_fetch`, or other tool outputs still add tokens. Check `scripts/top_llm_calls.ts` “By tool” to see which tools dominate.

5. **Confirm sanitizer is running**  
   Set `OPENCLAW_BROWSER_LOG_RESULT_SIZE=1` and restart. In the logs you should see `browser result size { action: "snapshot", chars: 8xxx }` (or similar). If snapshot chars are in the tens of thousands, the sanitizer is not applied (old code or sanitize off).

6. **Tabs**  
   The **tabs** action used to return the full tab list (unbounded). It is now sanitized: max 30 tabs, title 80 chars, URL 120 chars. If you're on old code, tabs could have been a large contributor.

7. **Images**  
   **Screenshot** and **snapshot with labels** return base64 images via `imageResultFromFile`. Those are not truncated; vision models need the image. If the latest request used many screenshots or label snapshots, token usage will still be high from image content.

## Changed files

- `src/agents/tools/browser-tool-sanitizer.ts` — Sanitizer (snapshot, act, console, tabs) and debug payload writer.
- `src/agents/tools/browser-tool-limits.ts` — Action count and retry limits, limit check.
- `src/agents/tools/browser-tool.ts` — Uses sanitizer, limits, and optional result-size logging.
- `src/infra/agent-run-storage.ts` — AsyncLocalStorage for current runId (used by browser tool for per-task limits).
- `src/commands/agent.ts` — Runs agent inside `runWithAgentRunIdAsync`; clears browser action count on run end.
- `src/gateway/server-chat.ts` — Optional `clearBrowserActionCount` in agent event handler; clears count on lifecycle end/error.
- `src/gateway/server.impl.ts` — Passes `clearBrowserActionCount` into `createAgentEventHandler`.
- `docs/browser-token-controls.md` — This file.
