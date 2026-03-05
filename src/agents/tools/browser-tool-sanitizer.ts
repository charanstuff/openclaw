/**
 * Sanitize/truncate browser tool results before they are injected into LLM messages.
 * Keeps: url, title, main visible text excerpt (max 8k chars), key selectors/refs, last error.
 * Drops/shrinks: full DOM/HTML, full accessibility trees, large console/network dumps.
 *
 * Enable: OPENCLAW_BROWSER_SANITIZE_RESULTS=1 (default). Disable with =0.
 * Debug: OPENCLAW_BROWSER_DEBUG_PAYLOAD_DIR=<path> writes full raw payload to files (never injected).
 */

import fs from "node:fs/promises";
import path from "node:path";

export const BROWSER_SANITIZE_EXCERPT_MAX_CHARS = 8_000;

export type SanitizedSnapshotAi = {
  url?: string;
  title?: string;
  targetId?: string;
  excerpt: string;
  refsSummary?: string;
  lastError?: string;
  truncated?: boolean;
  stats?: { lines?: number; chars?: number; refs?: number };
};

function excerptFromText(text: string, maxChars: number): { excerpt: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return { excerpt: trimmed, truncated: false };
  }
  return {
    excerpt:
      trimmed.slice(0, maxChars) + "\n\n[truncated; excerpt limited to " + maxChars + " chars]",
    truncated: true,
  };
}

