---
name: chained-supporter
description: Survey the other DraconDex repos in the chain BEFORE starting work — what moved in APP/SDB/TRX/EXE/APK/PWA/PKG/WEB/PGI/EXT/RUT since this repo last looked, sorted into what blocks you, what you block, and what is merely sibling news. Bounded to about six API calls and answers "nothing changed" cheaply. Use at the start of any session in a DraconDex chain repo, before planning a change that might already be in flight upstream, after a long gap since the last session, or when asked "มีอะไรเปลี่ยนบ้าง", "repo อื่นอัปเดตอะไร", "check the other repos", "what changed upstream", "chain survey".
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# chained-supporter — look before you work

In an eleven-repo chain the expensive mistake is not a bad change; it is a change
built on a stale assumption about another repo. This skill is the cheap check
that prevents it.

Run it **before** planning work, not after.

```bash
node tools/chain-survey.mjs            # the survey
node tools/chain-survey.mjs --mark     # record what you saw, after the work lands
```

## What it reports

Peers are sorted by their relationship to *this* repo, resolved from
`chain/chain.json` — that ordering is the point of the skill, because an EXE
agent should treat an SDB move as blocking and an APK move as trivia:

```
Chain survey (EXE, last surveyed 2026-09-09T18:02Z)
  ↑ SDB   MOVED  e4f5a6b "Add write_scene.mood, bump vaultSchemaVersion to 4"
                 latest tag sdb-v1.3.0 — you are pinned to sdb-v1.2.1
  ↑ APP   MOVED  73540da "…"   (skills/docs only — no action)
  ↓ PWA   unchanged
  ↓ WEB   unchanged
  ↓ PKG   unchanged
  · APK   MOVED  (sibling, not on your path — informational)
```

- `↑` **upstream** — this can block you. An unpinned schema change is the case that matters.
- `↓` **downstream** — you block them. Anything you land here has to reach these.
- `·` **sibling** — same chain, not on your path. Read it, do not act on it.

## What to do with each result

| Finding | Action |
|---|---|
| Upstream SDB moved and this repo's `sdb.lock.json` is behind | Check for an open `chained-update` PR first — do not hand-vendor. If none exists, run `chained-updated` from SDB. |
| Upstream APP moved (skills/chain) | `node tools/mirror-claude.mjs --check` in APP; a drift means the mirror never ran. |
| A downstream repo has an open `chained-update` PR from you | Finish it before starting new work — a half-propagated change is worse than an unpropagated one. |
| Nothing moved | Say so in one line and get on with the work. |

## How it stays cheap

State lives in `chain/.chain-sync.json`: per peer, the last commit SHA and
release tag this repo saw. The survey asks each peer for its newest commit only
(`perPage: 1`) and compares — six calls, and the common "nothing moved" answer
costs nothing more. It is the same idea as `write-docs`'s `.last-sync` marker,
generalised from one repo to six.

Two failure modes, both non-fatal by design:

- **A recorded SHA no longer resolves** (someone rebased or squashed): treat it
  as a full re-scan and say so, rather than crashing. `write-docs`'s
  `docs-diff.sh` already handles its marker this way — same convention.
- **A peer cannot be read** (private repo, no token, rate limit): report that
  peer as `unknown`, not as `unchanged`. A survey that silently downgrades an
  unreadable repo to "fine" is worse than no survey.

## When to mark

Run `--mark` **after the work lands**, not when the survey runs — same timing
rule as `write-docs`'s `mark-synced.sh`. Marking early records that you saw a
change you then did not act on.
