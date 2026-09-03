/**
 * Blank out corpus ops whose author (or follow target) is not yet in the given
 * ledger state, plus every op that depends on a blanked ref. Line numbers are
 * PRESERVED (blank lines), so the seeder's checkpoint stays valid when the
 * full corpus is run later.
 *
 *   node scripts/seed/filter-corpus-to-ledger.mjs <corpus.jsonl> <out.jsonl> [--min-state ready]
 */
import fs from 'node:fs';
const [input, output] = process.argv.slice(2);
const minState = process.argv.includes('--min-state') ? process.argv[process.argv.indexOf('--min-state') + 1] : 'ready';
if (!input || !output) throw new Error('usage: filter-corpus-to-ledger.mjs <corpus.jsonl> <out.jsonl> [--min-state ready]');
const ledger = JSON.parse(fs.readFileSync('.seed-identities.local.json', 'utf8'));
const rank = { planned: 0, funded: 1, locked: 2, registered: 3, profiled: 4, named: 5, ready: 6 };
const ok = new Set(ledger.identities.filter((e) => rank[e.state] >= rank[minState] && e.identityId).map((e) => e.personaIdx));
const lines = fs.readFileSync(input, 'utf8').split('\n');
const dropped = new Set();
let kept = 0;
const out = lines.map((ln) => {
  if (!ln.trim()) return '';
  const j = JSON.parse(ln);
  const deps = [j.quotedRef, j.rootRef, j.parentRef, j.targetRef].filter(Boolean);
  for (const m of String(j.content ?? '').matchAll(/\{\{link:([A-Za-z0-9_-]+)\}\}/g)) deps.push(m[1]);
  const bad = !ok.has(j.author) || (j.type === 'follow' && !ok.has(j.target)) || deps.some((d) => dropped.has(d));
  if (bad) { if (j.ref) dropped.add(j.ref); return ''; }
  kept += 1;
  return ln;
});
fs.writeFileSync(output, out.join('\n'));
console.log(`kept ${kept} ops (authors at >= ${minState}: ${ok.size}); line numbers preserved`);
