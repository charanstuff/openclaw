---
name: xurl
description: A CLI tool for making authenticated requests to the X (Twitter) API. Use this skill when you need to post tweets, reply, quote, search, read posts, manage followers, send DMs, upload media, or interact with any X API v2 endpoint.
metadata:
  {
    "openclaw":
      {
        "emoji": "𝕏",
        "requires": { "bins": ["xurl"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "node",
              "package": "@xdevplatform/xurl",
              "bins": ["xurl"],
              "label": "Install xurl (npm)",
            },
          ],
      },
  }
---

# xurl — Agent Skill Reference

`xurl` is a CLI tool for the X API. It supports both **shortcut commands** (human/agent‑friendly one‑liners) and **raw curl‑style** access to any v2 endpoint. All commands return JSON to stdout.

Use the same command reference as the main xurl skill. Prerequisites: install via npm above, then run `xurl auth oauth2` and ensure `~/.xurl` is configured (never expose secrets in agent context).
