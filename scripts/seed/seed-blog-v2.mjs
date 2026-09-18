/**
 * Realistic FAKE-DATA seeder for the **blog v2 contract** on the moutai devnet
 * (`contracts/yappr-blog-contract-v2.json`, docs/BLOG_V2.md), so the /devnet
 * deployment's blog surfaces look lived-in instead of empty.
 *
 * It writes the four v2 doctypes in the shapes the APP writes them, not the
 * battery's placeholder shapes (`scripts/verify-blog-v2.mjs` is still the
 * reference for the write MECHANICS — token payment, permanent-document
 * references):
 *
 *   blog        name / description / labels / picsum header+avatar /
 *               zlib-compressed themeConfig (lib/blog/theme-types.ts)
 *   blogPost    real BlockNote block arrays (headings, paragraphs, lists,
 *               quotes, callouts, code, images) zlib-compressed and chunked
 *               into data0–data3 exactly like lib/services/blog-post-service.ts
 *   blogComment `blogPostOwnerId` = the post's $ownerId, 1 YAPP each
 *               through the cross-contract tokenCost on the social contract
 *   blogFollow  unevenly distributed so "Most followed" and "Trending today"
 *               (followersByDay, the daily grid) have a clear leader
 *
 * A few posts are EDITED after creation so the revision-history UI
 * (`components/blog/blog-post-history.tsx`, `documents.history`) has something
 * to show.
 *
 * Deterministic: every choice comes from a seeded PRNG plus the article bank
 * written into this file, so two runs plan byte-identical content. Idempotent:
 * every write is keyed in `.seed-blog.local.json` and, when that record is
 * missing, recovered by reading the chain back (unique indices and
 * owner+name/content matching), so a resume never duplicates.
 *
 * Run:
 *   NETWORK=devnet node scripts/seed/seed-blog-v2.mjs --dry-run
 *   NETWORK=devnet node scripts/seed/seed-blog-v2.mjs [--contract <id>]
 *     [--only runbook-diaries,marginalia] [--concurrency 4] [--yapp 80]
 *     [--seed 20260917] [--state <file>] [--verify-only]
 *
 * Never prints private keys. Actors are seed-ledger personas
 * (`.seed-identities.local.json`): the blog authors are 280–285 plus 210, the
 * commenters and followers add 211 and 212.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ensureInitialized } from '@dashevo/evo-sdk';
import { zlibSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { createBattery, id32 } from '../battery-lib.mjs';
import {
  REPO_ROOT,
  YAPP_TOKEN_POSITION,
  createSdkHandle,
  describeErr,
  readEnvFile,
  socialContractId,
} from './seed-lib.mjs';

/** YAPP a single blogComment create costs (contract tokenCost.create.amount). */
const COMMENT_COST = 1n;
/** Compressed-content ceiling and chunk width the app enforces (lib/constants.ts). */
const CHUNK_SIZE = 5120;
const MAX_CHUNKS = 4;
const POST_SIZE_LIMIT = 16384;
/** The daily grid `followersByDay` buckets on (contract timeRange range/step). */
const DAY_GRID = { range: 86400, step: 86400 };
/** A ranked read on a bucket nothing landed in — that error IS the empty page. */
const COLD_BUCKET = /single-path axis read must produce exactly one axis descent/i;
/** Contract maxLengths we validate the bank against before any network I/O. */
const LIMITS = {
  blogName: 64, blogDescription: 256, blogLabels: 1024, image: 256,
  postTitle: 128, postSubtitle: 256, postLabels: 256, postSlug: 63,
  comment: 500, themeBytes: 5000,
};

const STATE_FILE = join(REPO_ROOT, '.seed-blog.local.json');

// ---- CLI ---------------------------------------------------------------------

function envValue(name) {
  return process.env[name] || readEnvFile(join(REPO_ROOT, '.env.devnet'))[name] || undefined;
}

function parseArgs(argv) {
  const args = {
    contract: envValue('NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID') ?? null,
    dryRun: false, verifyOnly: false, only: null, concurrency: 4, yapp: 80n,
    seed: 20260917, state: STATE_FILE,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      case '--verify-only': args.verifyOnly = true; break;
      case '--only': args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--concurrency': args.concurrency = Number(argv[++i]); break;
      case '--yapp': args.yapp = BigInt(argv[++i]); break;
      case '--seed': args.seed = Number(argv[++i]); break;
      case '--state': args.state = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.dryRun && !args.contract) {
    throw new Error('Pass --contract <id> or set NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID (.env.devnet)');
  }
  return args;
}

// ---- Deterministic PRNG -------------------------------------------------------

/** mulberry32 — small, fast, and stable across Node versions. */
function makeRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max) => Math.floor(next() * max);
  return {
    next,
    int,
    pick: (list) => list[int(list.length)],
    /** `count` distinct members of `list`, order-stable, without replacement. */
    sample: (list, count) => {
      const pool = [...list];
      const out = [];
      while (out.length < count && pool.length > 0) {
        const [drawn] = pool.splice(int(pool.length), 1);
        out.push(drawn);
      }
      return out;
    },
  };
}

/** Stable 32-bit seed for a string, so per-item streams do not depend on order. */
function seedFrom(text, salt) {
  const digest = sha256(Buffer.from(`${salt}:${text}`, 'utf8'));
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Deterministic nanoid-shaped block id (BlockNote ids are opaque strings). */
function blockId(key) {
  const digest = sha256(Buffer.from(key, 'utf8'));
  let out = '';
  for (let i = 0; i < 10; i++) out += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  return out;
}

// ---- Markdown → BlockNote blocks ----------------------------------------------
//
// The app persists `editor.document` verbatim (components/blog/blog-editor.tsx)
// and feeds it back as `initialContent` (blog-viewer.tsx), so what we write must
// be block JSON for the app's own schema (components/blog/blocknote-schema.tsx:
// default specs plus the overridden image/codeBlock/callout/divider/…).
//
// The bank is authored in a small markdown dialect — tilde fences and `:::`
// callouts so nothing collides with JS template literals:
//   ## / ###          heading level 2 / 3
//   - item            bulletListItem
//   1. item           numberedListItem
//   > text            quote
//   ![caption](url)   image block (previewWidth 800)
//   :::tip Title …    callout until a closing ::: line
//   ~~~lang … ~~~     codeBlock (props.language / props.code, content 'none')
//   ***               divider (fade)
//   [toc]             tableOfContents
//   anything else     paragraph
// Inline: **bold**, *italic*, backtick code, [text](url).

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

/** One BlockNote inline-content array from a line of the dialect. */
function inlineContent(text) {
  const out = [];
  const push = (value, styles) => {
    if (value) out.push({ type: 'text', text: value, styles });
  };
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

const TEXT_DEFAULTS = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };

/**
 * The block a single dialect line produces, or `null` when the line is prose
 * and belongs to the paragraph currently being accumulated.
 */
function singleLineBlock(trimmed) {
  const heading = /^(#{2,3})\s+(.*)$/.exec(trimmed);
  if (heading) {
    return {
      type: 'heading',
      props: { ...TEXT_DEFAULTS, level: heading[1].length, isToggleable: false },
      content: inlineContent(heading[2]),
    };
  }
  const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(trimmed);
  if (image) {
    return {
      type: 'image',
      props: { ...TEXT_DEFAULTS, name: '', url: image[2], caption: image[1], showPreview: true, previewWidth: 800 },
    };
  }
  if (trimmed === '***') return { type: 'divider', props: { ...TEXT_DEFAULTS, variant: 'fade' } };
  if (trimmed === '[toc]') return { type: 'tableOfContents', props: { ...TEXT_DEFAULTS } };
  if (trimmed.startsWith('> ')) {
    return {
      type: 'quote',
      props: { textColor: 'default', backgroundColor: 'default' },
      content: inlineContent(trimmed.slice(2)),
    };
  }
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
  const emit = (block) => {
    blocks.push({ id: blockId(`${key}#${blocks.length}`), children: [], ...block });
  };
  const flush = (buffer) => {
    if (buffer.length === 0) return;
    emit({ type: 'paragraph', props: { ...TEXT_DEFAULTS }, content: inlineContent(buffer.join(' ')) });
    buffer.length = 0;
  };

  const paragraph = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { flush(paragraph); continue; }

    if (trimmed.startsWith('~~~')) {
      flush(paragraph);
      const language = trimmed.slice(3).trim() || 'bash';
      const code = [];
      for (i += 1; i < lines.length && lines[i].trim() !== '~~~'; i++) code.push(lines[i]);
      emit({ type: 'codeBlock', props: { ...TEXT_DEFAULTS, language, code: code.join('\n') } });
      continue;
    }
    if (trimmed.startsWith(':::')) {
      flush(paragraph);
      const header = trimmed.slice(3).trim().split(/\s+(.*)/s);
      const variant = ['info', 'warning', 'tip', 'note'].includes(header[0]) ? header[0] : 'info';
      const body = [];
      for (i += 1; i < lines.length && lines[i].trim() !== ':::'; i++) body.push(lines[i].trim());
      emit({
        type: 'callout',
        props: { ...TEXT_DEFAULTS, variant, title: (header[1] ?? '').trim() },
        content: inlineContent(body.join(' ')),
      });
      continue;
    }

    const block = singleLineBlock(trimmed);
    if (block) {
      flush(paragraph);
      emit(block);
      continue;
    }
    paragraph.push(trimmed);
  }
  flush(paragraph);
  return blocks;
}

/** Words in a block array, for the dry-run table. Link nodes carry no text. */
function countWords(blocks) {
  return blocks.reduce((sum, block) => {
    if (!Array.isArray(block.content)) return sum;
    const text = block.content.map((node) => node.text ?? '').join(' ');
    return sum + text.split(/\s+/).filter(Boolean).length;
  }, 0);
}

/** zlib-compress JSON the way lib/utils/compression.ts does. */
const compress = (value) => zlibSync(new TextEncoder().encode(JSON.stringify(value)));

/** Split compressed bytes into the data0–data3 payload fields. */
function chunkFields(bytes) {
  const fields = {};
  let index = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE, index++) {
    fields[`data${index}`] = bytes.slice(offset, offset + CHUNK_SIZE);
  }
  return { fields, chunks: index };
}

const coverUrl = (seed) => `https://picsum.photos/seed/${seed}/1200/630`;
const headerUrl = (seed) => `https://picsum.photos/seed/${seed}/1600/500`;
const avatarUrl = (seed) => `https://picsum.photos/seed/${seed}/200/200`;

// ---- Themes ------------------------------------------------------------------
//
// Shapes normalizeBlogThemeConfig() accepts verbatim (lib/blog/theme-types.ts);
// font ids must be BLOG_FONT_OPTIONS ids or they fall back to inter.

const THEMES = {
  paper: {
    colors: { bg: '#fbfaf7', text: '#2b2a27', accent: '#8a6a3b', heading: '#151412', link: '#7a4f1d', surface: '#f2efe8', border: '#e0dbd0' },
    fonts: { body: 'source-serif-4', heading: 'playfair' },
    layout: 'narrow', headerStyle: 'minimal',
    customCSS: 'line-height: 1.85; letter-spacing: 0.005em;',
    gradient: { type: 'solid', angle: 0, from: '#8a6a3b', to: 'transparent', opacity: 100 },
  },
  midnight: {
    colors: { bg: '#07070c', text: '#b8bfd0', accent: '#8b7fd6', heading: '#eef1f8', link: '#a99cf0', surface: '#11111c', border: '#22223a' },
    fonts: { body: 'lora', heading: 'lora' },
    layout: 'narrow', headerStyle: 'minimal',
    customCSS: 'line-height: 1.9;',
    gradient: { type: 'radial', angle: 0, from: '#8b7fd6', to: 'transparent', opacity: 60 },
  },
  terminal: {
    colors: { bg: '#0b1015', text: '#c3d0d9', accent: '#3fd07f', heading: '#f2fbf6', link: '#5ce39a', surface: '#121a21', border: '#1f2b34' },
    fonts: { body: 'ibm-plex-sans', heading: 'jetbrains-mono' },
    layout: 'wide', headerStyle: 'banner',
    customCSS: 'line-height: 1.7;',
    gradient: { type: 'linear', angle: 100, from: '#3fd07f', to: '#0b1015', opacity: 90 },
  },
  warm: {
    colors: { bg: '#fff8f0', text: '#3a2a20', accent: '#c25b2a', heading: '#2a1a12', link: '#a8451c', surface: '#fbecdd', border: '#edd9c4' },
    fonts: { body: 'merriweather', heading: 'merriweather' },
    layout: 'magazine', headerStyle: 'hero',
    customCSS: 'line-height: 1.8;',
    gradient: { type: 'linear', angle: 160, from: '#f0a868', to: 'transparent', opacity: 100 },
  },
  forest: {
    colors: { bg: '#0d1411', text: '#c4d3c8', accent: '#6fbf8a', heading: '#eff6f1', link: '#8fd6a6', surface: '#141f19', border: '#22322a' },
    fonts: { body: 'inter', heading: 'space-grotesk' },
    layout: 'wide', headerStyle: 'hero',
    customCSS: 'line-height: 1.75;',
    gradient: { type: 'linear', angle: 200, from: '#6fbf8a', to: '#0d1411', opacity: 80 },
  },
  slate: {
    colors: { bg: '#f4f6f8', text: '#25303a', accent: '#41708f', heading: '#0f1a22', link: '#2f5d7c', surface: '#e7ecf1', border: '#d2dae2' },
    fonts: { body: 'ibm-plex-sans', heading: 'ibm-plex-sans' },
    layout: 'narrow', headerStyle: 'minimal',
    customCSS: 'line-height: 1.7; letter-spacing: 0.01em;',
    gradient: { type: 'solid', angle: 0, from: '#41708f', to: 'transparent', opacity: 100 },
  },
  amber: {
    colors: { bg: '#15110c', text: '#ded2c0', accent: '#e0a338', heading: '#fdf6e8', link: '#f0bd5e', surface: '#1f1913', border: '#332a20' },
    fonts: { body: 'space-grotesk', heading: 'space-grotesk' },
    layout: 'magazine', headerStyle: 'banner',
    customCSS: 'line-height: 1.72;',
    gradient: { type: 'linear', angle: 135, from: '#e0a338', to: '#15110c', opacity: 100 },
  },
  neon: {
    colors: { bg: '#050510', text: '#cbd5e1', accent: '#22d3ee', heading: '#f8fafc', link: '#38bdf8', surface: '#0f172a', border: '#1e293b' },
    fonts: { body: 'space-grotesk', heading: 'space-grotesk' },
    layout: 'wide', headerStyle: 'hero',
    customCSS: 'line-height: 1.75;',
    gradient: { type: 'linear', angle: 135, from: '#22d3ee', to: '#0f172a', opacity: 100 },
  },
};

// ---- Article bank ------------------------------------------------------------
//
// One entry per blog; `posts[]` is authored in the dialect above. `edit`
// describes the revision a post gets AFTER creation so documents.history (and
// components/blog/blog-post-history.tsx) has real revisions to show.

