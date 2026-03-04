---
name: internet-job-apply-headless
description: >
  Use when the user asks you to apply for jobs online or generate job-application
  materials (applications, cover letters, outreach messages, interview prep)
  **on a remote or headless browser** (for example, Chromium running on an EC2 host
  behind the OpenClaw gateway).
  This skill is optimized for using OpenClaw's built-in headless browser (CDP)
  instead of the Chrome extension relay. It MUST NOT ask the user to click the
  Chrome extension icon or attach a local tab; instead it should use the browser
  tool directly, and only fall back to generating a script when CDP truly is not
  available.
metadata: { "openclaw": { "emoji": "🛰️" } }
---

# Internet Job Apply — Headless (Resume + details.json, No Duplication)

## Goal

Help the user apply for jobs online and produce application materials while:

1. using the resume as the primary source of truth, and
2. using `details.json` only for additional facts not already present in the resume,
3. asking the user for missing facts and storing them into `details.json` for reuse,
4. driving a **headless / remote browser via OpenClaw's browser tool** (no Chrome extension).

**Critical rule:** Do **not** repeat/duplicate anything that already exists in the resume.
Also ensure you don't apply to the same job multiple times.
Do **not** assume the person you are talking to is the person you are applying for; always
use the candidate identity from the workspace (folder name + resume/details.json).

---

## Data sources (must use these)

- Candidate folder (primary): `<WORKSPACE>/<candidate>/`
- Resume file (primary): `<WORKSPACE>/<candidate>/resume.pdf` (or `resume.docx` / `resume.md`)
- Details memory (primary): `<WORKSPACE>/<candidate>/details.json`

### Candidate-folder resolution (mandatory)

1. Determine the candidate slug from user context (for example, `charan`, `john`, `shabnam`).
2. Use that candidate folder for ALL application facts/files.
   - Example: applying for Charan → `~/.openclaw/workspace/charan/`
   - Example: applying for Shabnam → `~/.openclaw/workspace/shabnam/`
3. Do NOT pull resume/details from a different person's folder.

### If folder/files are missing

If `<WORKSPACE>/<candidate>/` does not exist, stop and tell the user exactly what to create:

