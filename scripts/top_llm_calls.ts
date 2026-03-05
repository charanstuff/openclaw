#!/usr/bin/env node
/// <reference types="node" />
/**
 * Top 20 LLM calls by token usage — report from existing OpenClaw logs.
 *
 * Data sources (no new logging):
 * - Session transcripts: $OPENCLAW_STATE_DIR/agents/<agentId>/sessions/*.jsonl
 *   (default state dir: ~/.openclaw). Each line can have message.usage or entry.usage.
 * - Optional gateway log: --log-dir (e.g. /tmp/openclaw) to scan openclaw-*.log
 *   for "anthropic usage" lines (when payload logging is enabled).
 *
 * Run locally (from openclaw repo root):
 *   pnpm exec node --import tsx scripts/top_llm_calls.ts
 *   pnpm exec node --import tsx scripts/top_llm_calls.ts --state-dir ~/.openclaw
 *   pnpm exec node --import tsx scripts/top_llm_calls.ts --log-dir /tmp/openclaw
 *
 * Options:
 *   --state-dir <path>   Override state dir (default: OPENCLAW_STATE_DIR or ~/.openclaw)
 *   --log-dir <path>     Also scan gateway log files in this dir for "anthropic usage"
 *   --limit <n>          Number of top calls to show (default 20)
 *   --json               Emit machine-readable JSON instead of human report
 */

import fs from "node:fs";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

// --- State dir (match OpenClaw: OPENCLAW_STATE_DIR or ~/.openclaw) ---
function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".openclaw");
}

// --- Usage normalization (match openclaw NormalizedUsage) ---
type UsageLike = Record<string, unknown>;
type NormalizedUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

function asFiniteNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeUsage(raw?: UsageLike | null): NormalizedUsage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const input = asFiniteNumber(
    raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens,
  );
  const output = asFiniteNumber(
    raw.output ??
      raw.outputTokens ??
      raw.output_tokens ??
      raw.completionTokens ??
      raw.completion_tokens,
  );
  const cacheRead = asFiniteNumber(
    raw.cacheRead ??
      raw.cache_read ??
      raw.cache_read_input_tokens ??
      raw.cached_tokens ??
      (raw.prompt_tokens_details as UsageLike)?.cached_tokens,
  );
  const cacheWrite = asFiniteNumber(
    raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens,
  );
  const total = asFiniteNumber(raw.total ?? raw.totalTokens ?? raw.total_tokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function totalFromUsage(u: NormalizedUsage): number {
  const t = u.total;
  if (t !== undefined && Number.isFinite(t)) {
    return t;
  }
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

// --- Transcript entry parsing (assistant messages with usage = one LLM call) ---
function parseTimestamp(entry: Record<string, unknown>): Date | undefined {
  const raw = entry.timestamp;
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  const msg = entry.message as Record<string, unknown> | undefined;
  const ts = asFiniteNumber(msg?.timestamp);
  if (ts !== undefined) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  return undefined;
}

function extractToolNames(message: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const nameRaw = message.toolName ?? message.tool_name;
  if (typeof nameRaw === "string" && nameRaw.trim()) {
    names.add(nameRaw.trim());
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return Array.from(names);
  }
  const toolTypes = new Set(["tool_use", "toolcall", "tool_call"]);
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    const type = (typeof b.type === "string" ? b.type : "").trim().toLowerCase();
    if (!toolTypes.has(type)) {
      continue;
    }
    const name = b.name;
    if (typeof name === "string" && name.trim()) {
      names.add(name.trim());
    }
  }
  return Array.from(names);
}

/** Estimate token size from string (chars/4 heuristic). */
function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

/** From message.content (and optional message.input_tokens), derive input size and top contributors. */
function messageContributors(message: Record<string, unknown>): {
  estimatedInputTokens: number;
  contributors: Array<{ kind: string; tokens: number; detail?: string }>;
} {
  let estimated = asFiniteNumber(
    message.input_tokens ?? message.inputTokens ?? message.prompt_tokens ?? message.promptTokens,
  );
  const contributors: Array<{ kind: string; tokens: number; detail?: string }> = [];
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      const type = (typeof b.type === "string" ? b.type : "").toLowerCase();
      let size = 0;
      let detail: string | undefined;
      if (type === "text" && typeof b.text === "string") {
        size = estimateTokensFromChars(b.text.length);
        detail = `text ${b.text.length} chars`;
      } else if (["tool_use", "toolcall", "tool_call"].includes(type) && b.input !== undefined) {
        const inputStr = typeof b.input === "string" ? b.input : JSON.stringify(b.input);
        size = estimateTokensFromChars(inputStr.length);
        const name = typeof b.name === "string" ? b.name : "tool";
        detail = `tool_use ${name}`;
      } else if (["tool_result", "tool_result_error"].includes(type) && b.content !== undefined) {
        const contentStr = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        size = estimateTokensFromChars(contentStr.length);
        detail = `tool_result`;
      }
      if (size > 0) {
        contributors.push({
          kind: type || "block",
          tokens: size,
          detail,
        });
      }
    }
  }
  if (estimated === undefined && contributors.length > 0) {
    estimated = contributors.reduce((s, c) => s + c.tokens, 0);
  }
  contributors.sort((a, b) => b.tokens - a.tokens);
  return {
    estimatedInputTokens: estimated ?? 0,
    contributors: contributors.slice(0, 3),
  };
}