const BLOG_MARGINALIA = {
  key: 'marginalia',
  owner: 280,
  name: 'Marginalia',
  description: 'Weekly essays about attention, memory, and the machines we keep. Written slowly, on purpose, by a former librarian who still smells of card stock.',
  labels: 'essays,attention,reading,libraries,memory',
  theme: 'paper',
  commentsEnabledDefault: true,
  posts: [
    {
      slug: 'the-shape-of-a-reading-chair',
      title: 'The Shape of a Reading Chair',
      subtitle: 'I bought a chair to fix my attention. The chair was innocent.',
      labels: 'essays,attention',
      cover: 'reading-chair-window',
      body: `
For two years I believed my problem was furniture. I read standing at the kitchen counter, or folded sideways on a sofa built for people with shorter spines, and I told myself that the reason I could not finish a book was ergonomic. So I bought a chair. A good one, secondhand, the kind with a worn leather seat that has already made its peace with someone else's posture.

The chair did not fix anything, which I should have predicted and did not.

## What the chair did instead

It made the failure legible. Sitting in a chair chosen specifically for reading, holding a book I had chosen specifically to read, I could watch myself reach for my phone at roughly ninety-second intervals. The chair removed every other excuse and left me alone with the only real one.

There is a particular kind of honesty available only after you have spent money on the wrong solution.

## A short taxonomy of the reaching

Once I started counting, the reaching sorted itself into kinds:

- **Errand reaching.** A genuine question the book raised, which I could answer in eight seconds and then fail to return from.
- **Weather reaching.** No question at all. A hand moving the way a hand moves.
- **Escape reaching.** The paragraph was hard, and somewhere on the internet a paragraph was easy.
- **Social reaching.** The suspicion that something had happened to someone.

Only the first has any defence, and even it is mostly a lie; the answer is almost never needed.

:::note What I tried
Airplane mode, a drawer across the room, a paper notebook for errand questions, and one very silly week with a kitchen timer. The notebook worked. The timer made me feel observed, which turns out to be a different thing from being focused.
:::

## The part that actually helped

Not the chair, not the drawer. It was giving up on the idea that attention is a resource I own and can be taught to behave. Attention is closer to weather: it arrives, it has a direction, and the most I can do is build something that catches it when it comes.

So I read in the chair when the weather is good, and on the counter when it is not, and I stopped keeping score. In four months I finished eleven books, which is not a triumph of discipline. It is a triumph of lowered expectations, which I have come to think is the only kind that lasts.

The chair, for the record, is still excellent. It just was never the point.
`,
    },
    {
      slug: 'what-the-card-catalogue-knew',
      title: 'What the Card Catalogue Knew',
      subtitle: 'A drawer of index cards was a search engine with opinions, and it said them out loud.',
      labels: 'libraries,memory,essays',
      cover: 'card-catalogue-drawers',
      body: `
The catalogue in the branch where I worked had eleven hundred drawers and a smell I have never successfully described to anyone who did not grow up with it: dust, cardstock, and the faint metallic breath of the runners. It was retired in 2009. I kept a drawer. It is on a shelf above me now, full of cards for authors whose surnames begin with *Hal*.

## An honest interface

People talk about the catalogue as though it were merely slower than a search box. It was slower. It was also more honest, in a specific way worth naming: it showed you the neighbours.

When you looked for a book, you did not get a list ranked by a function you could not inspect. You got a physical position in an ordered world, and on either side of the card you wanted were cards you had not thought to want. Half of what I know, I know because it was filed next to something else.

> A ranked list tells you what it thinks you asked for. A drawer tells you where you are.

## The cards had authors

Every card was typed by a person, and the people disagreed. Subject headings drifted by decade. You could date a card by its vocabulary, and occasionally by its politics, and the whole drawer was therefore a record of what a particular institution had believed about the shape of knowledge in a particular year.

That record did not survive the migration. What survived was the data: title, author, year, call number, a flattened subject string. What was lost was the sediment — the crossings-out, the pencilled *see also* in three different hands, the card someone had turned sideways because it mattered.

## I am not arguing for the drawers

I want to be careful here, because nostalgia for card catalogues is usually a nostalgia for being the kind of person who knew how to use one. The catalogue was hostile to anyone who did not already speak its language, it was unsearchable by any term its makers had not anticipated, and it could not be in two places at once.

The database is better. It is better the way a road is better than a path.

***

What I miss is only this: the catalogue was a machine that admitted it had been made. You could see the hands in it. Every system we use now was also made by hands, with opinions, in a particular year — and almost none of them will let you see the cards.
`,
    },
    {
      slug: 'attention-is-not-a-muscle',
      title: 'Attention Is Not a Muscle',
      subtitle: 'The gym metaphor has been load-bearing for a decade and it cannot hold the weight.',
      labels: 'attention,essays',
      cover: 'attention-muscle-essay',
      body: `
The metaphor goes: attention is a muscle, focus is a workout, distraction is skipping leg day. It is a comforting picture because it implies a straightforward relationship between effort and capacity, and because it makes the failure entirely mine and therefore entirely fixable.

I have used the metaphor. I would like to retire it.

## Where it breaks

Muscles fatigue predictably and recover on a schedule. Attention does neither. I can spend six hours on a difficult text and come out sharper than I went in, and I can lose an entire morning to a page and a half with no measurable exertion at all. The variable that best predicts my day is not how much attention I spent yesterday. It is whether the thing in front of me is *interesting*, in the narrow, involuntary sense of that word.

Interest is not a muscle either. Interest is more like appetite, and appetite responds to what is on the table.

## Three things the metaphor hides

1. **Environment does most of the work.** A quiet room with one object in it is not a bicep curl; it is a different room. Most of what looks like willpower is furniture, and most of what looks like weakness is a notification.
2. **Boredom is information.** Under the gym metaphor, boredom is weakness to be pushed through. Sometimes it is. Often it is a correct report that this text is badly written or this task is pointless, and pushing through trains you to ignore a working instrument.
3. **The goal is not capacity.** Nobody wants a larger attention span in the abstract. People want to be absorbed in specific things. Training for span without reference to the thing is like training for chewing.

:::tip A better metaphor, offered tentatively
Attention as a *field* rather than a muscle: something with a shape, a set of conditions, and edges you can move. You do not do reps on a field. You clear it, you plant something, and you accept that some seasons are poor.
:::

## What I do now

Less training, more gardening. I keep a list of things I have actually been absorbed by and look for what they have in common — usually length, usually a voice, almost never anything with a progress bar. I arrange mornings around them. I stopped measuring minutes.

It works about seventy percent of the time, which is worse than the gym metaphor promises and better than it has ever delivered.
`,
    },
    {
      slug: 'borrowed-light',
      title: 'Borrowed Light',
      subtitle: 'On books you only understood because of who handed them to you.',
      labels: 'essays,reading',
      cover: 'borrowed-light-lamp',
      body: `
There is a shelf in my flat that I think of as the borrowed shelf, though nothing on it is technically on loan. Every book on it was handed to me by a specific person, in a specific mood, with a specific sentence attached, and I cannot read any of them without also reading that sentence.

## The mechanism

A recommendation is not information about a book. It is information about a relationship, disguised as information about a book. When M. gave me a battered translation of a Hungarian novel and said only *you will hate the first fifty pages*, she was telling me two things: something about the novel, and something about her estimate of my patience. The second was the useful part. I got to page fifty out of vanity.

I have never once finished a book recommended to me by an algorithm that did not also come with a person's face attached. Not because the recommendations were bad. Because there was nothing to be vain about.

## An incomplete list

- A book on glaciers from a colleague who was leaving the country, inscribed with a joke I no longer understand.
- Three detective novels from my father, in the specific order he insisted on, which turned out to matter.
- A slim book about grief handed over without comment by someone who had correctly guessed why I had stopped answering messages.
- One book I was given twice, by two people who did not know each other, which I now consider a kind of proof.

## Borrowed light

Astronomers talk about reflected light — objects that shine only because something else is burning nearby. Most of my reading life is reflected. Left to my own instincts I read narrowly and comfortably, the same three registers in rotation. Everything that changed anything arrived in someone else's hands.

> The books that changed me were not chosen by me. They were *aimed* at me.

I have started aiming back, badly. I am too enthusiastic and I over-explain, which is the recommender's equivalent of spoiling a joke. But I have noticed that the sentence matters more than the choice. *You will hate the first fifty pages* did more work than any summary could have.
`,
      edit: {
        note: 'author adds a closing section and a corrected attribution',
        titleSuffix: '',
        appendBody: `
***

## Addendum, two weeks later

Several people wrote to say the Hungarian novel was Krasznahorkai and that I had misremembered the translator. They are right, and I have left the original sentence standing rather than quietly fixing it, because the misremembering is part of the point: what I kept was M.'s warning, not the book's front matter.

One reader sent me a list of the books *they* had been handed, with the sentences attached. It is better than this essay. If you have one, send it.
`,
      },
    },
    {
      slug: 'an-inventory-of-interruptions',
      title: 'An Inventory of Interruptions',
      subtitle: 'I wrote down every interruption for eleven days. The results were humiliating and useful.',
      labels: 'attention,essays',
      cover: 'inventory-interruptions-notebook',
      body: `
The rule was simple: every time my attention left the thing in front of me, I made a mark and two words about why. Eleven days, one pencil, no judgement at the moment of writing. Judgement afterwards, in bulk.

## The count

Four hundred and nine marks. Of those, eighty-one were external — a person, a phone, a delivery, a smoke alarm with opinions about toast. The remaining three hundred and twenty-eight came from inside the house.

That ratio is the whole finding. I had spent years optimising for the eighty-one.

## What the two words said

Sorting the notes produced categories I did not expect:

- **Verification** (91). *Did I lock it, did I send it, is that the right date.* Almost always yes.
- **Anticipated boredom** (74). Leaving *before* the dull part arrived, which is a strange kind of foresight.
- **Small hunger** (52). Not hunger. Mouth-boredom.
- **Sentence failure** (48). A sentence I could not get right, abandoned mid-clause.
- **Genuine idea** (19). Worth having. Three of them became things.
- **Unclassifiable** (44).

:::warning The trap
Counting interruptions is itself an interruption, and by day four I noticed I was slightly enjoying the marks. A record of your own failures is still a record, and records are fun to keep. I do not think the numbers are contaminated beyond use, but they are not innocent.
:::

## The two changes that stuck

The verification category was solved with a piece of paper by the door listing four things, which I now touch instead of wondering about. Eleven days of the new regime cut the category by about two thirds.

Sentence failure was not solvable, but it was *movable*: I now write the bad sentence badly, in brackets, and keep going. The brackets are ugly and the draft is worse and the draft exists.

Everything else I have decided to accept. Three hundred marks a day is apparently the weather in here, and I would rather work in weather than keep buying umbrellas.
`,
    },
    {
      slug: 'the-long-way-round',
      title: 'The Long Way Round',
      subtitle: 'In praise of the inefficient route, from someone who timed both.',
      labels: 'essays,walking',
      cover: 'long-way-round-path',
      body: `
There are two ways from my flat to the library. The short way takes eleven minutes and passes a road. The long way takes twenty-six and passes water. For a year I took the short way and arrived at the library already spent.

## The arithmetic nobody does

The case for the short route is obvious and shallow: fifteen minutes saved, twice a day, is two and a half hours a week. Put that way it sounds like a scandal to walk slowly.

But the fifteen minutes are not the only quantity. The long way gets me to a desk in a state where I can work for two hours. The short way gets me to a desk in a state where I read the same paragraph four times and then leave. The efficient route is only efficient if you stop measuring at the door.

## Not a productivity argument

I want to resist the version of this essay where walking by water is a *hack*. That version is the same disease with better scenery. The honest version is smaller: some routes put you in a mood, and mood is not a rounding error.

> I have never regretted the long way round. I have frequently regretted the eleven minutes I saved.

## What the route contains

- A footbridge where the wind changes direction for no reason I have been able to establish.
- Two herons, possibly the same heron twice.
- A bench with a plaque for someone who liked this view, which I read every time and have never once found sentimental.
- A stretch of thirty metres where the city is genuinely inaudible.

That last one is the real cargo. Thirty metres of quiet is not enough to solve anything, but it is enough to notice what I am carrying, and noticing is usually most of it.

I still take the short way when I am late. I am late less often now, which I attribute entirely to no longer wanting to arrive.
`,
    },
  ],
};

const BLOG_QUIET_HOURS = {
  key: 'quiet-hours',
  owner: 280,
  name: 'The Quiet Hours',
  description: 'A small second notebook for the hours nobody schedules: four in the morning, the walk before work, the bakery light. Shorter than the essays and less sure of itself.',
  labels: 'notes,night,walking,insomnia',
  theme: 'midnight',
  commentsEnabledDefault: true,
  posts: [
    {
      slug: 'four-am-is-a-country',
      title: 'Four AM Is a Country',
      subtitle: 'It has its own weather, its own citizens, and no useful exports.',
      labels: 'night,notes',
      cover: 'four-am-street-lamp',
      body: `
I have been awake at four in the morning often enough to have opinions about it. The chief one is that it is not a time so much as a place, and the place has borders.

Before three, you are still up. After five, you are early. Four belongs to nobody.

## The citizens

From my window, in order of appearance: a man who walks a dog that does not want to be walked; a delivery van that idles for eleven minutes and then leaves without delivering anything; a woman in scrubs who I assume is going to a hospital and may be going anywhere; and a fox with a limp and a schedule.

None of us acknowledge each other. This is the local custom and I have grown to like it.

## What thinking is like there

Sharper and much worse. Everything arrives with a false sense of importance — decisions feel obvious, grudges feel structural, and sentences arrive fully formed and wrong. I have learned to write them down and not act on them until the sun has ratified them. Roughly one in six survives.

:::note The one rule
Nothing decided at four in the morning may be communicated before eight. I have broken this rule twice and apologised twice.
:::

## Why I no longer fight it

For years I treated being awake at four as a failure of the night before. Now I treat it as an unscheduled room. I do not do good work there, but I do notice things, and the noticing is cheap because nothing is asking for anything.

The fox is back. Same limp, same route, four minutes earlier than last week. I have no idea what that means and I am delighted to be told.
`,
    },
    {
      slug: 'walking-the-same-loop-for-a-year',
      title: 'Walking the Same Loop for a Year',
      subtitle: 'Three point one kilometres, four hundred times, and it never once repeated.',
      labels: 'walking,notes',
      cover: 'same-loop-year-path',
      body: `
Same route, most mornings, since last September. Three point one kilometres: down to the canal, along to the second bridge, back up through the allotments. I did not set out to do this four hundred times. It simply stopped being a decision.

## What changes

Everything, but slowly, and in a specific order:

1. **Light**, first and most obviously, moving along the row of houses like a hand along a shelf.
2. **Sound** — the allotments are loud in May and silent in January, and the canal reverses this.
3. **Smell**, which I was not expecting to be the most reliable calendar of the four.
4. **People**, on a longer cycle than the seasons. The regulars turned over almost completely in twelve months and I could not tell you when.

## What does not change

The gradient by the second bridge, which is unfair in both directions. And the specific spot, about two thirds of the way round, where whatever I have been chewing on since waking either resolves or is set down. Four hundred repetitions and it is still that spot. I have tried to move it and cannot.

> A familiar route is not a boring one. It is a controlled experiment with one variable: you.

## The unglamorous part

Roughly sixty of the four hundred were miserable. Rain sideways, ankle wrong, mind loud. I have kept no record of which, and the memory has quietly discarded them, which seems like the correct storage policy.

Next September I may change the loop. I probably will not.
`,
    },
    {
      slug: 'notes-on-not-sleeping',
      title: 'Notes on Not Sleeping',
      subtitle: 'What eleven years of intermittent insomnia has actually taught me, minus the advice.',
      labels: 'insomnia,notes',
      cover: 'not-sleeping-ceiling',
      body: `
I am not going to tell you what to do. Everything that worked for me failed for at least two people I like, and everything that failed for me is somebody's miracle. What follows is a description, not a protocol.

## The three kinds

For me it comes in three varieties and they want different things.

- **Cannot start.** Body ready, mind reviewing the day at a volume I did not authorise. Responds to boredom. Responds badly to being reasoned with.
- **Cannot stay.** Asleep by eleven, awake at two, sharp and alarmed and certain about something. Responds to getting up. Lying there is always worse and I always lie there anyway.
- **Cannot care.** Sleeping fine, waking flattened. This one is not insomnia and pretending it is has cost me months.

## What I stopped doing

Measuring. I wore a ring that told me a number every morning, and the number moved my whole day. On the nights I slept badly and did not know it, I was fine. On the nights I slept adequately and was told it was a five, I was not. I gave the ring away and my sleep did not improve at all, which is the point — my *days* did.

:::warning The obvious caveat
This is a description of ordinary bad sleep, not of a medical problem. I have had one of those too, and the thing that helped was a doctor, not a notebook.
:::

## The only thing that generalises

Nothing that happens at three in the morning is as bad as it is at three in the morning. I have tested this several hundred times with a high degree of rigour. The finding replicates.
`,
    },
    {
      slug: 'the-bakery-light',
      title: 'The Bakery Light',
      subtitle: 'Six hundred metres away, on at three forty, and the only proof I have that the day is coming.',
      labels: 'night,notes',
      cover: 'bakery-light-window',
      body: `
There is a bakery on the corner of the next street but one. From my kitchen window I can see exactly one thing of it: a rectangle of yellow light above the service door, which comes on somewhere between three thirty-five and three forty-five.

I have come to depend on it more than I would like to admit.

## The function it serves

On the bad nights, time stops being a sequence and becomes a condition — you are simply *in* the night, and there is no evidence it is going anywhere. The light is evidence. Somebody has got up. Somebody is weighing flour. The machinery of the ordinary day has started somewhere, six hundred metres away, whether or not I participate.

> It is not comfort exactly. It is more like a timestamp.

## What I know about them

Almost nothing, and I would like to keep it that way. Two people, I think, from the shadows. One of them props the door at four in any weather. Once, in February, the light did not come on at all, and I stood at the window until five feeling a degree of concern that would have been extremely difficult to explain to them.

They were open the next day. Presumably somebody was ill. I bought a loaf and said nothing, as is right.

## The point, such as it is

We are all leaning on strangers' schedules. The night bus, the hospital shift, the bakery, the man with the reluctant dog. I have no relationship with any of these people and they are nonetheless holding up a corner of my week.

The light is on. It is three forty-one. Good.
`,
    },
  ],
};

