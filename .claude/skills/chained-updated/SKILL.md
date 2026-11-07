---
name: chained-updated
description: Propagate a landed change to the DraconDex repos downstream of it — resolve the affected edges from chain/chain.json, rebuild each edge's payload, and open a labelled pull request on every downstream repo, without being told which repos or refs are involved. Use after a schema change in SDB, after an app change that PWA or PKG builds on, after editing a skill in APP, after changing EXE's plugin contract (plugin-manifest.js / preload-plugin.js) that the PGI and EXT templates vendor, or when asked "ส่งต่อให้ repo อื่น", "อัปเดต repo ที่เกี่ยวข้อง", "propagate this", "update downstream", "chained update".
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# chained-updated — push the change downstream

Every cross-repo dependency in DraconDex is an **edge** in `chain/chain.json`.
This skill walks the edges leaving the current repo and makes each downstream
repo current. You never have to name the repos: the contract already knows them.

```bash
node tools/chain-propagate.mjs                # every downstream edge
node tools/chain-propagate.mjs --to EXE       # one target
node tools/chain-propagate.mjs --dry-run      # show the PRs it would open
```

## The six edge kinds

| carries | from → to | What propagation actually does |
|---|---|---|
| `claude-tooling` | APP → all ten | `node tools/mirror-claude.mjs`, commit the changed mirror |
| `generated-schema` | SDB → EXE, APK | rewrite the vendored artifacts, bump `sdb.lock.json` |
| `app-source` | EXE, APK → PWA; EXE → RUT | bump the commit pin in `app-source.json`, let PWA rebuild |
| `release-mirror` | EXE, APK → WEB | already handled by `.github/scripts/mirror-release.sh` — do not duplicate it |
| `package-targets` | EXE, APK → PKG | update `minAppVersion` in the affected package manifests |
| `plugin-contract` | EXE → PGI, EXT | the template's own `node tools/plugin-contract.mjs --vendor --from <EXE>` re-copies `plugin-manifest.js` and rewrites `plugin-contract.lock.json`; read its `review` lines — a changed `preload-plugin.js` means `app.js` and the extension-* skills need a look |

`release-mirror` is listed so the chain is complete, but it is **not** this
skill's job: the build workflows already mirror inline as part of publishing.
Re-running it here would create a second, competing publisher.

## Pull request, never a direct push

The downstream repo's CI has to run *before* the artifact lands. This is not a
formality — `electron/src/db/schema/ddl.js` `require`s the vendored schema at
Electron startup, so a bad artifact is a boot failure rather than a test
failure. Same on the Flutter side, where the web-target compile catches breaks
that `flutter analyze` does not.

- Branch: `chain/<source>-<ref>` — deterministic, so a re-run updates the same
  branch and the same PR instead of opening a second one.
- Label: `chained-update`. Draft PRs, like every other automated PR here.
- The body states the before/after pin, the artifacts rewritten with their
  hashes, and the upstream commits since the previous pin.
- Every commit ends with a `Chained-From: <REPO>@<sha>` trailer.

## Three things that keep it from running away

**Direction.** Edges are one-way and `chain.json` is acyclic; propagation only
ever walks `from → to`. A consumer never writes to its producer, so `A → B → A`
is not representable. Validate with `node tools/chain-lib.mjs` in any repo.

**The label check.** GitHub does not re-trigger workflows for events raised by a
workflow's own `GITHUB_TOKEN` — but the chain writes across repos, which needs a
PAT (`CHAIN_TOKEN`), and a PAT **does** re-trigger. So a run triggered by a PR
carrying the `chained-update` label refuses to propagate further. Without this
check the PAT reintroduces exactly the loop the direction rule prevents.

**Path allowlist.** A propagation may only write the paths its edge declares,
plus the pin file. It can never touch a downstream repo's own source, so a human
working in `electron/src/renderer/**` can never conflict with the bot.

## When the downstream repo has diverged

- **A `chain/*` branch is bot-owned.** On a re-run it is recreated from the
  target's default branch and the payload re-applied — never rebased, never
  force-pushed onto someone's work. A conflicted PR therefore self-heals on the
  next run.
- **Someone hand-edited a vendored artifact.** Overwrite it, and say so in the
  PR body with the diff that was replaced. The artifact is generated; the edit
  belongs upstream and was already invalid. But it must be *shown*, never
  silently discarded.
- **A vendored destination no longer exists** (a consumer moved or deleted it):
  the bot cannot guess. Open an issue titled `Chain broken: <from> → <to>`
  naming the missing path, and fail loudly. A consumer that moved a contracted
  file broke the contract; a human repairs one side or the other.
- **A consumer deliberately wants to stay behind.** Honour a `hold` in the pin
  file — skip it with a notice, and keep enforcing the *pinned* version so being
  behind stays safe rather than becoming unchecked.

## Auth

Cross-repo writes need `CHAIN_TOKEN`, a PAT with `contents: write` and
`pull_requests: write` on all eleven repos — a workflow's own `GITHUB_TOKEN` is
scoped to its own repo and cannot do it. This repo already learned that lesson
building the release mirror; `.github/scripts/mirror-release.sh` is the
reference for how it must fail when the secret is absent:

> a loud error naming **the secret**, **the target repo**, **the consequence**,
> and **the fix** — never a silent skip.

Copy that standard for every chain error message. A missing token that fails
quietly leaves the chain silently behind, which is the one outcome this whole
mechanism exists to prevent.