/** Extract first line that looks like "Title: ..." or use first non-empty line as title hint. */
function extractTitleHint(snapshotText: string): string | undefined {
  const line = snapshotText.split("\n").find((l) => /^Title:\s*/i.test(l) || /^#\s+/.test(l));
  if (line) {
    return (
      line
        .replace(/^Title:\s*/i, "")
        .replace(/^#\s+/, "")
        .trim()
        .slice(0, 200) || undefined
    );
  }
  const first = snapshotText.split("\n").find((l) => l.trim().length > 0);
  return first?.trim().slice(0, 200) || undefined;
}

/** Build refs summary from refs object: "e1: button Submit, e2: link ..." */
function refsSummary(
  refs: Record<string, { role?: string; name?: string; nth?: number }> | undefined,
): string | undefined {
  if (!refs || typeof refs !== "object") {
    return undefined;
  }
  const entries = Object.entries(refs)
    .slice(0, 30)
    .map(([ref, v]) => {
      const part = [v.role, v.name].filter(Boolean).join(" ");
      return part ? `${ref}: ${part}` : ref;
    });
  return entries.length > 0 ? entries.join("; ") : undefined;
}

/**
 * Sanitize AI-format snapshot for prompt injection: url, title, excerpt (8k), refs summary, last error.
 */
export function sanitizeSnapshotAi(raw: {
  snapshot?: string;
  url?: string;
  targetId?: string;
  refs?: Record<string, { role?: string; name?: string; nth?: number }>;
  stats?: { lines?: number; chars?: number; refs?: number };
  truncated?: boolean;
}): SanitizedSnapshotAi {
  const fullText = typeof raw.snapshot === "string" ? raw.snapshot : "";
  const { excerpt, truncated } = excerptFromText(fullText, BROWSER_SANITIZE_EXCERPT_MAX_CHARS);
  const title = extractTitleHint(fullText);
  return {
    url: typeof raw.url === "string" ? raw.url : undefined,
    title: title ?? undefined,
    targetId: typeof raw.targetId === "string" ? raw.targetId : undefined,
    excerpt,
    refsSummary: refsSummary(raw.refs),
    truncated: truncated || Boolean(raw.truncated),
    stats: raw.stats,
  };
}

/**
 * Format sanitized AI snapshot as a single string for the LLM (no full DOM).
 */
export function formatSanitizedSnapshotAi(sanitized: SanitizedSnapshotAi): string {
  const parts: string[] = [];
  if (sanitized.url) {
    parts.push(`URL: ${sanitized.url}`);
  }
  if (sanitized.title) {
    parts.push(`Title: ${sanitized.title}`);
  }
  if (sanitized.targetId) {
    parts.push(`targetId: ${sanitized.targetId}`);
  }
  if (sanitized.refsSummary) {
    parts.push(`Refs: ${sanitized.refsSummary}`);
  }
  if (sanitized.stats) {
    parts.push(
      `Stats: lines=${sanitized.stats.lines ?? "?"} chars=${sanitized.stats.chars ?? "?"} refs=${sanitized.stats.refs ?? "?"}`,
    );
  }
  parts.push("---");
  parts.push(sanitized.excerpt);
  if (sanitized.lastError) {
    parts.push(`Last error: ${sanitized.lastError}`);
  }
  return parts.join("\n");
}

/**
 * Sanitize aria-format snapshot: keep url, targetId, and a compact list of interactive nodes (ref, role, name) up to ~8k chars.
 */
export function sanitizeSnapshotAria(raw: {
  url?: string;
  targetId?: string;
  nodes?: Array<{ ref?: string; role?: string; name?: string; value?: string }>;
}): string {
  const parts: string[] = [];
  if (typeof raw.url === "string") {
    parts.push(`URL: ${raw.url}`);
  }
  if (typeof raw.targetId === "string") {
    parts.push(`targetId: ${raw.targetId}`);
  }
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  let nodeText = nodes
    .slice(0, 500)
    .map((n) => {
      const ref = n.ref ?? "";
      const role = n.role ?? "";
      const name = typeof n.name === "string" ? n.name : "";
      const value = typeof n.value === "string" ? n.value : "";
      return [ref, role, name, value].filter(Boolean).join(" ");
    })
    .join("\n");
  if (nodeText.length > BROWSER_SANITIZE_EXCERPT_MAX_CHARS) {
    nodeText = nodeText.slice(0, BROWSER_SANITIZE_EXCERPT_MAX_CHARS) + "\n[truncated]";
  }
  parts.push("---");
  parts.push(nodeText);
  return parts.join("\n");
}

/**
 * Sanitize act result: keep ok, url, targetId, last error; drop large payloads.
 */
export function sanitizeActResult(raw: Record<string, unknown>): string {
  const parts: string[] = [];
  if (raw.ok === true) {
    parts.push("ok: true");
  }
  if (typeof raw.url === "string") {
    parts.push(`url: ${raw.url}`);
  }
  if (typeof raw.targetId === "string") {
    parts.push(`targetId: ${raw.targetId}`);
  }
  const err = raw.error ?? raw.message;
  if (typeof err === "string") {
    parts.push(`error: ${err.slice(0, 500)}`);
  }
  return parts.length > 0 ? parts.join("\n") : JSON.stringify({ ok: raw.ok, error: raw.error });
}

/**
 * Sanitize console result: last N messages, total size cap.
 */
const CONSOLE_MAX_MESSAGES = 10;
const CONSOLE_MAX_CHARS = 2_000;

export function sanitizeConsole(raw: { messages?: unknown[] }): string {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const last = messages.slice(-CONSOLE_MAX_MESSAGES);
  let out = last
    .map((m) =>
      typeof m === "object" && m !== null && "text" in m
        ? String((m as { text: unknown }).text)
        : JSON.stringify(m),
    )
    .join("\n");
  if (out.length > CONSOLE_MAX_CHARS) {
    out = out.slice(0, CONSOLE_MAX_CHARS) + "\n[truncated]";
  }
  return out || "No console messages.";
}

const DEBUG_PAYLOAD_DIR = process.env.OPENCLAW_BROWSER_DEBUG_PAYLOAD_DIR?.trim();

export async function writeDebugPayloadIfEnabled(action: string, payload: unknown): Promise<void> {
  if (!DEBUG_PAYLOAD_DIR) {
    return;
  }
  try {
    await fs.mkdir(DEBUG_PAYLOAD_DIR, { recursive: true });
    const name = `browser-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`;
    const filePath = path.join(DEBUG_PAYLOAD_DIR, name);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 0), "utf8");
  } catch {
    // best effort; do not fail the tool
  }
}

export function isSanitizeEnabled(): boolean {
  const v = process.env.OPENCLAW_BROWSER_SANITIZE_RESULTS?.trim();
  if (v === "0" || v?.toLowerCase() === "false") {
    return false;
  }
  return true;
}
