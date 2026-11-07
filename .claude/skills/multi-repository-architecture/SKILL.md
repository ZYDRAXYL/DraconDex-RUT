---
name: multi-repository-architecture
description: The contract for DraconDex's 11-repository architecture — which of APP/SDB/TRX/EXE/APK/PWA/PKG/WEB/PGI/EXT/RUT owns a given file, which direction changes flow, and where a new piece of work belongs. Read this BEFORE creating a file, moving code between repos, or answering "where does this live" — guessing produces a change in the wrong repo that the chain then propagates everywhere. Use when starting work in any DraconDex repo, when a change touches more than one repo, when adding a repo or an edge to the chain, or when asked "อยู่ repo ไหน", "ควรแก้ที่ไหน", "โครงสร้าง repo", "multi-repo", "which repo owns this".
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# DraconDex multi-repository architecture

`chain/chain.json` is the machine-readable form of everything below. Read it
rather than trusting this prose where the two disagree — and print the resolved
view for the repo you are standing in with:

```bash
node tools/chain-lib.mjs
```

## The eleven repos

| Repo | Role | Owns | Releases |
|---|---|---|---|
| **APP** | hub | `.claude/` (the source of every skill), `chain/`, `docs/`, `process/` | — |
| **SDB** | schema | `schema/vault.sql`, `schema/version.json`, `supabase/`, `assets/` masters | `sdb-v*` |
| **TRX** | service | `netlify/`, `public/` — the DDX Transfer hand-off service | — (deploys on push) |
| **EXE** | app | `electron/**` | `v*` |
| **APK** | app | `flutter/**` | `flutter-v*` |
| **PWA** | build | `tools/`, `shim/`, `dist/` | — |
| **PKG** | content | `packages/` — theme / language / view packages | `pkg-v*` |
| **WEB** | site | the website, its Docs pages, and the public release mirror | mirror |
| **PGI** | template | `DraconDex-PGI-Template` — the minimal plugin starter (one window, one table) | — |
| **EXT** | template | `DraconDex-EXT-Template` — the full extension template (window + side panel, kv persistence) | — |
| **RUT** | app | `src-tauri/`, `sidecar/` — the Tauri shell; runs EXE's `electron/` renderer + main process under a Node sidecar | — |

## The four chains

```
EXE   APP > SDB, TRX > EXE > PKG, WEB, PWA > PGI, EXT
APK   APP > SDB, TRX > APK > PKG, WEB, PWA > PGI, EXT
PWA   APP > SDB, TRX > EXE, APK > PWA > WEB > PGI, EXT
RUT   APP > SDB, TRX > EXE > RUT
```

PGI and EXT close every chain: the plugin templates are the last thing a
change can reach and nothing is built from them inside the project. Their only
real inbound edges are `APP → PGI, EXT` (claude-tooling) and
`EXE → PGI, EXT` (`plugin-contract`) — EXE owns the rules a plugin installs
under (`electron/src/db/plugin-manifest.js`) and the API it runs against
(`electron/preload-plugin.js`). APK and PWA have no plugin runtime (APK-V3 §1),
so in those two chains the tail is reached through APP only.

Plugins *made from* a template (`DraconDex-PGI-Claude`, `-Codex`, `-Ollama`,
`-AINative`, …) are **not** in the chain. They copy the contract tooling once
and move their own pin with `node tools/plugin-contract.mjs --vendor --ref
vX.Y.Z`; nothing in the project writes into them.

SDB and TRX sit side by side: both are contracts the two apps are built
against, neither is a step between them. TRX is upstream only — the service
treats a vault as an opaque blob, so no app change can ever require a change
there, and that one-directionality is what keeps the graph acyclic.

Changes flow **left to right, never backwards.** That single property is what
prevents an infinite propagation loop, and it is why `chain.json`'s `edges` are
directed.

## Where does this change belong?

