/**
 * Blogs: `blog` (zlib-compressed themeConfig), `blogPost` (real BlockNote block arrays, zlib-compressed and chunked
 * into data0–data3 exactly like lib/services/blog-post-service.ts), `blogComment` (1 YAPP each through the cross-
 * contract tokenCost on the social contract, `blogPostOwnerId` bound to the post's `$ownerId`) and `blogFollow`
 * (unevenly distributed so "Most followed" and "Trending today" have a clear leader). A few posts are EDITED after
 * creation so the replace path (frozen `blogId`/`publishedAt`) is exercised. Article bodies are generated from a fragment bank into
 * a small markdown dialect and converted to blocks here — the converter is what the app will read back, so it stays
 * faithful even though the prose is synthetic.
 */
import { zlibSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { COLD_BUCKET, id32, normalizeId, reportSelfTest } from '../../battery-lib.mjs';
import { YAPP_TOKEN_POSITION, describeErr } from '../seed-lib.mjs';
import {
  actorsFor, counts, createDocWriter, createRecorder, ensureTokens, entropySource, envValue, groupTasks, loadCheckpoint,
  network, phaseRunner, pick, printTable, rngFrom, runByActor, shuffled, utf8,
} from '../feature-seed-lib.mjs';

/**
 * Labels as the target blog cut stores them: blog v4 (4.2.0-beta.4) a typed
 * list of at most 64 (blog) / 16 (post) labels of 1-40 characters; v1-v3 the
 * comma-separated string. Chosen by NEXT_PUBLIC_BLOG_TOPOLOGY, like the app.
 */
const labelsTyped = () => envValue('NEXT_PUBLIC_BLOG_TOPOLOGY') === 'v4';
const labelList = (csv) => [...new Set(csv.split(',').map((label) => label.trim()).filter(Boolean))];
const storedLabels = (csv) => (labelsTyped() ? labelList(csv) : csv);
const TYPED_LABEL_LIMITS = { blog: 64, post: 16, length: 40 };

/** YAPP a single blogComment create costs (contract tokenCost.create.amount). */
const COMMENT_COST = 1n;
/** Compressed-content ceiling and chunk width the app enforces (lib/constants.ts). */
const CHUNK_SIZE = 5120;
const MAX_CHUNKS = 4;
const POST_SIZE_LIMIT = 16384;
/** The daily grid `followersByDay` buckets on (contract timeRange range/step). */
const DAY_GRID = { range: 86400, step: 86400 };
/** Contract maxLengths the plan is validated against before any network I/O. */
const LIMITS = { blogName: 64, blogDescription: 256, blogLabels: 1024, image: 256, postTitle: 128, postSubtitle: 256, postLabels: 256, postSlug: 63, comment: 500, themeBytes: 5000 };

const rngInt = (rng, max) => Math.floor(rng() * max);
/** `count` distinct members of `list`, without replacement. */
function sample(rng, list, count) {
  const pool = [...list];
  const out = [];
  while (out.length < count && pool.length > 0) out.push(...pool.splice(rngInt(rng, pool.length), 1));
  return out;
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
const TEXT_DEFAULTS = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Deterministic nanoid-shaped block id (BlockNote ids are opaque strings). */
function blockId(key) {
  const d = sha256(utf8(key));
  let out = '';
  for (let i = 0; i < 10; i++) out += ID_ALPHABET[d[i] % ID_ALPHABET.length];
  return out;
}

function inlineContent(text) {
  const out = [];
  const push = (value, styles) => { if (value) out.push({ type: 'text', text: value, styles }); };
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    push(text.slice(cursor, match.index), {});
    const token = match[0];
    if (token.startsWith('**')) push(token.slice(2, -2), { bold: true });
    else if (token.startsWith('`')) push(token.slice(1, -1), { code: true });
    else if (token.startsWith('[')) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      out.push({ type: 'link', href, content: [{ type: 'text', text: label, styles: {} }] });
    } else push(token.slice(1, -1), { italic: true });
    cursor = match.index + token.length;
  }
  push(text.slice(cursor), {});
  return out.length > 0 ? out : [{ type: 'text', text: '', styles: {} }];
}

