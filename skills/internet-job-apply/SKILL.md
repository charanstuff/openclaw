---
name: internet-job-apply
description: >
  Use when the user asks you to apply for jobs online or generate job-application
  materials (applications, cover letters, outreach messages, interview prep)
  using the user's resume plus a local details.json memory file.
  IMPORTANT: Only use details.json for information that is NOT already present
  in the resume. If required info is missing from BOTH sources, ask the user,
  then update details.json and reuse it later. Ensure you only ask personal information of the user if it's not in the details.json. IF it is a question like "Do you have experience working on..." or something related to job, answer in a way that will be positive for the candidate applying to the postion.
metadata: { "openclaw": { "emoji": "📋" } }
---

# Internet Job Apply (Resume + details.json, No Duplication)

## Goal

Help the user apply for jobs online and produce application materials while:

1. using the resume as the primary source of truth, and
2. using `details.json` only for additional facts not already present in the resume,
3. asking the user for missing facts and storing them into `details.json` for reuse.

**Critical rule:** Do **not** repeat/duplicate anything that already exists in the resume. Also ensure you don't apply to same job multiple times.

---

## Data sources (must use these)

- Candidate folder (primary): `<WORKSPACE>/<candidate>/`
- Resume file (primary): `<WORKSPACE>/<candidate>/resume.pdf` (or `resume.docx` / `resume.md`)
- Details memory (primary): `<WORKSPACE>/<candidate>/details.json`

### Candidate-folder resolution (mandatory)

1. Determine the candidate slug from user context (for example, `charan`, `john`).
2. Use that candidate folder for ALL application facts/files.
   - Example: applying for Charan → `~/.openclaw/workspace/charan/`
   - Example: applying for John → `~/.openclaw/workspace/john/`
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

- Do NOT run system commands.
- Do NOT install software, browser extensions, CLIs, plugins, or additional skills.
- Do NOT request or handle passwords, SSNs, tax IDs, bank account numbers, or payment info.
- Do NOT fabricate experience, employers, education, dates, titles, metrics, or credentials.
- Only store facts in `details.json` that the user explicitly confirms.
- If browser automation is used, stop before any irreversible step (submitting an application)
  unless the user explicitly says to submit.

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

## Browser automation rules (must follow on dynamic job portals)

### Snapshot discipline (mandatory)

- Take a NEW snapshot immediately before every click/type/submit action.
- Take a NEW snapshot after any navigation, modal/dialog open, page section expand, file upload, or form step transition.
- If any action fails with "Element e### not found/not visible", STOP and take a new snapshot, then re-locate the target element.

### File upload rule (mandatory)

- Never call setInputFiles on a button.
- If the UI shows an "Attach/Upload" button:
  1. Click the button.
  2. Wait for (or locate) the actual file input element: input[type="file"] (often hidden).
  3. Call setInputFiles ONLY on that input element.
- If upload fails twice, ask the user to upload manually, then continue from the next field.

### React/Workday-style re-render fallback

- If snapshot references keep going stale (repeated e### failures):
  - Switch to a selector strategy based on stable attributes (name/id/aria-label) or text matching.
  - If needed, use evaluate/JS querySelector to click the intended element.
  - After any fallback click, take a new snapshot before continuing.

- If browser tool errors repeat 3 times in a row, stop and ask the user whether to restart gateway or proceed with manual step.

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
   - include only what is NOT already in resume
8. If still missing required info → ask user → update details.json → proceed.
9. Produce final outputs ready to paste into applications.

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