- Folder: `<WORKSPACE>/<candidate>/`
- Required files:
  - `resume.pdf` (or `resume.docx` / `resume.md`)
  - `details.json` (using this skill's schema)

Also provide a minimal starter `details.json` template:

```json
{
  "identity": {},
  "preferences": {},
  "constraints": {},
  "work_stories": {},
  "projects": {},
  "metrics": {},
  "links": {},
  "misc": {}
}
```

---

## Safety rules (must follow)

- Do NOT run arbitrary system commands (shell, SSH, OS package managers) from this skill.
- Do NOT install software, browser extensions, CLIs, plugins, or additional skills.
- Do NOT request or handle passwords, SSNs, tax IDs, bank account numbers, or payment info.
- Do NOT fabricate experience, employers, education, dates, titles, metrics, or credentials.
- Only store facts in `details.json` that the user explicitly confirms.
- If browser automation is used, stop before any irreversible step (submitting an application)
  unless the user explicitly says to submit.
- If headless automation fails in a way that might cause duplicate or partial submissions,
  stop and explain clearly; ask before retrying.

---

## Core behavior rules

### 1) Resume-first, no duplication

When producing any output that references the user's background:

1. Read/parse the resume content first.
2. Determine which facts are relevant for the user's request or the application form.
3. For each fact you intend to include, check if it already exists in the resume:
   - If YES → use it from the resume and **do not include it from details.json**
   - If NO → check details.json:
     - If present → include it
     - If missing → ask the user and then store it in details.json

### 2) What belongs in details.json (only if NOT in resume)

`details.json` is strictly for extra details that commonly appear in job apps but may not be on a resume:

- work authorization / visa status phrasing (as the user prefers)
- notice period / start date availability
- location preference (onsite/hybrid/remote) and relocation willingness
- compensation preferences (ranges)
- links (LinkedIn, portfolio, GitHub) if absent from resume
- manager references or recruiter contact preferences
- role-specific story details: STAR context, conflict, tradeoffs, lessons
- extra metrics, scale, or tooling details not listed in resume
- common form fields: full legal name spelling, phone, address (ONLY if user wants stored)

### 3) Missing information protocol (ask → store → continue)

If required information is missing from BOTH resume and details.json:

- Ask 1 focused question (max 3 if tightly related).
- Wait for the answer.
- Update details.json immediately.
- Confirm (briefly) what you stored.
- Continue the task using the new information.

---

## Headless browser automation rules (must follow)

This skill is designed for environments where:

- OpenClaw's gateway is running, and
- `browser.cdpUrl` points at a **headless or remote Chromium** instance (for example, a
  Chromium container on EC2), and
- there is **no Chrome extension relay tab** available.

### A. Always prefer the built-in browser tool

- Use OpenClaw's `browser` tool (headless CDP) as the primary way to:
  - open the job application URL,
  - navigate multi-step forms (Greenhouse / Lever / Workday / Ashby / etc.),
  - fill text fields, selects, and checkboxes,
  - upload the resume file from the candidate workspace.
- Do **not** tell the user to click the Chrome extension icon or "attach a tab".
- If the browser tool reports that it cannot reach CDP (network or config error), treat that
  as a genuine infrastructure issue and follow the fallback below instead of looping.

### B. Snapshot discipline (mandatory)

- Take a NEW snapshot immediately before every click/type/submit action.
- Take a NEW snapshot after any navigation, modal/dialog open, page section expand, file upload,
  or form step transition.
- **Refs for fill/click/upload:** You can use either snapshot format. **AI** snapshots use refs
  like `e1`, `e2`, …; **aria** snapshots use refs like `ax1`, `ax2`, …. Both work for fill, click,
  and file upload — use the refs from the snapshot you just took (e.g. `e4` or `ax8`).
- If any action fails with "Element e### not found/not visible" (or ax###), STOP and take a new
  snapshot, then re-locate the target element.

### C. File upload rule (mandatory)

- Never call `setInputFiles` on a button.
- If the UI shows an "Attach/Upload" button:
  1. Click the button.
  2. Wait for (or locate) the actual file input element: `input[type="file"]` (often hidden).
  3. Call `setInputFiles` ONLY on that input element.
- If upload fails twice, ask the user to upload manually, then continue from the next field.

### D. React/Workday-style re-render fallback

- If snapshot references keep going stale (repeated e### failures):
  - Switch to a selector strategy based on stable attributes (name/id/aria-label) or text matching.
  - If needed, use evaluate/JS `querySelector` to click the intended element.
  - After any fallback click, take a new snapshot before continuing.
- If browser tool errors repeat 3 times in a row, stop and ask the user whether to
  retry once more, switch to a generated script, or proceed with manual steps.

### E. Script-generation fallback (last resort)

If the built-in browser tool cannot be used reliably in the current environment
(for example, repeated CDP connection failures, strict CSP, or automation blocking):

1. Offer to generate a **minimal, headless-friendly Playwright script** (Python or Node) that:
   - opens the specific job application URL,
   - fills all fields from resume + details.json,
   - uploads the resume from `<WORKSPACE>/<candidate>/resume.pdf` or `resume_ic.pdf`,
   - saves a pre-submit screenshot (PNG) and JSON of filled values,
   - waits for an explicit flag before actually submitting.
2. Clearly list:
   - the script file to create (for example, `p1ai_apply.py`),
   - exact commands to install dependencies and run it,
   - where artifacts (PNG/JSON/HTML) will be written.
3. Only suggest this path if the user is comfortable running commands on their gateway/EC2 host.

---

## Standard workflow (always follow)

1. Identify the candidate and resolve `<WORKSPACE>/<candidate>/`.
2. Identify the target: job link / company / role / platform (Greenhouse/Lever/Workday/etc.).
3. Determine what output is needed:
   - application form answers
   - resume tailoring bullets
   - cover letter
   - recruiter outreach
   - interview prep / STAR stories
4. Read resume and extract relevant facts.
5. Draft using only resume content.
6. Identify gaps where extra specificity improves quality (metrics, scope, tooling, preferences).
7. Consult details.json for missing-but-allowed details:
   - include only what is NOT already in resume.
8. If still missing required info → ask user → update details.json → proceed.
9. For online applications where headless is allowed:
   - use the headless browser tool as described above to fill and, if authorized, submit;
   - otherwise, generate ready-to-paste answers + optional automation script.

---

## details.json schema + update rules

### Required schema (keep stable)

`details.json` must always be valid JSON with this shape:

```json
{
  "identity": {},
  "preferences": {},
  "constraints": {},
  "work_stories": {},
  "projects": {},
  "metrics": {},
  "links": {},
  "misc": {}
}
```