/** The block one dialect line produces, or `null` when it is prose for the current paragraph. */
function singleLineBlock(trimmed) {
  const heading = /^(#{2,3})\s+(.*)$/.exec(trimmed);
  if (heading) return { type: 'heading', props: { ...TEXT_DEFAULTS, level: heading[1].length, isToggleable: false }, content: inlineContent(heading[2]) };
  if (trimmed === '***') return { type: 'divider', props: { ...TEXT_DEFAULTS, variant: 'fade' } };
  if (trimmed === '[toc]') return { type: 'tableOfContents', props: { ...TEXT_DEFAULTS } };
  if (trimmed.startsWith('> ')) return { type: 'quote', props: { textColor: 'default', backgroundColor: 'default' }, content: inlineContent(trimmed.slice(2)) };
  const bullet = /^-\s+(.*)$/.exec(trimmed);
  if (bullet) return { type: 'bulletListItem', props: { ...TEXT_DEFAULTS }, content: inlineContent(bullet[1]) };
  const numbered = /^\d+\.\s+(.*)$/.exec(trimmed);
  if (numbered) return { type: 'numberedListItem', props: { ...TEXT_DEFAULTS }, content: inlineContent(numbered[1]) };
  return null;
}

/** Parse the dialect into a BlockNote block array. `key` seeds the block ids. */
function blocksFromMarkdown(markdown, key) {
  const lines = markdown.replace(/^\n+|\n+$/g, '').split('\n');
  const blocks = [];
  const emit = (block) => blocks.push({ id: blockId(`${key}#${blocks.length}`), children: [], ...block });
  const paragraph = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    emit({ type: 'paragraph', props: { ...TEXT_DEFAULTS }, content: inlineContent(paragraph.join(' ')) });
    paragraph.length = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') { flush(); continue; }
    if (trimmed.startsWith('~~~')) {
      flush();
      const language = trimmed.slice(3).trim() || 'bash';
      const code = [];
      for (i += 1; i < lines.length && lines[i].trim() !== '~~~'; i++) code.push(lines[i]);
      emit({ type: 'codeBlock', props: { ...TEXT_DEFAULTS, language, code: code.join('\n') } });
      continue;
    }
    if (trimmed.startsWith(':::')) {
      flush();
      const header = trimmed.slice(3).trim().split(/\s+(.*)/s);
      const body = [];
      for (i += 1; i < lines.length && lines[i].trim() !== ':::'; i++) body.push(lines[i].trim());
      emit({
        type: 'callout',
        props: { ...TEXT_DEFAULTS, variant: ['info', 'warning', 'tip', 'note'].includes(header[0]) ? header[0] : 'info', title: (header[1] ?? '').trim() },
        content: inlineContent(body.join(' ')),
      });
      continue;
    }
    const block = singleLineBlock(trimmed);
    if (block) { flush(); emit(block); continue; }
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

/** Words in a block array, for the dry-run table. Link nodes carry no text. */
const countWords = (blocks) => blocks.reduce((total, block) => total + (Array.isArray(block.content)
  ? block.content.map((node) => node.text ?? '').join(' ').split(/\s+/).filter(Boolean).length : 0), 0);

/** zlib-compress JSON the way lib/utils/compression.ts does. */
const compress = (value) => zlibSync(utf8(JSON.stringify(value)));

/** Split compressed bytes into the data0–data3 payload fields. */
function chunkFields(bytes) {
  const fields = {};
  let index = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE, index++) fields[`data${index}`] = bytes.slice(offset, offset + CHUNK_SIZE);
  return { fields, chunks: index };
}

const coverUrl = (seed) => `https://picsum.photos/seed/${seed}/1200/630`;

const THEMES = {
  paper: { colors: { bg: '#fbfaf7', text: '#2b2a27', accent: '#8a6a3b', heading: '#151412', link: '#7a4f1d', surface: '#f2efe8', border: '#e0dbd0' }, fonts: { body: 'source-serif-4', heading: 'playfair' }, layout: 'narrow', headerStyle: 'minimal', customCSS: 'line-height: 1.85; letter-spacing: 0.005em;', gradient: { type: 'solid', angle: 0, from: '#8a6a3b', to: 'transparent', opacity: 100 } },
  midnight: { colors: { bg: '#07070c', text: '#b8bfd0', accent: '#8b7fd6', heading: '#eef1f8', link: '#a99cf0', surface: '#11111c', border: '#22223a' }, fonts: { body: 'lora', heading: 'lora' }, layout: 'narrow', headerStyle: 'minimal', customCSS: 'line-height: 1.9;', gradient: { type: 'radial', angle: 0, from: '#8b7fd6', to: 'transparent', opacity: 60 } },
  terminal: { colors: { bg: '#0b1015', text: '#c3d0d9', accent: '#3fd07f', heading: '#f2fbf6', link: '#5ce39a', surface: '#121a21', border: '#1f2b34' }, fonts: { body: 'ibm-plex-sans', heading: 'jetbrains-mono' }, layout: 'wide', headerStyle: 'banner', customCSS: 'line-height: 1.7;', gradient: { type: 'linear', angle: 100, from: '#3fd07f', to: '#0b1015', opacity: 90 } },
  warm: { colors: { bg: '#fff8f0', text: '#3a2a20', accent: '#c25b2a', heading: '#2a1a12', link: '#a8451c', surface: '#fbecdd', border: '#edd9c4' }, fonts: { body: 'merriweather', heading: 'merriweather' }, layout: 'magazine', headerStyle: 'hero', customCSS: 'line-height: 1.8;', gradient: { type: 'linear', angle: 160, from: '#f0a868', to: 'transparent', opacity: 100 } },
  forest: { colors: { bg: '#0d1411', text: '#c4d3c8', accent: '#6fbf8a', heading: '#eff6f1', link: '#8fd6a6', surface: '#141f19', border: '#22322a' }, fonts: { body: 'inter', heading: 'space-grotesk' }, layout: 'wide', headerStyle: 'hero', customCSS: 'line-height: 1.75;', gradient: { type: 'linear', angle: 200, from: '#6fbf8a', to: '#0d1411', opacity: 80 } },
  slate: { colors: { bg: '#f4f6f8', text: '#25303a', accent: '#41708f', heading: '#0f1a22', link: '#2f5d7c', surface: '#e7ecf1', border: '#d2dae2' }, fonts: { body: 'ibm-plex-sans', heading: 'ibm-plex-sans' }, layout: 'narrow', headerStyle: 'minimal', customCSS: 'line-height: 1.7; letter-spacing: 0.01em;', gradient: { type: 'solid', angle: 0, from: '#41708f', to: 'transparent', opacity: 100 } },
  amber: { colors: { bg: '#15110c', text: '#ded2c0', accent: '#e0a338', heading: '#fdf6e8', link: '#f0bd5e', surface: '#1f1913', border: '#332a20' }, fonts: { body: 'space-grotesk', heading: 'space-grotesk' }, layout: 'magazine', headerStyle: 'banner', customCSS: 'line-height: 1.72;', gradient: { type: 'linear', angle: 135, from: '#e0a338', to: '#15110c', opacity: 100 } },
  neon: { colors: { bg: '#050510', text: '#cbd5e1', accent: '#22d3ee', heading: '#f8fafc', link: '#38bdf8', surface: '#0f172a', border: '#1e293b' }, fonts: { body: 'space-grotesk', heading: 'space-grotesk' }, layout: 'wide', headerStyle: 'hero', customCSS: 'line-height: 1.75;', gradient: { type: 'linear', angle: 135, from: '#22d3ee', to: '#0f172a', opacity: 100 } },
};

const BLOGS = [
  { key: 'runbook-diaries', owner: 281, name: 'Runbook Diaries', theme: 'terminal', subject: 'incidents', technical: true,
    labels: 'postmortems,databases,documentation,oncall,diagrams',
    description: 'Postmortems, diagrams, and documentation that survives contact with production. Written by someone who has been paged at 03:12 and has opinions about it.',
    posts: [
      ['the-postmortem-nobody-wanted-to-write', 'The Postmortem Nobody Wanted to Write', 'Four hours of downtime, one missing index, and a document that took longer than the fix.', 'postmortems,oncall', 'postmortem-terminal-glow'],
      ['write-the-runbook-before-the-outage', 'Write the Runbook Before the Outage', 'A runbook written during an incident is a transcript. A runbook written before it is a tool.', 'documentation,oncall', 'runbook-before-outage'],
      ['diagrams-that-survive-production', 'Diagrams That Survive Contact With Production', 'Most architecture diagrams are lies within a quarter. A few kinds are not.', 'diagrams,documentation', 'diagrams-survive-production'],
      ['we-benchmarked-the-wrong-thing', 'We Benchmarked the Wrong Thing for Nine Months', 'Our numbers were beautiful, reproducible, and about a code path nobody used.', 'databases,postmortems', 'benchmark-wrong-thing'],
      ['on-call-is-a-documentation-problem', 'On-Call Is a Documentation Problem', 'The rota is not the hard part. Knowing what to do is the hard part, and that is writing.', 'oncall,documentation', 'oncall-documentation-problem'],
      ['four-words-that-ruined-a-migration', 'Four Words That Ruined a Migration', '"Should be backwards compatible." Reader, it was not.', 'databases,postmortems', 'four-words-migration'],
      // `long` is load-bearing: it is the only post that compresses past one
      // 5120-byte chunk, so `data1` — and the app's reassembly path — is seeded.
      ['everything-i-know-about-migrations', 'Everything I Know About Migrations', 'The long one: fourteen years, roughly ninety schema migrations, and the checklist that came out of it.', 'databases,documentation,postmortems', 'everything-about-migrations', true],
    ] },
  { key: 'marginalia', owner: 280, name: 'Marginalia', theme: 'paper', subject: 'attention',
    labels: 'essays,attention,reading,libraries,memory',
    description: 'Weekly essays about attention, memory, and the machines we keep. Written slowly, on purpose, by a former librarian who still smells of card stock.',
    posts: [
      ['the-shape-of-a-reading-chair', 'The Shape of a Reading Chair', 'I bought a chair to fix my attention. The chair was innocent.', 'essays,attention', 'reading-chair-window'],
      ['what-the-card-catalogue-knew', 'What the Card Catalogue Knew', 'A drawer of index cards was a search engine with opinions, and it said them out loud.', 'libraries,memory,essays', 'card-catalogue-drawers'],
      ['attention-is-not-a-muscle', 'Attention Is Not a Muscle', 'The gym metaphor has been load-bearing for a decade and it cannot hold the weight.', 'attention,essays', 'attention-muscle-essay'],
      ['borrowed-light', 'Borrowed Light', 'On books you only understood because of who handed them to you.', 'essays,reading', 'borrowed-light-lamp'],
      ['an-inventory-of-interruptions', 'An Inventory of Interruptions', 'I wrote down every interruption for eleven days. The results were humiliating and useful.', 'attention,essays', 'inventory-interruptions-notebook'],
      ['the-long-way-round', 'The Long Way Round', 'In praise of the inefficient route, from someone who timed both.', 'essays,walking', 'long-way-round-path'],
    ] },
  { key: 'brine-and-crumb', owner: 282, name: 'Brine & Crumb', theme: 'warm', subject: 'bread',
    labels: 'baking,fermentation,recipes,markets',
    description: 'Bread, brine, and things that take all day, from one small kitchen in Leipzig. Every recipe tested at least three times, with the failures left in.',
    posts: [
      ['a-starter-that-forgives-you', 'A Starter That Forgives You', 'Six weeks of neglect, one revival, and why your starter is much harder to kill than the internet says.', 'baking,fermentation', 'starter-forgives-jar'],
      ['the-only-bread-recipe-i-still-use', 'The Only Bread Recipe I Still Use', 'After nine years and roughly four hundred loaves, it fits on an index card.', 'baking,recipes', 'only-bread-recipe-loaf'],
      ['salt-time-and-cabbage', 'Salt, Time, and Cabbage', 'Sauerkraut is two ingredients and one decision, and the decision is not the salt.', 'fermentation,recipes', 'salt-time-cabbage-crock'],
      ['my-fourth-attempt-at-rye', 'My Fourth Attempt at Rye', 'Three bricks and one loaf. Here is exactly what changed.', 'baking,recipes', 'fourth-attempt-rye-crumb'],
      ['cast-iron-and-the-myth-of-seasoning', 'Cast Iron and the Myth of Seasoning', 'You cannot ruin it with soap, and you probably are not heating it long enough.', 'markets,recipes', 'cast-iron-myth-pan'],
      ['what-to-do-with-a-failed-loaf', 'What to Do With a Failed Loaf', 'Six uses for bread that went wrong, ranked by how much they hide the evidence.', 'baking,recipes', 'failed-loaf-uses'],
    ] },
  { key: 'bit-rot-quarterly', owner: 284, name: 'Bit Rot Quarterly', theme: 'slate', subject: 'archives', technical: true,
    labels: 'archives,formats,preservation,storage',
    description: 'Notes from twelve years of digital preservation. Formats rot, checksums lie, and everyone thinks their backup works. Occasional tables, frequent gentle doom.',
    posts: [
      ['your-backup-does-not-work', 'Your Backup Does Not Work', 'Of 41 restores I have personally attempted from other people’s backups, 12 failed outright.', 'preservation,storage', 'backup-does-not-work'],
      ['twelve-years-of-file-formats', 'Twelve Years of File Formats', 'Which ones I can still open, which ones I cannot, and what the pattern turned out to be.', 'formats,preservation', 'twelve-years-formats'],
      ['checksums-lie-politely', 'Checksums Lie Politely', 'A verified checksum tells you less than almost everyone assumes.', 'preservation,storage', 'checksums-lie-politely'],
      ['the-cost-of-keeping-everything', 'The Cost of Keeping Everything', 'Storage is cheap. Everything around the storage is not, and here are the actual proportions.', 'storage,preservation', 'cost-keeping-everything'],
      ['cold-storage-is-a-promise', 'Cold Storage Is a Promise', 'Tape, optical, and object tiers, judged by the only thing that matters: getting it back.', 'storage,preservation', 'cold-storage-promise'],
    ] },
  { key: 'monsoon-notes', owner: 283, name: 'Monsoon Notes', theme: 'forest', subject: 'the Ghats',
    labels: 'hiking,maps,monsoon,trains,ghats',
    description: 'Field notes from the long paths of the Western Ghats: distances, altitudes, bus timetables, and weather that does not negotiate. Written down before I forget it.',
    posts: [
      ['three-days-above-munnar', 'Three Days Above Munnar', '41 km, two ridges, one tea estate that fed me without being asked.', 'hiking,ghats', 'three-days-munnar-ridge'],
      ['the-bus-that-is-not-on-any-map', 'The Bus That Is Not on Any Map', 'How to find transport in the Ghats when no timetable, app, or website admits it exists.', 'trains,ghats', 'bus-not-on-map'],
      ['walking-in-the-first-rain', 'Walking in the First Rain', 'The monsoon does not arrive gradually. It arrives at a particular hour and you remember where you were.', 'monsoon,hiking', 'first-rain-walking'],
      ['a-map-is-a-rumour', 'A Map Is a Rumour', 'Four sources, all disagreeing, and how I decide which to believe.', 'maps,hiking', 'map-is-a-rumour'],
      ['leech-season', 'Leech Season', 'Everything I know about them after six monsoons, none of it dramatic.', 'monsoon,hiking', 'leech-season-boots'],
    ] },
  { key: 'shavings', owner: 285, name: 'Shavings', theme: 'amber', subject: 'the workshop',
    labels: 'woodworking,tools,business,shipping',
    description: 'A furniture shop and a software shop, run out of the same head. Joinery, invoices, dull chisels, and what a workshop teaches you about shipping things.',
    posts: [
      ['the-first-drawer-i-did-not-throw-away', 'The First Drawer I Did Not Throw Away', 'Eleven attempts at a dovetailed drawer, and the one thing that changed on the twelfth.', 'woodworking,tools', 'first-drawer-dovetails'],
      ['measure-twice-ship-once', 'Measure Twice, Ship Once', 'The workshop proverb is about irreversibility, and software mostly is not — except where it is.', 'shipping,business', 'measure-twice-ship-once'],
      ['what-a-dull-chisel-teaches-you', 'What a Dull Chisel Teaches You About Deadlines', 'I timed the sharpening. It costs four minutes and saves about forty.', 'tools,shipping', 'dull-chisel-deadlines'],
      ['pricing-a-table', 'Pricing a Table', 'Four years of getting this wrong, and the arithmetic I use now.', 'business,woodworking', 'pricing-a-table'],
      ['the-workshop-as-a-build-system', 'The Workshop as a Build System', 'Jigs are cached artefacts, offcuts are technical debt, and the bench is your working directory.', 'shipping,tools', 'workshop-build-system'],
    ] },
  { key: 'quiet-hours', owner: 280, name: 'The Quiet Hours', theme: 'midnight', subject: 'the night',
    labels: 'notes,night,walking,insomnia',
    description: 'A small second notebook for the hours nobody schedules: four in the morning, the walk before work, the bakery light. Shorter than the essays and less sure of itself.',
    posts: [
      ['four-am-is-a-country', 'Four AM Is a Country', 'It has its own weather, its own citizens, and no useful exports.', 'night,notes', 'four-am-street-lamp'],
      ['walking-the-same-loop-for-a-year', 'Walking the Same Loop for a Year', 'Three point one kilometres, four hundred times, and it never once repeated.', 'walking,notes', 'same-loop-year-path'],
      ['notes-on-not-sleeping', 'Notes on Not Sleeping', 'What eleven years of intermittent insomnia has actually taught me, minus the advice.', 'insomnia,notes', 'not-sleeping-ceiling'],
      ['the-bakery-light', 'The Bakery Light', 'Six hundred metres away, on at three forty, and the only proof I have that the day is coming.', 'night,notes', 'bakery-light-window'],
    ] },
  { key: 'devnet-desk', owner: 210, name: 'The Devnet Desk', theme: 'neon', subject: 'the devnet', technical: true,
    labels: 'devnet,proofs,contracts,notes',
    description: 'Notes from the edge of a test network: proofs, count trees, contract cutovers, and the specific ways a devnet lies to you before it tells the truth.',
    posts: [
      ['reading-a-proof-without-crying', 'Reading a Proof Without Crying', 'A field guide to the four error messages you will actually see.', 'proofs,devnet', 'reading-proof-without-crying'],
      ['what-a-count-tree-actually-counts', 'What a Count Tree Actually Counts', 'One request instead of a hundred, with three conditions nobody tells you.', 'contracts,proofs', 'count-tree-actually-counts'],
      ['notes-from-a-contract-cutover', 'Notes From a Contract Cutover', 'Repointing an id is not a migration, and pretending otherwise costs a day.', 'contracts,devnet', 'notes-contract-cutover'],
      ['the-week-the-index-lied', 'The Week the Index Lied', 'The count was wrong. The count is never wrong. The count was wrong.', 'proofs,contracts', 'week-the-index-lied'],
    ] },
].map((blog) => ({ ...blog, posts: blog.posts.map(([slug, title, subtitle, labels, cover, long]) => ({ slug, title, subtitle, labels, cover, long })) }));

/** Persona indexes that read, comment, and follow but own no blog. */
const AUDIENCE = [211, 212];
/** Posts published without a `publishedAt`, which the app badges as drafts. */
const DRAFTS = new Set(['quiet-hours/the-bakery-light', 'devnet-desk/the-week-the-index-lied']);
/** Posts written with `commentsEnabled: false`. */
const COMMENTS_OFF = new Set(['marginalia/an-inventory-of-interruptions']);
/** Posts deliberately given a long thread so "most discussed" ranks meaningfully. */
const HOT_POSTS = new Map([
  ['runbook-diaries/the-postmortem-nobody-wanted-to-write', 8],
  ['bit-rot-quarterly/your-backup-does-not-work', 7],
  ['brine-and-crumb/the-only-bread-recipe-i-still-use', 6],
  ['runbook-diaries/we-benchmarked-the-wrong-thing', 5],
]);
/** Followers per blog, uneven on purpose: runbook-diaries leads both rankings. */
const FOLLOWERS = {
  'runbook-diaries': [280, 282, 283, 284, 285, 210, 211, 212],
  'bit-rot-quarterly': [280, 281, 282, 283, 285, 210, 211],
  marginalia: [281, 282, 283, 284, 211, 212],
  'brine-and-crumb': [280, 281, 283, 284, 211],
  'monsoon-notes': [280, 281, 282, 211, 212],
  shavings: [281, 282, 284, 211],
  'devnet-desk': [281, 284, 211],
  'quiet-hours': [211, 212],
};
/** Posts edited after creation, exercising the replace path; blog v3 keeps no revision history. */
const EDITS = new Map([
  ['marginalia/borrowed-light', 'author adds a closing section and a corrected attribution'],
  ['runbook-diaries/the-postmortem-nobody-wanted-to-write', 'follow-up section added after the review meeting'],
  ['brine-and-crumb/my-fourth-attempt-at-rye', 'baker corrects the treacle quantity and adds a reader fix'],
  ['bit-rot-quarterly/your-backup-does-not-work', 'archivist updates the counts after another restore attempt'],
]);

const FRAGMENTS = {
  open: ['For two years I believed the problem was equipment. It was not, and finding that out cost more than the equipment did.',
    'This started as a note to myself and turned into the thing I send people instead of explaining it again.',
    'I kept a record for eleven days, mostly out of spite, and the record turned out to be the whole argument.'],
  claim: ['The useful part was not the answer. It was that the failure became **legible** — I could finally see what I was doing.',
    'What changed was not effort. It was *arrangement*: the same work, in a different order, with the expensive step first.',
    'Most of what looks like discipline is furniture, and most of what looks like weakness is a notification you did not choose.'],
  detail: ['I did not trust the result, so I ran it again with the same inputs on a different day. Same shape, slightly worse numbers.',
    'There is a particular kind of honesty available only after you have spent money on the wrong solution.',
    'None of this generalises cleanly. The thresholds move with temperature, scale, and how tired you are when you start.',
    'The part people skip is the boring middle, which is also where every case I have seen actually went wrong.'],
  bullets: ['**Write it before you need it.** A note taken calmly is worth five taken in a panic.',
    '**Keep the failures in.** A record that only lists successes cannot be used to predict anything.',
    '**Measure the thing you complain about**, not the thing that is easy to measure.',
    '**Name the version.** Half of all disagreements about `{subject}` are two people describing different versions of it.',
    '**Leave a way back.** The step you cannot undo deserves twice the attention of the four before it.',
    '**Ask someone who disagrees.** They will find the hole in four minutes and you will not find it in four days.'],
  steps: ['Write down what you expect to happen, in one sentence, before you start.',
    'Do the smallest version that can actually fail, and let it.',
    'Record what the result was, including the bits that embarrassed you.',
    'Change exactly one variable and repeat until the shape stops moving.'],
  quotes: ['A ranked list tells you what it thinks you asked for. A drawer tells you where you are.',
    'Everything has maintenance. This version just has less of it than the one you were about to ask for.',
    'The instrument was fine. The question was wrong.'],
  callouts: [['tip', 'What I would do differently', 'Start with the boring inventory. Two hours, and it removes half the guessing that follows.'],
    ['warning', 'The failure mode to watch', 'It looks like success right up until the moment you need the thing, which is the worst time to find out.'],
    ['note', 'What I tried first', 'The obvious solution, twice, with more effort the second time. It did not work either time.']],
  code: [['bash', 'set -euo pipefail\n# restore into a scratch volume, never over the original\nrestore --from "$SNAPSHOT" --to /mnt/scratch\ndiff -r /mnt/scratch/manifest /var/lib/manifest'],
    ['sql', '-- the index that was missing, and the query that noticed\nEXPLAIN ANALYZE\nSELECT id FROM events WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 50;'],
    ['javascript', "// the count is over the index entries, not the documents you can read\nconst total = await sdk.documents.count({ documentTypeName: 'post', where });\nconsole.log(total.get(''));"]],
  close: ['So that is where it stands. It works about seventy percent of the time, which is worse than the advice promises and better than it has ever delivered.',
    'If you try it, I would like to know where it breaks — the interesting failures are the ones I did not plan for. Notes to [the usual place](https://yap.pr/devnet).',
    'None of this is a method. It is a habit that survived a bad month, which is the only recommendation I can give anything.'],
  headings: ['Where it breaks', 'What I actually do now', 'A short taxonomy', 'The part that helped', 'What the numbers said', 'The boring checklist'],
};

/**
 * One article in the dialect. Deterministic in the post key, and shaped so the corpus exercises every block type the
 * app's schema defines.
 */
function articleFor(post, blog) {
  const rng = rngFrom(`article/${post.key}`);
  const of = (list) => pick(rng, list);
  const fill = (text) => text.replaceAll('{subject}', blog.subject).replaceAll('{title}', post.title);
  const headings = shuffled(rng, FRAGMENTS.headings);
  const [variant, title, body] = of(FRAGMENTS.callouts);
  const lines = [];
  // Technical blogs always publish a contents block and a code fence; the rest
  // draw for the contents block, so both branches appear across the corpus.
  if (blog.technical || rng() < 0.5) lines.push('[toc]', '');
  lines.push(fill(of(FRAGMENTS.open)), '', fill(of(FRAGMENTS.detail)), '');
  // A `long` post repeats the body cycle until it is past one 5120-byte chunk.
  for (let pass = 0; pass < (post.long ? 22 : 1); pass++) {
    lines.push(`## ${headings[pass * 2 % headings.length]}`, '', fill(of(FRAGMENTS.claim)), '', fill(of(FRAGMENTS.detail)), '');
    for (const bullet of sample(rng, FRAGMENTS.bullets, 4)) lines.push(`- ${fill(bullet)}`);
    lines.push('', `## ${headings[(pass * 2 + 1) % headings.length]}`, '', fill(of(FRAGMENTS.detail)), '');
    sample(rng, FRAGMENTS.steps, 3).forEach((step, index) => lines.push(`${index + 1}. ${fill(step)}`));
    lines.push('', `> ${fill(of(FRAGMENTS.quotes))}`, '');
  }
  lines.push(`:::${variant} ${title}`, body, ':::', '');
  if (blog.technical) {
    const [language, source] = of(FRAGMENTS.code);
    lines.push(`### ${headings[2]}`, '', `Run it against a copy first — \`${language}\` is unforgiving about the order.`, '', `~~~${language}`, source, '~~~', '');
  }
  lines.push('***', '', fill(of(FRAGMENTS.close)));
  return lines.join('\n');
}

/** The appended section an edited post gains, so its revision differs visibly. */
const editBodyFor = (post) => `\n***\n\n## Update\n\n${EDITS.get(post.key)}. `
  + 'The original paragraph is left in above, because a correction that hides what it corrects is not a correction.\n';

const FIRST_NAMES = { 210: 'Bea', 211: 'Rui', 212: 'Lou', 280: 'Nia', 281: 'Oz', 282: 'Pia', 283: 'Ravi', 284: 'Mei', 285: 'Tomás' };
const COMMENTS = {
  praise: ['This is the best thing I have read on the subject, and I have read a lot of bad things on the subject.',
    'Saved, printed, and pinned above my desk. Thank you {first}.',
    '{blog} is the only thing in my reader I open immediately. The last two paragraphs are worth the whole piece.'],
  question: ['Genuine question: how much of this transfers at a much smaller scale? Some of it feels like it needs a team to enforce.',
    'What would you change if you had to do it again from scratch?',
    'Do you have a number for how long this took? The post implies "a while" and I am trying to budget for it.'],
  addition: ['One thing I would add: the same failure shows up on the read path too, and it is much harder to see there because nothing alerts on it.',
    'Small addition from a different scale: the numbers hold up, but the ordering matters more than the post lets on. Step three before step two cost me a fortnight.',
    'For anyone trying this: the tool you need is cheaper than it looks, and the version that comes with everything is worse than the plain one.'],
  disagree: ['Respectfully, the third point overstates it. The failure is real but it is not the common case, and the fix has a cost the post does not price.',
    'I disagree with the conclusion and agree with everything leading up to it, which is a frustrating place to end up.',
    'Not sure about the second half. Everything before the divider I would sign my name to.'],
  story: ['This happened to me almost exactly, except nobody noticed for four months. The fix took twenty minutes and the explaining took a week.',
    'Had the same thing at a smaller scale and drew the wrong conclusion for two years. Reading this is slightly uncomfortable.',
    'I sent this to a colleague who has argued the opposite for six months. No response yet, which I choose to read as agreement.'],
  thanks: ['Thank you for leaving the failures in. Nobody does that.', 'The correction at the bottom is why I trust this blog.',
    'Bookmarking for the next time I have to explain this to someone.'],
  followup: ['Following up on the earlier comment about scale: I tried it at two people and it does work, as long as you write the notes down.',
    'Second the point above. The read path is where this bites and it is invisible until it is not.',
    'Coming back to say I tried this and it worked. Two weeks in, no regressions.'],
};
const COMMENT_INTENTS = ['praise', 'question', 'addition', 'disagree', 'story', 'thanks'];

/**
 * The whole run from the bank and the seed, with no network I/O — so `--dry-run` validates every field length and
 * chunk count before a single write.
 */
function buildPlan({ seed, only, publishAnchor }) {
  const rng = rngFrom(seed);
  const selected = only ? BLOGS.filter((blog) => only.includes(blog.key)) : BLOGS;
  if (selected.length === 0) throw new Error(`--only matched no blogs (known: ${BLOGS.map((b) => b.key).join(', ')})`);
  const blogs = [];
  const posts = [];
  const edits = [];
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  for (const blog of selected) {
    check(blog.name.length <= LIMITS.blogName, `${blog.key}: name exceeds ${LIMITS.blogName}`);
    check(blog.description.length <= LIMITS.blogDescription, `${blog.key}: description exceeds ${LIMITS.blogDescription}`);
    check(blog.labels.length <= LIMITS.blogLabels, `${blog.key}: labels exceed ${LIMITS.blogLabels}`);
    check(labelList(blog.labels).length <= TYPED_LABEL_LIMITS.blog && labelList(blog.labels).every((label) => label.length <= TYPED_LABEL_LIMITS.length),
      `${blog.key}: labels exceed the v4 typed-list bounds`);
    const theme = THEMES[blog.theme];
    check(Boolean(theme), `${blog.key}: unknown theme "${blog.theme}"`);
    const themeConfig = compress(theme ?? {});
    check(themeConfig.byteLength <= LIMITS.themeBytes, `${blog.key}: themeConfig is ${themeConfig.byteLength} bytes`);
    blogs.push({
      key: blog.key, owner: blog.owner, name: blog.name,
      data: {
        name: blog.name, description: blog.description, labels: storedLabels(blog.labels),
        headerImage: `https://picsum.photos/seed/${blog.key}-header/1600/500`,
        avatar: `https://picsum.photos/seed/${blog.key}-avatar/200/200`,
        themeConfig, commentsEnabledDefault: true,
      },
    });

    // Staggered publishedAt values so the newest post is recent and the archive
    // looks like an archive; $createdAt is block time and not ours to choose.
    // The anchor is checkpointed so a resume reproduces the same values.
    let daysBack = 3 + rngInt(rng, 6);
    for (const post of [...blog.posts].reverse()) {
      const key = `${blog.key}/${post.slug}`;
      const blocks = blocksFromMarkdown(articleFor({ ...post, key }, blog), key);
      const compressed = compress(blocks);
      const { fields, chunks } = chunkFields(compressed);
      check(post.title.length <= LIMITS.postTitle, `${key}: title exceeds ${LIMITS.postTitle}`);
      check((post.subtitle ?? '').length <= LIMITS.postSubtitle, `${key}: subtitle exceeds ${LIMITS.postSubtitle}`);
      check(post.slug.length <= LIMITS.postSlug, `${key}: slug exceeds ${LIMITS.postSlug} (${post.slug.length})`);
      check((post.labels ?? '').length <= LIMITS.postLabels, `${key}: labels exceed ${LIMITS.postLabels}`);
      check(labelList(post.labels ?? '').length <= TYPED_LABEL_LIMITS.post, `${key}: labels exceed the v4 typed-list bound`);
      check(coverUrl(post.cover).length <= LIMITS.image, `${key}: coverImage exceeds ${LIMITS.image}`);
      check(compressed.byteLength <= POST_SIZE_LIMIT, `${key}: compressed content is ${compressed.byteLength} bytes (max ${POST_SIZE_LIMIT})`);
      check(chunks >= 1 && chunks <= MAX_CHUNKS, `${key}: needs ${chunks} chunks (max ${MAX_CHUNKS})`);

      const commentsEnabled = !COMMENTS_OFF.has(key);
      const published = !DRAFTS.has(key);
      // Every blogPost field except the chunked payload; create and edit differ
      // only in their data0–dataN, so both spread this.
      const meta = {
        title: post.title, ...(post.subtitle ? { subtitle: post.subtitle } : {}), ...(post.labels ? { labels: storedLabels(post.labels) } : {}),
        coverImage: coverUrl(post.cover), commentsEnabled, slug: post.slug,
        ...(published ? { publishedAt: publishAnchor - daysBack * 86_400_000 } : {}),
      };
      posts.push({
        key, blogKey: blog.key, owner: blog.owner, slug: post.slug, title: post.title,
        words: countWords(blocks), chunks, bytes: compressed.byteLength, commentsEnabled, published, data: { ...meta, ...fields },
      });

      if (EDITS.has(key)) {
        const editedBlocks = blocksFromMarkdown(`${articleFor({ ...post, key }, blog)}\n${editBodyFor({ key })}`, `${key}@edit`);
        const editedBytes = compress(editedBlocks);
        const edited = chunkFields(editedBytes);
        check(editedBytes.byteLength <= POST_SIZE_LIMIT, `${key}@edit: compressed content is ${editedBytes.byteLength} bytes`);
        check(edited.chunks <= MAX_CHUNKS, `${key}@edit: needs ${edited.chunks} chunks`);
        edits.push({ key: `${key}@edit`, postKey: key, owner: blog.owner, note: EDITS.get(key), bytes: editedBytes.byteLength, data: { ...meta, ...edited.fields } });
      }
      daysBack += 4 + rngInt(rng, 9);
    }
  }

  // Comments: hot posts get long threads so `mostDiscussedPosts` ranks; the rest
  // get a realistic thin tail; drafts and comments-off posts get none.
  const everyone = [...new Set([...BLOGS.map((blog) => blog.owner), ...AUDIENCE])].sort((a, b) => a - b);
  const blogNames = new Map(blogs.map((blog) => [blog.key, blog.name]));
  const comments = [];
  for (const post of posts) {
    if (!post.commentsEnabled || !post.published) continue;
    const postRng = rngFrom(`comments:${post.key}`);
    const hot = HOT_POSTS.get(post.key);
    const count = hot ?? [0, 0, 1, 1, 1, 2, 2, 3][rngInt(postRng, 8)];
    if (count === 0) continue;
    const pool = everyone.filter((idx) => idx !== post.owner);
    const authors = sample(postRng, pool, Math.min(count, pool.length));
    for (let i = 0; i < count; i++) {
      // Late entries in a long thread answer the earlier ones.
      const intent = i >= 4 && postRng() < 0.6 ? 'followup' : pick(postRng, COMMENT_INTENTS);
      const content = pick(postRng, COMMENTS[i === 0 && hot ? 'praise' : intent])
        .replaceAll('{first}', FIRST_NAMES[post.owner] ?? 'there').replaceAll('{blog}', blogNames.get(post.blogKey) ?? '');
      check(content.length <= LIMITS.comment, `comment template exceeds ${LIMITS.comment} chars: ${content.slice(0, 60)}…`);
      comments.push({ key: `${post.key}#${i}`, postKey: post.key, author: authors[i % authors.length], content });
    }
  }

  const follows = [];
  for (const blog of blogs) {
    for (const follower of FOLLOWERS[blog.key] ?? []) {
      if (follower === blog.owner) continue;
      follows.push({ key: `${follower}@${blog.key}`, blogKey: blog.key, follower });
    }
  }
  if (problems.length > 0) throw new Error(`the article bank violates the contract:\n  ${problems.join('\n  ')}`);
  return { blogs, posts, edits, comments, follows };
}

const planPersonas = (plan) => [...new Set([...plan.blogs.map((b) => b.owner), ...plan.comments.map((c) => c.author), ...plan.follows.map((f) => f.follower)])];

async function run({ args, handle, battery, socialId, contractId }) {
  const state = loadCheckpoint(args.state, { network: network(), contractId }, { docs: {}, publishAnchor: Date.now() });
  const plan = buildPlan({ seed: args.seed, only: args.only, publishAnchor: state.publishAnchor });
  const writer = createDocWriter({ handle, contractId, entropyFor: entropySource(`yappr/blog-seed/${contractId}`), paymentInfo: battery.paymentInfo });
  const tokenId = await battery.readback(() => battery.sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));
  const actors = await actorsFor(battery, planPersonas(plan));
  const recorder = createRecorder({ writer, state, file: args.state });
  const { createDoc } = recorder;
  const phase = phaseRunner(args.concurrency);
  const blogIds = new Map();
  const postIds = new Map();
  const ownerOf = (postKey) => plan.posts.find((post) => post.key === postKey);
  /** A fresh checkpoint cannot have written anything, so resume-only probes are skipped. */
  const resumed = Object.keys(state.docs).length > 0;
  /** First row of a query, as a recorded id — the adoption probe for a doctype the id alone cannot recognise. */
  const firstId = async (docType, where, orderBy) => {
    const [found] = await battery.queryDocs(docType, { where, ...(orderBy ? { orderBy } : {}), limit: 1 });
    return found ? normalizeId(found.$id) : null;
  };

  if (!args.verifyOnly) {
    // One YAPP per comment, bought with credits when the maker transfer was
    // unavailable (the battery's documented fallback).
    const perAuthor = new Map();
    for (const comment of plan.comments) perAuthor.set(comment.author, (perAuthor.get(comment.author) ?? 0) + 1);
    await ensureTokens(battery, tokenId, actors, new Map([...perAuthor].map(([idx, count]) => [idx, BigInt(count) * COMMENT_COST])));

    // `blog` has NO unique index, so a deterministic id alone cannot recognise a
    // blog an earlier run — or the registration battery, which shares this
    // contract and owns persona 210 — already wrote. Match the owner's blogs by
    // name first, or the run produces duplicates.
    await phase(`blogs (${plan.blogs.length})`, plan.blogs, (blog) => blog.owner, async (blog) => {
      const actor = actors.get(blog.owner);
      const id = await createDoc(actor, 'blog', `blog:${blog.key}`, blog.data, {
        adopt: async () => {
          const owned = await battery.queryDocs('blog',
            { where: [['$ownerId', '==', actor.ownerId]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 100 });
          const found = owned.find((doc) => doc.name === blog.data.name);
          return found ? normalizeId(found.$id) : null;
        },
      });
      if (id) blogIds.set(blog.key, id);
    });
    // `blogAndSlug` is unique: adopt the existing row rather than earn a 40105,
    // which `createDocWriter` treats as a consensus refusal and rethrows.
    await phase(`posts (${plan.posts.length})`, plan.posts.filter((post) => blogIds.has(post.blogKey)), (post) => post.owner, async (post) => {
      const blogId = blogIds.get(post.blogKey);
      const id = await createDoc(actors.get(post.owner), 'blogPost', post.key, { blogId: id32(blogId), ...post.data },
        { adopt: () => firstId('blogPost', [['blogId', '==', blogId], ['slug', '==', post.slug]], [['blogId', 'asc'], ['slug', 'asc']]) });
      if (id) postIds.set(post.key, id);
    });

    // Follows, comments and edits all write against existing parents, so they
    // share one queue per signer.
    console.log(`--- follows (${plan.follows.length}), comments (${plan.comments.length}), edits (${plan.edits.length}) ---`);
    const tasks = new Map();
    // `ownerAndBlog` is unique, so the same 40105 applies to a repeat follow.
    groupTasks(plan.follows.filter((follow) => blogIds.has(follow.blogKey)), (follow) => follow.follower, (follow) =>
      createDoc(actors.get(follow.follower), 'blogFollow', `follow:${follow.key}`, { blogId: id32(blogIds.get(follow.blogKey)) },
        { adopt: () => firstId('blogFollow', [['$ownerId', '==', actors.get(follow.follower).ownerId], ['blogId', '==', blogIds.get(follow.blogKey)]]) }), tasks);
    // `blogComment` has no unique index either, and each one costs a YAPP and
    // moves the ranked commentCount axis, so a resumed run must recognise its own
    // by (post, author, content) rather than write a second.
    groupTasks(plan.comments.filter((comment) => postIds.has(comment.postKey)), (comment) => comment.author, (comment) =>
      createDoc(actors.get(comment.author), 'blogComment', `comment:${comment.key}`, {
        blogPostId: id32(postIds.get(comment.postKey)),
        // Must equal the post's $ownerId or consensus rejects (40127).
        blogPostOwnerId: id32(actors.get(ownerOf(comment.postKey).owner).ownerId),
        content: comment.content,
      }, {
        tokenCost: COMMENT_COST,
        adopt: resumed ? async () => {
          const written = await battery.queryDocs('blogComment', {
            where: [['blogPostId', '==', postIds.get(comment.postKey)]],
            orderBy: [['blogPostId', 'asc'], ['$createdAt', 'asc']], limit: 100,
          });
          const mine = written.find((doc) => normalizeId(doc.$ownerId) === actors.get(comment.author).ownerId && doc.content === comment.content);
          return mine ? normalizeId(mine.$id) : null;
        } : undefined,
      }), tasks);
    groupTasks(plan.edits.filter((edit) => postIds.has(edit.postKey)), (edit) => edit.owner, async (edit) => {
      if (recorder.id(edit.key)) return;
      const postId = postIds.get(edit.postKey);
      const current = await battery.fetchDocument('blogPost', postId);
      const revision = BigInt(current?.revision ?? 1);
      if (revision > 1n) { recorder.record(edit.key, postId, true); return; } // already edited by an earlier run
      // `blogId` and `publishedAt` are frozen; a replace that changes OR DROPS
      // either is a 40128, and so is adding one the stored draft does not have.
      // Mirror the stored value exactly, absence included.
      const stored = current?.toObject ? current.toObject() : current;
      const data = { ...edit.data, blogId: id32(blogIds.get(ownerOf(edit.postKey).blogKey)) };
      if ((stored?.publishedAt ?? null) === null) delete data.publishedAt;
      else data.publishedAt = Number(stored.publishedAt);
      const outcome = await battery.attemptReplace(actors.get(edit.owner), 'blogPost', postId, data, revision);
      if (outcome.ok) {
        recorder.record(edit.key, postId);
        console.log(`  ~ edited ${edit.postKey} (rev ${revision + 1n}, ${edit.bytes}B) — ${edit.note}`);
      } else recorder.fail(edit.key, 'blogPost', outcome.error);
    }, tasks);
    await runByActor(tasks, args.concurrency);
  } else {
    for (const blog of plan.blogs) if (recorder.id(`blog:${blog.key}`)) blogIds.set(blog.key, recorder.id(`blog:${blog.key}`));
    for (const post of plan.posts) if (recorder.id(post.key)) postIds.set(post.key, recorder.id(post.key));
  }

  // ---- Verification: the shapes lib/services/blog-*-service.ts issue.
  const { page: followed } = await battery.ranked('blogFollow', 'blogId', { type: 'count' }, { direction: 'desc' });
  let trending = new Map();
  try {
    const { page } = await battery.ranked('blogFollow', 'blogId', { type: 'count' },
      { direction: 'desc', timeRange: [{ field: '$createdAt', selector: 'newest', grid: { ...DAY_GRID } }] });
    trending = new Map(page.entries.map((entry) => [entry.groupValue, Number(entry.value)]));
  } catch (error) {
    const message = describeErr(error);
    console.log(`trending today: ${COLD_BUCKET.test(message) ? 'cold bucket (empty page, as designed)' : message.slice(0, 160)}`);
  }

  // blogCommentService.countCommentsByPostBatch() — one grouped count per page.
  const ids = [...postIds.values()].filter(Boolean);
  const commentCounts = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const grouped = await battery.groupedCount('blogComment', [['blogPostId', 'in', ids.slice(i, i + 40)]], ['blogPostId'],
      (hex) => normalizeId(Uint8Array.from(Buffer.from(hex, 'hex'))));
    for (const [id, count] of grouped) commentCounts.set(id, count);
  }

  const rows = [];
  for (const blog of plan.blogs) {
    const blogId = blogIds.get(blog.key);
    if (!blogId) continue;
    const posts = await battery.queryDocs('blogPost', { where: [['blogId', '==', blogId]], orderBy: [['blogId', 'asc'], ['$createdAt', 'desc']], limit: 100 });
    const ranked = battery.groupValueOf(followed, blogId);
    rows.push([
      await battery.countBy('blogFollow', [['blogId', '==', blogId]]),
      ranked ? Number(ranked.value) : 0, trending.get(blogId) ?? 0, posts.length,
      [...postIds.entries()].filter(([key]) => key.startsWith(`${blog.key}/`)).reduce((total, [, id]) => total + (commentCounts.get(id) ?? 0), 0),
      `${blog.name} (${blog.key})`,
    ]);
  }
  rows.sort((a, b) => b[0] - a[0] || b[4] - a[4]);
  printTable([['followers', -9], ['ranked', -6], ['today', -5], ['posts', -5], ['comments', -8], ['blog', 40]], rows,
    'read back through the app’s query shapes — followers from the countable axis, ranked = the "Most followed" page');

  const postById = new Map(plan.posts.map((post) => [postIds.get(post.key), post]));
  const { page: discussed } = await battery.ranked('blogComment', 'blogPostId', { type: 'count' }, { direction: 'desc', limit: 10 });
  printTable([['comments', -8], ['post', 60]],
    discussed.entries.filter((e) => e.value > 0n).slice(0, 8).map((entry) => {
      const post = postById.get(entry.groupValue);
      return [Number(entry.value), post ? `${post.title} [${post.blogKey}]` : `(another run) ${entry.groupValue}`];
    }), 'Most discussed posts (ranked commentCount axis)');

  const edited = [];
  for (const edit of plan.edits) {
    const postId = postIds.get(edit.postKey);
    if (!postId) continue;
    const current = await battery.fetchDocument('blogPost', postId);
    edited.push([edit.postKey, Number(current?.revision ?? 0)]);
  }
  printTable([['edited post', 50], ['revision', -9]], edited, 'Edited posts (blog v3 keeps no revision history; the stored revision is the proof)');
  return recorder.summary(`; checkpoint ${args.state}`) === 0 && rows.length > 0 ? 0 : 1;
}

