import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";

function looksLikeSkillsDir(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        return true;
      }
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(fullPath, "SKILL.md"))) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

export type BundledSkillsResolveOptions = {
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
};

const PLATFORM_SKILLS_DIR = process.platform === "linux" ? "skills-linux" : "skills";

function resolveBundledSkillsDirWithBase(baseDir: string): string | undefined {
  // On Linux prefer skills-linux so EC2/Docker can use Linux install paths (apt, go, etc.).
  if (PLATFORM_SKILLS_DIR !== "skills") {
    const platformDir = path.join(baseDir, PLATFORM_SKILLS_DIR);
    if (fs.existsSync(platformDir) && looksLikeSkillsDir(platformDir)) {
      return platformDir;
    }
  }
  const defaultDir = path.join(baseDir, "skills");
  if (looksLikeSkillsDir(defaultDir)) {
    return defaultDir;
  }
  return undefined;
}

export function resolveBundledSkillsDir(
  opts: BundledSkillsResolveOptions = {},
): string | undefined {
  const override = process.env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
  if (override) {
    return override;
  }

  // bun --compile: ship a sibling `skills/` or `skills-linux/` next to the executable.
  try {
    const execPath = opts.execPath ?? process.execPath;
    const execDir = path.dirname(execPath);
    const resolved = resolveBundledSkillsDirWithBase(execDir);
    if (resolved) {
      return resolved;
    }
  } catch {
    // ignore
  }

  // npm/dev: resolve `<packageRoot>/skills` or `<packageRoot>/skills-linux` relative to this module.
  try {
    const moduleUrl = opts.moduleUrl ?? import.meta.url;
    const moduleDir = path.dirname(fileURLToPath(moduleUrl));
    const argv1 = opts.argv1 ?? process.argv[1];
    const cwd = opts.cwd ?? process.cwd();
    const packageRoot = resolveOpenClawPackageRootSync({
      argv1,
      moduleUrl,
      cwd,
    });
    if (packageRoot) {
      const resolved = resolveBundledSkillsDirWithBase(packageRoot);
      if (resolved) {
        return resolved;
      }
    }
    let current = moduleDir;
    for (let depth = 0; depth < 6; depth += 1) {
      const resolved = resolveBundledSkillsDirWithBase(current);
      if (resolved) {
        return resolved;
      }
      const next = path.dirname(current);
      if (next === current) {
        break;
      }
      current = next;
    }
  } catch {
    // ignore
  }

  return undefined;
}
