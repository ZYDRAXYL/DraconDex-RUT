// chained-supporter's executable: what moved in the other six repos since this
// one last looked.
//
//   node tools/chain-survey.mjs           survey
//   node tools/chain-survey.mjs --mark    record what you saw (AFTER work lands)
//   node tools/chain-survey.mjs --json    machine-readable
//
// Uses `git ls-remote`, not the GitHub API: it needs no token beyond the
// credentials git already has, it is one round trip per peer, and it works
// identically for a private repo. The cost is that it sees refs, not commit
// messages — which is the right trade for a pre-work survey, where "did SDB
// move, and is there a newer tag" is the whole question.
import { execFileSync } from 'node:child_process';
import { loadChain, repoRoot, selfKey, upstreamOf, downstreamOf, readSyncState, writeSyncState } from './chain-lib.mjs';

const ROOT = repoRoot();
const chain = loadChain(ROOT);
const ME = selfKey(chain);
const args = process.argv.slice(2);
const MARK = args.includes('--mark');
const JSON_OUT = args.includes('--json');

const up = new Set(upstreamOf(ME, chain).map(e => e.from));
const down = new Set(downstreamOf(ME, chain).map(e => e.to));
const state = readSyncState(ROOT, chain);

function lsRemote(key) {
  const url = `https://github.com/${chain.org}/${chain.repos[key].repo}`;
  // One call gets HEAD and every tag. --tags alone omits HEAD, so ask for both.
  const out = execFileSync('git', ['ls-remote', '--heads', '--tags', url], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  });
  let head = null; const tags = [];
  for (const line of out.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!sha || !ref) continue;
    if (ref === 'refs/heads/main') head = sha;
    // ^{} entries are the dereferenced target of an annotated tag; the tag
    // name is the same, so skipping them avoids listing every tag twice.
    else if (ref.startsWith('refs/tags/') && !ref.endsWith('^{}')) tags.push(ref.slice(10));
  }
  return { head, tags };
}

/** Newest tag in this repo's own namespace — never "the newest tag overall",
 *  which in a shared mirror is whichever product published last. */
function newestTag(tags, pattern) {
  if (!pattern || pattern === 'mirror') return null;
  const prefix = pattern.replace(/\*$/, '');
  const mine = tags.filter(t => t.startsWith(prefix));
  if (!mine.length) return null;
  const num = t => t.slice(prefix.length).split('.').map(n => parseInt(n, 10) || 0);
  return mine.sort((a, b) => {
    const [A, B] = [num(a), num(b)];
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      if ((A[i] || 0) !== (B[i] || 0)) return (B[i] || 0) - (A[i] || 0);
    }
    return 0;
  })[0];
}

const peers = Object.keys(chain.repos).filter(k => k !== ME);
const results = [];

for (const key of peers) {
  const prev = state.repos?.[key] || {};
  let cur;
  try { cur = lsRemote(key); }
  catch (e) {
    // Unreadable is NOT unchanged. Saying "fine" about a repo we could not read
    // is worse than not surveying at all, because the caller then builds on it.
    results.push({ key, status: 'unknown', reason: (e.message || '').split('\n')[0].slice(0, 120) });
    continue;
  }
  const tag = newestTag(cur.tags, chain.repos[key].releases);
  const moved = prev.head ? prev.head !== cur.head : true;
  results.push({
    key,
    status: prev.head ? (moved ? 'moved' : 'unchanged') : 'first-survey',
    head: cur.head, prevHead: prev.head || null,
    tag, prevTag: prev.tag || null,
    newTag: tag && prev.tag && tag !== prev.tag ? tag : (tag && !prev.tag ? tag : null),
  });
}

const rank = k => (up.has(k) ? 0 : down.has(k) ? 1 : 2);
results.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));

if (JSON_OUT) {
  console.log(JSON.stringify({ self: ME, surveyedAt: new Date().toISOString(), peers: results }, null, 2));
} else {
  const when = state.surveyedAt ? `last surveyed ${state.surveyedAt}` : 'never surveyed before';
  console.log(`Chain survey (${ME}, ${when})`);
  for (const r of results) {
    const mark = up.has(r.key) ? '↑' : down.has(r.key) ? '↓' : '·';
    const short = s => (s ? s.slice(0, 7) : '—');
    if (r.status === 'unknown')      console.log(`  ${mark} ${r.key.padEnd(4)} UNKNOWN   could not read: ${r.reason}`);
    else if (r.status === 'unchanged') console.log(`  ${mark} ${r.key.padEnd(4)} unchanged`);
    else {
      const label = r.status === 'first-survey' ? 'FIRST' : 'MOVED';
      let line = `  ${mark} ${r.key.padEnd(4)} ${label.padEnd(9)} ${short(r.head)}`;
      if (r.prevHead) line += ` (was ${short(r.prevHead)})`;
      if (r.tag) line += `  tag ${r.tag}${r.prevTag && r.prevTag !== r.tag ? ` (was ${r.prevTag})` : ''}`;
      console.log(line);
    }
  }
  const blocking = results.filter(r => up.has(r.key) && (r.status === 'moved' || r.status === 'first-survey'));
  const unknown = results.filter(r => r.status === 'unknown');
  console.log('');
  if (unknown.length) console.log(`  ! ${unknown.map(r => r.key).join(', ')} could not be read — treat as unknown, not as unchanged.`);
  if (blocking.length) console.log(`  → upstream moved: ${blocking.map(r => r.key).join(', ')}. Check for an open chained-update PR before doing this by hand.`);
  else if (!unknown.length) console.log('  → nothing upstream blocks this work.');
}

if (MARK) {
  state.self = ME;
  state.surveyedAt = new Date().toISOString();
  state.repos = state.repos || {};
  for (const r of results) {
    if (r.status === 'unknown') continue;   // never record a peer we could not read
    state.repos[r.key] = { head: r.head, tag: r.tag || null, seenAt: state.surveyedAt };
  }
  console.log(`\nmarked: ${writeSyncState(state, ROOT, chain)}`);
}
