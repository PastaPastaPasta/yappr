/**
 * Derive a runnable subset of a corpus, preserving line numbers.
 *
 * Blanks out (a) ops whose author — or follow target — has not reached the
 * given ledger state, (b) ops whose type is excluded by --types, and (c) any
 * op whose referenced target is neither already on chain (per the seeder's
 * checkpoint) nor kept earlier in this same file. Line numbers are PRESERVED
 * as blank lines, so the seeder's checkpoint stays valid and a later run of
 * the FULL corpus still picks up everything that was blanked here.
 *
 *   node scripts/seed/filter-corpus-to-ledger.mjs <corpus.jsonl> <out.jsonl> \
 *     [--min-state ready] [--types post,quote] [--limit N]
 */
import fs from 'node:fs';
import { PROGRESS_FILE, loadLedger, stateRank } from './seed-lib.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const [input, output] = argv.filter((a, i) => !a.startsWith('--') && !String(argv[i - 1] ?? '').startsWith('--'));
if (!input || !output) {
  throw new Error('usage: filter-corpus-to-ledger.mjs <corpus.jsonl> <out.jsonl> [--min-state ready] [--types a,b] [--limit N]');
}
const minState = flag('min-state', 'ready');
const types = flag('types') ? new Set(flag('types').split(',').map((t) => t.trim())) : null;
const limit = flag('limit') ? Number(flag('limit')) : Infinity;

const ledger = loadLedger();
const ok = new Set(
  ledger.identities.filter((e) => stateRank(e.state) >= stateRank(minState) && e.identityId).map((e) => e.personaIdx)
);

/** Refs the seeder has already materialized on chain, and the lines that did it. */
const known = new Set();
const doneLines = new Set();
if (fs.existsSync(PROGRESS_FILE)) {
  for (const line of fs.readFileSync(PROGRESS_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.status !== 'done') continue;
      doneLines.add(row.line);
      if (row.ref) known.add(row.ref);
    } catch { /* partial trailing write */ }
  }
}

const depsOf = (op) => {
  const deps = [op.quotedRef, op.rootRef, op.parentRef, op.targetRef].filter(Boolean);
  for (const m of String(op.content ?? '').matchAll(/\{\{link:([A-Za-z0-9_-]+)\}\}/g)) deps.push(m[1]);
  return deps;
};

const lines = fs.readFileSync(input, 'utf8').split('\n');
const kept = new Set();
let n = 0;
const out = lines.map((line, i) => {
  if (!line.trim() || n >= limit) return '';
  // Lines the checkpoint already completed are no-ops for the seeder; blanking
  // them makes --limit count ops that will actually be broadcast.
  if (doneLines.has(i + 1)) return '';
  const op = JSON.parse(line);
  if (!ok.has(op.author)) return '';
  if (op.type === 'follow' && !ok.has(op.target)) return '';
  if (types && !types.has(op.type)) return '';
  if (!depsOf(op).every((d) => known.has(d) || kept.has(d))) return '';
  if (op.ref) kept.add(op.ref);
  n += 1;
  return line;
});
fs.writeFileSync(output, out.join('\n'));
console.log(
  `kept ${n} pending op(s)${types ? ` of type ${[...types].join('/')}` : ''} ` +
  `(authors at >= ${minState}: ${ok.size}, lines already done: ${doneLines.size}); line numbers preserved`
);