const BLOG_RUNBOOK_DIARIES = {
  key: 'runbook-diaries',
  owner: 281,
  name: 'Runbook Diaries',
  description: 'Postmortems, diagrams, and documentation that survives contact with production. Written by someone who has been paged at 03:12 and has opinions about it.',
  labels: 'postmortems,databases,documentation,oncall,diagrams',
  theme: 'terminal',
  commentsEnabledDefault: true,
  posts: [
    {
      slug: 'the-postmortem-nobody-wanted-to-write',
      title: 'The Postmortem Nobody Wanted to Write',
      subtitle: 'Four hours of downtime, one missing index, and a document that took longer than the fix.',
      labels: 'postmortems,oncall',
      cover: 'postmortem-terminal-glow',
      body: `
[toc]

## Summary

On a Tuesday, between 09:41 and 13:58 UTC, writes to the primary order path failed for approximately 34% of requests. The immediate cause was a query plan regression after an index was dropped as part of a cleanup migration nine days earlier. The regression was invisible until traffic crossed a threshold, which it did on the Tuesday because a marketing email went out at 09:40.

No data was lost. Everything else about this is bad.

## Timeline

1. **09:40** — campaign email sends to 210k addresses.
2. **09:41** — p99 write latency crosses 2s. No alert; the alert is on error rate.
3. **09:52** — first customer report. Support asks in a channel nobody on call watches.
4. **10:06** — error rate crosses threshold, page fires. Responder begins looking at the load balancer, because the dashboard's top panel is the load balancer.
5. **10:48** — responder escalates. Second responder asks whether anything changed, and is told *nothing this week*, which was true and useless.
6. **11:30** — someone thinks to diff the schema against the previous release tag.
7. **12:15** — index recreated on a replica to confirm the hypothesis.
8. **13:58** — index live on primary, latency recovers within ninety seconds.

## What went wrong that was not the index

The index was a mistake. The four hours were a documentation failure, and they are the part worth writing down.

- The cleanup migration's description said **"remove unused indexes"**. It cited a query log window of seven days. The queries that needed this index run at campaign volume, which is monthly.
- The runbook for *write latency high* did not exist. The runbook for *write errors high* existed and began with the load balancer, so the first forty minutes were spent in the wrong system by a responder correctly following instructions.
- The phrase *nothing changed this week* was accurate. The change was nine days old. Our template asks "what changed recently" and nobody has ever defined recently.

:::warning The sentence that cost us two hours
"Nothing changed this week." It was true. Our question was wrong. The template now reads: *list every migration and deploy in the last 30 days, then rule them out explicitly.*
:::

## Remediation

~~~sql
-- restored, with a comment that will outlive me
CREATE INDEX CONCURRENTLY orders_customer_created_idx
  ON orders (customer_id, created_at DESC);
-- Used only at campaign volume (~monthly). A 7-day query log
-- will show this index as unused. It is not unused.
COMMENT ON INDEX orders_customer_created_idx IS
  'Campaign-path only. Do not drop on the basis of a short query-log window.';
~~~

Three actions, all shipped:

- Latency alerting on the write path, not just errors.
- Index-drop migrations require a 45-day log window and an owner sign-off.
- Every index whose traffic is periodic now carries a COMMENT saying so. This is the cheapest thing on the list and I expect it to prevent the most.

## What I am not going to do

I am not going to add a process step that requires a human to remember something monthly. We have eleven of those already and they are all quietly dead.
`,
      edit: {
        note: 'follow-up section added after the review meeting',
        appendBody: `
***

## Update: what the review actually changed

The review meeting added one thing I did not expect and did not propose: a standing item to re-read the *previous* postmortem's action items before writing a new one. Two of ours were already open from March and would have caught this.

Also, for the record: the campaign email was not at fault, the marketing team does not need to warn us, and the first draft of this document implied otherwise. That paragraph is gone.
`,
      },
    },
    {
      slug: 'write-the-runbook-before-the-outage',
      title: 'Write the Runbook Before the Outage',
      subtitle: 'A runbook written during an incident is a transcript. A runbook written before it is a tool.',
      labels: 'documentation,oncall',
      cover: 'runbook-before-outage',
      body: `
Every team I have worked on has written runbooks, and almost all of them wrote them in the wrong order: incident happens, postmortem demands a runbook, someone writes down what they did last Tuesday. The result is a transcript of one specific failure, which is the least reusable artefact in the building.

## What makes a runbook usable at 03:12

A responder at 03:12 is not reading. They are scanning for a command they can paste. Everything the document does that is not that is furniture.

- **The first line says what this document is for, in symptom language.** Not "Kafka consumer lag remediation" — *"queue is backing up / consumers look stuck"*. The responder knows the symptom, not your subsystem taxonomy.
- **Verification before action.** Two commands that distinguish this failure from the three that look like it. If both come back wrong, the document says so and points elsewhere.
- **One safe action, then stop.** Not a decision tree with six branches. The branch point is where you lose people.
- **The escalation line, with a name.** Roles do not answer phones.

:::tip The 90-second test
Hand the runbook to someone who has never touched the system and ask them to reach the first action within ninety seconds. If they cannot, the problem is layout, not their knowledge.
:::

## The template we settled on

~~~markdown
# SYMPTOM: <what the human sees>
## Confirm it is this
  <cmd>   # expect: <exact output>
  <cmd>   # expect: <exact output>
  If not: see <other doc>
## Do this
  <single command>
  Wait <n> minutes. Confirm with <cmd>.
## If that did not work
  Escalate: <person>, <person>. Say: "<one sentence>"
## Why this happens (read later, not now)
~~~

The last heading is load-bearing. Explanation is valuable and it is not valuable at 03:12, so it goes below the fold where it stops competing with the commands.

## Writing them before

The objection is always that you cannot write a runbook for a failure you have not had. You can write most of one. Take any component, ask *what does it look like when this is the problem*, and you will get three symptoms and two confirmations without any incident at all. The action step may be a guess. A guessed action with an honest note saying *untested, verify on a replica first* is worth more than nothing, which is the alternative.

We wrote fourteen this way in a single afternoon. Four have since been used. Two were wrong in their action step and correct in their confirmation step, which still cut the diagnosis to minutes.
`,
    },
    {
      slug: 'diagrams-that-survive-production',
      title: 'Diagrams That Survive Contact With Production',
      subtitle: 'Most architecture diagrams are lies within a quarter. A few kinds are not.',
      labels: 'diagrams,documentation',
      cover: 'diagrams-survive-production',
      body: `
I have drawn a great many architecture diagrams and thrown away almost all of them. The ones that survived have something in common, and it is not tooling.

## The three failure modes

1. **The everything diagram.** Every service, every queue, every datastore, laid out on one canvas at a scale where the labels are unreadable. It is drawn once, printed, admired, and never updated, because updating it requires re-laying-out the whole thing.
2. **The aspirational diagram.** Describes the architecture as designed, not as deployed. Distinguishable at a glance: it is too symmetrical and there is no box labelled with a person's name.
3. **The auto-generated diagram.** Always accurate, never useful. It has no opinion about what matters, so it shows the 200 edges the code contains rather than the 6 you need.

## What survives

**Request-path diagrams.** One diagram per user-visible action, showing only what that action touches, in order. They survive because they are small, because they are falsifiable, and because when someone changes the path they must change the diagram or the diagram becomes obviously wrong rather than subtly stale.

**Failure-domain diagrams.** Not what talks to what; what dies together. Draw the blast radius. These survive because they are the only diagram anyone wants during an incident, so they get corrected constantly.

**Data-lifecycle diagrams.** Where a record is created, where it is copied, where it is deleted, and — the panel everyone forgets — where it is *retained after deletion*. These survive because auditors ask for them.

> A diagram earns its keep by being wrong in a way somebody notices.

:::note The rule I now apply
Every diagram gets one sentence underneath: *this diagram is correct as of <date> for <purpose>*. If neither the date nor the purpose can be written honestly, the diagram should not exist.
:::

## On tooling, briefly

Text-based is better than canvas-based for exactly one reason: diff. A diagram you can review in a pull request gets corrected; a PNG someone exported from a design tool does not. Everything else about the tooling argument is taste.

I keep the source next to the code it describes. When the code moves, the diagram moves with it or gets deleted, and either outcome is fine.
`,
    },
    {
      slug: 'we-benchmarked-the-wrong-thing',
      title: 'We Benchmarked the Wrong Thing for Nine Months',
      subtitle: 'Our numbers were beautiful, reproducible, and about a code path nobody used.',
      labels: 'databases,postmortems',
      cover: 'benchmark-wrong-thing',
      body: `
The benchmark ran nightly for nine months. It was well written: fixed dataset, warmed cache, three runs, median reported, variance under two percent. We tuned against it and the numbers improved by 41%.

Production did not get faster. Not slightly. Not at all.

## The gap

The benchmark issued its queries with a single connection, sequentially, against a dataset that fit in memory. Production issued them from 240 connections against a working set four times RAM. Every optimisation we made was an optimisation for the case where there is no contention and no eviction — which is to say, for a case that only existed in our harness.

The two most effective changes we made in those nine months actively hurt production, and we could not see it because the production graph was noisy and the benchmark graph was clean, and we are human beings who prefer clean graphs.

## The four questions we should have asked

1. **What is the concurrency in production, and does the harness reproduce it?** Ours: 240 vs 1.
2. **What is the working-set-to-memory ratio?** Ours: 4.1 vs 0.3.
3. **What is the read/write mix?** Ours: 70/30 vs 100/0. We were not benchmarking writes at all.
4. **Does the query *distribution* match, not just the query set?** Ours had a long tail we had trimmed for reproducibility. The tail was where the pain was.

:::warning Reproducibility is not validity
We trimmed the long tail *because* it made the numbers noisy. That decision is why the benchmark was stable and why it was worthless. Noise in a benchmark is sometimes signal about the workload.
:::

## What we replaced it with

A shadow-traffic harness: real query text sampled from production logs at real concurrency, replayed against a restored snapshot. It is noisier, slower, and considerably more annoying to operate.

~~~bash
# the whole idea, roughly
pg_sample_queries --window 24h --preserve-distribution \
  | replay --concurrency-from-source --target staging-restored \
  | report --percentiles 50,95,99,99.9
~~~

Percentiles, not medians. The median was never the problem; the median was fine in both worlds. All the damage lived at p99.9, which the old harness — three sequential runs — could not even represent.

## The uncomfortable conclusion

Nine months of work was not wasted, exactly. We learned the system deeply. But every conclusion we drew had to be re-derived, and two shipped changes had to be reverted. If I had spent one afternoon at the start comparing four numbers between the harness and production, we would have caught it in a day.
`,
    },
    {
      slug: 'on-call-is-a-documentation-problem',
      title: 'On-Call Is a Documentation Problem',
      subtitle: 'The rota is not the hard part. Knowing what to do is the hard part, and that is writing.',
      labels: 'oncall,documentation',
      cover: 'oncall-documentation-problem',
      body: `
Every on-call improvement project I have been part of started with the rota — fairness, follow-the-sun, compensation, handover meetings. All worth doing. None of it touched the thing that actually makes on-call unbearable, which is being woken up to solve a problem you do not have the information to solve.

## The two kinds of page

**Pages where you know what to do.** These are fine. Genuinely. Being woken at four to run a known command for ten minutes is a bad night, not a bad job.

**Pages where you do not.** These are where the damage lives: the forty minutes of reading code you have never seen, the escalation you delay because you do not want to wake a colleague, the dawning certainty that you are the wrong person and there is no right person awake.

The rota changes how *often* you get the second kind. Documentation changes whether the second kind exists.

## Measure the right thing

We tracked pages per week for a year and it told us nothing useful. Then we started tracking, for each page, one question answered by the responder: **did you know what to do within five minutes?**

- Yes: 61%.
- No, but a document got me there: 12%.
- No, I figured it out: 19%.
- No, I escalated: 8%.

The 19% is the number to attack. Every one of those is knowledge that existed in a human head at 04:00 and was not written down. Each one became a runbook, and the number fell to 11% in a quarter.

> On-call quality is the percentage of pages where the responder is executing rather than investigating.

:::tip The five-minute writeup
The rule that changed the most: after any page you resolved by investigating, you write five minutes of notes before going back to bed. Not a runbook. Notes. Someone converts them in business hours. Five minutes is short enough that people actually do it.
:::

## What the handover meeting is for

Not status. The handover meeting should produce exactly one artefact: a list of things the outgoing responder learned that are not yet written down. Ours takes eleven minutes and generates two to four items a week.
`,
    },
    {
      slug: 'four-words-that-ruined-a-migration',
      title: 'Four Words That Ruined a Migration',
      subtitle: '"Should be backwards compatible." Reader, it was not.',
      labels: 'databases,postmortems',
      cover: 'four-words-migration',
      body: `
The pull request description was 340 words long and entirely reasonable. Somewhere in the middle was the sentence *this should be backwards compatible*, and three reviewers including me read it as an assertion. It was a hope.

## The change

A column widened, a default added, and an enum extended with one new value. All three are individually safe. Together, with a client fleet that had not been fully redeployed, the new enum value reached a deserialiser that treated unknown variants as a hard error rather than a skip.

Nine percent of clients — the ones still on the previous release, which we did not have a dashboard for — began failing on read. Not on write, where we were watching. On read, which nobody thought a write-side migration could break.

## The reading failure

Here is what I actually did during review: I read the migration SQL closely, verified the lock behaviour, checked the rollback, and skimmed the prose. The prose contained the only claim I could not verify from the diff, and it was the claim that turned out to be wrong.

:::note The reviewer habit I changed
Any unverifiable claim in a PR description now gets a comment asking **how was this checked**. Not as a challenge. As a prompt, because in this case the author had not checked either — the sentence was a genuine belief, honestly held, and untested.
:::

## The four rules we wrote afterwards

1. **Enum extension is a two-phase deploy.** Readers learn the value in phase one; writers emit it in phase two. No exceptions, including for values that "cannot happen yet".
2. **"Backwards compatible" must name the versions.** Compatible with what? The answer is a list of deployed client versions, which requires knowing them, which required a dashboard we did not have.
3. **Unknown-variant handling is a deserialiser property, and it is written down per client.** We now have a table. It is ugly and it has saved us twice.
4. **Read-path alerting on write-path migrations.** Obvious in retrospect; absent for years.

## The bit I keep thinking about

Everyone behaved well. The author was careful, the reviewers were attentive, the rollback worked, the incident lasted 26 minutes. The failure was in a single hedged sentence that three experienced people read as a fact because it was phrased like one.

I now grep my own PR descriptions for *should*, *probably*, and *ought to be*. Roughly half the time, the word is covering a thing I have not actually verified.
`,
    },
    {
      slug: 'everything-i-know-about-migrations',
      title: 'Everything I Know About Migrations',
      subtitle: 'The long one: fourteen years, roughly ninety schema migrations, and the checklist that came out of it.',
      labels: 'databases,documentation,postmortems',
      cover: 'everything-about-migrations',
      body: `
This is the post I point people at instead of explaining it again. It is long. There is a table of contents. I have rewritten it four times and each rewrite has made it longer, which I think is honest about the subject.

[toc]

## What a migration actually is

A schema migration is usually described as a change to a database. That description is why they go wrong. A migration is a change to the **agreement between every writer, every reader, and the storage**, executed while all of them are running, with no moment at which they all agree.

Once you hold it that way, most of the rules below become obvious rather than arbitrary. The database change is the easy half. The hard half is that for some window — minutes, or a whole release cycle — there are two populations of code with two different beliefs about the shape of the world, and both of them are right from where they stand.

## The four phases nobody writes down

Every safe migration I have run has had the same four phases, whether or not anybody named them at the time.

1. **Expand.** Add the new thing. Nothing reads it, nothing requires it. Fully reversible: you can drop it again and nobody notices.
2. **Teach.** Deploy readers that understand both shapes. Still nothing writes the new shape. This phase is pure risk reduction and it is the one that gets skipped.
3. **Migrate.** Start writing the new shape, backfill the old rows, and run both in parallel long enough to be bored.
4. **Contract.** Remove the old thing, once you can prove nothing reads it.

The failures cluster in two places: skipping phase two, and rushing phase four. Skipping *teach* means your first write of a new shape meets a reader that has never seen it. Rushing *contract* means you drop a column that something still reads once a month.

:::warning The phase-four question
"Nothing reads this any more" is a claim about production behaviour, not about the codebase. Grep is not evidence. Log the reads for a period longer than your longest batch job, and look at the log.
:::

## Backfills

A backfill is a migration inside a migration and deserves its own care.

- **Batch it, always.** A single statement over 40 million rows will either hold a lock long enough to matter or blow out a transaction log. Batches of a few thousand with a pause between them will finish later and finish.
- **Make it resumable.** A backfill that cannot restart from where it stopped will be stopped — by a deploy, a failover, or someone's laptop closing — and the restart from zero is how a two-hour job becomes a two-day job.
- **Make it idempotent.** Re-running a batch must be safe, because you will re-run batches.
- **Write down the progress somewhere queryable.** A backfill whose progress lives in a terminal window that has since been closed is a backfill of unknown status.
- **Measure the tail.** The last 1% of rows is often the oldest, largest, or strangest data and can take as long as the first 99%.

The best backfill I have written logged one line per batch with the batch bounds, the row count, and the elapsed time, and wrote its high-water mark to a table. When it was killed by a failover at 60% it restarted with one command and no thought, which is the entire point.

## Locks, and the difference between "fast" and "safe"

A statement that completes in eight milliseconds can still take an outage, because the time that matters is not how long the statement runs — it is how long it waits for a lock, and how long everything behind it waits for the lock it holds.

The specific pattern that has burned me twice: a DDL statement queues behind a long-running read, and every subsequent query queues behind the DDL. The DDL itself would have taken milliseconds. The queue took the site down for four minutes.

Two habits fix it. Set a short lock timeout on DDL so the statement fails instead of queueing, and retry it. And check for long-running transactions before you start, because the answer to "is now a good time" is a query, not a feeling.

~~~sql
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN settled_at timestamptz;
-- fails fast if it cannot get the lock; retry in a loop rather than
-- letting every reader pile up behind a queued DDL.
~~~

## Reversibility is a property you design, not a script you write

Everyone writes a down-migration. Almost nobody can use one, because by the time you want it, the new column has data in it that the old shape cannot represent, and reversing means deciding what to do with that data — which is a product question, at three in the morning.

So I have stopped treating the down-migration as the rollback plan. The rollback plan is the **phase structure**: at every point in the sequence, the previous deploy must still work against the current schema. If that holds, you roll back code rather than data, which is fast, safe, and rehearsed.

> A migration is reversible if you can roll back the *code* at any point. A down-migration is a nice extra and is almost never the thing you use.

## The things I now always write down

The migration document is four short sections and it has caught more problems in review than any automated check.

1. **What shape changes, exactly.** The before and after, as DDL, not as prose.
2. **Which deployed versions can read each shape.** A list of versions, not "the current release". This requires knowing what is deployed, which is itself a thing worth being able to answer.
3. **What the backfill is, how long it takes, and how it resumes.** With a number. An estimate from a count and a measured batch, not a guess.
4. **How I will know it worked, and how I will know it did not.** The specific query, dashboard, or log line. "Monitor for errors" is not an answer.

:::tip The review question that finds the most
For every claim in the document: **how was this checked?** In my experience about a third of the claims in a migration plan are beliefs that nobody has tested, and the author is usually surprised to discover which ones.
:::

## Enum and type changes specifically

These deserve a section because they look trivial and are not.

Adding a value to an enum is a **two-phase deploy**, without exception. Readers learn the value first; writers emit it second. Even for a value that "cannot happen yet" — because it will happen, on a Tuesday, from a code path nobody remembered.

Widening a type is usually safe and occasionally not: a client with a fixed-width buffer or a strict deserialiser will reject the wider value at read time, on a path you were not watching because you changed a write.

Narrowing a type is not a migration. It is a data-loss event with a plan attached, and it should be documented as one.

## What I got wrong for years

**I optimised for the migration and ignored the window.** All my care went into the statement — the lock, the batch size, the rollback script — and none into the days during which two shapes coexist. Almost every incident happened in the window, not during the statement.

**I trusted the codebase over production.** Grep told me nothing read the column. A monthly report read the column.

**I treated the plan as paperwork.** For about five years I wrote migration documents because the process required them, filled them with confident sentences, and never used them as an instrument. They became useful the moment I started asking "how was this checked" of my own text, and about half the sentences did not survive.

## Two migrations I would run differently

**The one that was fine.** A column split across 60 million rows, done over eleven days, with a week of parallel writes and a backfill nobody watched because it logged properly. It was boring, it took three times longer than the technically-necessary minimum, and it is the only large migration I have run that generated no incident and no follow-up work at all. Boring is the target, not a compromise.

**The one that was not.** Same shape of change, compressed into a single evening because a release depended on it. Nothing went wrong during the statement. Four days later a report that ran weekly met the new shape and produced silently wrong numbers, which nobody noticed for a month, and the correction took longer than the entire migration would have if we had simply taken the eleven days.

The lesson is not "go slower". It is that the schedule pressure never applies to the part that actually carries the risk, and agreeing to compress a migration is almost always agreeing to compress phase two.

## The checklist

Print it, tape it up, it is short.

- Which of the four phases is this? If more than one, split it.
- Does the previous deployed version work against the schema after this step?
- What is the lock behaviour, and is there a long transaction running right now?
- Is the backfill batched, resumable, idempotent, and measured?
- Which deployed client versions read each shape, by number?
- What is the specific signal that says it worked?
- What is the specific signal that says it did not, and who sees it?
- After this lands, what is the *next* step, and when?

That last one matters more than it looks. An unfinished migration — expanded, taught, never contracted — is the most common state of a real system, and a half-finished migration that everyone has forgotten is where the next surprise lives. Ours has a standing review of every migration older than sixty days that has not reached phase four. It is never empty.
`,
    },
  ],
};