export type LlmCallRecord = {
  source: "transcript" | "gateway_log";
  timestamp: Date | undefined;
  sessionId: string;
  agentId: string;
  model: string | undefined;
  provider: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  estimated: boolean;
  contributors: Array<{ kind: string; tokens: number; detail?: string }>;
  toolNames: string[];
};

function parseTranscriptLine(
  line: string,
  sessionId: string,
  agentId: string,
): LlmCallRecord | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") {
    return null;
  }
  const role = message.role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  // We only count assistant messages as "one LLM call" (response with usage).
  if (role !== "assistant") {
    return null;
  }

  const usageRaw =
    (message.usage as UsageLike | undefined) ?? (entry.usage as UsageLike | undefined);
  const usage = usageRaw ? normalizeUsage(usageRaw) : undefined;

  const provider =
    (typeof message.provider === "string" ? message.provider : undefined) ??
    (typeof entry.provider === "string" ? entry.provider : undefined);
  const model =
    (typeof message.model === "string" ? message.model : undefined) ??
    (typeof entry.model === "string" ? entry.model : undefined);

  const toolNames = extractToolNames(message);
  const { estimatedInputTokens, contributors } = messageContributors(message);

  let inputTokens: number;
  let outputTokens: number;
  let cacheRead: number;
  let cacheWrite: number;
  let estimated = false;

  if (usage) {
    inputTokens = usage.input ?? 0;
    outputTokens = usage.output ?? 0;
    cacheRead = usage.cacheRead ?? 0;
    cacheWrite = usage.cacheWrite ?? 0;
  } else {
    inputTokens = estimatedInputTokens;
    outputTokens = 0; // cannot estimate output from content alone
    cacheRead = 0;
    cacheWrite = 0;
    estimated = true;
  }

  const totalTokens =
    usage && usage.total !== undefined && Number.isFinite(usage.total)
      ? usage.total
      : inputTokens + outputTokens + cacheRead + cacheWrite;

  return {
    source: "transcript",
    timestamp: parseTimestamp(entry),
    sessionId,
    agentId,
    model,
    provider,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    totalTokens,
    estimated,
    contributors,
    toolNames,
  };
}

async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) {
      yield trimmed;
    }
  }
}

async function scanTranscripts(stateDir: string): Promise<LlmCallRecord[]> {
  const records: LlmCallRecord[] = [];
  const agentsPath = path.join(stateDir, "agents");
  if (!fs.existsSync(agentsPath)) {
    return records;
  }
  const agentDirs = fs.readdirSync(agentsPath, { withFileTypes: true });
  for (const ad of agentDirs) {
    if (!ad.isDirectory()) {
      continue;
    }
    const agentId = ad.name;
    const sessionsDir = path.join(agentsPath, agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      continue;
    }
    const files = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) {
        continue;
      }
      const sessionId = f.name.replace(/\.jsonl$/, "");
      const filePath = path.join(sessionsDir, f.name);
      for await (const line of readJsonlLines(filePath)) {
        const rec = parseTranscriptLine(line, sessionId, agentId);
        if (rec) {
          records.push(rec);
        }
      }
    }
  }
  return records;
}

// --- Gateway log: lines like {"0":"anthropic usage","1":{ runId, sessionId, usage }, ...} ---
function parseGatewayLogLine(line: string): LlmCallRecord | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const msg0 = obj["0"];
  if (msg0 !== "anthropic usage") {
    return null;
  }
  const payload = obj["1"] as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const usageRaw = payload.usage as UsageLike | undefined;
  const usage = usageRaw ? normalizeUsage(usageRaw) : undefined;
  if (!usage) {
    return null;
  }
  const runId = typeof payload.runId === "string" ? payload.runId : undefined;
  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId : (runId ?? "unknown");
  const timeStr = typeof obj.time === "string" ? obj.time : undefined;
  const timestamp = timeStr ? new Date(timeStr) : undefined;
  const totalTokens = totalFromUsage(usage);
  return {
    source: "gateway_log",
    timestamp,
    sessionId,
    agentId: "main",
    model: undefined,
    provider: "anthropic",
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens,
    estimated: false,
    contributors: [],
    toolNames: [],
  };
}