function dryRun(plan) {
  printTable([['post', 46], ['blog', 18], ['words', -5], ['bytes', -5], ['chunks', -6], ['comments', -8], ['flags', 24]],
    plan.posts.map((post) => [post.slug, post.blogKey, post.words, post.bytes, post.chunks,
      plan.comments.filter((comment) => comment.postKey === post.key).length,
      [post.published ? null : 'draft', post.commentsEnabled ? null : 'comments off',
        plan.edits.some((edit) => edit.postKey === post.key) ? 'edited' : null].filter(Boolean).join(', ')]));
  console.log(`\n${counts({ blogs: plan.blogs.length, posts: plan.posts.length, edits: plan.edits.length,
    comments: plan.comments.length, follows: plan.follows.length }, `; YAPP required ${plan.comments.length}`)}`);
  return 0;
}

function selfTest(args) {
  const plan = buildPlan({ seed: args.seed, only: null, publishAnchor: 1_800_000_000_000 });
  const drafts = plan.posts.filter((post) => !post.published);
  const spread = plan.posts.reduce((acc, post) => ({ ...acc, [post.chunks]: (acc[post.chunks] ?? 0) + 1 }), {});
  // The corpus must exercise the whole dialect, or a block type silently stops being tested.
  const types = new Set();
  for (const blog of BLOGS) for (const post of blog.posts) {
    for (const block of blocksFromMarkdown(articleFor({ ...post, key: `${blog.key}/${post.slug}` }, blog), 'x')) types.add(block.type);
  }
  const inline = blocksFromMarkdown('A **bold** and *italic* and `code` and [link](https://yap.pr).', 'x')[0].content;
  // Uneven on purpose: "Most followed" is only worth looking at with a clear leader.
  const followerCounts = Object.values(FOLLOWERS).map((list) => list.length).sort((a, b) => b - a);
  const again = buildPlan({ seed: args.seed, only: null, publishAnchor: 1_800_000_000_000 });
  // The label encoding follows NEXT_PUBLIC_BLOG_TOPOLOGY: prove both shapes.
  const labelShapes = (topology) => {
    const saved = process.env.NEXT_PUBLIC_BLOG_TOPOLOGY;
    process.env.NEXT_PUBLIC_BLOG_TOPOLOGY = topology;
    try {
      const shaped = buildPlan({ seed: args.seed, only: null, publishAnchor: 1_800_000_000_000 });
      return [shaped.blogs[0].data.labels, shaped.posts.find((post) => post.data.labels)?.data.labels];
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_BLOG_TOPOLOGY; else process.env.NEXT_PUBLIC_BLOG_TOPOLOGY = saved;
    }
  };
  const [v3Blog, v3Post] = labelShapes('v3');
  const [v4Blog, v4Post] = labelShapes('v4');
  return reportSelfTest('the blog plan', [
    ['labels are comma-separated strings for blog v1–v3', typeof v3Blog === 'string' && typeof v3Post === 'string'],
    ['labels are typed lists for blog v4', Array.isArray(v4Blog) && Array.isArray(v4Post) && v4Blog.join(',') === v3Blog],
    [`8 blogs / 42 posts (${plan.blogs.length}/${plan.posts.length})`, plan.blogs.length === 8 && plan.posts.length === 42],
    [`40 follows / 4 edits (${plan.follows.length}/${plan.edits.length})`, plan.follows.length === 40 && plan.edits.length === 4],
    [`73 comments (${plan.comments.length})`, plan.comments.length === 73],
    ['two drafts, written with publishedAt OMITTED entirely', drafts.length === 2],
    ['a draft carries no publishedAt key at all', drafts.every((post) => !('publishedAt' in post.data))],
    ['one post has commentsEnabled: false', plan.posts.filter((post) => !post.commentsEnabled).length === 1],
    ['drafts collect no comments', plan.comments.every((comment) => plan.posts.find((post) => post.key === comment.postKey).published)],
    ['every post fits in data0–data3', plan.posts.every((post) => post.chunks >= 1 && post.chunks <= MAX_CHUNKS)],
    // Otherwise the check above passes vacuously and data1–data3 — and the app's
    // chunk-reassembly path — get no seeded coverage at all.
    [`at least one post needs a second chunk (spread ${JSON.stringify(spread)})`, plan.posts.some((post) => post.chunks >= 2)],
    ['every blog has followers', new Set(plan.follows.map((follow) => follow.blogKey)).size === 8],
    [`follower counts are uneven with a single leader (${followerCounts.join(',')})`,
      followerCounts[0] > followerCounts[1] && new Set(followerCounts).size >= 6],
    ['nobody follows their own blog',
      plan.follows.every((follow) => follow.follower !== plan.blogs.find((blog) => blog.key === follow.blogKey).owner)],
    ...['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'quote', 'divider', 'tableOfContents', 'codeBlock', 'callout']
      .map((type) => [`the corpus produces a ${type} block`, types.has(type)]),
    ['inline bold/italic/code/link all convert', inline.some((n) => n.styles?.bold) && inline.some((n) => n.styles?.italic)
      && inline.some((n) => n.styles?.code) && inline.some((n) => n.type === 'link')],
    ['the same seed plans identical content',
      JSON.stringify(again.posts.map((p) => p.bytes)) === JSON.stringify(plan.posts.map((p) => p.bytes))],
  ]);
}

export default {
  name: 'blog',
  state: '.seed-blog.local.json',
  contractEnv: ['BLOG_CONTRACT_ID', 'NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID'],
  defaults: { seed: '20260917', concurrency: 4 },
  plan: (args) => buildPlan({ seed: args.seed, only: args.only, publishAnchor: 1_800_000_000_000 }),
  dryRun,
  selfTest,
  run,
};