const BLOG_BRINE_AND_CRUMB = {
  key: 'brine-and-crumb',
  owner: 282,
  name: 'Brine & Crumb',
  description: 'Bread, brine, and things that take all day, from one small kitchen in Leipzig. Every recipe tested at least three times, with the failures left in.',
  labels: 'baking,fermentation,recipes,markets',
  theme: 'warm',
  commentsEnabledDefault: true,
  posts: [
    {
      slug: 'a-starter-that-forgives-you',
      title: 'A Starter That Forgives You',
      subtitle: 'Six weeks of neglect, one revival, and why your starter is much harder to kill than the internet says.',
      labels: 'baking,fermentation',
      cover: 'starter-forgives-jar',
      body: `
I left my starter in the back of the fridge for six weeks in August. When I found it there was a grey layer of liquid on top, the smell was closer to nail polish than bread, and by every rule I had read online it was dead.

It was not dead. It was hungry and sulking, which are different things.

## The revival, in full

1. Pour off the grey liquid. All of it. It is alcohol and it is telling you the yeast ran out of food, not that anything has gone wrong.
2. Take **20 g** from the middle of the jar. Not the top, not the bottom. Discard the rest without ceremony.
3. Feed **40 g** flour and **40 g** water at about 26 °C. Stir properly; you want air in it.
4. Wait 12 hours. Nothing much will happen. This is normal and it is where most people give up.
5. Repeat. On the second feed you will see bubbles. On the third it will double. On the fourth it will smell like yoghurt and apples, and you are back.

Four days, total. No new flour types, no pineapple juice, no rituals.

:::tip How to know it is actually gone
Fuzzy mould — pink, orange, or anything with texture — is the end. Throw the jar out, do not scrape. A grey liquid, a sharp smell, or a hard crust are all recoverable.
:::

## Why the internet made you afraid

Because starters are the one part of bread that is alive, and living things generate anxiety. Also because a fragile starter makes for better content than a robust one: there is nothing to say about a culture that just works.

Mine is eleven years old and I have neglected it worse than this. It has survived two house moves, one broken fridge, and a fortnight in a rucksack. What it has never survived is being fed exactly on schedule at exactly 24 °C by someone anxious — that starter was two years old and never rose well, and I now think I was overfeeding it into laziness.

## The unhelpful truth

You want a schedule. I cannot give you one, because it depends on your flour, your kitchen, and how warm your radiator is. What I can give you is the tell: a healthy starter, fed at 1:2:2, should roughly double in 6–8 hours at 22 °C and smell faintly sour and sweet at the peak. If it takes twelve hours, it is cold. If it smells of acetone, it is hungry. If it smells of nothing, feed it twice and ask again.

Neglect it. It will forgive you. That is the whole post.
`,
    },
    {
      slug: 'the-only-bread-recipe-i-still-use',
      title: 'The Only Bread Recipe I Still Use',
      subtitle: 'After nine years and roughly four hundred loaves, it fits on an index card.',
      labels: 'baking,recipes',
      cover: 'only-bread-recipe-loaf',
      body: `
I have written down dozens of bread recipes. I use one. It is not the best bread I have made — that was an accident in 2021 involving a power cut — but it is the bread I can make while distracted, and that turns out to matter far more.

## The recipe

- **500 g** strong white flour (I use a T550)
- **350 g** water, room temperature
- **100 g** starter, at peak
- **10 g** fine salt

That is 70% hydration, which is enough to be interesting and not enough to be a wrestling match.

1. Mix flour and water. Leave 30 minutes. This is the only step people skip and the one that does the most work.
2. Add starter, squeeze through. Wait 20 minutes. Add salt, squeeze through again.
3. Four folds, 30 minutes apart. Wet hand, lift, over. Ten seconds each.
4. Bulk until risen by half — **4 to 5 hours at 22 °C**, and this is the number to watch, not the clock.
5. Shape, into a floured basket, fridge overnight.
6. Bake from cold: **250 °C** in a covered pot for 25 minutes, lid off, **230 °C** for 20 more.

## What I got wrong for years

**Over-proofing the bulk.** I waited for doubling because everything said doubling. At 70% hydration and my starter's activity, doubling is too far — the loaf spread in the oven and the crumb went gummy near the base. Risen by half, finger-dent springing back slowly, is the target.

**Under-baking.** A loaf that looks done at 40 minutes is not. The extra ten minutes with the lid off is where the crust gets its snap, and a pale loaf tastes of nothing.

**Fussing during bulk.** More folds do not make better bread. Four is plenty. Six made it tighter and worse.

:::warning About the fridge step
It is not for flavour, mostly. It is so that shaping happens when the dough is manageable and baking happens when you are awake. If you skip it, proof at room temperature for 90 minutes and accept a slightly more open, slightly less controllable loaf.
:::

## The index card

If you take one thing: *watch the dough, not the clock*. Every number above is a description of my kitchen in March. Yours will differ by an hour in either direction and the dough will tell you which.

What does your bulk take? I am genuinely curious how much the 4-to-5 hours moves in other kitchens.
`,
    },
    {
      slug: 'salt-time-and-cabbage',
      title: 'Salt, Time, and Cabbage',
      subtitle: 'Sauerkraut is two ingredients and one decision, and the decision is not the salt.',
      labels: 'fermentation,recipes',
      cover: 'salt-time-cabbage-crock',
      body: `
Two ingredients: cabbage and salt. One number: **2% of the cabbage's weight**. Everything else people argue about — whey, starters, airlocks, special crocks, the phase of the moon — is optional at best.

The decision that actually matters is temperature, and almost nobody talks about it.

## The method, complete

1. Weigh the shredded cabbage. Multiply by 0.02. That is your salt.
2. Mix, then squeeze hard for five minutes. Real force. The cabbage will release enough liquid to submerge itself.
3. Pack into a jar, press down until the brine covers everything, and weight it. A smaller jar of water works.
4. Leave it somewhere you have chosen deliberately.

## The temperature decision

- **18–20 °C**: three to four weeks. Complex, layered, faintly funky. This is the one I make.
- **22–24 °C**: eight to twelve days. Sharper, simpler, more obviously sour. Good, and less interesting.
- **Above 26 °C**: four to six days and a real risk of softness. The texture goes first and does not come back.
- **Below 16 °C**: six weeks or more, and it may simply stall. Not dangerous, just boring.

Same two ingredients, same 2%, four quite different foods. The fermentation books that give you one timeline are describing their own kitchen.

:::note The scum question
A white, flat film on the surface is kahm yeast. Skim it, carry on, nothing is wrong. Anything fuzzy or coloured means the ferment was not submerged; that batch goes out.
:::

## Two things I stopped doing

**Airlocks.** I used them for two years. The kraut was identical to the jar with a weight and a loose lid. I keep one airlock for the satisfaction of the bubbling, which is honest entertainment and not a technique.

**Tasting daily.** Every opening is an opportunity to introduce something and a reason to stop early. I taste at day eight and then every four days.

## The one variation worth it

Add **caraway at the start**, not the end — 4 g per kilo. It softens over three weeks into something rounder. Everything else I have tried (juniper, apple, dill) was better added to the bowl at the table, where you can adjust it.
`,
    },
    {
      slug: 'my-fourth-attempt-at-rye',
      title: 'My Fourth Attempt at Rye',
      subtitle: 'Three bricks and one loaf. Here is exactly what changed.',
      labels: 'baking,recipes',
      cover: 'fourth-attempt-rye-crumb',
      body: `
Attempts one through three produced, in order: a brick, a slightly damper brick, and something with a cave in the middle large enough to lose a thumb in. Attempt four was bread. I want to write down the difference while I still remember it.

## What I was doing wrong

**Treating it like wheat.** Rye has almost no gluten worth speaking of. Folding it does nothing; kneading it does nothing; the strength has to come from somewhere else, and it comes from acidity and from the batter's own thickness. Attempts one and two were extensively, uselessly folded.

**Too much water, too little sour.** 80% hydration with a mild white starter gave me a paste that never set. The cave in attempt three was steam with nowhere to go, through a crumb with no structure.

**Cutting it warm.** Rye needs a full day. I cut attempt three after two hours and pulled out a gummy mess, then blamed the recipe.

## Attempt four

- **400 g** wholegrain rye
- **100 g** strong white flour
- **400 g** water at 40 °C
- **150 g** rye sourdough, refreshed twice and properly sour
- **12 g** salt
- **15 g** dark treacle

1. Mix everything to a thick batter. It will be a batter, not a dough. This is correct and I spent three attempts refusing to believe it.
2. Into a lined tin immediately. No bulk shaping, no folds.
3. Proof **2.5 to 3 hours at 26 °C**, until the surface is dotted with small holes and just domed. Rye goes from underproofed to collapsed quickly.
4. Bake **240 °C for 15 minutes**, then **190 °C for 55**. Internal temperature **98 °C**; anything less and the middle stays wet.
5. **Wrap in a cloth and leave 24 hours.** Not optional.

## The result

A tight, moist, faintly sweet crumb that slices thin without crumbling and tastes better on day three than day two. Not a beautiful loaf. Rye is not a beautiful loaf.

:::tip The one number that mattered most
Internal temperature. I bought a probe after attempt two and it converted the whole project from guesswork to a single check. 98 °C or it goes back in.
:::
`,
      edit: {
        note: 'baker corrects the treacle quantity and adds a reader fix',
        appendBody: `
***

## Correction and a reader's improvement

The treacle should be **25 g**, not 15. I measured from the wrong jar when writing this up; at 15 g the crust is noticeably paler and the sweetness barely registers. Attempt five confirmed it.

A reader in Jena suggested scalding **50 g** of the rye with an equal weight of boiling water the night before and folding that in. I have now made this twice. It is better — moister, sweeter, keeps a day longer — and it costs you one bowl. Do that.
`,
      },
    },
    {
      slug: 'cast-iron-and-the-myth-of-seasoning',
      title: 'Cast Iron and the Myth of Seasoning',
      subtitle: 'You cannot ruin it with soap, and you probably are not heating it long enough.',
      labels: 'markets,recipes',
      cover: 'cast-iron-myth-pan',
      body: `
I own three cast iron pans. The oldest was my grandmother's, the newest cost eleven euros at a flea market and needed an hour of work. All three cook the same, which undercuts most of what gets written about them.

## Things that are not true

- **Soap destroys seasoning.** Seasoning is polymerised oil, chemically bonded to the iron. Dish soap does not remove polymerised oil. This myth is a holdover from lye-based soaps that have not been sold in generations.
- **You must never soak it.** Twenty minutes of soaking to release something welded on is fine. Two days is not — that is rust, which is annoying and entirely fixable.
- **A new pan needs seven coats.** It needs one thin coat and then to be used. Coats applied thickly flake off in sheets, which looks alarming and is your own doing.
- **Never cook tomatoes in it.** Fifteen minutes of acidic sauce in a well-used pan is nothing. Three hours of it will strip patches; do that in steel.

## The thing that is true and underrated

**Preheat much longer than you think.** Cast iron is slow and uneven, and almost every complaint about food sticking is a complaint about an unevenly heated pan. Eight minutes on a medium flame, moved around the burner twice. A drop of water should skitter, not sizzle.

I tested this deliberately: same pan, same oil, same eggs, two minutes of preheat versus eight. The two-minute eggs stuck every time. The eight-minute eggs slid.

:::note The eleven-euro pan
Rust to the elbows, one previous owner's initials scratched on the handle. Vinegar and water 1:1 for an hour, a wire brush, dry it on the hob immediately, one thin coat of rapeseed oil at 230 °C for an hour with the extractor on. It is now my second-favourite pan.
:::

## What I actually do after cooking

Hot water, a brush, soap if it needs it. Back on the flame for a minute to dry. That is all. No oiling after every use — that builds up and goes sticky. Oil it when it looks dry, which for a pan in weekly use is about twice a year.
`,
    },
    {
      slug: 'what-to-do-with-a-failed-loaf',
      title: 'What to Do With a Failed Loaf',
      subtitle: 'Six uses for bread that went wrong, ranked by how much they hide the evidence.',
      labels: 'baking,recipes',
      cover: 'failed-loaf-uses',
      body: `
I fail roughly one loaf in twelve. Dense, flat, gummy, burnt on one side, or simply sad. Nothing gets thrown away, and over nine years I have developed an entirely unsentimental ranking of what to do about it.

## Ranked by how completely the failure disappears

1. **Breadcrumbs.** Total erasure. Dry it low (120 °C, an hour), blitz, freeze. Even a gummy crumb works because the drying finishes what the oven did not. There is no failure so complete it cannot be breadcrumbs.
2. **Panzanella or fattoush.** Torn, oiled, toasted hard, then soaked in dressing and tomato juice. The chewier the failure, the better it holds up, which makes this the correct destination for anything dense.
3. **Soup thickener.** A handful of stale crumb in a tomato or bean soup, blended. Adds body and nobody ever asks what it was.
4. **French toast.** Hides a tight crumb beautifully; cannot hide a burnt crust or a sour over-fermented loaf, because the custard is sweet and the sourness fights it.
5. **Croutons.** Requires the crumb to be structurally sound, so a cave-in loaf is out. Cube, oil, 200 °C, fifteen minutes, shake twice.
6. **Toast, and honesty.** Sometimes the loaf is fine and merely ugly. Eat it and stop apologising to your own bread.

## The one category with no rescue

Sour. Not sourdough-sour — over-fermented, acetone-sharp, the loaf you forgot in a warm kitchen for nine hours. That flavour survives drying, toasting, and soaking. It gets stronger in breadcrumbs, which I learned by ruining a tray of meatballs.

That one goes to the birds, who are unbothered.

:::tip Diagnose before you repurpose
Gummy and dense → underbaked or over-proofed; breadcrumbs or panzanella. Flat and pale → weak starter; croutons. Cave under the crust → too wet, shaped too loose; French toast. Sharp and acetone → over-fermented; birds.
:::

Nine years, four hundred loaves, roughly thirty-five failures. I have a bag of breadcrumbs in the freezer that is essentially a sedimentary record of every mistake I have made, and it makes the best fried fish in the building.
`,
    },
  ],
};