async function scanGatewayLogs(logDir: string): Promise<LlmCallRecord[]> {
  const records: LlmCallRecord[] = [];
  if (!fs.existsSync(logDir)) {
    return records;
  }
  const entries = fs.readdirSync(logDir, { withFileTypes: true });
  const logFiles = entries
    .filter((e) => e.isFile() && e.name.startsWith("openclaw-") && e.name.endsWith(".log"))
    .map((e) => path.join(logDir, e.name));
  for (const filePath of logFiles) {
    for await (const line of readJsonlLines(filePath)) {
      const rec = parseGatewayLogLine(line);
      if (rec) {
        records.push(rec);
      }
    }
  }
  return records;
}

// --- Dedupe: same session + approximate timestamp may appear in both transcript and gateway log ---
function mergeRecords(transcript: LlmCallRecord[], gateway: LlmCallRecord[]): LlmCallRecord[] {
  const byKey = new Map<string, LlmCallRecord>();
  for (const r of transcript) {
    const ts = r.timestamp?.getTime() ?? 0;
    const key = `${r.agentId}:${r.sessionId}:${Math.floor(ts / 1000)}`;
    const existing = byKey.get(key);
    if (!existing || r.totalTokens >= existing.totalTokens) {
      byKey.set(key, r);
    }
  }
  for (const r of gateway) {
    const ts = r.timestamp?.getTime() ?? 0;
    const key = `main:${r.sessionId}:${Math.floor(ts / 1000)}`;
    if (!byKey.has(key)) {
      byKey.set(key, r);
    }
  }
  return Array.from(byKey.values());
}

// --- Aggregates ---
type Aggregates = {
  byModel: Map<string, { input: number; output: number; total: number; count: number }>;
  byTool: Map<string, { total: number; count: number }>;
  cacheHit: { cacheRead: number; cacheWrite: number; input: number; totalPrompt: number };
};

function computeAggregates(records: LlmCallRecord[]): Aggregates {
  const byModel = new Map<
    string,
    { input: number; output: number; total: number; count: number }
  >();
  const byTool = new Map<string, { total: number; count: number }>();
  let cacheRead = 0,
    cacheWrite = 0,
    inputTotal = 0;

  for (const r of records) {
    const modelKey = r.model ?? r.provider ?? "unknown";
    const cur = byModel.get(modelKey) ?? {
      input: 0,
      output: 0,
      total: 0,
      count: 0,
    };
    cur.input += r.inputTokens;
    cur.output += r.outputTokens;
    cur.total += r.totalTokens;
    cur.count += 1;
    byModel.set(modelKey, cur);

    for (const tool of r.toolNames) {
      const t = byTool.get(tool) ?? { total: 0, count: 0 };
      t.total += r.totalTokens;
      t.count += 1;
      byTool.set(tool, t);
    }

    cacheRead += r.cacheRead;
    cacheWrite += r.cacheWrite;
    inputTotal += r.inputTokens;
  }

  const totalPrompt = inputTotal + cacheRead + cacheWrite;
  return {
    byModel,
    byTool,
    cacheHit: {
      cacheRead,
      cacheWrite,
      input: inputTotal,
      totalPrompt,
    },
  };
}