| If you are changing... | Do it in | Notes |
|---|---|---|
| a vault table, a column, `vaultSchemaVersion` | **SDB** | `schema/vault.sql`; regenerate; EXE/APK pick it up by bumping their pin |
| the plugin manifest rules, `window.pluginApi`, the side panel host | **EXE** | `plugin-manifest.js` / `preload-plugin.js`; then `chained-updated` re-vendors into PGI and EXT |
| a plugin template's demo page, its README/CLAUDE.md | **PGI** / **EXT** | the `extension-*` skills and `tools/{validate-manifest,plugin-contract}.mjs` are edited in **APP** |
| an app-level table (`plugin`, `app_setting`, `nexus_file`) | **EXE** | `electron/src/db/schema/ddl.js`'s `APP_DDL_SQL` — deliberately NOT in `vault.sql`; Flutter has no plugin system and no multi-file vault |
| an Electron renderer, main, or db file | **EXE** | |
| a Flutter widget, provider, or dao | **APK** | PWA builds from this same tree — never fork it |
| the browser shims, the lane router, the PWA build | **PWA** | |
| the DDX Transfer API, its web pages, its expiry/limits | **TRX** | change the API and BOTH clients follow — see the wire-format rule below |
| a theme, a locale pack, a view preset shipped as a download | **PKG** | |
| a *built-in* theme or locale | **EXE** / **APK** | `themes.css` + `state.js`'s `UI_THEME_OPTIONS`; `i18n.js`'s `L` |
| the website, the download page, the Docs manuals | **WEB** | |
| a skill, an agent, `chain.json` | **APP** | then `node tools/mirror-claude.mjs` |
| a plan, a process write-up, the changelog | **APP** | `Plan.md`, `process/`, `docs/CHANGELOG.md` stay project-wide |

**Before building new UI in EXE or APK, read `docs/COMPONENTS.md` (in APP)** — the registry of shared components (popover, modal, chip, segmented, card, field, list) and their EXE function ↔ APK widget pairs.

## Three rules that are not negotiable

**0. The DDX Transfer wire format is a three-way contract.**
`public/assets/js/ddx-crypto.js` in **TRX** is the source of truth;
`electron/src/db/transfer-crypto.js` in **EXE** and
`lib/data/services/ddx_transfer_service.dart` in **APK** must agree with it
byte for byte. A mismatch does not throw — it delivers a vault that imports as
nonsense. Change one, change all three.

**1. Never hand-edit a generated or mirrored file at its destination.**
Every one carries a header naming its source. Edit the source; let the chain
carry it. The files this covers today:

| Destination | Source |
|---|---|
| `EXE/src/schema/generated/vault-ddl.electron.js` | SDB `schema/vault.sql` |
| `APK/flutter/lib/core/database/vault_schema.g.dart` | SDB `schema/vault.sql` |
| `EXE/electron/src/db/supabase-schema.js` | SDB `supabase/setup/dracondex_setup.sql` |
| `APK/flutter/lib/data/services/supabase_schema.dart` | SDB `supabase/setup/dracondex_setup.sql` |
| `APK/flutter/assets/**` | SDB `assets/{flutter,fonts}` |
| any `.claude/skills/**` outside APP | APP `.claude/skills/**` |
| `PGI/EXT tools/plugin-manifest.cjs` | EXE `electron/src/db/plugin-manifest.js` (byte-identical, pinned in `plugin-contract.lock.json`) |
| `PGI/EXT tools/{validate-manifest,plugin-contract}.mjs` | APP `tools/plugin-template/` |
| `PWA/dist/**` | built from EXE + APK |
| `WEB/assets/data/releases.json` | WEB's own releases, snapshotted |

**2. `flutter/lib/` is one source tree serving both APK and PWA.**
It splits by platform through conditional exports —
`db_factory.dart` exports `_stub` / `_io` / `_web`, and the same pattern repeats
for `file_export`, `temp_file`, `apk_installer`, `google_auth_platform`. PWA is a
build *target* of that tree. Copying `flutter/lib/` into PWA forks the app in two
and every later fix has to be made twice.

## Directory prefixes are preserved on purpose

EXE keeps `electron/` as a subdirectory, and APK keeps `flutter/`, rather than
flattening to the repo root. This is not cosmetic:

- `electron/css/*.css` resolves brand images through `url(../../src/assets/brand/…)`
- `electron/src/db/schema/ddl.js` requires `../../../../src/schema/generated/vault-ddl.electron.js`
- `flutter/pubspec.yaml` declares assets relative to its own package dir

Keeping the prefix and vendoring `src/` beside it makes every relative path
byte-identical to the monorepo, so no CSS, no `require`, and neither static
checker needed a path change during the split. **Do not flatten these later** —
it would break all three at once, silently, at runtime rather than at build.

## The version trains are independent

`EXE` ships `vX.Y.Z` from `package.json`; `APK` ships `flutter-vX.Y.Z` from
`pubspec.yaml`. Their numbers are unrelated and either may be newest overall.
Both apps' update checkers poll **WEB's** release list and filter by tag prefix,
because `/releases/latest` returns whichever was published most recently
regardless of product — an Android release would otherwise offer itself as a
Windows update. `sdb-v*` and `pkg-v*` are further namespaces in the same list.

Never remove a tag prefix or repoint a checker at a private repo:
`api.github.com` answers 404 for a private repo to everyone without a token,
which is every install of the app.

## Related skills

- `chained-supporter` — run before work: what changed in the other ten repos
- `chained-updated` — run after work: push the change downstream
- `merge-release` — after a merge: is a release due, and cut it