const BLOG_MONSOON_NOTES = {
  key: 'monsoon-notes',
  owner: 283,
  name: 'Monsoon Notes',
  description: 'Field notes from the long paths of the Western Ghats: distances, altitudes, bus timetables, and weather that does not negotiate. Written down before I forget it.',
  labels: 'hiking,maps,monsoon,trains,ghats',
  theme: 'forest',
  commentsEnabledDefault: true,
  posts: [
    {
      slug: 'three-days-above-munnar',
      title: 'Three Days Above Munnar',
      subtitle: '41 km, two ridges, one tea estate that fed me without being asked.',
      labels: 'hiking,ghats',
      cover: 'three-days-munnar-ridge',
      body: `
Rain on the first afternoon, cloud on the second, and on the third morning a clear hour at 2,100 m that made the whole thing worth it. Notes as I wrote them, cleaned up only where the pencil had run.

## Day one — 14 km, +900 m

Left the road at 06:40 from the second hairpin above the estate gate. The path is obvious for the first two kilometres and then is not; at the fork by the culvert, go **left and up**, not right along the water, which is a work track and dead-ends at a pumphouse.

Grass ridges from 1,400 m. Nothing to shelter under. It rained from 14:00 with the specific density that makes a rain jacket a formality, and I walked the last two hours wet and warm, which is fine, and camped at a flat spot by the third stream crossing.

- Water: every 30–40 minutes on this section. Do not carry more than a litre.
- Leeches: yes, below 1,500 m. See the other post.
- Phone signal: none after the culvert, one bar at the camp if you stand on the boulder.

## Day two — 16 km, +400 m / -600 m

Cloud all day. Walked inside a white room for eight hours and saw perhaps forty metres of any view. The path traverses the western side of the ridge and there are two places where it is genuinely exposed, both short, both fine dry and unpleasant wet.

> Navigation in cloud on a grass ridge: trust the compass, not the path. The path is a cattle path and the cattle are not going where you are going.

At 15:30 I came down to a tea estate road I had not expected for another hour and was wrong about where I was by about two kilometres, which on a ridge is nothing and in my notebook is underlined twice.

The estate family fed me rice and a fish curry I have thought about since, refused money, and let me sleep in a room with a corrugated roof and the loudest rain of my life.

## Day three — 11 km, -1,100 m

Clear from 06:00 to 07:10. Both ridges visible, the reservoir below, the whole thing laid out as though the previous two days had been withheld deliberately.

Then cloud again, and a long descent on a gravel estate road that punished the knees more than any of the trail had.

:::tip Getting there and out
Bus to Munnar, then the 07:15 estate bus which does not appear on any timetable and leaves from the corner opposite the vegetable market. Ask for **Kanthalloor side**. Coming out, any lorry.
:::

## What I would change

Two days, not three. Day two is a connection, not a destination, and in cloud it is eight hours of walking inside a bag. If the forecast is poor, do day one and three and take the road between.
`,
    },
    {
      slug: 'the-bus-that-is-not-on-any-map',
      title: 'The Bus That Is Not on Any Map',
      subtitle: 'How to find transport in the Ghats when no timetable, app, or website admits it exists.',
      labels: 'trains,ghats',
      cover: 'bus-not-on-map',
      body: `
The single most useful skill for walking in the Western Ghats has nothing to do with walking. It is finding the bus.

Roughly a third of the services I have used in six years appear in no published timetable, on no mapping app, and on no state transport website. They exist, they are reliable, and they are the difference between a two-day walk and a five-day one.

## Where the information actually lives

1. **The tea shop opposite the stand.** Not the stand itself. The stand has a board listing the four services someone printed in 2014. The tea shop owner watches every bus that has come through for twenty years.
2. **Estate workers at shift change.** They commute on these buses daily. Ask what time *they* leave, not what time the bus leaves — you will get a precise answer.
3. **The driver of the bus you are currently on.** The best source, universally. Ask about the onward connection and you will frequently be handed a phone number.
4. **Lorry drivers at any junction with a chai stall.** Not a bus, but the same function.

## What to ask

Not *is there a bus to X*. The answer is often technically no. Ask **how do people get to X from here**, which is a different question and produces a different answer — a shared jeep, a milk lorry at 05:30, a school bus that takes passengers, or a bus that goes most of the way and a walk of three kilometres.

:::note A worked example
There is no bus from Vattavada to Kanthalloor on any source I can find. There are three vehicles a day. One is a jeep that fills at the junction from about 07:00, one is a private bus at roughly 13:00 that comes from the other direction and turns around, and one is a vegetable lorry in the late afternoon that will take two people in the cab. I learned all three from one tea shop in nineteen minutes.
:::

## The etiquette

- Ask, wait, and accept the answer you are given even if it contradicts the last one. Both are usually true on different days.
- Write down times in pencil.
- Be at the place forty minutes early. These services are reliable in existence and flexible in schedule.
- Pay the fare that is asked and do not negotiate on a milk lorry. You are the imposition, not the customer.

## Why this is not in an app

Because the information changes with the season, the estate's harvest schedule, and the condition of one particular culvert. It is maintained by the people who use it, in their heads, and updated continuously. It is a better system than a timetable and it is simply not written down.
`,
    },
    {
      slug: 'walking-in-the-first-rain',
      title: 'Walking in the First Rain',
      subtitle: 'The monsoon does not arrive gradually. It arrives at a particular hour and you remember where you were.',
      labels: 'monsoon,hiking',
      cover: 'first-rain-walking',
      body: `
June the second, 15:40, on the track above the coffee at about 1,100 m. I had been watching the western sky for two hours the way everyone does in late May, and then the temperature dropped four or five degrees in a minute and the smell arrived before the water did.

## The smell

Everyone who has been in it tries to describe this and nobody manages. Dust and something green and something almost metallic. It arrives thirty to ninety seconds before the rain, carried on the downdraft, and it is the most reliable forecast instrument in the hills.

I have twice sheltered in time purely because of the smell, with no cloud visible from where I stood.

## What actually changes

- **Paths become streams**, and not gradually. A dry cutting is ankle-deep in an hour and knee-deep by evening. Route choice matters more than fitness from June onwards.
- **Leeches**, within two days, below about 1,500 m.
- **Visibility** collapses to the ridge in front of you for weeks at a time.
- **Streams that were dry in May are uncrossable in July.** This is the one that catches people. A route that works in the dry season is a different route.
- **Everything is loud.** On a corrugated roof, conversation stops.

:::warning The one genuine danger
Not the rain. Stream crossings. Water in the Ghats rises fast and falls fast — if a crossing looks wrong, waiting three hours is often enough, and pushing through is how people are lost every single year. I have turned back twice and both times the crossing was fine by evening.
:::

## Why walk in it at all

Because the hills are a completely different place and nobody else is out. Because the grass ridges go from brown to a green that does not photograph. Because the estates are working and the roads are busy with it and there is a sociability to the monsoon that the dry season does not have.

And because of the clear hour. Somewhere in a week of cloud there is one hour, usually early, when the whole thing lifts and you see everything at once. You cannot plan for it. You can only be there.

> Nobody photographs the monsoon well. Go anyway.
`,
    },
    {
      slug: 'a-map-is-a-rumour',
      title: 'A Map Is a Rumour',
      subtitle: 'Four sources, all disagreeing, and how I decide which to believe.',
      labels: 'maps,hiking',
      cover: 'map-is-a-rumour',
      body: `
I carry four maps and trust none of them. This is not cynicism; it is the correct posture, and it has kept me out of trouble more than any single accurate map would have.

## The four, and what each is good for

1. **Survey of India topo sheets.** Contours are excellent and essentially timeless. Paths are from a survey that may be fifty years old. Trust the terrain, ignore the tracks.
2. **OpenStreetMap.** Paths are frequently real, because someone walked them recently with a GPS. Coverage is wildly uneven — dense near towns, empty on the ridges. Trust what is there, assume absence means nothing.
3. **Satellite imagery.** Truthful about what exists and silent about whether it is passable. A path visible from above may be through three metres of lantana. Dry-season imagery of a monsoon route is actively misleading.
4. **What a person told me.** The most accurate about current condition and the least accurate about distance. Everything is *two kilometres* or *very close*.

## How I resolve a disagreement

Contours win on terrain. People win on condition. OSM wins on existence. Nobody wins on time.

When the topo shows a path and OSM does not, I look at the satellite image for a line and at the contours for whether the line makes sense — a path that climbs a 40% slope directly is usually a drawing error or a hundred years old. When two disagree about a junction, I plan for the junction not existing.

:::tip The habit that matters most
Pick a **handrail** — a stream, a ridge, an estate road — that you can find in cloud and cannot lose. Navigate to the handrail, not to the destination. Every serious mistake I have made was on ground where I had no handrail and believed a path.
:::

## The altitude problem

Phone altimeters in the Ghats are wrong by 30–80 m in monsoon pressure, and consistently wrong in one direction over a day. A barometric altitude is not a location. I use altitude as a check on the *rate* of climb, not on position, and cross-check on any feature I can name.

## The honest summary

A map is a claim someone made at a time, for a purpose, at a scale. Four rumours, triangulated, beat one authority. And all four of them together are worth less than a tea shop owner who says *not that one, the other path, the first one floods*.
`,
    },
    {
      slug: 'leech-season',
      title: 'Leech Season',
      subtitle: 'Everything I know about them after six monsoons, none of it dramatic.',
      labels: 'monsoon,hiking',
      cover: 'leech-season-boots',
      body: `
People ask about leeches more than about anything else, usually with an expression of horror, and the honest answer is disappointing: they are a nuisance on the order of mosquitoes, they carry nothing, and after the first day you stop noticing.

## The facts

- Terrestrial leeches in the Ghats, below roughly 1,500 m, from about two days after the first rain until the monsoon breaks.
- They find you by movement and warmth and they are fast for their size — they will cross half a metre of leaf litter while you stand still.
- The bite is painless. You discover it later from the blood, because the anticoagulant keeps it running for a while.
- They transmit nothing. The bleeding is the whole problem and it looks worse than it is.

## What works

1. **Tuck trousers into socks.** Unfashionable, effective. Most arrive at the ankle.
2. **Check at every stop.** Two-minute sweep of boots, ankles, and the back of the calf. It becomes automatic.
3. **Flick them off with a fingernail** before they attach. Once attached, wait — they detach on their own in twenty minutes — or slide a nail under the front sucker. Do not pull the body.
4. **Salt or tobacco in a sock** rubbed around boots and ankles. Genuinely helps, needs reapplying every two hours in rain.

## What does not work

- **Burning them off.** Unnecessary, and a good way to burn yourself.
- **Most DEET repellents**, at least on leeches. It works on mosquitoes and is roughly indifferent to these.
- **Gaiters alone.** They walk up the outside.

:::note The bleeding
A bite bleeds for twenty minutes to two hours. Pressure, then a plaster if it is annoying you. Keep it clean; the only real risk is an infected scratch from your own fingers. I have had perhaps two hundred bites and never a complication.
:::

## One good thing about them

They are a very precise altitude gauge. When the leeches stop, you are above about 1,500 m, and you can check your altimeter against that with more confidence than against the pressure. I am only half joking.
`,
    },
  ],
};

const BLOG_BIT_ROT = {
  key: 'bit-rot-quarterly',
  owner: 284,
  name: 'Bit Rot Quarterly',
  description: 'Notes from twelve years of digital preservation. Formats rot, checksums lie, and everyone thinks their backup works. Occasional tables, frequent gentle doom.',
  labels: 'archives,formats,preservation,storage',
  theme: 'slate',
  commentsEnabledDefault: true,
  posts: [
    {
      slug: 'your-backup-does-not-work',
      title: 'Your Backup Does Not Work',
      subtitle: 'Of 41 restores I have personally attempted from other people’s backups, 12 failed outright.',
      labels: 'preservation,storage',
      cover: 'backup-does-not-work',
      body: `
[toc]

## The number

Over twelve years I have been asked to restore from someone else's backup forty-one times. Twelve of those restores failed completely. A further nine were partial — some files, some years, not what was asked for.

That is a 29% total failure rate on backups their owners believed in, at organisations that had a policy, a budget, and in nine cases a compliance obligation.

## The five ways they failed

1. **Never tested** (7 cases). The job reported success for years. Nobody had read the job's definition of success, which in four cases excluded the directory that mattered.
2. **Encrypted, key lost** (3 cases). The backup was perfect. The key was on a laptop belonging to someone who left in 2019.
3. **Media unreadable** (2 cases). LTO tapes stored above a heating duct; an external drive that had not been spun up in six years.
4. **Format unreadable** (5 cases). The bytes were fine. The proprietary container needed software with a licence server that no longer exists.
5. **Retention shorter than the incident** (4 cases). Thirty days of backups and a corruption that began in month four.

The remaining failures were combinations.

:::warning The one that keeps me up
Format and key loss are the cruel ones because the backup is *intact*. Every byte is there, verified, checksummed, and permanently inaccessible. Media failure is at least honest about itself.
:::

## What a working backup looks like

| Property | The test |
| --- | --- |
| Restorable | A restore was performed, end to end, in the last 90 days, by someone who did not build it |
| Complete | The restore was compared against a manifest, not eyeballed |
| Decryptable | The key was retrieved from its documented location, by a second person |
| Readable | The format opens in software you could install today from scratch |
| Long enough | Retention exceeds your worst realistic detection delay, not your best |

Every row is a thing that has failed in front of me.

## The drill

Pick a date. Restore everything as of that date to a clean machine, with no help from whoever built the system, using only written instructions. Time it. Write down what you had to ask about.

We do this quarterly. It has never once gone smoothly, and it has never once failed to find something.

## The cheap version, if you do nothing else

Restore **one file** from **one year ago**, right now, and open it. That single act would have caught nine of my twelve failures.
`,
      edit: {
        note: 'archivist updates the counts after another restore attempt',
        appendBody: `
***

## Update: forty-two

Since publishing I was asked to do another. It failed, in a new way: the backup was complete, tested, decryptable, and written to an object store whose lifecycle policy had silently transitioned every object older than 180 days to a tier requiring a 12-hour restore — during an incident with a 4-hour recovery objective.

The data was not lost. It was merely unavailable for three times longer than the plan allowed, which for the purposes of that afternoon was the same thing. Add a row to the table: **available in time**.
`,
      },
    },
    {
      slug: 'twelve-years-of-file-formats',
      title: 'Twelve Years of File Formats',
      subtitle: 'Which ones I can still open, which ones I cannot, and what the pattern turned out to be.',
      labels: 'formats,preservation',
      cover: 'twelve-years-formats',
      body: `
In 2014 I inherited a collection of about 340,000 files spanning 1988 to 2011. I have been opening them, on and off, ever since. This is what I have learned about which formats survive.

## The survivors

- **Plain text** in any encoding. Even the strange ones — an encoding is a puzzle, not a wall.
- **TIFF**, uncompressed or LZW. Boring, enormous, and readable by everything.
- **PDF/A**, and plain PDF more often than its reputation suggests.
- **WAV**. Header, then samples. There is almost nothing to break.
- **CSV**, with the standard caveat that nobody agrees what a CSV is and it does not matter, because you can look.

## The casualties

- **Anything with a licence server.** Two CAD formats and one statistical package. The bytes are intact and I cannot read them at any price.
- **Formats that are really databases.** A 1990s document system whose files are fragments of a proprietary index. Individually meaningless.
- **Lossy formats at the edge of their era.** Early RealAudio, one obscure fractal image codec.
- **Anything that depends on fonts or plugins that shipped separately.** Technically openable, visibly wrong.

## The pattern

It is not age, and it is not popularity. The single best predictor is **whether the format can be understood from the bytes alone**.

> A format survives if a determined person with a hex editor and no vendor can make progress. Everything else is a countdown.

That is why uncompressed TIFF beats a newer, better, smaller format with an external colour profile. It is why plain text from 1988 opens and a document from 2006 does not.

:::note Second-best predictor
Whether a free, independent implementation exists — not a free *reader* from the vendor, an independent one. Two implementations from different lineages is close to a guarantee.
:::

## What I do now

On ingest, every file gets a normalised access copy in a boring format alongside the original. The original is kept because normalisation loses things and I do not trust my own judgement about what will matter in thirty years. The access copy is what people actually use.

It costs roughly 1.6x the storage. Twelve years in, it is the best decision in the whole operation.
`,
    },
    {
      slug: 'checksums-lie-politely',
      title: 'Checksums Lie Politely',
      subtitle: 'A verified checksum tells you less than almost everyone assumes.',
      labels: 'preservation,storage',
      cover: 'checksums-lie-politely',
      body: `
Fixity checking is the core ritual of digital preservation: hash everything, store the hashes, re-hash periodically, compare. It is genuinely valuable. It is also routinely over-trusted, and the gap between what it proves and what people believe it proves has bitten me three times.

## What a matching checksum proves

That the bytes you just read are the bytes that were hashed **when the hash was recorded**.

That is the whole claim. Everything else is inference.

## What it does not prove

1. **That the bytes were correct when hashed.** If a file was corrupted during ingest, before hashing, the checksum faithfully protects the corruption forever. I have a folder of perfectly-verified truncated scans from 2009.
2. **That the file is still meaningful.** A valid checksum on a container nothing can open is a promise about a coffin.
3. **That the hash record is trustworthy.** If the manifest lives on the same volume, the same event can take both. This one is obvious and I have found it in production four times.
4. **That anything happened recently.** A report saying "all 2.1M objects verified" is often a report that a script ran. Sample the log for actual read volume; if the bytes were never read from cold media, nothing was verified.

:::warning The failure I am least proud of
Our nightly job verified 100% of objects for eleven months. It was reading a cached manifest and comparing it to itself. Every report was green. The fix was two lines. Finding it took a colleague noticing that the job finished suspiciously fast for its data volume.
:::

## What to add

- **Hash at the earliest possible moment**, ideally at the point of capture, and record *who* hashed it and *with what*.
- **Store manifests independently** — different medium, different failure domain, ideally different organisation.
- **Verify the verifier.** Deliberately corrupt a canary object each cycle and confirm the job screams. If it does not, your green reports mean nothing.
- **Pair fixity with format validation**, so you learn about coffins as well as bytes.
- **Log read bytes, not object counts.** It is the only number that cannot be faked by a caching bug.

## Still do it

None of this is an argument against fixity checking. It is the cheapest thing in preservation and it catches real, silent, otherwise-invisible decay. It just answers one narrow question very well, and people hear it answering a much broader one.
`,
    },
    {
      slug: 'the-cost-of-keeping-everything',
      title: 'The Cost of Keeping Everything',
      subtitle: 'Storage is cheap. Everything around the storage is not, and here are the actual proportions.',
      labels: 'storage,preservation',
      cover: 'cost-keeping-everything',
      body: `
"Storage is cheap" is true and it is the most expensive sentence in my field, because it ends the budget conversation before the real costs appear.

## Where the money actually went

Twelve years, one mid-sized archive, everything normalised to a proportion of total spend:

| Item | Share |
| --- | --- |
| Media and cloud storage | 14% |
| Staff time: ingest, description, normalisation | 47% |
| Staff time: verification, migration, audits | 18% |
| Software, licences, integration | 12% |
| Migrations between systems (three of them) | 9% |

Storage was the fifth-largest line. The largest was people looking at things.

## Why ingest dominates

Because keeping a file is trivial and keeping it *findable* is not. A file with no description is a file nobody will ever request, which means the storage cost was pure waste. Every hour of description is what converts a byte cost into an asset.

We measured it: median 6.5 minutes of human attention per ingested item, at any scale. It does not amortise. That is the real unit cost of "keeping everything", and at a million items it is eleven person-years.

:::tip The question that saves the most money
Not *can we afford to store this*. It is **who will ask for this, and what will they ask for it by**. If nobody can answer the second half, the item is a liability with a storage bill.
:::

## The migration tax

Three system migrations in twelve years — roughly one every four years, which I now believe is the industry-normal rate regardless of how permanent the current system feels. Each one cost between 2% and 4% of cumulative spend and each one lost something: a metadata field with no equivalent, a set of relationships, one audit trail.

Budget for it as a certainty. A preservation plan with no migration line is a plan that has not been written by someone who has done one.

## What we changed

We now appraise harder at the door and describe better on the way in. The collection grows about 30% slower than it used to and costs about the same, and the proportion of items that are ever actually retrieved has roughly tripled.

Keeping less, better, turns out to be preservation. Keeping everything is just storage.
`,
    },
    {
      slug: 'cold-storage-is-a-promise',
      title: 'Cold Storage Is a Promise',
      subtitle: 'Tape, optical, and object tiers, judged by the only thing that matters: getting it back.',
      labels: 'storage,preservation',
      cover: 'cold-storage-promise',
      body: `
Cold storage is sold on cost per terabyte per month. That number is real and it is the least interesting property of the medium. What you are buying is a promise that in some number of years, someone can get the bytes back. Here is how the options have actually behaved for me.

## Tape (LTO)

**Good.** Density, cost at scale, genuinely long shelf life in decent conditions, and an offline air gap that no ransomware has crossed.

**Bad.** The drive is the real dependency, not the cartridge. LTO drives read two generations back and write one, so a library left alone for eight years is a library of media nothing on site can read. I have twice bought a used drive off a broker to recover a collection.

**The rule:** budget for the drive generation, not the tape. Migrate on the drive's schedule.

## Optical (archival-grade)

**Good.** Extremely stable chemically, truly write-once, small volumes are cheap and simple.

**Bad.** Capacity per disc is poor, writing is slow, and quality varies enormously between manufacturers in ways you cannot see. Two of the five brands I tested had unreadable discs inside four years.

**Where it earns its place:** a small, precious, legally-significant set. Not bulk.

## Cloud cold tiers

**Good.** No media to manage, no drive generation, geographic redundancy without a second building.

**Bad.** Retrieval cost and retrieval *time*, both of which are policy and can change under you. Egress is where the promise turns out to have a price attached, and that price is set annually by someone else.

**The trap:** lifecycle policies that transition objects without telling anybody. See my postscript about a 12-hour restore against a 4-hour objective.

:::note The comparison that matters
For each option, ask: *what do I need that I do not control, in order to read this in ten years?* Tape needs a drive. Optical needs a reader and a brand that did not lie. Cloud needs a company, a price list, and an API.
:::

## What we run

Two copies on tape in two buildings, one cloud cold copy, and the small legally-significant set additionally on optical. Three technologies, because the failure modes are unrelated, which is the only real redundancy there is.

And a restore drill every quarter, from the medium, not from the cache.
`,
    },
  ],
};

