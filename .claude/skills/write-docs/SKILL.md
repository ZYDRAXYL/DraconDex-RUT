---
name: write-docs
description: Auto-generate and keep project documentation in sync with the code — explains what each system/module does and what each file contains (docs/SYSTEMS.md, docs/FILES.md), and appends a dated changelog entry summarizing what Claude changed and why (docs/CHANGELOG.md). Use when asked to "เขียน doc", "อัปเดต doc", "document this change", "write documentation", "sync docs with code", "update the changelog", or proactively after a set of edits big enough that the docs would go stale.
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# write-docs — sync docs/SYSTEMS.md, docs/FILES.md, docs/CHANGELOG.md with the code

Paths below are relative to the repo root of whichever chain repo you are in, not to this
skill directory.

This skill maintains three files:

| File | Purpose | Audience |
|---|---|---|
| `docs/SYSTEMS.md` | How each system/module behaves — data flow, what happens when the user does X | Someone who wants to understand behavior without reading code |
| `docs/FILES.md` | What's in each file, per-directory — line counts, responsibilities, key functions | Someone about to edit a specific file |
| `docs/CHANGELOG.md` | Dated log of what Claude changed, why, and which of the above two files it touched | Anyone tracking what happened between sessions |

**The driver is a diff detector, not an app launcher** — this isn't a GUI to
click through, so the "driving" step is figuring out *what changed since docs
were last synced*. That's `.claude/skills/write-docs/docs-diff.sh`.

## Run (the actual workflow)

### 1. See what changed since the last doc sync

```bash
bash .claude/skills/write-docs/docs-diff.sh
```

This prints (verified working in this repo):
- Uncommitted working-tree changes (`git status --porcelain`)
- If `.claude/skills/write-docs/.last-sync` exists: commit log + changed-file
  list between that commit and `HEAD`
- If no marker exists yet (first run ever): a note to treat it as a full-repo
  scan, plus the full tracked file list

Read the actual diff/files — don't guess from commit messages alone. A commit
message can undersell what changed.

### 2. Update docs/FILES.md for touched files

For every file in the diff:
- If the file is new: add an entry under the right directory table/section.
- If the file changed meaningfully (new function, changed responsibility, new
  exported API): update its existing entry. Don't just note "changed" — say
  *what* changed (new function name, new IPC channel, new table column).
- If the change is cosmetic (formatting, comment tweak, variable rename with
  no behavior change): skip — don't pad the doc with noise.

### 3. Update docs/SYSTEMS.md for affected systems

Ask: does this diff change *user-visible behavior* or *data flow* for any
system section? If yes, update that section's prose. If the diff only touches
internals with no behavior change (refactor, perf, dead code removal), leave
SYSTEMS.md alone.

**Verify claims against the running app when the change is behavioral, not
just against the diff.** A diff can look right and still not work — if this
project has a driver skill for launching/testing it (check
`.claude/skills/*/SKILL.md` for one, e.g. `run-<project>`), use it to confirm
before writing the behavior down as fact.

### 4. Append a changelog entry

Prepend (newest first) to `docs/CHANGELOG.md` using this format:

```
## YYYY-MM-DD — short title
- commit: <sha, or "uncommitted" if not committed yet>
- ไฟล์ที่แก้: path/a.js, path/b.js
- อะไรเปลี่ยน: ...
- ทำไม: ...
- Doc ที่อัปเดต: docs/SYSTEMS.md §X, docs/FILES.md §Y (or "ไม่กระทบ doc" if neither needed an update)
```

Match the language already in the changelog (Thai in this repo — see the
2026-07-04 baseline entry). Keep each entry to what actually changed; don't
restate the whole diff line by line.

### 5. Mark the sync point

Only after `docs/SYSTEMS.md`, `docs/FILES.md`, and `docs/CHANGELOG.md` are all
updated (or explicitly confirmed to need no update):

```bash
bash .claude/skills/write-docs/mark-synced.sh
```

This writes current `HEAD` to `.claude/skills/write-docs/.last-sync` (verified
working — prints `Docs sync marker updated -> <sha>`). The next run's diff
starts from here.

**Don't run this if there are still-uncommitted changes you intend to keep
editing** — the marker is meant to track "docs are caught up to code," and if
code keeps moving without a commit, re-run step 1 instead of trusting the
marker.

## First run on a fresh checkout / new project

If `docs/SYSTEMS.md` or `docs/FILES.md` don't exist yet, this isn't an
incremental sync — do a **full scan**:
1. List every top-level file and every file under `src/` (or the project's
   equivalent source dirs) with `git ls-files`.
2. For each system/module (however this project divides them — check for an
   obvious module boundary: folders, IPC namespaces, route groups), read
   enough of the code to describe real behavior, not just file names.
3. If the app is drivable (check for a `run-<project>`-style skill), actually
   launch it and click through the systems before writing "how it behaves" —
   don't infer behavior from code alone when you can verify it.
4. Write `docs/SYSTEMS.md` and `docs/FILES.md` from scratch, then seed
   `docs/CHANGELOG.md` with one baseline entry describing "initial doc write"
   (see the 2026-07-04 entry in this repo's `docs/CHANGELOG.md` for the shape).
5. Run `mark-synced.sh` to set the baseline.

## Gotchas

- `git diff --name-status <marker>..HEAD` silently returns nothing if
  `<marker>` was on a branch that got rebased/squashed away — `docs-diff.sh`
  checks `git cat-file -e <marker>^{commit}` first and tells you to fall back
  to a full re-scan rather than reporting a false "nothing changed."
- The marker file itself (`.claude/skills/write-docs/.last-sync`) and
  `docs/` are excluded from the diff/`git ls-files` output in
  `docs-diff.sh` — otherwise every doc-sync run would show up as a change
  needing documentation about itself.
- Uncommitted changes always show up in step 1 regardless of the marker —
  don't skip documenting something just because it hasn't been committed.
  If it's uncommitted, write `commit: uncommitted` in the changelog entry and
  correct it to the real sha in a later pass once it lands (or just leave it —
  the important record is that the change happened).
- This skill does not commit anything itself and does not run `mark-synced.sh`
  automatically — both are explicit steps so a partial/interrupted doc-sync
  never silently advances the marker past work that wasn't actually
  documented.
