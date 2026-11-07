// chained-updated's executable: carry a landed change out to the repos
// downstream of this one.
//
//   node tools/chain-propagate.mjs              every outgoing edge
//   node tools/chain-propagate.mjs --to EXE     one target
//   node tools/chain-propagate.mjs --dry-run    show what would happen
//   node tools/chain-propagate.mjs --push       also commit + push the branch
//
// Without --push this only stages the payload in each sibling checkout and
// reports. That default is deliberate: propagation is easy to trigger by
// accident and expensive to undo across six repos.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadChain, repoRoot, selfKey, downstreamOf, clonePathOf, fullName } from './chain-lib.mjs';

const ROOT = repoRoot();
const chain = loadChain(ROOT);
const ME = selfKey(chain);
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const PUSH = args.includes('--push');
const ONLY = (() => { const i = args.indexOf('--to'); return i >= 0 ? args[i + 1] : null; })();
const BRANCH = chain.branch;

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sourceSha = git(ROOT, 'rev-parse', 'HEAD');

// Refuse to propagate from a chained-update commit. The chain writes across
// repos with a PAT, and a PAT re-triggers workflows where a repo's own
// GITHUB_TOKEN would not — without this check the propagation loops.
const headMsg = git(ROOT, 'log', '-1', '--pretty=%B');
if (new RegExp(`^${chain.propagation.trailerPrefix}:`, 'm').test(headMsg)) {
  console.error(`refusing to propagate: HEAD is itself a ${chain.propagation.label} commit.`);
  console.error('Propagating from a propagation is how the chain loops. Nothing was done.');
  process.exit(2);
}

const edges = downstreamOf(ME, chain).filter(e => !ONLY || e.to === ONLY);
if (!edges.length) {
  console.log(`${ME} has no outgoing edges${ONLY ? ` to ${ONLY}` : ''} — nothing to propagate.`);
  process.exit(0);
}

/** Each edge kind knows how to rebuild its own payload. An unimplemented kind
 *  reports that plainly rather than succeeding with an empty change — a silent
 *  no-op here leaves the chain behind, which is the failure this prevents. */
const HANDLERS = {
  'claude-tooling': (edge, dest) => {
    // The mirror tool already knows the per-repo skill set and writes the
    // chain contract with `self` rewritten. Never hand-copy skills.
    const out = execFileSync('node', [`${ROOT}/tools/mirror-claude.mjs`, '--only', edge.to],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, note: out.trim().split('\n').pop() };
  },
  'generated-schema': () => ({ ok: false, note: 'SDB is not populated yet — Phase 1c. Vendoring runs from SDB, not from here.' }),
  'app-source':       () => ({ ok: false, note: 'PWA source pinning lands in Phase 3c.' }),
  'package-targets':  () => ({ ok: false, note: 'PKG package manifests land in Phase 3a.' }),
  'release-mirror':   () => ({ ok: false, note: 'handled inline by the build workflow (.github/scripts/mirror-release.sh) — not this tool\'s job.' }),
  'plugin-contract': (edge, dest) => {
    // EXE → a plugin template: re-vendor plugin-manifest.js from THIS checkout
    // with the template's own tool, which also rewrites its lock. Run from EXE
    // only — the template decides what it vendors, EXE never writes into it.
    const tool = `${dest}/tools/plugin-contract.mjs`;
    if (!existsSync(tool)) return { ok: false, note: `${edge.to} has no tools/plugin-contract.mjs yet — mirror claude-tooling from APP first.` };
    const out = execFileSync('node', [tool, '--vendor', '--from', ROOT], { cwd: dest, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, note: out.trim().split('\n').pop() };
  },
};

let staged = 0, skipped = 0;
for (const edge of edges) {
  const dest = clonePathOf(edge.to, chain, ROOT);
  const label = `${ME} → ${edge.to} (${edge.carries})`;

  if (!dest) { console.log(`skip  ${label}: ${fullName(edge.to, chain)} is not cloned here`); skipped++; continue; }
  const handler = HANDLERS[edge.carries];
  if (!handler) { console.log(`skip  ${label}: no handler for this edge kind`); skipped++; continue; }

  if (DRY) { console.log(`would ${label}  →  ${dest}`); continue; }

  const res = handler(edge, dest);
  if (!res.ok) { console.log(`skip  ${label}: ${res.note}`); skipped++; continue; }

  const dirty = git(dest, 'status', '--porcelain');
  if (!dirty) { console.log(`ok    ${label}: already current`); continue; }
  console.log(`stage ${label}: ${dirty.split('\n').length} file(s)${res.note ? ` — ${res.note}` : ''}`);
  staged++;

  if (!PUSH) continue;

  // A chain/* branch is bot-owned and recreated from the target's default
  // branch on every run — never rebased onto, never force-pushed over someone
  // else's work.
  const cur = git(dest, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (cur !== BRANCH) execFileSync('git', ['checkout', '-B', BRANCH], { cwd: dest, stdio: 'inherit' });
  execFileSync('git', ['add', '-A'], { cwd: dest, stdio: 'inherit' });
  const msg = `Sync ${edge.carries} from ${chain.repos[ME].repo}\n\n`
    + `Propagated along the ${ME} → ${edge.to} edge declared in chain/chain.json.\n`
    + `Generated by tools/chain-propagate.mjs — do not hand-edit the mirrored files;\n`
    + `edit them in ${fullName(ME, chain)} and re-run the mirror.\n\n`
    + `${chain.propagation.trailerPrefix}: ${chain.repos[ME].repo}@${sourceSha}\n`;
  execFileSync('git', ['commit', '-m', msg], { cwd: dest, stdio: 'inherit' });
  execFileSync('git', ['push', '-u', 'origin', BRANCH], { cwd: dest, stdio: 'inherit' });
  console.log(`push  ${label}: ${BRANCH}`);
}

console.log(`\n${staged} edge(s) staged, ${skipped} skipped.`);
if (staged && !PUSH && !DRY) console.log('Re-run with --push to commit and push, or review the sibling checkouts first.');
