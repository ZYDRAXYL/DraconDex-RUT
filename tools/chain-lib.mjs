// Shared helper every chain-aware skill loads. It answers four questions the
// skills would otherwise each re-derive (and get subtly different answers to):
//
//   which repo am I in?          selfKey()
//   who is upstream/downstream?  upstreamOf() / downstreamOf()
//   where is repo X checked out? clonePathOf()
//   what changed since I synced? readSyncState() / writeSyncState()
//
// It reads chain/chain.json and nothing else. `self` in that file is rewritten
// per repo by tools/mirror-claude.mjs, so the SAME code answers correctly in
// all seven checkouts — that is the whole point: a skill never has to be told
// which repo it is running in.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/chain-lib.mjs -> repo root. Skills under .claude/skills/<name>/ resolve
// three levels up instead; both land in the same place, so always go through
// repoRoot() rather than recomputing.
const HERE = dirname(fileURLToPath(import.meta.url));

export function repoRoot(from = HERE) {
  // Walk up until chain/chain.json appears. Works from tools/ AND from
  // .claude/skills/<x>/ without either caller knowing its own depth.
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'chain', 'chain.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('chain/chain.json not found above ' + from + ' — is this a DraconDex chain repo?');
}

export function loadChain(root = repoRoot()) {
  return JSON.parse(readFileSync(join(root, 'chain', 'chain.json'), 'utf8'));
}

export function selfKey(chain = loadChain()) {
  return chain.self;
}

export function repoOf(key, chain = loadChain()) {
  const r = chain.repos[key];
  if (!r) throw new Error(`unknown repo key "${key}" — known: ${Object.keys(chain.repos).join(', ')}`);
  return r;
}

export function fullName(key, chain = loadChain()) {
  return `${chain.org}/${repoOf(key, chain).repo}`;
}

/** Edges leaving `key` — what this repo must push downstream when it changes. */
export function downstreamOf(key, chain = loadChain()) {
  return chain.edges.filter(e => e.from === key);
}

/** Edges arriving at `key` — what this repo must watch for upstream. */
export function upstreamOf(key, chain = loadChain()) {
  return chain.edges.filter(e => e.to === key);
}

/**
 * Every repo whose changes can reach `key`, transitively. This is what
 * chained-supporter surveys: not just direct parents, because a schema change
 * in SDB reaches PWA only through EXE/APK and would otherwise be invisible.
 */
export function ancestorsOf(key, chain = loadChain()) {
  const seen = new Set();
  const queue = upstreamOf(key, chain).map(e => e.from);
  while (queue.length) {
    const k = queue.shift();
    if (seen.has(k)) continue;      // cycles are not expected, but do not hang on one
    seen.add(k);
    for (const e of upstreamOf(k, chain)) queue.push(e.from);
  }
  seen.delete(key);
  return [...seen];
}

/**
 * Sibling checkouts live beside this one: /home/user/DraconDex-<KEY>. Returns
 * null when that repo is not cloned locally, so callers can fall back to the
 * GitHub API instead of failing.
 */
export function clonePathOf(key, chain = loadChain(), root = repoRoot()) {
  const p = join(dirname(root), repoOf(key, chain).repo);
  return existsSync(join(p, '.git')) ? p : null;
}

export function readSyncState(root = repoRoot(), chain = loadChain(root)) {
  const p = join(root, chain.propagation.syncState);
  if (!existsSync(p)) return { repos: {} };
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return { repos: {} }; }   // a corrupt marker means "re-scan", never a crash
}

export function writeSyncState(state, root = repoRoot(), chain = loadChain(root)) {
  const p = join(root, chain.propagation.syncState);
  writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  return p;
}

/** CLI: `node tools/chain-lib.mjs` prints the resolved view for this repo. */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const chain = loadChain();
  const me = selfKey(chain);
  console.log(`self         ${me}  (${fullName(me, chain)})`);
  console.log(`role         ${repoOf(me, chain).role}`);
  console.log(`releases     ${repoOf(me, chain).releases ?? '—'}`);
  console.log(`upstream     ${upstreamOf(me, chain).map(e => `${e.from}:${e.carries}`).join(', ') || '—'}`);
  console.log(`downstream   ${downstreamOf(me, chain).map(e => `${e.to}:${e.carries}`).join(', ') || '—'}`);
  console.log(`ancestors    ${ancestorsOf(me, chain).join(', ') || '—'}`);
  for (const k of Object.keys(chain.repos)) {
    const p = clonePathOf(k, chain);
    console.log(`  clone ${k.padEnd(4)} ${p || '(not cloned here)'}`);
  }
}