// --- CLI ---
function parseArgs(argv: string[]): {
  stateDir: string;
  logDir: string | undefined;
  limit: number;
  json: boolean;
} {
  let stateDir = resolveStateDir(process.env);
  let logDir: string | undefined;
  let limit = 20;
  let json = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state-dir" && argv[i + 1]) {
      stateDir = path.resolve(argv[++i]);
    } else if (a === "--log-dir" && argv[i + 1]) {
      logDir = path.resolve(argv[++i]);
    } else if (a === "--limit" && argv[i + 1]) {
      limit = Math.max(1, parseInt(argv[++i], 10) || 20);
    } else if (a === "--json") {
      json = true;
    }
  }
  return { stateDir, logDir, limit, json };
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function printReport(records: LlmCallRecord[], aggregates: Aggregates, limit: number): void {
  const top = records
    .slice()
    .toSorted((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit);

  console.log(`=== Top ${limit} LLM calls by token usage ===\n`);
  for (let i = 0; i < top.length; i++) {
    const r = top[i]!;
    const ts = r.timestamp ? r.timestamp.toISOString() : "—";
    console.log(
      `${i + 1}. ${ts}  ${r.agentId}:${r.sessionId}  ${r.provider ?? "—"}/${r.model ?? "—"}  in=${fmtNum(r.inputTokens)} out=${fmtNum(r.outputTokens)} total=${fmtNum(r.totalTokens)}${r.estimated ? " (est.)" : ""}`,
    );
    if (r.contributors.length > 0) {
      console.log(
        "    Top contributors: " +
          r.contributors
            .map((c) =>
              c.detail ? `${c.detail} ~${fmtNum(c.tokens)} tok` : `${c.kind} ~${fmtNum(c.tokens)}`,
            )
            .join(", "),
      );
    }
    if (r.toolNames.length > 0) {
      console.log("    Tools: " + r.toolNames.join(", "));
    }
    console.log("");
  }

  console.log("--- Aggregates ---");
  console.log("By model:");
  const byModel = Array.from(aggregates.byModel.entries()).toSorted(
    (a, b) => b[1].total - a[1].total,
  );
  for (const [model, v] of byModel) {
    console.log(
      `  ${model}: total=${fmtNum(v.total)} (in=${fmtNum(v.input)} out=${fmtNum(v.output)}) calls=${v.count}`,
    );
  }
  if (aggregates.byTool.size > 0) {
    console.log("By tool (calls that used the tool):");
    const byTool = Array.from(aggregates.byTool.entries()).toSorted(
      (a, b) => b[1].total - a[1].total,
    );
    for (const [tool, v] of byTool) {
      console.log(`  ${tool}: total tokens=${fmtNum(v.total)} calls=${v.count}`);
    }
  }
  const { cacheRead, cacheWrite, totalPrompt } = aggregates.cacheHit;
  if (totalPrompt > 0 && (cacheRead > 0 || cacheWrite > 0)) {
    const hitRate = (cacheRead / totalPrompt) * 100;
    console.log(
      `Cache: cache_read=${fmtNum(cacheRead)} cache_write=${fmtNum(cacheWrite)} (prompt total=${fmtNum(totalPrompt)}) → cache hit rate ~${hitRate.toFixed(1)}%`,
    );
  }
}

function printJson(records: LlmCallRecord[], aggregates: Aggregates, limit: number): void {
  const top = records
    .slice()
    .toSorted((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit);
  const byModel = Object.fromEntries(
    Array.from(aggregates.byModel.entries()).map(([k, v]) => [k, v]),
  );
  const byTool = Object.fromEntries(
    Array.from(aggregates.byTool.entries()).map(([k, v]) => [k, v]),
  );
  const { cacheHit } = aggregates;
  const cacheHitRate =
    cacheHit.totalPrompt > 0 ? (cacheHit.cacheRead / cacheHit.totalPrompt) * 100 : undefined;
  console.log(
    JSON.stringify(
      {
        topCalls: top.map((r) => ({
          timestamp: r.timestamp?.toISOString(),
          sessionId: r.sessionId,
          agentId: r.agentId,
          model: r.model,
          provider: r.provider,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheRead: r.cacheRead,
          cacheWrite: r.cacheWrite,
          totalTokens: r.totalTokens,
          estimated: r.estimated,
          contributors: r.contributors,
          toolNames: r.toolNames,
        })),
        aggregates: {
          byModel,
          byTool,
          cache: {
            cacheRead: cacheHit.cacheRead,
            cacheWrite: cacheHit.cacheWrite,
            totalPrompt: cacheHit.totalPrompt,
            cacheHitRatePercent: cacheHitRate,
          },
        },
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const { stateDir, logDir, limit, json } = parseArgs(process.argv);

  const transcriptRecords = await scanTranscripts(stateDir);
  let records: LlmCallRecord[] = transcriptRecords;
  if (logDir) {
    const gatewayRecords = await scanGatewayLogs(logDir);
    records = mergeRecords(transcriptRecords, gatewayRecords);
  }

  if (records.length === 0) {
    console.error(
      "No LLM usage found. Check that session transcripts exist under %s/agents/*/sessions/*.jsonl",
      stateDir,
    );
    if (!logDir) {
      console.error(
        "Optionally pass --log-dir <path> (e.g. /tmp/openclaw) to scan gateway logs for 'anthropic usage'.",
      );
    }
    process.exit(1);
  }

  const aggregates = computeAggregates(records);
  if (json) {
    printJson(records, aggregates, limit);
  } else {
    printReport(records, aggregates, limit);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