const BLOG_SHAVINGS = {
  key: 'shavings',
  owner: 285,
  name: 'Shavings',
  description: 'A furniture shop and a software shop, run out of the same head. Joinery, invoices, dull chisels, and what a workshop teaches you about shipping things.',
  labels: 'woodworking,tools,business,shipping',
  theme: 'amber',
  commentsEnabledDefault: true,
  posts: [
    {
      slug: 'the-first-drawer-i-did-not-throw-away',
      title: 'The First Drawer I Did Not Throw Away',
      subtitle: 'Eleven attempts at a dovetailed drawer, and the one thing that changed on the twelfth.',
      labels: 'woodworking,tools',
      cover: 'first-drawer-dovetails',
      body: `
Eleven drawers went into the offcut bin. Gaps you could post a letter through, tails split at the shoulder, one that racked so badly it would only close from the left. The twelfth is in a cabinet in my sister's kitchen and I am still slightly amazed by it.

The difference was not skill and it was not practice, exactly. It was one procedural change.

## What I was doing

Cutting the tails, then the pins, then paring both to fit. Every attempt, I would pare a little from each side of the joint, chasing a fit, and every attempt the joint would end up loose because I had removed material from both halves.

Eleven times. The classic beginner's oscillation, and I could not see it because each individual cut was defensible.

## What changed

**One reference surface, never touched.** Cut the tails to the line and then *do not touch them again for any reason*. The tail board is now the truth. Every subsequent adjustment happens on the pin board, paring to the marks the tails made.

That is it. That is the whole difference between eleven bins and a drawer.

## Why it generalises

I write software for a living and I had the identical bug there for years: two components that did not quite agree on a format, and I would adjust both, alternately, converging on nothing. The fix is the same — declare one side authoritative, and fix only the other.

> When two things must fit, make exactly one of them the reference. Symmetry feels fair and it is how you chase a gap forever.

## The measurements, for anyone attempting one

- Drawer sides **12 mm**, front **18 mm**. Thinner sides than most instructions suggest, and much easier to saw accurately.
- Baseline scored with a marking knife, not a pencil. A pencil line is 0.5 mm wide and 0.5 mm is the whole tolerance.
- Saw **on the waste side** of the line, always, consistently. Pick a side and never vary.
- Fit dry, once. If it needs a mallet, it is too tight; a dovetail should go together with hand pressure and complain a little.

:::tip The cheapest improvement
Sharpen the chisel. Not metaphorically — actually stop and sharpen it. Nine of my eleven failures had a crushed shoulder from a chisel I had been telling myself was fine for a week.
:::

## Attempt twelve took ninety minutes

Attempt three took four hours. The difference is not speed of hand; it is the absence of chasing. Most of those four hours were spent making a joint worse very carefully.
`,
    },
    {
      slug: 'measure-twice-ship-once',
      title: 'Measure Twice, Ship Once',
      subtitle: 'The workshop proverb is about irreversibility, and software mostly is not — except where it is.',
      labels: 'shipping,business',
      cover: 'measure-twice-ship-once',
      body: `
Everyone quotes *measure twice, cut once*. Fewer people notice what makes it true: a cut is irreversible and cheap to check. That ratio is what justifies the care.

Software is mostly the opposite. Changes are reversible and checking is often expensive. Applying the proverb uniformly is how you get a team that spends three weeks deciding on a button.

## The useful version

Sort the work by whether it is a cut or a clamp.

**Cuts** — irreversible or expensive to reverse:
- Data migrations that drop a column.
- Public API shapes, once a client depends on them.
- Anything that sends an email to customers.
- Pricing, once published.
- A URL scheme you have let people bookmark.

**Clamps** — cheap to undo:
- Almost all interface layout.
- Internal module boundaries.
- Copy, in most places.
- Configuration.
- The first version of essentially any feature.

Measure twice on the cuts. On the clamps, put it in place and look at it, because looking at it is the measurement and no amount of discussion substitutes.

:::note Where I get this wrong
I over-measure clamps and under-measure cuts, consistently, because cuts *look* like small technical decisions and clamps are the ones people have opinions about in meetings. The column drop takes twenty minutes to write and is permanent. The button colour takes a week of conversation and is a repaint.
:::

## The workshop equivalent of a revert

Wood has one: you can usually make a piece shorter. So the real rule in the shop is not *measure twice* but **cut long**. Leave 3 mm and trim to fit against the actual, existing, physical other piece rather than against a number on a drawing.

That has a direct translation. Build the thing slightly more general than you need, fit it against the real adjoining system, and trim. Not *design for every future* — that is cutting long by 200 mm and ending up with a pile of offcuts. Three millimetres.

## The invoice version

Quote long. Trim down on delivery if it went faster. I spent two years quoting exactly and absorbing every surprise myself, out of a sense that a precise quote was more honest. It was less honest: it consistently described a project that could only happen if nothing went wrong, and something always goes wrong.

Now I quote with a named contingency line that I remove when it is not used. Nobody has ever objected, and several clients have said they preferred it.
`,
    },
    {
      slug: 'what-a-dull-chisel-teaches-you',
      title: 'What a Dull Chisel Teaches You About Deadlines',
      subtitle: 'I timed the sharpening. It costs four minutes and saves about forty.',
      labels: 'tools,shipping',
      cover: 'dull-chisel-deadlines',
      body: `
I kept a log for two months, partly out of curiosity and partly to win an argument with myself. Every time I stopped to sharpen, I noted the time it took. Every time I did not stop when I should have, I noted what happened.

## The numbers

- Median sharpening: **4 minutes** on a 1000/6000 stone, including setup and wiping down.
- Sessions where I sharpened when first tempted: **11**. Failures attributable to tool condition: **1**.
- Sessions where I pushed on with a dull edge: **14**. Failures attributable to tool condition: **9**.
- Median time lost to one of those failures: **38 minutes**, and in two cases a piece of wood.

Fifty-six minutes of sharpening across the first group. Roughly five and a half hours lost in the second.

## Why I pushed on anyway

This is the interesting part, because I knew the numbers by week three and kept doing it.

1. **The edge degrades continuously and my judgement is threshold-based.** There is no moment when it becomes dull. There is a long slope on which each individual cut is *almost* fine.
2. **Sharpening is a context switch.** The work is in my hands and the stone is on the other bench, and the cost I feel is not four minutes, it is losing the thread.
3. **The failure is deferred and attributed elsewhere.** When the joint tears out forty minutes later, it feels like bad wood.

Every one of those three has an exact analogue in shipping software, which is why I wrote this down.

## The translation

- The slow degradation: a test suite that gets 4% slower a month. Never a day when it becomes intolerable; eventually nobody runs it.
- The context switch: fixing the flaky test *now* costs the thread you are on, so it gets an issue instead, and the issue is a way of not doing it.
- The deferred attribution: the outage gets blamed on the deploy, not on the six months of not-quite-sharpening that preceded it.

> A dull tool does not fail. It makes you worse, gradually, and lets you keep the blame.

:::tip What actually fixed it for me
I put a stone on the bench I work at. Not the sharpening bench — arm's reach. The four minutes did not change; the context switch went to nearly zero, and my sharpening frequency roughly tripled without any additional discipline.

The software version was a single key binding that runs the one relevant test. Same mechanism, same result.
:::

## The uncomfortable conclusion

I did not solve this with resolve. I solved it by moving the stone, which is to say I accepted that my judgement in the moment is unreliable and rearranged the room so it mattered less. This is how most of my good decisions have gone.
`,
    },
    {
      slug: 'pricing-a-table',
      title: 'Pricing a Table',
      subtitle: 'Four years of getting this wrong, and the arithmetic I use now.',
      labels: 'business,woodworking',
      cover: 'pricing-a-table',
      body: `
The first dining table I sold cost me 340,000 pesos in materials and eleven days of work, and I charged for the materials plus what felt like a reasonable day rate for six days, because it *should* have taken six days.

I lost money on my most successful early project. Here is what I do instead.

## The arithmetic

1. **Materials at actual cost, plus 15% waste.** The waste is not optional and it is not padding — I have never built anything without a board going to the offcut pile.
2. **Hours at a shop rate, not a wage.** The rate has to carry the building, the tools, the insurance, the electricity, and the roughly 30% of my week that is quoting, buying, delivering, and answering email. My wage is a fraction of the shop rate and conflating them is the single most common mistake I see.
3. **Estimate hours, then add 40%.** Measured, not guessed: across 23 projects my estimates ran 38% under. So the 40% is not a cushion, it is a correction for a known bias.
4. **Finishing is its own line.** It is 20–30% of the total hours on a table and it is invisible in the drawing, so clients do not picture it and I used to forget to count it.
5. **Delivery and installation as a fixed fee.** Two people, a van, and stairs.

## What I stopped apologising for

The number. For two years I presented quotes with a small speech about how it was more than a shop-bought table, which trained clients to expect a negotiation. Now the quote is a document: line items, a photograph of a comparable piece, a delivery date, and no adjectives.

Conversion went up. I suspect the speech was reading as doubt.

:::note The discount question
I do not discount the price. I reduce the scope — a simpler apron, a different timber, an oiled finish instead of built-up varnish. Same rate, smaller job. Discounting the rate once means every future quote from me is a negotiation.
:::

## The one I still get wrong

**Bespoke design time.** Three rounds of drawings for a client who then chose the first option is real work that produces nothing to photograph, and I charge for it inconsistently. The clients who take the most design time are also the ones most likely to mention the price, which is presumably not a coincidence.

Current experiment: a small, non-refundable design fee credited against the build. Six clients in, nobody has objected, and two chose a stock design instead — which is a good outcome for everybody.
`,
    },
    {
      slug: 'the-workshop-as-a-build-system',
      title: 'The Workshop as a Build System',
      subtitle: 'Jigs are cached artefacts, offcuts are technical debt, and the bench is your working directory.',
      labels: 'shipping,tools',
      cover: 'workshop-build-system',
      body: `
I have run both a workshop and a software shop for four years now, and the mapping between them has stopped being a cute metaphor and started being how I actually plan work.

## The mapping

- **A jig is a cached build artefact.** Expensive once, nearly free afterwards, and invalidated by a change in inputs. My dovetail marking jig is only valid for 12 mm stock; using it on 15 mm produces a confident, precise, wrong result. Cache invalidation, exactly.
- **The bench is the working directory.** A bench with four projects on it has the same effect as four half-finished branches: nothing can be completed because there is no room to lay out the pieces.
- **Offcuts are technical debt.** Genuinely useful, genuinely accumulating, and past a threshold they cost more in searching than they save in material. I purge twice a year and always feel wrong about it.
- **Sharpening is maintenance you cannot defer, only pay interest on.** Discussed at length elsewhere.
- **Glue-up is deployment.** An irreversible window of about eight minutes during which everything must already be right. You do not think during a glue-up. You rehearse before it, dry, with all the clamps on the bench in order.

## The dry run

That is the practice I have moved most directly into software. Before any glue-up I assemble the whole thing dry, with clamps, and *time it*. Twice I have discovered a piece was upside down; once that the clamps I owned could not reach.

A dry run is not a test of the joinery. It is a test of the *procedure*, under time pressure, with the actual tools, and it is the thing our deploy rehearsals were missing for a year. We tested the migration. We had never once rehearsed the sequence of commands, in order, on a clock, with the person who would actually be running them.

:::warning Where the metaphor fails
Wood does not have a revert. Every piece is unique stock with unique grain, and a mistake is not a lost afternoon, it is a lost board that does not exist anymore. This makes the workshop more conservative than software *should* be, and I have to actively resist importing that caution back into code, where most things are clamps and not cuts.
:::

## What the shop taught the software business

Sequence matters more than speed. A furniture project has a strict order — mill, joint, dry-fit, finish the inside faces *before* assembly, glue, finish the outside — and getting the order wrong costs more than working slowly. Finishing an inside face after assembly is a lesson everyone learns exactly once.

I now write the order down before starting anything in either shop. It takes ten minutes and it is the highest-return ten minutes in my week.
`,
    },
  ],
};

const BLOG_DEVNET_DESK = {
  key: 'devnet-desk',
  owner: 210,
  name: 'The Devnet Desk',
  description: 'Notes from the edge of a test network: proofs, count trees, contract cutovers, and the specific ways a devnet lies to you before it tells the truth.',
  labels: 'devnet,proofs,contracts,notes',
  theme: 'neon',
  commentsEnabledDefault: true,
  posts: [
    {
      slug: 'reading-a-proof-without-crying',
      title: 'Reading a Proof Without Crying',
      subtitle: 'A field guide to the four error messages you will actually see.',
      labels: 'proofs,devnet',
      cover: 'reading-proof-without-crying',
      body: `
Proved queries are wonderful right up to the moment one fails, at which point you get a sentence written for whoever implemented the proof format and not for you. Here are the four I have met most often and what each actually means.

## 1. "a single-path axis read must produce exactly one axis descent"

This is not a bug in your query. It is what an **empty windowed ranking** looks like. You asked for a ranking inside a time bucket that no document has ever landed in, and proving the absence of a whole subtree is not something the format can currently do, so generation fails instead of returning nothing.

Treat it as the empty page. Match the string, return an empty array, move on.

~~~javascript
const COLD_BUCKET = /single-path axis read must produce exactly one axis descent/i;
// ...
catch (error) {
  if (windowed && COLD_BUCKET.test(String(error))) return [];
  throw error;
}
~~~

## 2. "referenced permanent document ... not found"

A reference field names a document that does not exist. Usually a genuine bug, occasionally a **timing** problem: you created the parent and the child in the same breath and the parent's block had not been committed yet. If your writes are fast and your reads are proved, this appears and disappears in ways that look haunted.

Sequence the writes. Read the parent back before referencing it.

## 3. A protocol-version mismatch inside proof verification

Fresh client, fresh devnet, first proved read against a contract on a newer protocol version, and the failure happens *inside* verification rather than at the request. Worse, the addresses you tried get penalised, so your next attempt looks like a network problem.

The cure is a single proved query that does not touch a contract — the current epoch — before anything else. It teaches the client the chain's real version.

## 4. "Quorum not found in cache" / "no available addresses"

The quorum rotated under you. There is no refresh; the trusted context's prefetched keys are stale and nothing will work again. Rebuild the client from scratch. Any code that holds a long-lived client needs to be able to swap it out mid-flight.

:::tip The general rule
A proof failure is a claim about the *shape of the answer*, not about your permissions or your data. Read it as "the format could not express this", and about three quarters of the time that points straight at the cause.
:::
`,
    },
    {
      slug: 'what-a-count-tree-actually-counts',
      title: 'What a Count Tree Actually Counts',
      subtitle: 'One request instead of a hundred, with three conditions nobody tells you.',
      labels: 'contracts,proofs',
      cover: 'count-tree-actually-counts',
      body: `
A countable index turns "how many comments does this post have" from a paginated crawl into a single proved read. It is the best thing in the toolbox. It also has three properties that surprised me.

## It counts index entries, not documents

If the indexed property is absent on a document and the index skips absent values, that document is not in the tree. The count is a count of *rows in that index*, which is usually what you want and is not the same as the number of documents.

## Deletes decrement, and that is not free

On a deletable doctype the tree is maintained on delete as well as create, so counts stay honest. Two consequences worth knowing:

1. A delete costs a little more than you might budget for, because the tree is updated.
2. If the doctype carries a *windowed* index whose bucket has already drained, the delete still works. I expected the missing entry to be required, and it is not — a delete a week later cannot strand a user.

## Grouped counts are one request for the whole page

This is the part that changes page budgets:

~~~javascript
// one request, counts for every post on the page
sdk.documents.count({
  dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostId', 'in', pageIds]],
  groupBy: ['blogPostId'],
});
~~~

The result is keyed by the group value in hex, which you decode yourself. Groups with zero rows are simply absent — do not read a missing key as an error.

:::warning The spelling trap
The three count flags must be written out in full alongside each other. A short spelling passes the offline validator and is rejected at registration, because the meta-schema's dependency rules run on the literal keys and the validator compiles that check out. Lost an afternoon to this.
:::

## What it does not give you

Ranking *within* a subset. The ranked axis is global: you can ask for the twenty most-commented posts across the whole contract, and you cannot ask for the twenty most-commented posts *of one blog*. If you need that, it is a different index or a client-side merge.
`,
    },
    {
      slug: 'notes-from-a-contract-cutover',
      title: 'Notes From a Contract Cutover',
      subtitle: 'Repointing an id is not a migration, and pretending otherwise costs a day.',
      labels: 'contracts,devnet',
      cover: 'notes-contract-cutover',
      body: `
We repointed a contract id in an environment file and redeployed. Everything worked. Nothing was there. Both of those sentences are important.

## What a repoint actually does

It changes which contract the client reads and writes. The documents under the *old* id are untouched, unreachable, and permanent. There is no migration, no redirect, and no tombstone — from the app's point of view the world began ten minutes ago.

On a devnet that is fine and occasionally desirable. The failure mode is believing it is a migration.

## The specific sharp edge

The new schema required a field the old documents did not have. Old records were therefore not merely invisible — they were *unusable even if you pointed at them*, because a child document could not satisfy the new agreement against a parent that lacked the attested field.

So there was no halfway. Not "some features degrade": no path at all from the old data to the new shape, short of re-writing every document.

> An id repoint is a new world. Plan the content, not the migration.

## The checklist we use now

1. Write down the doctypes whose **required** fields changed. Those have no compatibility story.
2. Check every **reference** field. A child under the new id cannot point at a parent under the old one.
3. Check every **count and ranked axis**. They start at zero, and any UI that divides by them needs to survive zero.
4. Re-seed before announcing. An empty surface reads as broken, and people file bugs against the cutover that are actually just emptiness.
5. Confirm who **owns** the registration. Ours was owned by a throwaway identity, which is fine until you want to publish a v3.

:::note The thing that cost the day
A cached contract. The client had the old schema in memory and produced validation errors that described the *old* required fields, against the new id. Twenty minutes of reading an error message about a field that no longer exists. Clear the cache, or restart, before you debug anything after a repoint.
:::
`,
    },
    {
      slug: 'the-week-the-index-lied',
      title: 'The Week the Index Lied',
      subtitle: 'The count was wrong. The count is never wrong. The count was wrong.',
      labels: 'proofs,contracts',
      cover: 'week-the-index-lied',
      body: `
For six days a count came back lower than the number of documents I could see by paging. Proved query, matching contract, correct where clause, wrong answer. I want to write down the diagnosis order because I got it wrong twice before getting it right.

## What I checked, in the order I checked it

1. **My where clause.** Obviously. It was right.
2. **The page scan.** Maybe the paging was double-counting. It was not; ids were unique.
3. **The contract on chain versus the contract in the repo.** Different! But identically so for this doctype — a red herring that cost three hours.
4. **The index definition.** Here it was.

## The actual cause

The index was declared over a property that was **optional** in the schema, and a run of documents had been written without it. Those documents existed, were returned by the page scan on a different index, and had no entry in the count tree at all.

The count was exactly correct about the number of rows in that index. It was not correct about the number of documents, and I had been treating those as synonyms for months.

## The part I am still annoyed about

Nothing in the failure pointed at the index. A count that is *wrong* looks like a bug in counting. A count that is *counting something else* looks identical from the outside, and the only way to see it is to ask what would have to be true for the number to be right.

:::tip The question that resolved it
"What set of documents *would* make this number correct?" 
Answer: the ones written after Tuesday. What changed on Tuesday? The writer started omitting an optional field. That took ninety seconds once I asked it the right way round, after two days of asking whether the count was broken.
:::

## What changed afterwards

- Every countable index in our contracts is now over a **required** property, or the doctype documents loudly why not.
- The writer sets the field explicitly, even to a sentinel, rather than relying on a default.
- Our reconciliation job compares the count against a page scan nightly and shouts about a mismatch. It has fired twice since, both times correctly, both times for this same class of reason.

The index never lied. It answered a question I was not asking, very precisely, for six days.
`,
    },
  ],
};

/** Every blog the seeder knows how to write, in creation order. */
const BLOGS = [
  BLOG_RUNBOOK_DIARIES, BLOG_MARGINALIA, BLOG_BRINE_AND_CRUMB, BLOG_BIT_ROT,
  BLOG_MONSOON_NOTES, BLOG_SHAVINGS, BLOG_QUIET_HOURS, BLOG_DEVNET_DESK,
];

/** Persona indexes that read, comment, and follow but own no blog. */
const AUDIENCE = [211, 212];

/** First names the comment bank addresses authors by, keyed by persona index. */
const FIRST_NAMES = {
  210: 'Bea', 211: 'Rui', 212: 'Lou',
  280: 'Nia', 281: 'Oz', 282: 'Pia', 283: 'Ravi', 284: 'Mei', 285: 'Tomás',
};

/** Posts published without a `publishedAt`, which the app badges as drafts. */
const DRAFTS = new Set(['quiet-hours/the-bakery-light', 'devnet-desk/the-week-the-index-lied']);
/** Posts written with `commentsEnabled: false`. */
const COMMENTS_OFF = new Set(['marginalia/an-inventory-of-interruptions']);
/** Posts deliberately given a long comment thread so "most discussed" ranks. */
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

// ---- Comment bank ------------------------------------------------------------
//
// {first} = the post author's first name, {title} = the post title,
// {blog} = the blog name. Mixed lengths on purpose: the thread views should
// have one-liners next to paragraphs, the way a real comment section does.

const COMMENTS = {
  praise: [
    'This is the best thing I have read on the subject, and I have read a lot of bad things on the subject.',
    'Saved, printed, and pinned above my desk. Thank you {first}.',
    'The last two paragraphs are worth the whole piece.',
    'I have been trying to articulate this for about three years and you did it in one heading. Slightly annoyed, mostly grateful.',
    'Read this twice. The second time was better.',
    '{blog} is the only thing in my reader I open immediately.',
  ],
  question: [
    'Genuine question: how much of this transfers if you are working at a much smaller scale? I have a two-person setup and some of it feels like it needs a team to enforce.',
    'What would you change if you had to do it again from scratch?',
    'Do you have a number for how long this took in practice? The post implies "a while" and I am trying to budget for it.',
    'How did you convince everyone else? That is the part I always fail at.',
    'Is there a version of this that works when you cannot control the environment? Mine is decided by someone else entirely.',
    'Which of the four would you drop if you could only keep three?',
  ],
  addition: [
    'One thing I would add: the same failure shows up on the read path too, and it is much harder to see there because nothing alerts on it. Took us two weeks to spot the equivalent.',
    'Small addition from doing this at a different scale: the numbers hold up, but the ordering matters more than the post lets on. Doing step three before step two cost me a fortnight.',
    'This matches my experience almost exactly, with one difference. The threshold in my case was about half what you found, and I suspect the variable is temperature rather than time.',
    'For anyone trying this: the tool you need is cheaper than it looks and the version that comes with everything is worse than the plain one.',
    'Worth noting the same principle shows up in an entirely different field under a different name, which is usually a sign it is real.',
  ],
  disagree: [
    'Respectfully, I think the third point overstates it. The failure you describe is real but it is not the common case, and the fix you propose has a cost the post does not price.',
    'I disagree with the conclusion and agree with everything leading up to it, which is a frustrating place to end up.',
    'This is right for your context and I would push back on generalising it. The tradeoff flips completely once you are subject to an external deadline you do not control.',
    'Not sure about the second half. Everything before the divider I would sign my name to.',
  ],
  story: [
    'This happened to me almost exactly, except that in my case nobody noticed for four months and the eventual discovery was entirely accidental. I found it while looking for something else, at which point the fix took twenty minutes and the explaining took a week.',
    'Had the same thing on a much smaller scale and drew the wrong conclusion from it for two years. Reading this is a slightly uncomfortable experience.',
    'The bit about pushing on anyway is painfully accurate. I know the numbers. I still do it. I have started moving the equivalent of the stone closer, which is the only thing that has ever worked.',
    'My version of this involved a rented van, two flights of stairs, and a piece that was four millimetres too wide. Everything you wrote about measuring against the real thing is correct and I learned it the expensive way.',
    'I sent this to a colleague who has been arguing the opposite position for six months. No response yet, which I choose to read as agreement.',
  ],
  thanks: [
    'Thank you for leaving the failures in. Nobody does that.',
    'The correction at the bottom is why I trust this blog.',
    'Bookmarking for the next time I have to explain this to someone.',
    'Reading this on a bus and nodding like a lunatic.',
    'Excellent, as always.',
  ],
  followup: [
    'Following up on the earlier comment about scale: I tried it at two people and it does work, with the caveat that you have to write the notes down or nothing survives the week.',
    'Second the point above. The read path is where this bites and it is invisible until it is not.',
    'Coming back to say I tried this and it worked. Two weeks in, no regressions, and the one problem I hit was my own fault.',
    'Update from the person who asked about the timing above: about nine hours in my kitchen, which is well outside the range given. Colder flat, I think.',
    'Re-reading this after the update and it lands differently. Leaving the original paragraph in was the right call.',
  ],
};

const COMMENT_INTENTS = ['praise', 'question', 'addition', 'disagree', 'story', 'thanks'];

/** Fill the bank's slots and hard-fail if a template would exceed the contract. */
function renderComment(template, { authorIdx, title, blogName }) {
  const text = template
    .replaceAll('{first}', FIRST_NAMES[authorIdx] ?? 'there')
    .replaceAll('{title}', title)
    .replaceAll('{blog}', blogName);
  if (text.length > LIMITS.comment) throw new Error(`comment template exceeds ${LIMITS.comment} chars: ${text.slice(0, 60)}…`);
  return text;
}

// ---- Plan (pure) --------------------------------------------------------------

/**
 * The whole run, derived from the bank and the seed with no network I/O — so
 * `--dry-run` validates every field length and chunk count before a single
 * write, and two runs plan identical content.
 */
function buildPlan({ seed, only, publishAnchor }) {
  const rng = makeRng(seed);
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
    const theme = THEMES[blog.theme];
    check(Boolean(theme), `${blog.key}: unknown theme "${blog.theme}"`);
    const themeConfig = compress(theme ?? {});
    check(themeConfig.byteLength <= LIMITS.themeBytes, `${blog.key}: themeConfig is ${themeConfig.byteLength} bytes`);

    blogs.push({
      key: blog.key,
      owner: blog.owner,
      name: blog.name,
      data: {
        name: blog.name,
        description: blog.description,
        labels: blog.labels,
        headerImage: headerUrl(`${blog.key}-header`),
        avatar: avatarUrl(`${blog.key}-avatar`),
        themeConfig,
        commentsEnabledDefault: blog.commentsEnabledDefault,
      },
    });

    // Posts get staggered publishedAt values so the newest blog post is recent
    // and the archive looks like an archive; $createdAt is block time and not
    // ours to choose. The anchor is recorded in the state file so a resume
    // reproduces the same values.
    let daysBack = 3 + rng.int(6);
    for (const post of [...blog.posts].reverse()) {
      const key = `${blog.key}/${post.slug}`;
      const blocks = blocksFromMarkdown(post.body, key);
      const compressed = compress(blocks);
      const { fields, chunks } = chunkFields(compressed);

      check(post.title.length <= LIMITS.postTitle, `${key}: title exceeds ${LIMITS.postTitle}`);
      check((post.subtitle ?? '').length <= LIMITS.postSubtitle, `${key}: subtitle exceeds ${LIMITS.postSubtitle}`);
      check(post.slug.length <= LIMITS.postSlug, `${key}: slug exceeds ${LIMITS.postSlug} (${post.slug.length})`);
      check((post.labels ?? '').length <= LIMITS.postLabels, `${key}: labels exceed ${LIMITS.postLabels}`);
      check(coverUrl(post.cover).length <= LIMITS.image, `${key}: coverImage exceeds ${LIMITS.image}`);
      check(compressed.byteLength <= POST_SIZE_LIMIT, `${key}: compressed content is ${compressed.byteLength} bytes (max ${POST_SIZE_LIMIT})`);
      check(chunks >= 1 && chunks <= MAX_CHUNKS, `${key}: needs ${chunks} chunks (max ${MAX_CHUNKS})`);

      const commentsEnabled = !COMMENTS_OFF.has(key);
      const published = !DRAFTS.has(key);
      // Every blogPost field except the chunked payload. The create and the
      // edit differ only in their data0–dataN, so both spread this.
      const meta = {
        title: post.title,
        ...(post.subtitle ? { subtitle: post.subtitle } : {}),
        ...(post.labels ? { labels: post.labels } : {}),
        coverImage: coverUrl(post.cover),
        commentsEnabled,
        slug: post.slug,
        ...(published ? { publishedAt: publishAnchor - daysBack * 86_400_000 } : {}),
      };
      posts.push({
        key,
        blogKey: blog.key,
        owner: blog.owner,
        slug: post.slug,
        title: post.title,
        words: countWords(blocks),
        chunks,
        bytes: compressed.byteLength,
        commentsEnabled,
        published,
        data: { ...meta, ...fields },
      });

      if (post.edit) {
        const editedBlocks = blocksFromMarkdown(`${post.body}\n${post.edit.appendBody}`, `${key}@edit`);
        const editedBytes = compress(editedBlocks);
        const edited = chunkFields(editedBytes);
        check(editedBytes.byteLength <= POST_SIZE_LIMIT, `${key}@edit: compressed content is ${editedBytes.byteLength} bytes`);
        check(edited.chunks <= MAX_CHUNKS, `${key}@edit: needs ${edited.chunks} chunks`);
        edits.push({
          key: `${key}@edit`, postKey: key, owner: blog.owner, note: post.edit.note,
          chunks: edited.chunks, bytes: editedBytes.byteLength,
          data: { ...meta, ...edited.fields },
        });
      }
      daysBack += 4 + rng.int(9);
    }
  }

  // Comments. Hot posts get long threads so `mostDiscussedPosts` ranks
  // meaningfully; everything else gets a realistic thin tail, and drafts and
  // comments-off posts get none.
  const everyone = [...new Set([...BLOGS.map((b) => b.owner), ...AUDIENCE])].sort((a, b) => a - b);
  const blogNames = new Map(blogs.map((blog) => [blog.key, blog.name]));
  const comments = [];
  for (const post of posts) {
    if (!post.commentsEnabled || !post.published) continue;
    const postRng = makeRng(seedFrom(post.key, 'comments'));
    const hot = HOT_POSTS.get(post.key);
    const count = hot ?? [0, 0, 1, 1, 1, 2, 2, 3][postRng.int(8)];
    if (count === 0) continue;
    const pool = everyone.filter((idx) => idx !== post.owner);
    const authors = postRng.sample(pool, Math.min(count, pool.length));
    for (let i = 0; i < count; i++) {
      const author = authors[i % authors.length];
      // Late entries in a long thread answer the earlier ones.
      const intent = i >= 4 && postRng.next() < 0.6 ? 'followup' : postRng.pick(COMMENT_INTENTS);
      const pick = i === 0 && hot ? 'praise' : intent;
      const content = renderComment(postRng.pick(COMMENTS[pick]), {
        authorIdx: post.owner, title: post.title, blogName: blogNames.get(post.blogKey) ?? '',
      });
      comments.push({ key: `${post.key}#${i}`, postKey: post.key, author, content });
    }
  }

  // Follows: fixed, uneven, self-follows filtered.
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

// ---- State file (.seed-blog.local.json) ---------------------------------------
//
// key → created document id, written after every accepted write, so a resume
// skips what landed. When a key is missing but the document exists (a crash
// between broadcast and save), the chain is read back instead of writing twice.

function loadState(file) {
  if (!existsSync(file)) return { createdAt: new Date().toISOString(), items: {} };
  return JSON.parse(readFileSync(file, 'utf8'));
}

function saveState(file, state) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

// ---- Execution ---------------------------------------------------------------

/** Every persona the plan touches, as a blog owner, a commenter or a follower. */
function planPersonas(plan) {
  return [...new Set([
    ...plan.blogs.map((blog) => blog.owner),
    ...plan.comments.map((comment) => comment.author),
    ...plan.follows.map((follow) => follow.follower),
  ])];
}

/**
 * Runs each actor's tasks strictly in order (one state transition in flight per
 * identity — the contract nonce demands it) while up to `concurrency` actors
 * progress in parallel.
 */
async function runPerActor(tasksByActor, concurrency) {
  const queues = [...tasksByActor.values()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queues.length) {
      const queue = queues[cursor];
      cursor += 1;
      for (const task of queue) await task();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queues.length)) }, worker));
}

/**
 * Groups tasks by the identity that signs them, preserving plan order. Pass
 * `groups` to append to an existing map, so several item lists can share one
 * per-actor queue (a follow, then a comment, then an edit).
 */
function groupByActor(items, actorOf, taskOf, groups = new Map()) {
  for (const item of items) {
    const actor = actorOf(item);
    if (!groups.has(actor)) groups.set(actor, []);
    groups.get(actor).push(() => taskOf(item));
  }
  return groups;
}

function createRecorder({ state, stateFile }) {
  const tally = { created: 0, skipped: 0, recovered: 0, failed: 0 };
  const failures = [];
  return {
    tally,
    failures,
    get(key) { return state.items[key] ?? null; },
    skip(key) { tally.skipped += 1; return state.items[key]; },
    record(key, id, kind = 'created') {
      state.items[key] = id;
      saveState(stateFile, state);
      tally[kind] += 1;
      return id;
    },
    fail(key, error) {
      tally.failed += 1;
      failures.push({ key, error: String(error ?? '').slice(0, 220) });
      return null;
    },
  };
}

async function seed({ battery, plan, state, stateFile, args, tokenId }) {
  const recorder = createRecorder({ state, stateFile });
  /** A state file with nothing in it is a fresh run: no recovery reads needed. */
  const fresh = Object.keys(state.items).length === 0;
  /** A recovery read, skipped on a fresh run because nothing can be on chain. */
  const alreadyOnChain = (lookup) => (fresh ? null : lookup());
  const postByKey = new Map(plan.posts.map((post) => [post.key, post]));
  const actors = new Map();
  const actorFor = async (idx) => {
    if (!actors.has(idx)) actors.set(idx, await battery.personaActor(idx));
    return actors.get(idx);
  };

  await Promise.all(planPersonas(plan).map((idx) => actorFor(idx)));

  // ---- YAPP: one token per comment, bought with credits when the maker
  // transfer was unavailable (the battery's documented fallback).
  const commentsPerAuthor = new Map();
  for (const comment of plan.comments) commentsPerAuthor.set(comment.author, (commentsPerAuthor.get(comment.author) ?? 0) + 1);
  for (const [idx, count] of [...commentsPerAuthor.entries()].sort((a, b) => a[0] - b[0])) {
    const actor = actors.get(idx);
    const target = BigInt(count) * COMMENT_COST + 2n;
    const balance = await battery.ensureYapp(tokenId, actor, target);
    console.log(`  ${actor.label}: ${balance} YAPP (needs ${target} for ${count} comment(s))`);
    if (balance < target) console.log(`  WARNING ${actor.label} is short on YAPP; its comments will be rejected`);
  }

  // ---- blogs (sequential per owner; a blog is the parent of everything else)
  console.log(`\n--- blogs (${plan.blogs.length}) ---`);
  const blogIds = new Map();
  const ownerBlogCache = new Map();
  await runPerActor(groupByActor(plan.blogs, (blog) => blog.owner, async (blog) => {
    const key = `blog:${blog.key}`;
    const known = recorder.get(key);
    if (known) { recorder.skip(key); blogIds.set(blog.key, known); return; }
    const actor = actors.get(blog.owner);
    // `blog` has no unique index, so a lost state entry would duplicate it —
    // match the owner's existing blogs by name before writing.
    const recoverByName = async () => {
      if (!ownerBlogCache.has(blog.owner)) {
        ownerBlogCache.set(blog.owner, await battery.queryDocs('blog', {
          where: [['$ownerId', '==', actor.ownerId]],
          orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 100,
        }));
      }
      const found = ownerBlogCache.get(blog.owner).find((doc) => doc.name === blog.name);
      return found ? battery.b58(found.$id) : null;
    };
    const resumed = await alreadyOnChain(recoverByName);
    if (resumed) {
      blogIds.set(blog.key, recorder.record(key, resumed, 'recovered'));
      console.log(`  = ${blog.key} (already on chain)`);
      return;
    }
    const outcome = await battery.attemptCreate(actor, 'blog', blog.data);
    if (!outcome.ok) { recorder.fail(key, outcome.error); console.log(`  ! ${blog.key}: ${String(outcome.error).slice(0, 140)}`); return; }
    blogIds.set(blog.key, recorder.record(key, outcome.id));
    console.log(`  + ${blog.key} → ${outcome.id} (${actor.label})`);
  }), args.concurrency);

  // ---- posts
  console.log(`\n--- posts (${plan.posts.length}) ---`);
  const postIds = new Map();
  const readyPosts = plan.posts.filter((post) => blogIds.has(post.blogKey));
  await runPerActor(groupByActor(readyPosts, (post) => post.owner, async (post) => {
    const known = recorder.get(post.key);
    if (known) { recorder.skip(post.key); postIds.set(post.key, known); return; }
    const actor = actors.get(post.owner);
    const blogId = blogIds.get(post.blogKey);
    const recoverBySlug = async () => {
      const [found] = await battery.queryDocs('blogPost', {
        where: [['blogId', '==', blogId], ['slug', '==', post.slug]],
        orderBy: [['blogId', 'asc'], ['slug', 'asc']], limit: 1,
      });
      return found ? battery.b58(found.$id) : null;
    };
    const resumed = await alreadyOnChain(recoverBySlug);
    if (resumed) {
      postIds.set(post.key, recorder.record(post.key, resumed, 'recovered'));
      console.log(`  = ${post.key} (already on chain)`);
      return;
    }
    const outcome = await battery.attemptCreate(actor, 'blogPost', {
      blogId: id32(blogId),
      ...post.data,
    });
    if (outcome.ok) {
      postIds.set(post.key, recorder.record(post.key, outcome.id));
      console.log(`  + ${post.key} → ${outcome.id} (${post.words}w, ${post.bytes}B, ${post.chunks} chunk(s)${post.published ? '' : ', draft'})`);
      return;
    }
    // The blogAndSlug index is unique: a duplicate means it landed already.
    const existing = await recoverBySlug();
    if (existing) {
      postIds.set(post.key, recorder.record(post.key, existing, 'recovered'));
      console.log(`  = ${post.key} (recovered after ${String(outcome.error).slice(0, 60)})`);
      return;
    }
    recorder.fail(post.key, outcome.error);
    console.log(`  ! ${post.key}: ${String(outcome.error).slice(0, 180)}`);
  }), args.concurrency);

  // ---- comments, follows and edits all write against existing parents, so
  // they run as one per-actor queue.
  console.log(`\n--- follows (${plan.follows.length}), comments (${plan.comments.length}), edits (${plan.edits.length}) ---`);
  const commentIndex = new Map();
  const commentsOn = async (postId) => {
    if (!commentIndex.has(postId)) {
      const docs = await battery.queryDocs('blogComment', {
        where: [['blogPostId', '==', postId]],
        orderBy: [['blogPostId', 'asc'], ['$createdAt', 'asc']], limit: 100,
      });
      commentIndex.set(postId, docs.map((doc) => ({ id: battery.b58(doc.$id), ownerId: battery.b58(doc.$ownerId), content: doc.content })));
    }
    return commentIndex.get(postId);
  };

  const writeFollow = async (follow) => {
    const key = `follow:${follow.key}`;
    if (recorder.get(key)) { recorder.skip(key); return; }
    const actor = actors.get(follow.follower);
    const blogId = blogIds.get(follow.blogKey);
    const recover = async () => {
      const [found] = await battery.queryDocs('blogFollow', {
        where: [['$ownerId', '==', actor.ownerId], ['blogId', '==', blogId]], limit: 1,
      });
      return found ? battery.b58(found.$id) : null;
    };
    const resumed = await alreadyOnChain(recover);
    if (resumed) { recorder.record(key, resumed, 'recovered'); return; }
    const outcome = await battery.attemptCreate(actor, 'blogFollow', { blogId: id32(blogId) });
    if (outcome.ok) { recorder.record(key, outcome.id); return; }
    const existing = await recover();
    if (existing) { recorder.record(key, existing, 'recovered'); return; }
    recorder.fail(key, outcome.error);
    console.log(`  ! follow ${follow.key}: ${String(outcome.error).slice(0, 160)}`);
  };

  const writeComment = async (comment) => {
    const key = `comment:${comment.key}`;
    if (recorder.get(key)) { recorder.skip(key); return; }
    const actor = actors.get(comment.author);
    const post = postByKey.get(comment.postKey);
    const postId = postIds.get(comment.postKey);
    const resumed = await alreadyOnChain(async () => (await commentsOn(postId))
      .find((doc) => doc.ownerId === actor.ownerId && doc.content === comment.content));
    if (resumed) { recorder.record(key, resumed.id, 'recovered'); return; }
    const outcome = await battery.attemptCreate(actor, 'blogComment', {
      blogPostId: id32(postId),
      // Must equal the post's $ownerId or consensus rejects (40127).
      blogPostOwnerId: id32(actors.get(post.owner).ownerId),
      content: comment.content,
    }, { tokenCost: COMMENT_COST });
    if (outcome.ok) { recorder.record(key, outcome.id); return; }
    recorder.fail(key, outcome.error);
    console.log(`  ! comment ${comment.key}: ${String(outcome.error).slice(0, 160)}`);
  };

  const writeEdit = async (edit) => {
    if (recorder.get(edit.key)) { recorder.skip(edit.key); return; }
    const actor = actors.get(edit.owner);
    const post = postByKey.get(edit.postKey);
    const postId = postIds.get(edit.postKey);
    const current = await battery.fetchDocument('blogPost', postId);
    const revision = BigInt(current?.revision ?? 1);
    // Already edited (by an earlier run whose state file was lost).
    if (revision > 1n) { recorder.record(edit.key, postId, 'recovered'); return; }
    // `edit.data` spreads the same `meta` the create used, so `publishedAt`
    // comes back byte-identical — required, because v2 freezes it (and blogId)
    // and a replace that changed or dropped either is rejected with 40128.
    const outcome = await battery.attemptReplace(actor, 'blogPost', postId, {
      blogId: id32(blogIds.get(post.blogKey)),
      ...edit.data,
    }, revision);
    if (outcome.ok) {
      recorder.record(edit.key, postId);
      console.log(`  ~ edited ${edit.postKey} (rev ${revision + 1n}, ${edit.bytes}B) — ${edit.note}`);
      return;
    }
    recorder.fail(edit.key, outcome.error);
    console.log(`  ! edit ${edit.postKey}: ${String(outcome.error).slice(0, 160)}`);
  };

  // One queue per signer, in this order: an actor's follows, then its comments,
  // then its edits. Items whose parent write failed are dropped.
  const tasks = new Map();
  groupByActor(plan.follows.filter((follow) => blogIds.has(follow.blogKey)), (follow) => follow.follower, writeFollow, tasks);
  groupByActor(plan.comments.filter((comment) => Boolean(postIds.get(comment.postKey))), (comment) => comment.author, writeComment, tasks);
  groupByActor(plan.edits.filter((edit) => Boolean(postIds.get(edit.postKey))), (edit) => edit.owner, writeEdit, tasks);
  await runPerActor(tasks, args.concurrency);
  return { recorder, blogIds, postIds, actors };
}

// ---- Verification -------------------------------------------------------------
//
// Reads back through the shapes the APP uses (lib/services/blog-stats-service.ts
// ranked pages, blog-comment-service.ts grouped counts, blog-follow-service.ts
// counts) rather than through whatever the writes happened to return.

async function verify({ battery, contractId, plan, blogIds, postIds }) {
  const postById = new Map(plan.posts.map((post) => [postIds.get(post.key), post]));

  console.log('\n=== read back through the app\'s query shapes ===');

  // blogStatsService.mostFollowedBlogs()
  const { page: followed } = await battery.ranked('blogFollow', 'blogId', { type: 'count' }, { direction: 'desc' });
  // blogStatsService.trendingBlogs() — the same axis under today's bucket.
  let trending = new Map();
  try {
    const { page } = await battery.ranked('blogFollow', 'blogId', { type: 'count' }, {
      direction: 'desc', timeRange: [{ field: '$createdAt', selector: 'newest', grid: { ...DAY_GRID } }],
    });
    trending = new Map(page.entries.map((entry) => [entry.groupValue, Number(entry.value)]));
  } catch (error) {
    const message = describeErr(error);
    console.log(`trending today: ${COLD_BUCKET.test(message) ? 'cold bucket (empty page, as designed)' : message.slice(0, 160)}`);
  }

  // blogCommentService.countCommentsByPostBatch() — one grouped count.
  const ids = [...postIds.values()].filter(Boolean);
  const commentCounts = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const slice = ids.slice(i, i + 40);
    const grouped = await battery.groupedCount('blogComment', [['blogPostId', 'in', slice]], ['blogPostId'],
      (hex) => bs58.encode(Uint8Array.from(Buffer.from(hex, 'hex'))));
    for (const [id, count] of grouped.entries()) commentCounts.set(id, count);
  }

  const rows = [];
  for (const blog of plan.blogs) {
    const blogId = blogIds.get(blog.key);
    if (!blogId) continue;
    const posts = await battery.queryDocs('blogPost', {
      where: [['blogId', '==', blogId]], orderBy: [['blogId', 'asc'], ['$createdAt', 'desc']], limit: 100,
    });
    const followers = await battery.countBy('blogFollow', [['blogId', '==', blogId]]);
    const comments = [...postIds.entries()]
      .filter(([key]) => key.startsWith(`${blog.key}/`))
      .reduce((sum, [, id]) => sum + (commentCounts.get(id) ?? 0), 0);
    const ranked = battery.groupValueOf(followed, blogId);
    rows.push({
      name: blog.name, key: blog.key, posts: posts.length, followers, comments,
      ranked: ranked ? Number(ranked.value) : 0, today: trending.get(blogId) ?? 0,
    });
  }

  rows.sort((a, b) => b.followers - a.followers || b.comments - a.comments);
  console.log('\nTop blogs (followers from the countable axis, ranked = the "Most followed" page)');
  console.log('  followers  ranked  today  posts  comments  blog');
  for (const row of rows) {
    console.log(`  ${String(row.followers).padStart(9)}  ${String(row.ranked).padStart(6)}  ${String(row.today).padStart(5)}  ${String(row.posts).padStart(5)}  ${String(row.comments).padStart(8)}  ${row.name} (${row.key})`);
  }

  // blogStatsService.mostDiscussedPosts()
  const { page: discussed } = await battery.ranked('blogComment', 'blogPostId', { type: 'count' }, { direction: 'desc', limit: 10 });
  console.log('\nMost discussed posts (ranked commentCount axis)');
  for (const entry of discussed.entries.filter((e) => e.value > 0n).slice(0, 8)) {
    const post = postById.get(entry.groupValue);
    console.log(`  ${String(Number(entry.value)).padStart(3)}  ${post ? `${post.title} [${post.blogKey}]` : `(a post from another run) ${entry.groupValue}`}`);
  }

  // documents.history on every edited post.
  console.log('\nRevision history (documents.history)');
  for (const edit of plan.edits) {
    const postId = postIds.get(edit.postKey);
    if (!postId) continue;
    try {
      const history = await battery.readback(() => battery.sdk.documents.history({
        dataContractId: contractId, documentTypeName: 'blogPost', documentId: postId,
      }));
      const revisions = [...history.values()].map((doc) => Number(doc.toObject().$revision ?? 0));
      console.log(`  ${edit.postKey}: ${history.size} revision(s) [${revisions.join(', ')}]`);
    } catch (error) {
      console.log(`  ${edit.postKey}: history failed — ${describeErr(error).slice(0, 140)}`);
    }
  }

  return rows;
}

// ---- Dry run ------------------------------------------------------------------

function printPlan(plan) {
  const blockTypes = new Map();
  const selected = new Set(plan.blogs.map((blog) => blog.key));
  for (const blog of BLOGS.filter((blog) => selected.has(blog.key))) {
    for (const post of blog.posts) {
      for (const block of blocksFromMarkdown(post.body, `${blog.key}/${post.slug}`)) {
        blockTypes.set(block.type, (blockTypes.get(block.type) ?? 0) + 1);
      }
    }
  }

  for (const blog of plan.blogs) {
    const posts = plan.posts.filter((post) => post.blogKey === blog.key);
    const followers = plan.follows.filter((follow) => follow.blogKey === blog.key).length;
    console.log(`\n${blog.name}  [${blog.key}]  owner=${blog.owner}  followers=${followers}  theme bytes=${blog.data.themeConfig.byteLength}`);
    for (const post of posts) {
      const comments = plan.comments.filter((comment) => comment.postKey === post.key).length;
      const flags = [post.published ? null : 'draft', post.commentsEnabled ? null : 'comments off',
        plan.edits.some((edit) => edit.postKey === post.key) ? 'edited' : null].filter(Boolean);
      console.log(`  ${post.slug.padEnd(46)} ${String(post.words).padStart(4)}w ${String(post.bytes).padStart(5)}B ${post.chunks}ch ${String(comments).padStart(2)}c${flags.length ? `  (${flags.join(', ')})` : ''}`);
    }
  }

  const wordCounts = plan.posts.map((post) => post.words).sort((a, b) => a - b);
  const words = wordCounts.reduce((sum, count) => sum + count, 0);
  const median = wordCounts[Math.floor(wordCounts.length / 2)];
  console.log(`\nblocks by type: ${[...blockTypes.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => `${type}=${count}`).join(' ')}`);
  console.log(`chunk spread: ${[1, 2, 3, 4].map((n) => `${n}→${plan.posts.filter((post) => post.chunks === n).length}`).join(' ')}`);
  console.log(`totals: ${plan.blogs.length} blogs, ${plan.posts.length} posts (${words} words, median ${median}w), ${plan.edits.length} edits, ${plan.comments.length} comments, ${plan.follows.length} follows`);
  console.log(`YAPP required: ${plan.comments.length} (1 per comment)`);
  console.log('\nfirst three blocks of the first post (the shape BlockNote is handed back):');
  console.log(JSON.stringify(blocksFromMarkdown(BLOGS[0].posts[0].body, 'sample').slice(0, 3), null, 1));
}

// ---- Main ---------------------------------------------------------------------

try {
  const args = parseArgs(process.argv.slice(2));
  const state = loadState(args.state);
  state.publishAnchor ??= Date.now();
  const plan = buildPlan({ seed: args.seed, only: args.only, publishAnchor: state.publishAnchor });

  if (args.dryRun) {
    printPlan(plan);
    console.log('\n--dry-run: nothing was written.');
    process.exit(0);
  }

  await ensureInitialized();
  const socialId = socialContractId();
  const handle = createSdkHandle({ contractIds: [socialId, args.contract] });
  const { protocolVersion } = await handle.connect();
  const battery = createBattery({ handle, contractId: args.contract, socialId });
  console.log(`connected (PV${protocolVersion}); blog v2 ${args.contract}; YAPP from ${socialId}`);
  const tokenId = await battery.readback(() => battery.sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));

  let result;
  if (args.verifyOnly) {
    // Replay the state file's ids rather than writing anything.
    const blogIds = new Map(plan.blogs.map((blog) => [blog.key, state.items[`blog:${blog.key}`]]).filter(([, id]) => id));
    const postIds = new Map(plan.posts.map((post) => [post.key, state.items[post.key]]).filter(([, id]) => id));
    const actors = new Map();
    for (const idx of new Set(plan.blogs.map((blog) => blog.owner))) actors.set(idx, await battery.personaActor(idx));
    result = { blogIds, postIds, actors, recorder: null };
  } else {
    console.log(`\n--- YAPP for ${new Set(plan.comments.map((c) => c.author)).size} commenter(s) ---`);
    result = await seed({ battery, plan, state, stateFile: args.state, args, tokenId });
    saveState(args.state, state);
  }

  const rows = await verify({
    battery, contractId: args.contract, plan, blogIds: result.blogIds, postIds: result.postIds,
  });

  console.log('\n=== personas ===');
  const personaIdxs = planPersonas(plan).sort((a, b) => a - b);
  const actorList = await Promise.all(personaIdxs.map(async (idx) => result.actors.get(idx) ?? battery.personaActor(idx)));
  const credits = await battery.readback(() => battery.sdk.identities.balances(actorList.map((actor) => actor.ownerId)));
  for (const actor of actorList) {
    const yapp = await battery.yappBalance(tokenId, actor.ownerId);
    const balance = (credits instanceof Map ? credits.get(actor.ownerId) : undefined) ?? 0n;
    console.log(`  ${actor.label.padEnd(22)} credits=${(Number(balance) / 1e9).toFixed(3)}G  YAPP=${yapp}`);
  }

  if (result.recorder) {
    const { created, skipped, recovered, failed } = result.recorder.tally;
    console.log(`\nwrites: ${created} created, ${recovered} recovered, ${skipped} already done, ${failed} failed`);
    for (const failure of result.recorder.failures) console.log(`  FAILED ${failure.key}: ${failure.error}`);
    console.log(`state: ${args.state}`);
    process.exit(failed === 0 ? 0 : 1);
  }
  process.exit(rows.length > 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
