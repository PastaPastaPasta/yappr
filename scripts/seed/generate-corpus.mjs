#!/usr/bin/env node
/**
 * Corpus generator for the devnet mass seed.
 *
 *   node scripts/seed/generate-corpus.mjs --users 1000 --posts 100000 --ops 1000000 \
 *        --seed 42 --out .seed-corpus.local/mass [--banks .seed-corpus.local/banks] \
 *        [--topology v6] [--mix likes=0.55,replies=0.2,...] [--quiet]
 *   node scripts/seed/generate-corpus.mjs --self-test
 *
 * Writes <out>.personas.json, <out>.corpus.jsonl, <out>.summary.json, then
 * re-reads both and validates them with seed-lib's loadPersonas/parseCorpus
 * (the exact validators run-seeder.mjs uses) — any violation is fatal.
 *
 * Model (see GENERATOR.md for the knobs):
 *   personas   30 archetypes (weights in corpus-archetypes.mjs), heavy-tailed
 *              activity, three fixed hero personas (alice7 / bob8 / carol9).
 *   follows    preferential attachment + interest homophily; follower count = reach.
 *   posts      author ~ activity (Zipf-like); content composed from claude-authored
 *              banks (or the built-in fallback) with slot fills and per-persona tics;
 *              trending bursts, Dash lore, media, links, hashtags.
 *   engagement per-post λ = lognormal(quality) × reach^0.8, calibrated so the
 *              like budget lands on the --mix target and ~45% of posts get 0 likes;
 *              replies/quotes/reposts/bookmarks/likeReply derive from λ.
 *   hero       exact product-owner thread, top like count by ≥2× over the runner-up.
 *   timeline   every op gets a virtual position; engagement trails its target by a
 *              heavy-tailed delay; follows sit mostly in the first ~4% of lines.
 *
 * Deterministic for a given --seed (own PRNG; never Math.random).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ARCHETYPES, ARCHETYPE_KEYS, BLOCK_HEIGHT_BASE, BLOCK_HEIGHT_LINES, CITIES, DASH_LORE, DEFAULT_INTENTS, EMOJI_SETS,
  FALLBACK_BANK, FIRST_NAMES, GENERIC_FALLBACK, GLOBAL_SLOTS, HASHTAG_UNIVERSE, HERO_ANSWERS, HERO_FALLBACK, INTENTS, INTENT_BIAS,
  LAST_NAMES, LINK_LINES, TREND_CANDIDATES, TREND_LINES,
} from './corpus-archetypes.mjs';
import { loadBanks } from './author-banks.mjs';
import { CONTENT_MAX, HASHTAG_MAX, expandedContentLength, loadPersonas, parseCorpus, validateHandle } from './seed-lib.mjs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

export const DEFAULT_MIX = {
  quoteShare: 0.10, // share of --posts that are quotes
  replies: 0.20, // shares of --ops
  likes: 0.55,
  likeReply: 0.08,
  repost: 0.03,
  follow: 0.035,
  bookmark: 0.005,
};

function parseMix(s) {
  const mix = { ...DEFAULT_MIX };
  if (!s || s === true) return mix;
  for (const kv of String(s).split(',')) {
    const [k, v] = kv.split('=');
    if (!(k in mix)) throw new Error(`unknown --mix key "${k}" (known: ${Object.keys(mix).join(', ')})`);
    mix[k] = Number(v);
  }
  return mix;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG + distributions
// ---------------------------------------------------------------------------
export function makeRng(seed) {
  // sfc32 seeded via splitmix of the numeric seed
  let a = 0x9e3779b9 ^ seed;
  let b = 0x243f6a88 ^ (seed * 0x85ebca6b);
  let c = 0xb7e15162 ^ (seed << 7);
  let d = seed >>> 0 || 1;
  const rand = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 20; i += 1) rand();
  const rng = {
    rand,
    int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
    chance: (p) => rand() < p,
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    normal: () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = rand();
      while (v === 0) v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    lognormal: (mu, sigma) => Math.exp(mu + sigma * rng.normal()),
    poisson: (lambda) => {
      if (lambda <= 0) return 0;
      if (lambda > 60) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.normal()));
      const L = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do { k += 1; p *= rand(); } while (p > L);
      return k - 1;
    },
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    weighted: (weights) => {
      let total = 0;
      for (const w of weights) total += w;
      let r = rand() * total;
      for (let i = 0; i < weights.length; i += 1) {
        r -= weights[i];
        if (r <= 0) return i;
      }
      return weights.length - 1;
    },
  };
  return rng;
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------
const HERO_PERSONAS = [
  {
    idx: 0, handle: 'alice7', displayName: 'Alice', archetype: 'dashdev',
    bio: 'Builds on Dash Platform. Thinks the interesting question is always who gets to see the database. Verify, then trust, then verify again.',
    location: 'Zürich, Switzerland', website: 'https://docs.dash.org/projects/platform', avatarSeed: 'alice7-rootHash',
    style: 'clear and aphoristic, short declarative sentences, one idea per post, no emoji, asks questions she already knows the answer to, never uses more words than needed',
    interests: ['dash platform', 'merkle proofs', 'databases', 'hiking', 'espresso'], activity: 2.2,
    tics: { lowercase: false, typos: 0, emojiRate: 0, prestige: 16 },
  },
  {
    idx: 1, handle: 'bob8', displayName: 'Bob', archetype: 'techie',
    bio: 'Backend engineer who got nerd-sniped by Merkle proofs and never recovered. Explains things twice: once badly, once well.',
    location: 'Manchester, UK', website: 'https://github.com/dashpay/platform', avatarSeed: 'bob8-nerdsniped',
    style: 'friendly and enthusiastic, explains with analogies, occasional exclamation mark, no emoji, replies to everything he understands and half of what he does not',
    interests: ['distributed systems', 'open source', 'cycling', 'board games', 'dash platform'], activity: 2.4,
    tics: { lowercase: false, typos: 0, emojiRate: 0, prestige: 9 },
  },
  {
    idx: 2, handle: 'carol9', displayName: 'Carol', archetype: 'skeptic',
    bio: 'Product person. Runner. Will ask the obvious question so you don\'t have to. Currently learning what a Merkle proof is, apparently.',
    location: 'Toronto, ON', avatarSeed: 'carol9-obviousquestion',
    style: 'curious, lowercase, asks the obvious question, friendly skeptic, short, occasional emoji, admits when she was wrong',
    interests: ['product', 'running', 'coffee', 'user research', 'payments'], activity: 1.9,
    tics: { lowercase: true, typos: 0.05, emojiRate: 0.15, prestige: 6 },
  },
];

// Per-archetype tic probabilities: P(persona writes all-lowercase), P(persona
// makes typos), emoji rate range, P(persona has a signature tail).
const STYLE_PROFILE = {
  dashdev: { lower: 0.6, typos: 0.1, emoji: [0, 0], tail: 0.2 },
  masternode: { lower: 0.2, typos: 0.1, emoji: [0, 0], tail: 0.4 },
  merchant: { lower: 0.1, typos: 0.15, emoji: [0.1, 0.4], tail: 0.5 },
  skeptic: { lower: 0.05, typos: 0.0, emoji: [0, 0], tail: 0.3 },
  privacy: { lower: 0.8, typos: 0.05, emoji: [0, 0], tail: 0.2 },
  venezuela: { lower: 0.3, typos: 0.15, emoji: [0.1, 0.4], tail: 0.4 },
  memer: { lower: 0.95, typos: 0.5, emoji: [0, 0.3], tail: 0.1 },
  foodie: { lower: 0.1, typos: 0.15, emoji: [0.2, 0.6], tail: 0.4 },
  gamer: { lower: 0.4, typos: 0.25, emoji: [0, 0.3], tail: 0.4 },
  fitness: { lower: 0.1, typos: 0.2, emoji: [0.2, 0.6], tail: 0.5 },
  musician: { lower: 0.85, typos: 0.2, emoji: [0, 0.3], tail: 0.4 },
  photographer: { lower: 0.9, typos: 0.0, emoji: [0, 0], tail: 0.1 },
  traveler: { lower: 0.3, typos: 0.2, emoji: [0.1, 0.4], tail: 0.4 },
  student: { lower: 0.6, typos: 0.3, emoji: [0, 0.3], tail: 0.3 },
  parent: { lower: 0.2, typos: 0.2, emoji: [0.1, 0.4], tail: 0.3 },
  smallbiz: { lower: 0.1, typos: 0.15, emoji: [0.1, 0.4], tail: 0.5 },
  sportsfan: { lower: 0.3, typos: 0.3, emoji: [0.1, 0.4], tail: 0.4 },
  bookworm: { lower: 0.05, typos: 0.0, emoji: [0, 0], tail: 0.3 },
  maker: { lower: 0.2, typos: 0.1, emoji: [0, 0], tail: 0.3 },
  localnews: { lower: 0.1, typos: 0.05, emoji: [0, 0], tail: 0.4 },
  economist: { lower: 0.0, typos: 0.0, emoji: [0, 0], tail: 0.4 },
  artist: { lower: 0.5, typos: 0.1, emoji: [0.1, 0.4], tail: 0.3 },
  gardener: { lower: 0.0, typos: 0.05, emoji: [0, 0.3], tail: 0.7 },
  filmbuff: { lower: 0.2, typos: 0.05, emoji: [0, 0.1], tail: 0.4 },
  scientist: { lower: 0.1, typos: 0.0, emoji: [0, 0], tail: 0.3 },
  techie: { lower: 0.4, typos: 0.15, emoji: [0, 0.3], tail: 0.3 },
  outdoors: { lower: 0.3, typos: 0.15, emoji: [0.1, 0.4], tail: 0.4 },
  petlover: { lower: 0.3, typos: 0.2, emoji: [0.3, 0.7], tail: 0.4 },
  finance: { lower: 0.1, typos: 0.0, emoji: [0, 0], tail: 0.5 },
  lurker: { lower: 0.7, typos: 0.3, emoji: [0, 0.3], tail: 0.1 },
};

const TITLE_TOKENS = new Set(['dr.', 'dr', 'mr.', 'mrs.', 'ms.', 'prof.', 'big', 'coach', 'chef', 'the']);
export function firstNameOf(persona) {
  const tokens = persona.displayName.split(/\s+/).filter(Boolean);
  const t = tokens.find((x) => !TITLE_TOKENS.has(x.toLowerCase())) ?? tokens[0] ?? persona.handle;
  return t.replace(/[^\p{L}\p{N}.'-]/gu, '') || persona.handle;
}

function asciiSlug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HANDLE_WORDS = ['codes', 'eats', 'lens', 'gains', 'dev', 'econ', 'posts', 'beats', 'campus', 'plots', 'reads', 'makes', 'runs', 'rides', 'shoots',
  'writes', 'bakes', 'lifts', 'hikes', 'draws', 'paints', 'grows', 'trades', 'plays', 'sings', 'cooks', 'walks', 'builds', 'ships', 'votes', 'nodes',
  'pays', 'mixes', 'brews', 'prints', 'cuts', 'stitches', 'rolls', 'jams', 'loops', 'snaps', 'films', 'notes', 'maps', 'trains', 'ferries', 'blocks',
  'proofs', 'roots', 'stacks', 'bits', 'bytes', 'seeds', 'soil', 'bees', 'birds', 'dogs', 'cats', 'reels', 'pages', 'plates', 'pixels', 'synths', 'vinyl',
  'tea', 'coffee', 'oats', 'fog', 'dawn', 'north', 'south', 'east', 'west', 'lab', 'shop', 'desk', 'bench', 'trail', 'ridge', 'pitch', 'court', 'lane'];

function makeHandle(rng, first, last, archetype, taken) {
  const f = asciiSlug(first).slice(0, 10) || 'user';
  const l = asciiSlug(last).slice(0, 10) || 'x';
  const digit = () => String(rng.int(2, 9));
  const word = () => rng.pick(HANDLE_WORDS);
  const tagWord = () => asciiSlug(rng.pick(ARCHETYPES[archetype].interests).split(' ')[0]).slice(0, 8) || word();
  const patterns = [
    () => `${f}-${word()}${digit()}`,
    () => `${f}${digit()}${digit()}`,
    () => `${f}-${tagWord()}${digit()}`,
    () => `${word()}-${f}${digit()}`,
    () => `${f}${l.slice(0, 1)}${digit()}${rng.int(0, 9)}`,
    () => `${f}-${l}${digit()}`,
    () => `${tagWord()}${f}${digit()}`,
    () => `${f}${rng.int(1980, 2009)}`.replace(/(\d{4})$/, (y) => (/[2-9]/.test(y) ? y : `${y.slice(0, 3)}${digit()}`)),
    () => `${f}-${word()}-${digit()}`,
    () => `${l}-${word()}${digit()}`,
  ];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    let h = rng.pick(patterns)().replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (h.length > 19) h = h.slice(0, 19).replace(/-$/, '');
    if (h.length < 3) continue;
    if (!/[2-9]/.test(h)) h = `${h.slice(0, 18)}${digit()}`;
    if (validateHandle(h) === null && !taken.has(h)) return h;
  }
  // Deterministic last resort.
  for (let i = 2; i < 999; i += 1) {
    const h = `${f.slice(0, 14)}-${i}${digit()}`.slice(0, 19);
    if (validateHandle(h) === null && !taken.has(h)) return h;
  }
  throw new Error(`could not derive a unique handle for ${first} ${last}`);
}

function activitySample(rng) {
  // ~15% near-lurkers; the rest lognormal, heavy right tail, clipped.
  if (rng.chance(0.15)) return Number((0.03 + rng.rand() * 0.12).toFixed(3));
  const a = 0.55 * rng.lognormal(0, 0.9);
  return Number(Math.min(8, Math.max(0.12, a)).toFixed(3));
}

const NICKNAME_STYLES = [
  (first) => first.toLowerCase(),
  (first) => `${first.toUpperCase()}.WAV`,
  (first) => `Big ${first}`,
  (first, last) => `${first} ${last[0]}.`,
  (first) => `${first.toLowerCase()}${'_'.repeat(0)}`,
  (first) => `${first} (real)`,
  (first, last) => `${last} & Co.`,
  (first) => `${first} of the North`,
  (first) => `just ${first.toLowerCase()}`,
  (first) => `Coach ${first}`,
  (first) => `Dr. ${first}`,
  (first) => `${first}, allegedly`,
];

export function buildPersonas(rng, users, bankSlots) {
  const personas = [];
  const takenHandles = new Set();
  const takenNames = new Set();
  const archetypeWeights = ARCHETYPE_KEYS.map((k) => ARCHETYPES[k].weight);

  const fillSlots = makeSlotFiller(rng, bankSlots ?? {});

  for (const hero of HERO_PERSONAS) {
    const { tics, archetype, ...persona } = hero;
    takenHandles.add(persona.handle);
    takenNames.add(persona.displayName.toLowerCase());
    personas.push({ ...persona, archetype, tics: { ...tics, tail: null, bits: [] } });
  }

  let errorsDevAssigned = false;
  let heightBitAssigned = false;
  let firstLoop = 0;
  while (personas.length < users) {
    firstLoop += 1;
    if (firstLoop > users * 50) throw new Error('persona generation stalled (name space exhausted?)');
    const archetype = ARCHETYPE_KEYS[rng.weighted(archetypeWeights)];
    const A = ARCHETYPES[archetype];
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let displayName = `${first} ${last}`;
    if (rng.chance(0.18)) displayName = rng.pick(NICKNAME_STYLES)(first, last);
    if (displayName.length > 50 || takenNames.has(displayName.toLowerCase())) continue;
    takenNames.add(displayName.toLowerCase());
    const handle = makeHandle(rng, first, last, archetype, takenHandles);
    takenHandles.add(handle);

    const profile = STYLE_PROFILE[archetype];
    const cityFull = rng.pick(CITIES);
    const city = cityFull.split(',')[0];
    const slotsCtx = { city, handle };
    let bio = fillSlots(rng.pick(A.bios), slotsCtx);
    if (bio.length > 160) bio = `${bio.slice(0, 157).replace(/\s+\S*$/, '')}...`;
    const persona = {
      idx: personas.length,
      handle,
      displayName,
      avatarSeed: `${handle}-${rng.pick(A.picsum)}`,
      style: '',
      interests: [],
      activity: archetype === 'lurker' ? Number((activitySample(rng) * 0.35).toFixed(3)) : activitySample(rng),
      archetype,
    };
    if (bio.length > 0) persona.bio = bio;
    if (rng.chance(0.85)) persona.location = cityFull.slice(0, 50);
    if (A.websites && rng.chance(0.35)) persona.website = rng.pick(A.websites).replace('{handle}', handle.replace(/-/g, ''));
    else if (rng.chance(0.08)) persona.website = `https://${handle.replace(/-/g, '')}.example.org`;

    const traits = rng.shuffle(A.styleTraits.filter((t) => !/emoji|lowercase/i.test(t))).slice(0, rng.int(2, 4));
    const lowercase = rng.chance(profile.lower);
    const typos = rng.chance(profile.typos) ? 0.15 + rng.rand() * 0.25 : 0;
    const emojiRate = profile.emoji[1] > 0 && (EMOJI_SETS[archetype] ?? []).length > 0 && rng.chance(0.7)
      ? profile.emoji[0] + rng.rand() * (profile.emoji[1] - profile.emoji[0])
      : 0;
    const styleBits = [...traits];
    if (lowercase) styleBits.push('all lowercase');
    if (typos > 0) styleBits.push('occasional typos');
    styleBits.push(emojiRate > 0 ? (emojiRate > 0.4 ? 'emoji often' : 'emoji sometimes') : 'no emoji');
    const bits = [];
    if (archetype === 'dashdev' && !errorsDevAssigned) { bits.push('errors'); errorsDevAssigned = true; styleBits.push('quotes error messages verbatim'); }
    if ((archetype === 'masternode' || archetype === 'dashdev') && !heightBitAssigned && personas.length > 20) { bits.push('blockheight'); heightBitAssigned = true; styleBits.push('posts the current block height as a running bit'); }
    persona.style = [...new Set(styleBits)].join(', ');
    const interests = rng.shuffle([...A.interests]).slice(0, rng.int(3, 5));
    persona.interests = interests;
    persona.tics = { lowercase, typos, emojiRate, prestige: 0, tail: null, bits };
    personas.push(persona);
  }
  if (!heightBitAssigned) {
    const cand = personas.find((p) => p.idx > 2 && (p.archetype === 'masternode' || p.archetype === 'dashdev' || p.archetype === 'techie'));
    if (cand) { cand.tics.bits.push('blockheight'); cand.style += ', posts the current block height as a running bit'; }
  }
  return personas;
}

// ---------------------------------------------------------------------------
// Follow graph — preferential attachment + interest homophily
// ---------------------------------------------------------------------------
export function buildFollowGraph(rng, personas, totalFollows) {
  const n = personas.length;
  const following = personas.map(() => new Set());
  const followers = personas.map(() => []);
  const byArchetype = {};
  personas.forEach((p) => { (byArchetype[p.archetype] ??= []).push(p.idx); });

  // prestige: how attractive an account is to follow, independent of its activity
  const prestige = personas.map((p) => {
    const fixed = p.tics?.prestige ?? 0;
    const base = Math.pow(Math.max(p.activity, 0.05), 0.7) * (fixed > 0 ? 1.3 : rng.lognormal(0, 0.9));
    return base * (1 + fixed);
  });
  // out-degree ∝ activity^0.5 with noise, normalized to totalFollows
  const outRaw = personas.map((p) => Math.pow(Math.max(p.activity, 0.05), 0.5) * rng.lognormal(0, 0.6));
  const outSum = outRaw.reduce((s, x) => s + x, 0);
  const outDeg = outRaw.map((x) => Math.min(n - 1, Math.max(2, Math.round((x / outSum) * totalFollows))));

  // attachment urn: each idx appears ceil(prestige*4)+1 times, then grows with in-degree
  const urn = [];
  for (let i = 0; i < n; i += 1) {
    const reps = Math.ceil(Math.pow(prestige[i], 1.4) * 4) + 1;
    for (let r = 0; r < reps; r += 1) urn.push(i);
  }
  const order = rng.shuffle(personas.map((p) => p.idx));
  const edges = [];
  for (const u of order) {
    const want = outDeg[u];
    const mine = byArchetype[personas[u].archetype];
    let attempts = 0;
    while (following[u].size < want && attempts < want * 30) {
      attempts += 1;
      let v;
      const r = rng.rand();
      if (r < 0.7) v = rng.pick(urn);
      else if (r < 0.92) v = rng.pick(mine);
      else v = rng.int(0, n - 1);
      if (v === u || following[u].has(v)) continue;
      following[u].add(v);
      followers[v].push(u);
      edges.push([u, v]);
      urn.push(v);
      if (rng.chance(0.12) && !following[v].has(u) && following[v].size < n - 1) {
        // reciprocation
        following[v].add(u);
        followers[u].push(v);
        edges.push([v, u]);
      }
    }
  }
  return { following, followers, edges, byArchetype };
}

// ---------------------------------------------------------------------------
// Slot filling / text composition
// ---------------------------------------------------------------------------
function makeSlotFiller(rng, customSlots) {
  const priceFmt = () => {
    const r = rng.rand();
    if (r < 0.4) return `${rng.int(2, 9)}.${rng.pick(['50', '20', '80', '90', '00'])}`;
    if (r < 0.8) return String(rng.int(10, 95));
    return String(rng.int(100, 900));
  };
  return (template, ctx = {}) => template.replace(/\{([A-Za-z]+)\}/g, (m, slot, offset) => {
    const digitFollows = /^\d/.test(template.slice(offset + m.length));
    if (slot === 'name') return ctx.name ?? 'friend';
    if (slot === 'height') return String(ctx.height ?? BLOCK_HEIGHT_BASE);
    if (slot === 'city') return ctx.city ?? rng.pick(CITIES).split(',')[0];
    if (slot === 'handle') return ctx.handle ?? 'someone';
    if (slot === 'year') return String(rng.int(2013, 2025));
    if (slot === 'n') return String(rng.int(2, 12));
    if (slot === 'nn') return String(rng.int(10, 99));
    if (slot === 'big') { const v = rng.int(100, 9999); return v >= 1000 && !digitFollows && rng.chance(0.5) ? v.toLocaleString('en-US') : String(v); }
    if (slot === 'pct') return String(rng.int(5, 95));
    if (slot === 'price') return priceFmt();
    if (ctx.slots && Array.isArray(ctx.slots[slot]) && ctx.slots[slot].length) return rng.pick(ctx.slots[slot]);
    if (Array.isArray(customSlots[slot]) && customSlots[slot].length) return rng.pick(customSlots[slot]);
    if (Array.isArray(GLOBAL_SLOTS[slot]) && GLOBAL_SLOTS[slot].length) return rng.pick(GLOBAL_SLOTS[slot]);
    return m.slice(1, -1);
  });
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;

function applyTypo(rng, text) {
  const words = text.split(' ');
  const idxs = words.map((w, i) => (w.length >= 5 && /^[a-z]+$/i.test(w) ? i : -1)).filter((i) => i >= 0);
  if (idxs.length === 0) return text.replace(/'/, '');
  const i = rng.pick(idxs);
  const w = words[i];
  const k = rng.int(1, w.length - 3);
  words[i] = w.slice(0, k) + w[k + 1] + w[k] + w.slice(k + 2);
  return words.join(' ');
}

function lowercaseKeep(text) {
  // Lowercase but keep obvious proper nouns / acronyms that are all-caps tokens of 2-6 letters.
  return text.replace(/\S+/g, (tok) => (/^[A-Z0-9]{2,6}$/.test(tok) && tok !== 'I' ? tok : tok.toLowerCase()));
}

// A Deck deals lines from a pool in shuffled order and reshuffles when
// exhausted, so no line is used k+1 times before every line is used k times.
// Keyed by pool identity so the same array always maps to the same deck.
function makeDecks(rng) {
  const decks = new Map();
  return (pool) => {
    if (!Array.isArray(pool) || pool.length === 0) return undefined;
    let d = decks.get(pool);
    if (!d) { d = { order: rng.shuffle(pool.map((_, i) => i)), pos: 0 }; decks.set(pool, d); }
    if (d.pos >= d.order.length) { rng.shuffle(d.order); d.pos = 0; }
    return pool[d.order[d.pos++]];
  };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------
export function generate(opts) {
  const {
    users, posts: postTarget, ops: opsTarget, seed, topology = 'v6', mix = DEFAULT_MIX, banksDir, loadedBanks = null, log = () => {},
  } = opts;
  const rng = makeRng(seed);
  const deal = makeDecks(rng);
  const hashtagMax = HASHTAG_MAX[topology];

  // --- banks ---------------------------------------------------------------
  const { banks: authored, missing, files } = loadedBanks ?? (existsSync(banksDir) ? loadBanks(banksDir) : { banks: {}, missing: [...ARCHETYPE_KEYS, 'generic', 'hero', 'dashlore', 'trends'], files: [] });
  const bankOf = (key) => authored[key] ?? FALLBACK_BANK[key] ?? FALLBACK_BANK.lurker;
  const generic = authored.generic ?? GENERIC_FALLBACK;
  const heroBank = authored.hero ?? HERO_FALLBACK;
  const lore = {
    general: [...DASH_LORE.general, ...(authored.dashlore?.general ?? [])],
    dev: [...DASH_LORE.dev, ...(authored.dashlore?.dev ?? [])],
    verify: [...(authored.dashlore?.verify ?? [])],
  };
  const trendLines = (tag) => [...(TREND_LINES[tag] ?? []), ...(authored.trends?.[tag] ?? [])];
  const trendPools = Object.fromEntries(TREND_CANDIDATES.map((t) => [t, trendLines(t)]));
  const errorLines = [...new Set([...(authored.dashdev?.posts ?? FALLBACK_BANK.dashdev.posts), ...DASH_LORE.dev, ...(authored.dashlore?.dev ?? [])])].filter((l) => /`|Error|error\[|panicked|failed|mismatch/i.test(l));
  const customSlots = {};
  for (const key of ARCHETYPE_KEYS) for (const [s, v] of Object.entries(bankOf(key).slots ?? {})) customSlots[s] = [...(customSlots[s] ?? []), ...v];
  const fill = makeSlotFiller(rng, customSlots);
  const bankSource = missing.length === ARCHETYPE_KEYS.length + 4 ? 'fallback' : missing.length ? 'mixed' : 'claude';
  const distinctBankLines = new Set();
  for (const key of ARCHETYPE_KEYS) { const b = bankOf(key); b.posts.forEach((l) => distinctBankLines.add(l)); }
  generic.posts.forEach((l) => distinctBankLines.add(l));
  lore.general.forEach((l) => distinctBankLines.add(l));
  lore.dev.forEach((l) => distinctBankLines.add(l));
  for (const t of TREND_CANDIDATES) trendLines(t).forEach((l) => distinctBankLines.add(l));

  // --- personas + graph ----------------------------------------------------
  const personas = buildPersonas(rng, users, customSlots);
  // Adaptive generic share: archetypes whose expected post volume dwarfs their
  // bank draw more from the voice-neutral generic pool, so per-line reuse is
  // balanced across archetypes instead of concentrated on the small banks.
  const activityByArchetype = {};
  let activitySum = 0;
  for (const p of personas) { activityByArchetype[p.archetype] = (activityByArchetype[p.archetype] ?? 0) + p.activity; activitySum += p.activity; }
  const totalLines = ARCHETYPE_KEYS.reduce((s, k) => s + bankOf(k).posts.length, 0) + generic.posts.length;
  const targetReuse = postTarget / Math.max(1, totalLines);
  const genericShare = {};
  for (const k of ARCHETYPE_KEYS) {
    const expectedPosts = ((activityByArchetype[k] ?? 0) / Math.max(1e-9, activitySum)) * postTarget;
    const lines = bankOf(k).posts.length;
    const g = expectedPosts > 0 ? 1 - (targetReuse * lines) / expectedPosts : 0.3;
    genericShare[k] = Math.min(0.75, Math.max(k === 'lurker' ? 0.5 : 0.12, g));
  }
  for (const p of personas) {
    const prof = STYLE_PROFILE[p.archetype];
    if (rng.chance(prof.tail)) p.tics.tail = rng.pick(bankOf(p.archetype).tails ?? ['anyway']);
  }
  const firstNames = personas.map(firstNameOf);
  const followTarget = Math.round(opsTarget * mix.follow);
  const { following, followers, edges: followEdges, byArchetype } = buildFollowGraph(rng, personas, followTarget);
  const followerCount = followers.map((f) => f.length);
  const activityUrn = [];
  personas.forEach((p) => { for (let r = 0; r < Math.ceil(p.activity * 4); r += 1) activityUrn.push(p.idx); });

  // --- timeline plumbing ---------------------------------------------------
  const L = opsTarget; // virtual line space
  const ops = []; // {t, s, o}
  let seq = 0;
  const emit = (t, o) => { ops.push({ t, s: seq++, o }); return o; };
  const delay = (median, sigma = 1.1) => Math.max(1, rng.lognormal(Math.log(median), sigma));

  const contents = new Set();
  let dupRescues = 0;
  const lineUse = new Map();
  const useLine = (line) => lineUse.set(line, (lineUse.get(line) ?? 0) + 1);

  // --- post bookkeeping -----------------------------------------------------
  let postCounter = 0;
  let replyCounter = 0;
  const postRefs = []; // {ref, author, t, hashtag, likers:Set, reposters:Set, bookmarkers:Set, likes}
  const postByRef = new Map();
  const likeCount = new Map(); // ref -> n
  const replyLikeCount = new Map();
  const replyCountByRoot = new Map();
  const perAuthorYapp = new Array(users).fill(0);
  const counts = { post: 0, quote: 0, reply: 0, like: 0, likeReply: 0, repost: 0, follow: 0, bookmark: 0 };
  const tagCounts = new Map();
  let mediaPosts = 0;
  let sensitivePosts = 0;
  let linkPosts = 0;
  let lorePosts = 0;
  let trendPosts = 0;
  let quotesWithEmoji = 0;

  // --- follows: 80% in the first ~4% of the stream, the rest spread --------
  for (const [u, v] of followEdges) {
    const t = rng.chance(0.85) ? rng.rand() * L * 0.025 : rng.rand() * L;
    emit(t, { type: 'follow', author: u, target: v });
    counts.follow += 1;
  }

  // --- hashtag weights ------------------------------------------------------
  const universeRank = new Map(HASHTAG_UNIVERSE.map((t, i) => [t, i]));
  const tagWeight = (t) => 1 / Math.pow((universeRank.get(t) ?? 60) + 3, 0.8);
  const archetypeTagChoices = {};
  for (const key of ARCHETYPE_KEYS) {
    const tags = ARCHETYPES[key].tags.filter((t) => universeRank.has(t) && t.length <= hashtagMax);
    const pool = tags.length ? tags : ['life'];
    archetypeTagChoices[key] = { tags: pool, weights: pool.map(tagWeight) };
  }
  const globalTags = ['life', 'weekend', 'mood', 'dash', 'memes', 'food'];
  const loreTagFor = (line) => {
    const l = line.toLowerCase();
    if (/instantsend/.test(l)) return 'instantsend';
    if (/chainlock/.test(l)) return 'chainlocks';
    if (/coinjoin/.test(l)) return 'coinjoin';
    if (/masternode|collateral|dip-3|proposal/.test(l)) return 'masternodes';
    if (/grovedb|merkle|proof|platform|dpns|document/.test(l)) return rng.chance(0.5) ? 'dashplatform' : 'dash';
    if (/caracas|venezuela|arepa/.test(l)) return 'caracas';
    if (/digital cash/.test(l)) return 'digitalcash';
    return 'dash';
  };
  const pickTag = (archetype) => {
    if (rng.chance(0.12)) return rng.pick(globalTags);
    const c = archetypeTagChoices[archetype];
    return c.tags[rng.weighted(c.weights)];
  };

  // --- trending bursts ------------------------------------------------------
  const burstCount = Math.max(1, Math.min(8, Math.round(postTarget / 14000)));
  const bursts = rng.shuffle([...TREND_CANDIDATES]).slice(0, burstCount).map((tag, i) => {
    const start = L * (0.08 + (0.85 * (i + rng.rand() * 0.6)) / burstCount);
    return { tag, start, end: start + L * 0.006 };
  });
  const burstAt = (t) => bursts.find((b) => t >= b.start && t <= b.end);

  // --- content composition --------------------------------------------------
  const picsumSizes = ['900/600', '800/600', '1200/800', '1000/750', '900/900'];
  const mediaUrlFor = (archetype) => `https://picsum.photos/seed/${rng.pick(ARCHETYPES[archetype].picsum)}${rng.int(1, 999)}/${rng.pick(picsumSizes)}`;

  const isDevish = (p) => ['dashdev', 'techie', 'masternode', 'privacy'].includes(p.archetype);

  function finishText(p, text, { allowTail = true, allowEmoji = true } = {}) {
    let out = text;
    if (p.tics.lowercase) out = lowercaseKeep(out);
    if (p.tics.typos > 0 && rng.chance(p.tics.typos)) out = applyTypo(rng, out);
    if (allowTail && p.tics.tail && rng.chance(0.15)) out = `${out} ${p.tics.tail}`;
    if (allowEmoji && p.tics.emojiRate > 0 && !EMOJI_RE.test(out) && rng.chance(p.tics.emojiRate)) {
      const set = EMOJI_SETS[p.archetype] ?? [];
      if (set.length) out = `${out} ${rng.pick(set)}`;
    }
    // "a {drink}" where the fill already carries its own article ("an espresso").
    return out.replace(/\b([Aa]) (an?|the) /g, '$2 ').replace(/\s+/g, ' ').trim();
  }

  const startsWithOpener = (text, opener) => text.toLowerCase().startsWith(opener.toLowerCase().replace(/[:,]$/, ''));
  const withOpener = (opener, text) => (startsWithOpener(text, opener) ? text : `${opener} ${/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text}`);

  // Ensure global uniqueness; escalate variations, never emit a duplicate.
  // `mode` picks post-shaped (openers/tails) or reply-shaped (name prefixes,
  // conversational suffixes) variations.
  const REPLY_PREFIX = ['ok', 'yes,', 'honestly', 'also', 'ok but', 'no because', 'wait', 'right,', 'same,', 'oh', 'ha,', 'true,', 'fair,', 'yep', 'hm,', 'genuinely', 'look,', 'ok ok', 'no but', 'and'];
  const REPLY_SUFFIX = ['lol', 'tbh', 'though', 'honestly', 'for real', 'again', 'still', 'to be fair', 'no?', 'right?', 'imo', 'ngl', '(again)', 'today', 'this week', 'as usual', 'I think', 'apparently', 'sadly', 'thankfully'];
  // After a prefix ("Name, " / "ok "), a sentence-initial capital reads wrong; drop it unless it looks like a proper noun or "I".
  const decap = (t) => (/^[A-Z][a-z]/.test(t) && !/^I\b/.test(t) && !/^[A-Z][a-z]+ [A-Z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);
  function unique(p, base, render, ctx, mode = 'post') {
    let text = render(base, ctx);
    if (!contents.has(text)) { contents.add(text); return text; }
    const lc = (t) => (p.tics.lowercase ? t.toLowerCase() : t);
    const variants = mode === 'post'
      ? [
        () => render(base, ctx),
        () => withOpener(rng.pick(bankOf(p.archetype).openers ?? ['ok so']), render(base, ctx)),
        () => `${render(base, ctx)} ${rng.pick(bankOf(p.archetype).tails ?? ['anyway'])}`,
        () => `${rng.pick(GLOBAL_SLOTS.Day)}: ${render(base, ctx)}`,
        () => `${render(base, ctx)} ${rng.pick(['honestly', 'tbh', 'lol', 'ok', 'fine', 'anyway', 'again', 'still', 'today', 'apparently', '(again)', '(still)'])}`,
        () => `${withOpener(rng.pick(['ok so', 'update:', 'small thing:', 'today:', 'note to self:', 'once more:']), render(base, ctx))} ${rng.pick(GLOBAL_SLOTS.hour)}`,
      ]
      : [
        () => render(base, ctx),
        () => (ctx.name && !render(base, ctx).toLowerCase().startsWith(ctx.name.toLowerCase()) ? `${ctx.name}, ${decap(render(base, ctx))}` : `${lc(rng.pick(REPLY_PREFIX))} ${decap(render(base, ctx))}`),
        () => `${render(base, ctx)} ${lc(rng.pick(REPLY_SUFFIX))}`,
        () => `${lc(rng.pick(REPLY_PREFIX))} ${decap(render(base, ctx))} ${lc(rng.pick(REPLY_SUFFIX))}`,
        () => (ctx.name ? `${ctx.name} ${decap(render(base, ctx))} ${lc(rng.pick(REPLY_SUFFIX))}` : `${lc(rng.pick(REPLY_PREFIX))} ${lc(rng.pick(REPLY_PREFIX))} ${decap(render(base, ctx))}`),
        () => `${render(base, ctx)} ${lc(rng.pick(REPLY_SUFFIX))} ${lc(rng.pick(REPLY_SUFFIX))}`,
      ];
    for (let round = 0; round < 40; round += 1) {
      const v = variants[Math.min(variants.length - 1, Math.floor(round / 3))]();
      text = v.replace(/\s+/g, ' ').trim();
      if (!contents.has(text)) { contents.add(text); dupRescues += 1; return text; }
    }
    // Last resort: a deterministic day/hour stamp keeps it unique and readable.
    for (let k = 0; k < 10000; k += 1) {
      text = `${render(base, ctx)} (${rng.pick(GLOBAL_SLOTS.day)} ${rng.pick(GLOBAL_SLOTS.hour)}, take ${k + 2})`;
      if (!contents.has(text)) { contents.add(text); dupRescues += 1; return text; }
    }
    throw new Error('could not make content unique');
  }

  function composePost(p, t) {
    const A = bankOf(p.archetype);
    let base;
    let kind = 'bank';
    let hashtag = '';
    const burst = burstAt(t);
    const r = rng.rand();
    if (p.tics.bits.includes('blockheight') && rng.chance(0.2)) {
      base = deal(BLOCK_HEIGHT_LINES);
      kind = 'height';
    } else if (burst && rng.chance(0.6) && trendPools[burst.tag].length) {
      base = deal(trendPools[burst.tag]);
      hashtag = burst.tag;
      kind = 'trend';
    } else if (r < (isDevish(p) ? 0.1 : 0.06)) {
      const pool = isDevish(p) ? (rng.chance(0.7) ? lore.dev : lore.general) : (lore.verify.length && rng.chance(0.15) ? lore.verify : lore.general);
      base = deal(pool);
      kind = 'lore';
    } else if (p.tics.bits.includes('errors') && rng.chance(0.4)) {
      base = deal(errorLines) ?? deal(A.posts);
    } else {
      if (rng.chance(genericShare[p.archetype])) { base = deal(generic.posts); kind = 'generic'; } else base = deal(A.posts);
    }
    useLine(base);
    if (kind === 'bank' && rng.chance(p.archetype === 'lurker' ? 0.12 : 0.44)) hashtag = pickTag(p.archetype);
    else if (kind === 'generic' && rng.chance(0.2)) hashtag = rng.pick(globalTags.filter((t) => t !== 'dash'));
    else if (kind === 'lore' && rng.chance(0.5)) hashtag = loreTagFor(base);
    else if (kind === 'height' && rng.chance(0.5)) hashtag = 'dash';
    const height = BLOCK_HEIGHT_BASE + Math.floor((t / L) * 5760);
    const ctx = { city: p.location?.split(',')[0], height, slots: A.slots ?? {} };
    const opener = (kind === 'bank' || kind === 'generic') && rng.chance(0.1) && A.openers?.length ? rng.pick(A.openers) : null;
    const render = (b, c) => finishText(p, opener ? withOpener(opener, fill(b, c)) : fill(b, c));
    let text = unique(p, base, render, ctx);
    // link callback (~1%)
    let linked = false;
    if (postRefs.length > 50 && rng.chance(0.01)) {
      const earlier = postRefs[rng.int(Math.max(0, postRefs.length - 4000), postRefs.length - 1)];
      if (earlier && earlier.t < t) {
        const plainBase = text.length < 220 && !/^[^.!?]{0,24}:/.test(text);
        const tpl = rng.pick(plainBase ? LINK_LINES : LINK_LINES.filter((l) => !l.includes('{base}'))).replace('REF', earlier.ref);
        const candidate = tpl.includes('{base}') ? tpl.replace('{base}', text) : `${text} ${tpl}`;
        if (expandedContentLength(candidate) <= CONTENT_MAX - 12 && !contents.has(candidate)) {
          contents.delete(text);
          text = candidate;
          contents.add(text);
          linked = true;
        }
      }
    }
    if (hashtag) {
      const withTag = `${text} #${hashtag}`;
      if (expandedContentLength(withTag) <= CONTENT_MAX && !contents.has(withTag)) { contents.delete(text); text = withTag; contents.add(text); } else hashtag = '';
    }
    if (expandedContentLength(text) > CONTENT_MAX) {
      contents.delete(text);
      text = text.slice(0, 380).replace(/\s+\S*$/, '');
      if (hashtag) text = `${text} #${hashtag}`;
      if (contents.has(text)) text = `${text} (${rng.int(2, 99)})`;
      contents.add(text);
    }
    return { text, hashtag, kind, linked };
  }

  function composeReply(p, parent, { intent, isAuthorAnswer, parentIntent, isNested }) {
    const A = bankOf(p.archetype);
    let base;
    if (isAuthorAnswer) base = deal(A.replies?.answer ?? GENERIC_FALLBACK.followups.question);
    else if (isNested && parentIntent && rng.chance(0.5) && generic.followups?.[parentIntent]?.length) base = deal(generic.followups[parentIntent]);
    else if (rng.chance(p.archetype === 'lurker' ? 0.65 : 0.28)) base = deal(generic.replies?.[intent] ?? GENERIC_FALLBACK.replies[intent]);
    else base = deal(A.replies?.[intent] ?? GENERIC_FALLBACK.replies[intent]);
    useLine(base);
    const ctx = { name: firstNames[parent.author], city: p.location?.split(',')[0], slots: A.slots ?? {} };
    const render = (b, c) => finishText(p, fill(b, c), { allowTail: false });
    return unique(p, base, render, ctx, 'reply');
  }

  function composeQuote(p, quoted, isHero) {
    const A = bankOf(p.archetype);
    let base;
    if (isHero && heroBank.quotes?.length && rng.chance(0.85)) base = deal(heroBank.quotes);
    else if (isHero) base = deal(generic.quotes ?? GENERIC_FALLBACK.quotes);
    else if (rng.chance(0.3)) base = deal(generic.quotes ?? GENERIC_FALLBACK.quotes);
    else base = deal(A.quotes ?? GENERIC_FALLBACK.quotes);
    useLine(base);
    const ctx = { name: firstNames[quoted.author], city: p.location?.split(',')[0], slots: A.slots ?? {} };
    const render = (b, c) => finishText(p, fill(b, c));
    let text = unique(p, base, render, ctx, 'reply');
    let hashtag = '';
    if (rng.chance(0.2)) {
      hashtag = quoted.hashtag && rng.chance(0.5) ? quoted.hashtag : pickTag(p.archetype);
      const withTag = `${text} #${hashtag}`;
      if (!contents.has(withTag) && withTag.length <= CONTENT_MAX) { contents.delete(text); text = withTag; contents.add(text); } else hashtag = '';
    }
    if (EMOJI_RE.test(text)) quotesWithEmoji += 1;
    return { text, hashtag };
  }

  // --- engagement helpers ---------------------------------------------------
  function pickEngager(author, exclude) {
    const f = followers[author];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      let v;
      const r = rng.rand();
      if (f.length && r < 0.6) v = rng.pick(f);
      else if (r < 0.75) v = rng.pick(byArchetype[personas[author].archetype]);
      else v = rng.pick(activityUrn);
      if (v !== author && !exclude.has(v)) return v;
    }
    return -1;
  }
  function pickDistinctEngagers(author, k, exclude) {
    const out = [];
    const seen = new Set(exclude);
    seen.add(author);
    if (k >= users - 2) {
      // near-everyone (hero): take all followers first, then fill globally
      const all = rng.shuffle(personas.map((p) => p.idx).filter((i) => !seen.has(i)));
      return all.slice(0, k);
    }
    let attempts = 0;
    while (out.length < k && attempts < k * 25) {
      attempts += 1;
      const v = pickEngager(author, seen);
      if (v < 0) { const g = rng.int(0, users - 1); if (g === author || seen.has(g)) continue; seen.add(g); out.push(g); continue; }
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  const intentFor = (archetype) => {
    const bias = INTENT_BIAS[archetype] ?? DEFAULT_INTENTS;
    return INTENTS[rng.weighted(INTENTS.map((i) => bias[i]))];
  };

  function addPost({ author, t, content, hashtag, mediaUrl, sensitive, quotedRef, kind }) {
    postCounter += 1;
    const ref = `p${postCounter}`;
    const o = quotedRef
      ? { type: 'quote', ref, author, content, quotedRef, hashtag }
      : { type: 'post', ref, author, content, hashtag };
    if (mediaUrl) o.mediaUrl = mediaUrl;
    if (sensitive) o.sensitive = true;
    emit(t, o);
    counts[quotedRef ? 'quote' : 'post'] += 1;
    perAuthorYapp[author] += 10;
    if (hashtag) tagCounts.set(hashtag, (tagCounts.get(hashtag) ?? 0) + 1);
    const rec = { ref, author, t, hashtag, likers: new Set(), reposters: new Set(), bookmarkers: new Set(), kind: kind ?? (quotedRef ? 'quote' : 'post') };
    if (kind === 'trend') rec.burstTag = hashtag;
    postRefs.push(rec);
    postByRef.set(ref, rec);
    likeCount.set(ref, 0);
    return rec;
  }
  function addReply({ author, t, rootRef, parent, content, intent }) {
    replyCounter += 1;
    const ref = `r${replyCounter}`;
    emit(t, { type: 'reply', ref, author, rootRef, parentRef: parent.ref, content });
    counts.reply += 1;
    perAuthorYapp[author] += 3;
    replyLikeCount.set(ref, 0);
    replyCountByRoot.set(rootRef, (replyCountByRoot.get(rootRef) ?? 0) + 1);
    return { ref, author, t, intent, likers: new Set(), kind: 'reply' };
  }
  function addLike(liker, post, t) {
    if (post.likers.has(liker) || liker === post.author) return false;
    post.likers.add(liker);
    emit(t, { type: 'like', author: liker, targetRef: post.ref });
    counts.like += 1;
    perAuthorYapp[liker] += 1;
    likeCount.set(post.ref, likeCount.get(post.ref) + 1);
    return true;
  }
  function addLikeReply(liker, reply, t) {
    if (reply.likers.has(liker) || liker === reply.author) return false;
    reply.likers.add(liker);
    emit(t, { type: 'likeReply', author: liker, targetRef: reply.ref });
    counts.likeReply += 1;
    perAuthorYapp[liker] += 1;
    replyLikeCount.set(reply.ref, replyLikeCount.get(reply.ref) + 1);
    return true;
  }
  function addRepost(u, post, t) {
    if (post.reposters.has(u) || u === post.author) return false;
    post.reposters.add(u);
    emit(t, { type: 'repost', author: u, targetRef: post.ref });
    counts.repost += 1;
    perAuthorYapp[u] += 1;
    return true;
  }
  function addBookmark(u, post, t) {
    if (post.bookmarkers.has(u) || u === post.author) return false;
    post.bookmarkers.add(u);
    emit(t, { type: 'bookmark', author: u, targetRef: post.ref });
    counts.bookmark += 1;
    return true;
  }

  // --- reply thread builder --------------------------------------------------
  function buildThread(post, nReplies, { spread = 1, fixedFirst = [] } = {}) {
    const nodes = []; // reply records incl. intent
    const authorP = personas[post.author];
    const participants = new Set([post.author]);
    const target = nReplies;
    let made = 0;
    let lastT = post.t;
    const replyDelay = () => delay(600 * spread, 1.2);
    for (const fx of fixedFirst) {
      const parent = fx.parent ?? post;
      const t = Math.max(lastT, parent.t) + fx.delay;
      const node = addReply({ author: fx.author, t, rootRef: post.ref, parent, content: fx.content, intent: fx.intent });
      contents.add(fx.content);
      node.parentIntent = parent.intent ?? null;
      node.isAuthorAnswer = fx.author === post.author;
      nodes.push(node);
      participants.add(fx.author);
      lastT = t;
      made += 1;
    }
    while (made < target) {
      // choose parent: post (top-level) or an existing reply (nested)
      const nested = nodes.length > 0 && rng.chance(nodes.length >= 3 ? 0.45 : 0.3);
      const parent = nested ? nodes[nodes.length > 6 && rng.chance(0.6) ? rng.int(Math.max(0, nodes.length - 6), nodes.length - 1) : rng.int(0, nodes.length - 1)] : post;
      let replier;
      let isAuthorAnswer = false;
      if (nested && parent.author !== post.author && authorP.activity > 0.2 && rng.chance(0.35)) {
        replier = post.author;
        isAuthorAnswer = true;
      } else {
        const exclude = new Set([parent.author]);
        replier = rng.chance(0.25) && participants.size > 1 ? rng.pick([...participants].filter((x) => x !== parent.author)) : pickEngager(post.author, exclude);
        if (replier === undefined || replier < 0) replier = rng.int(0, users - 1);
        if (replier === parent.author) continue;
      }
      const rp = personas[replier];
      const intent = isAuthorAnswer ? 'answer' : intentFor(rp.archetype);
      const content = composeReply(rp, parent, { intent, isAuthorAnswer, parentIntent: parent.intent, isNested: nested });
      const t = Math.max(parent.t, lastT - 200) + replyDelay();
      const node = addReply({ author: replier, t, rootRef: post.ref, parent, content, intent });
      node.isAuthorAnswer = isAuthorAnswer;
      nodes.push(node);
      participants.add(replier);
      lastT = Math.max(lastT, t);
      made += 1;
    }
    return nodes;
  }

  // --- like-budget calibration ------------------------------------------------
  const quoteCount = Math.round(postTarget * mix.quoteShare);
  const baseCount = postTarget - quoteCount;
  const likeTarget = Math.round(opsTarget * mix.likes);
  const replyTarget = Math.round(opsTarget * mix.replies);
  const likeReplyTarget = Math.round(opsTarget * mix.likeReply);
  const repostTarget = Math.round(opsTarget * mix.repost);
  const bookmarkTarget = Math.round(opsTarget * mix.bookmark);

  // Reserve engagement budget for the hero thread and for quotes.
  const heroLikes = Math.max(3, Math.round((users - 1) * 0.92));
  const otherCap = Math.max(1, Math.floor(heroLikes / 2.2));
  const heroReplyCount = Math.min(users - 2, heroBank.replies.length + 3 + 6);
  const heroLikeReplies = Math.min(Math.round(users * 0.9), 5) * 3;
  const quoteLikeShare = 0.08;
  const baseLikeBudget = Math.max(0, likeTarget - heroLikes) * (1 - quoteLikeShare);
  const baseReplyBudget = Math.max(0, replyTarget - heroReplyCount) * 0.95;

  // Base post skeleton: author ~ activity, time uniform; hero at ~5%.
  const activityWeights = personas.map((p) => p.activity);
  const skeleton = [];
  for (let i = 0; i < baseCount - 1; i += 1) {
    const author = rng.weighted(activityWeights);
    skeleton.push({ author, t: rng.rand() * L });
  }
  const heroT = L * 0.05;
  skeleton.push({ author: 0, t: heroT, hero: true });
  skeleton.sort((a, b) => a.t - b.t);

  // λ per base post. Two-component mixture (a "dead" mass of posts nobody
  // sees + a lognormal "live" component) × author reach, self-calibrated so the
  // like budget lands, ~45% of posts draw zero likes, and the top 1% of posts
  // hold ~15–25% of likes. A pure lognormal cannot satisfy all three at once.
  const reach = (author) => Math.pow(followerCount[author] + 4, 0.8);
  const rescale = (arr, budget) => { const sum = arr.reduce((a, b) => a + b, 0) || 1; return arr.map((x) => (x * budget) / sum); };
  const zeroShareOf = (arr) => arr.reduce((z, l) => z + Math.exp(-l), 0) / arr.length;
  const top1ShareOf = (arr) => {
    const sorted = [...arr].sort((a, b) => b - a);
    const n = Math.max(1, Math.ceil(sorted.length * 0.01));
    const total = sorted.reduce((a, b) => a + b, 0) || 1;
    return sorted.slice(0, n).reduce((a, b) => a + b, 0) / total;
  };
  let pDead = 0.3;
  let sigmaLive = 0.9;
  const deadDraw = skeleton.map(() => rng.rand());
  const liveDraw = skeleton.map(() => rng.normal());
  const dead2 = skeleton.map(() => rng.normal());
  const lambdaFor = () => rescale(skeleton.map((s, i) => {
    if (s.hero) return 0;
    const q = deadDraw[i] < pDead ? 0.03 * Math.exp(0.5 * dead2[i]) : Math.exp(sigmaLive * liveDraw[i]);
    return q * reach(s.author);
  }), baseLikeBudget);
  let lambda = lambdaFor();
  const calibration = [];
  for (let iter = 0; iter < 30; iter += 1) {
    const z = zeroShareOf(lambda);
    const t1 = top1ShareOf(lambda);
    calibration.push({ iter, pDead: Number(pDead.toFixed(2)), sigmaLive: Number(sigmaLive.toFixed(2)), zeroShare: Number(z.toFixed(3)), top1Share: Number(t1.toFixed(3)) });
    let changed = false;
    if (z < 0.40) { pDead = Math.min(0.7, pDead + 0.03); changed = true; } else if (z > 0.46) { pDead = Math.max(0.05, pDead - 0.03); changed = true; }
    if (t1 > 0.25) { sigmaLive = Math.max(0.3, sigmaLive - 0.08); changed = true; } else if (t1 < 0.15) { sigmaLive = Math.min(2.5, sigmaLive + 0.08); changed = true; }
    if (!changed) break;
    lambda = lambdaFor();
  }
  // Guaranteed viral tail (bounded by the hero margin) and cap everything else.
  const orderByLambda = skeleton.map((_, i) => i).filter((i) => !skeleton[i].hero).sort((a, b) => lambda[b] - lambda[a]);
  const viralFractions = [1.0, 0.86, 0.74, 0.66, 0.58, 0.52, 0.46, 0.42, 0.38, 0.35, 0.32, 0.3];
  const viralN = Math.min(viralFractions.length, Math.max(3, Math.floor(baseCount / 8000)));
  for (let k = 0; k < viralN && k < orderByLambda.length; k += 1) lambda[orderByLambda[k]] = otherCap * viralFractions[k];
  {
    const viralSum = orderByLambda.slice(0, viralN).reduce((s, i) => s + lambda[i], 0);
    const rest = orderByLambda.slice(viralN);
    const restSum = rest.reduce((s, i) => s + lambda[i], 0) || 1;
    const f = Math.max(0, baseLikeBudget - viralSum) / restSum;
    for (const i of rest) lambda[i] = Math.min(otherCap * 0.9, lambda[i] * f);
  }
  const replyLambda = rescale(skeleton.map((s, i) => (s.hero ? 0 : 0.25 + Math.pow(lambda[i], 0.85))), baseReplyBudget);
  const quoteWeights = skeleton.map((s, i) => (s.hero ? 0 : Math.pow(lambda[i] + 0.3, 1.3)));
  const quoteLambda = rescale(quoteWeights, Math.max(0, quoteCount - 14));
  const repostLambda = rescale(skeleton.map((s, i) => (s.hero ? 0 : Math.pow(lambda[i] + 0.2, 1.2))), Math.max(0, repostTarget - 120) * 0.92);
  const bookmarkLambda = rescale(skeleton.map((s, i) => (s.hero ? 0 : lambda[i] + 0.1)), Math.max(0, bookmarkTarget - 80) * 0.92);
  // likeReply: λ per reply = likeReplyPerReply × intentBoost × heat(post likes).
  // Normalise by the reply-weighted expectation of intentBoost × heat so the
  // budget lands instead of overshooting on hot threads.
  const heatOf = (likes) => Math.pow(Math.max(likes, 1), 0.55) / 3;
  const expectedIntentBoost = 1.2;
  let heatSum = 0;
  let heatW = 0;
  skeleton.forEach((s, i) => { if (!s.hero) { heatSum += replyLambda[i] * heatOf(lambda[i]); heatW += replyLambda[i]; } });
  const expectedHeat = heatW > 0 ? heatSum / heatW : 1;
  const likeReplyPerReply = Math.max(0, likeReplyTarget - heroLikeReplies) / Math.max(1, replyTarget * expectedIntentBoost * expectedHeat);

  // --- engagement on one post (base or quote) --------------------------------
  function engage(post, { likes, replies, quotes, reposts, bookmarks, spread = 1, heroThread = null }) {
    const likeDelay = () => delay(1500 * spread, 1.3);
    // likes
    const nLikes = Math.min(likes, users - 1);
    const likers = pickDistinctEngagers(post.author, nLikes, new Set());
    for (const u of likers) addLike(u, post, post.t + likeDelay());
    // replies (thread)
    let nodes = [];
    if (replies > 0 || heroThread) nodes = heroThread ? heroThread() : buildThread(post, replies, { spread });
    // likeReply on good replies: weight by intent + thread heat
    for (const node of nodes) {
      const intentBoost = node.intent === 'joke' || node.intent === 'fact' ? 1.8 : node.intent === 'answer' ? 1.2 : 0.8;
      const lam = node.fixedLikes ?? likeReplyPerReply * intentBoost * heatOf(likes);
      const n = node.fixedLikes ?? rng.poisson(lam);
      if (n <= 0) continue;
      const pool = likers.length ? likers : null;
      const seen = new Set([node.author]);
      let got = 0;
      let attempts = 0;
      while (got < n && attempts < n * 20) {
        attempts += 1;
        const u = pool && rng.chance(0.7) ? rng.pick(pool) : pickEngager(post.author, seen);
        if (u === undefined || u < 0 || seen.has(u)) continue;
        seen.add(u);
        if (addLikeReply(u, node, node.t + delay(800 * spread, 1.2))) got += 1;
      }
    }
    // reposts / bookmarks from likers mostly
    const fromLikers = (n, fn, med) => {
      let got = 0;
      let attempts = 0;
      const seen = new Set();
      while (got < n && attempts < n * 15) {
        attempts += 1;
        const u = likers.length && rng.chance(0.75) ? rng.pick(likers) : pickEngager(post.author, seen);
        if (u === undefined || u < 0 || seen.has(u)) continue;
        seen.add(u);
        if (fn(u, post, post.t + delay(med * spread, 1.2))) got += 1;
      }
    };
    fromLikers(Math.min(reposts, users - 1), addRepost, 2000);
    fromLikers(Math.min(bookmarks, users - 1), addBookmark, 2500);
    // quotes: each is a new post with its own (smaller) engagement
    for (let q = 0; q < quotes; q += 1) {
      const seen = new Set([post.author]);
      let quoter = likers.length && rng.chance(0.6) ? rng.pick(likers) : pickEngager(post.author, seen);
      if (quoter === undefined || quoter < 0) quoter = rng.int(0, users - 1);
      if (quoter === post.author) continue;
      const qp = personas[quoter];
      const { text, hashtag } = composeQuote(qp, post, post.kind === 'hero');
      const qt = post.t + delay(2500 * spread, 1.1);
      const mediaUrl = rng.chance(0.03) ? mediaUrlFor(qp.archetype) : undefined;
      const quote = addPost({ author: quoter, t: qt, content: text, hashtag, mediaUrl, quotedRef: post.ref, kind: 'quote' });
      if (mediaUrl) mediaPosts += 1;
      const qLam = Math.min(otherCap * 0.5, 0.35 * rng.lognormal(0, 1.0) * reach(quoter) * (baseLikeBudget / Math.max(1, baseCount)) / 6);
      const qLikes = rng.poisson(qLam);
      const qReplies = rng.poisson(0.12 + Math.pow(qLikes, 0.8) * 0.3);
      engage(quote, { likes: qLikes, replies: qReplies, quotes: 0, reposts: rng.poisson(qLikes * 0.05), bookmarks: rng.poisson(qLikes * 0.01), spread });
    }
    return nodes;
  }

  // --- hero thread -------------------------------------------------------------
  function heroThreadFor(post) {
    const alice = 0; const bob = 1; const carol = 2;
    const fixed = [];
    const bobNode = { author: bob, delay: 30, content: 'Every single one of them. It\'s such an obvious thing once you see it.', intent: 'agree' };
    const carolNode = { author: carol, delay: 80, content: 'ok but how would you even check', intent: 'question' };
    fixed.push(bobNode, carolNode);
    // Build the first two, then alice's reply to carol, then the bank.
    const nodes = [];
    let lastT = post.t;
    const mk = (author, parent, dt, content, intent, fixedLikes) => {
      const t = Math.max(lastT, parent.t) + dt;
      const node = addReply({ author, t, rootRef: post.ref, parent, content, intent });
      contents.add(content);
      node.fixedLikes = fixedLikes;
      nodes.push(node);
      lastT = t;
      return node;
    };
    const bobR = mk(bob, post, 30, bobNode.content, 'agree', Math.round(users * 0.28));
    const carolR = mk(carol, post, 80, carolNode.content, 'question', Math.round(users * 0.14));
    const verifyR = mk(alice, carolR, 140, 'Don\'t trust. Verify.', 'answer', Math.round(users * 0.36));
    // Bank replies, spread over a long window, from personas of the requested archetype.
    const usedAuthors = new Set([alice, bob, carol]);
    const targets = { post, carol: carolR, bob: bobR, alice_verify: verifyR };
    const pickRole = (role) => {
      const pool = (byArchetype[role] ?? []).filter((i) => !usedAuthors.has(i) && i > 2);
      if (pool.length) return rng.pick(pool);
      const any = personas.filter((p) => p.idx > 2 && !usedAuthors.has(p.idx));
      return rng.pick(any).idx;
    };
    const bankReplies = rng.shuffle([...heroBank.replies]);
    let dt = 400;
    for (const r of bankReplies) {
      const author = pickRole(r.role);
      usedAuthors.add(author);
      const parent = targets[r.target] ?? post;
      const content = fill(r.content, { name: firstNames[parent.author] });
      if (contents.has(content) || content.length > CONTENT_MAX) continue;
      const likes = Math.max(0, Math.round(rng.lognormal(Math.log(users * 0.02 + 1), 0.9)));
      const node = mk(author, parent, dt + delay(700, 0.9), content, r.intent, r.role === 'dashdev' ? Math.round(users * 0.2) : Math.min(likes, Math.round(users * 0.1)));
      node.parentIntent = parent.intent ?? null;
      dt = 50;
      // alice or bob answer a few of the direct questions / disagreements
      if ((r.intent === 'question' || r.intent === 'disagree') && rng.chance(0.75)) {
        const answerer = rng.chance(0.6) ? alice : bob;
        const pool = (HERO_ANSWERS[answerer === alice ? 'alice' : 'bob'][r.intent] ?? []).filter((l) => !contents.has(l));
        if (pool.length) mk(answerer, node, delay(400, 0.8), rng.pick(pool), 'answer', Math.round(users * 0.05));
      } else if ((r.intent === 'agree' || r.intent === 'joke') && rng.chance(0.15)) {
        const answerer = rng.chance(0.5) ? alice : bob;
        const pool = (HERO_ANSWERS[answerer === alice ? 'alice' : 'bob'][r.intent] ?? []).filter((l) => !contents.has(l));
        if (pool.length) mk(answerer, node, delay(400, 0.8), rng.pick(pool), 'answer', Math.round(users * 0.03));
      }
    }
    // a few nested follow-ups from other people
    for (let i = 0; i < 4; i += 1) {
      const parent = rng.pick(nodes.slice(3));
      const author = pickRole(rng.pick(ARCHETYPE_KEYS));
      if (usedAuthors.has(author) || author === parent.author) continue;
      usedAuthors.add(author);
      const ap = personas[author];
      const content = composeReply(ap, parent, { intent: intentFor(ap.archetype), isAuthorAnswer: false, parentIntent: parent.intent, isNested: true });
      mk(author, parent, delay(2000, 0.9), content, 'agree', rng.int(0, 4));
    }
    return nodes;
  }

  // --- main pass: posts in time order, engagement trailing each --------------
  const heroContent = 'Every app you have ever used answered this question with a database you were not allowed to see.';
  let heroRef = null;
  skeleton.forEach((s, i) => {
    const p = personas[s.author];
    if (s.hero) {
      contents.add(heroContent);
      const post = addPost({ author: 0, t: s.t, content: heroContent, hashtag: '', kind: 'hero' });
      heroRef = post.ref;
      engage(post, {
        likes: heroLikes,
        replies: 0,
        quotes: Math.min(14, Math.max(4, Math.round(users * 0.014))),
        reposts: Math.min(users - 1, Math.max(6, Math.round(users * 0.12))),
        bookmarks: Math.min(users - 1, Math.max(4, Math.round(users * 0.08))),
        spread: 5,
        heroThread: () => heroThreadFor(post),
      });
      return;
    }
    const { text, hashtag, kind, linked } = composePost(p, s.t);
    const mediaUrl = rng.chance(p.archetype === 'photographer' || p.archetype === 'artist' || p.archetype === 'foodie' ? 0.2 : 0.06) ? mediaUrlFor(p.archetype) : undefined;
    const sensitive = mediaUrl && rng.chance(0.06) ? true : undefined;
    const post = addPost({ author: s.author, t: s.t, content: text, hashtag, mediaUrl, sensitive, kind });
    if (mediaUrl) mediaPosts += 1;
    if (sensitive) sensitivePosts += 1;
    if (linked) linkPosts += 1;
    if (kind === 'lore') lorePosts += 1;
    if (kind === 'trend') trendPosts += 1;
    const likes = Math.min(otherCap, rng.poisson(lambda[i]));
    const replies = rng.poisson(replyLambda[i]);
    const quotes = rng.poisson(quoteLambda[i]);
    const reposts = rng.poisson(repostLambda[i]);
    const bookmarks = rng.poisson(bookmarkLambda[i]);
    engage(post, { likes, replies, quotes, reposts, bookmarks });
  });

  // --- hit --ops exactly: top up (preferentially, so the zero-share holds) or trim likes
  const total = () => Object.values(counts).reduce((a, b) => a + b, 0);
  const likeOps = ops.filter((x) => x.o.type === 'like' && x.o.targetRef !== heroRef);
  let guard = 0;
  while (total() < opsTarget && guard < opsTarget * 3) {
    guard += 1;
    const post = likeOps.length && rng.chance(0.9) ? postByRef.get(rng.pick(likeOps).o.targetRef) : postRefs[rng.int(0, postRefs.length - 1)];
    if (post.kind === 'hero') continue;
    if (likeCount.get(post.ref) >= otherCap) continue;
    const u = pickEngager(post.author, post.likers);
    if (u < 0) continue;
    addLike(u, post, post.t + delay(1500, 1.3));
    likeOps.push(ops[ops.length - 1]);
  }
  if (total() > opsTarget) {
    let surplus = total() - opsTarget;
    const drop = new Set();
    for (let i = ops.length - 1; i >= 0 && surplus > 0; i -= 1) {
      const o = ops[i].o;
      if (o.type !== 'like' || o.targetRef === heroRef) continue;
      const post = postByRef.get(o.targetRef);
      post.likers.delete(o.author);
      likeCount.set(o.targetRef, likeCount.get(o.targetRef) - 1);
      perAuthorYapp[o.author] -= 1;
      counts.like -= 1;
      drop.add(i);
      surplus -= 1;
    }
    if (drop.size) {
      let w = 0;
      for (let i = 0; i < ops.length; i += 1) if (!drop.has(i)) ops[w++] = ops[i];
      ops.length = w;
    }
  }

  // --- order + stats -----------------------------------------------------------
  ops.sort((a, b) => (a.t - b.t) || (a.s - b.s));
  // Actual line windows of the trending bursts (virtual time ≠ line index,
  // because engagement trails its post).
  const burstLines = new Map(bursts.map((b) => [b.tag, { first: Infinity, last: -1, posts: 0 }]));
  ops.forEach((x, i) => {
    if (x.o.type !== 'post') return;
    const rec = postByRef.get(x.o.ref);
    if (!rec?.burstTag) return;
    const w = burstLines.get(rec.burstTag);
    w.first = Math.min(w.first, i + 1); w.last = Math.max(w.last, i + 1); w.posts += 1;
  });

  const likeValues = [...likeCount.values()].sort((a, b) => b - a);
  const meanLikesOf = (author) => {
    const mine = postRefs.filter((p) => p.author === author && p.kind !== 'hero');
    return mine.length ? Number((mine.reduce((s, p) => s + likeCount.get(p.ref), 0) / mine.length).toFixed(2)) : 0;
  };
  const heroLikeCount = likeCount.get(heroRef);
  const runnerUpVal = likeValues[0] === heroLikeCount ? likeValues[1] ?? 0 : likeValues[0];
  const likesTotal = likeValues.reduce((a, b) => a + b, 0);
  const top1 = likeValues.slice(0, Math.max(1, Math.ceil(likeValues.length * 0.01))).reduce((a, b) => a + b, 0);
  const median = likeValues[Math.floor(likeValues.length / 2)];
  const zeroShare = likeValues.filter((v) => v === 0).length / likeValues.length;
  const followerSorted = [...followerCount].sort((a, b) => b - a);
  const replyPerRoot = [...replyCountByRoot.values()].sort((a, b) => b - a);
  const maxYapp = perAuthorYapp.reduce((m, v) => (v > m ? v : m), 0);
  const credits = {
    post: (counts.post + counts.quote) * 188e6,
    reply: counts.reply * 175e6,
    like: [...postRefs].reduce((s, p) => s + likeCount.get(p.ref) * (p.hashtag ? 130e6 : 90e6), 0),
    likeReply: counts.likeReply * 54e6,
    repost: counts.repost * 66e6,
    follow: counts.follow * 46e6,
    bookmark: counts.bookmark * 18e6,
  };
  const creditsTotal = Object.values(credits).reduce((a, b) => a + b, 0);
  const tagged = [...tagCounts.values()].reduce((a, b) => a + b, 0);
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, c]) => ({ tag: t, posts: c }));
  const archetypeCounts = {};
  personas.forEach((p) => { archetypeCounts[p.archetype] = (archetypeCounts[p.archetype] ?? 0) + 1; });
  const lineUses = [...lineUse.values()].sort((a, b) => b - a);
  const postLineUses = [...lineUse.entries()].filter(([l]) => distinctBankLines.has(l)).map(([, c]) => c).sort((a, b) => b - a);

  const summary = {
    generatedAt: new Date().toISOString(),
    seed, topology, users, targets: { posts: postTarget, ops: opsTarget, mix },
    counts: { ...counts, total: total() },
    yapp: { total: perAuthorYapp.reduce((a, b) => a + b, 0), maxPerAuthor: maxYapp, maxAuthor: perAuthorYapp.indexOf(maxYapp), perType: { post: 10, quote: 10, reply: 3, like: 1, likeReply: 1, repost: 1 } },
    credits: { ...credits, total: creditsTotal, totalDash: Number((creditsTotal / 1e11).toFixed(2)), assumptions: 'post 188M, reply 175M, like 90M untagged / 130M tagged, likeReply 54M, repost 66M, follow 46M, bookmark 18M credits' },
    likes: {
      max: likeValues[0], top10: likeValues.slice(0, 10), median, zeroShare: Number(zeroShare.toFixed(3)),
      top1PercentShare: Number((top1 / Math.max(1, likesTotal)).toFixed(3)), postsWith100Plus: likeValues.filter((v) => v >= 100).length,
      meanPerPost: Number((likesTotal / likeValues.length).toFixed(2)),
    },
    hero: { ref: heroRef, likes: heroLikeCount, runnerUp: runnerUpVal, ratio: Number((heroLikeCount / Math.max(1, runnerUpVal)).toFixed(2)), replies: replyCountByRoot.get(heroRef) ?? 0, reposts: postByRef.get(heroRef).reposters.size, bookmarks: postByRef.get(heroRef).bookmarkers.size, quotes: ops.filter((x) => x.o.type === 'quote' && x.o.quotedRef === heroRef).length, bobMeanLikes: meanLikesOf(1), carolMeanLikes: meanLikesOf(2), aliceMeanLikes: meanLikesOf(0), allMeanLikes: Number((likesTotal / likeValues.length).toFixed(2)) },
    follows: { total: counts.follow, maxFollowers: followerSorted[0], top10Followers: followerSorted.slice(0, 10), medianFollowers: followerSorted[Math.floor(followerSorted.length / 2)], zeroFollowers: followerSorted.filter((v) => v === 0).length, bob: followerCount[1], carol: followerCount[2], alice: followerCount[0] },
    replies: { total: counts.reply, meanPerPost: Number((counts.reply / Math.max(1, counts.post + counts.quote)).toFixed(2)), maxThread: replyPerRoot[0] ?? 0, top10Threads: replyPerRoot.slice(0, 10), postsWithReplies: replyCountByRoot.size, threads10Plus: replyPerRoot.filter((v) => v >= 10).length },
    hashtags: { taggedShare: Number((tagged / Math.max(1, counts.post + counts.quote)).toFixed(3)), distinct: tagCounts.size, top: topTags, bursts: bursts.map((b) => ({ tag: b.tag, ...burstLines.get(b.tag) })) },
    content: {
      mediaShare: Number((mediaPosts / Math.max(1, counts.post + counts.quote)).toFixed(3)), sensitive: sensitivePosts, linkPosts, lorePosts, trendPosts,
      distinctContents: contents.size, duplicateRescues: dupRescues,
      bankSource, bankFiles: files.length, missingBanks: missing, distinctBankPostLines: distinctBankLines.size,
      postLineReuse: { max: postLineUses[0] ?? 0, mean: Number((postLineUses.reduce((a, b) => a + b, 0) / Math.max(1, postLineUses.length)).toFixed(2)), p95: postLineUses[Math.floor(postLineUses.length * 0.05)] ?? 0 },
      anyLineReuse: { max: lineUses[0] ?? 0, distinctLinesUsed: lineUses.length },
    },
    archetypes: archetypeCounts,
    genericShare: Object.fromEntries(Object.entries(genericShare).map(([k, v]) => [k, Number(v.toFixed(2))])),
    activity: { max: personas.reduce((m, p) => (p.activity > m ? p.activity : m), 0), lurkers: personas.filter((p) => p.activity < 0.16).length },
  };
  summary.calibration = calibration;

  // Personas file: strip generator-internal fields.
  const personasOut = personas.map(({ tics, archetype, ...p }) => ({ ...p, archetype }));
  return { personas: personasOut, ops: ops.map((x) => x.o), summary };
}

// ---------------------------------------------------------------------------
// Output + validation
// ---------------------------------------------------------------------------
const KEY_ORDER = ['type', 'ref', 'author', 'rootRef', 'parentRef', 'quotedRef', 'targetRef', 'target', 'content', 'hashtag', 'mediaUrl', 'sensitive'];
function lineOf(o) {
  const ordered = {};
  for (const k of KEY_ORDER) if (o[k] !== undefined) ordered[k] = o[k];
  return JSON.stringify(ordered);
}

export function writeOutputs(out, { personas, ops, summary }) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const personasFile = `${out}.personas.json`;
  const corpusFile = `${out}.corpus.jsonl`;
  const summaryFile = `${out}.summary.json`;
  writeFileSync(personasFile, JSON.stringify(personas, null, 1));
  const fd = openSync(corpusFile, 'w');
  const CHUNK = 20000;
  for (let i = 0; i < ops.length; i += CHUNK) {
    writeSync(fd, `${ops.slice(i, i + CHUNK).map(lineOf).join('\n')}\n`);
  }
  closeSync(fd);
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  return { personasFile, corpusFile, summaryFile };
}

export function validateOutputs({ personasFile, corpusFile }, topology, summary) {
  const personas = loadPersonas(personasFile);
  const text = readFileSync(corpusFile, 'utf8');
  const { ops, stats } = parseCorpus(text, personas, { topology });
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

  check('parseCorpus + loadPersonas pass', true, `${ops.length} ops, ${personas.length} personas`);
  const likeByRef = new Map();
  const seenContent = new Set();
  let dupContent = 0;
  let heroRef = null;
  const heroContent = 'Every app you have ever used answered this question with a database you were not allowed to see.';
  const byHandle = new Map(personas.map((p) => [p.handle, p]));
  for (const o of ops) {
    if (o.type === 'like') likeByRef.set(o.targetRef, (likeByRef.get(o.targetRef) ?? 0) + 1);
    if (o.content !== undefined) { if (seenContent.has(o.content)) dupContent += 1; seenContent.add(o.content); }
    if (o.type === 'post' && o.content === heroContent) heroRef = o.ref;
  }
  const alice = byHandle.get('alice7'); const bob = byHandle.get('bob8'); const carol = byHandle.get('carol9');
  check('hero personas alice7/bob8/carol9 exist', alice && bob && carol && alice.displayName === 'Alice' && bob.displayName === 'Bob' && carol.displayName === 'Carol');
  const heroOp = ops.find((o) => o.ref === heroRef);
  check('hero post exists, by alice7, untagged', heroOp && heroOp.author === alice?.idx && heroOp.hashtag === '');
  const heroReplies = ops.filter((o) => o.type === 'reply' && o.rootRef === heroRef);
  const bobR = heroReplies.find((o) => o.author === bob?.idx && o.content === 'Every single one of them. It\'s such an obvious thing once you see it.' && o.parentRef === heroRef);
  const carolR = heroReplies.find((o) => o.author === carol?.idx && o.content === 'ok but how would you even check' && o.parentRef === heroRef);
  const verifyR = carolR && heroReplies.find((o) => o.author === alice?.idx && o.content === 'Don\'t trust. Verify.' && o.parentRef === carolR.ref);
  check('hero thread fixed replies (bob, carol, alice→carol)', bobR && carolR && verifyR);
  check('hero thread long tail (≥15 replies)', heroReplies.length >= 15, `${heroReplies.length} replies`);
  const sortedLikes = [...likeByRef.values()].sort((a, b) => b - a);
  const heroLikes = likeByRef.get(heroRef) ?? 0;
  const runnerUp = sortedLikes[0] === heroLikes ? (sortedLikes[1] ?? 0) : sortedLikes[0];
  check('hero is most-liked by ≥2×', heroLikes === sortedLikes[0] && heroLikes >= 2 * runnerUp, `${heroLikes} vs ${runnerUp}`);
  const heroQuotes = ops.filter((o) => o.type === 'quote' && o.quotedRef === heroRef).length;
  const heroReposts = ops.filter((o) => o.type === 'repost' && o.targetRef === heroRef).length;
  check('hero has quotes and reposts', heroQuotes >= 3 && heroReposts >= 6, `${heroQuotes} quotes, ${heroReposts} reposts`);
  check('no duplicate contents', dupContent === 0, `${dupContent} duplicates`);
  const postCount = stats.post + stats.quote;
  const zeroShare = 1 - likeByRef.size / postCount;
  check('zero-like share 0.30–0.60', zeroShare >= 0.30 && zeroShare <= 0.60, zeroShare.toFixed(3));
  const followIdx = ops.map((o, i) => (o.type === 'follow' ? i : -1)).filter((i) => i >= 0);
  const earlyFollows = followIdx.filter((i) => i < ops.length * 0.05).length / Math.max(1, followIdx.length);
  check('follows mostly early (≥70% in first 5%)', earlyFollows >= 0.7, earlyFollows.toFixed(2));
  const tagged = ops.filter((o) => (o.type === 'post' || o.type === 'quote') && o.hashtag).length / postCount;
  check('tagged share 0.25–0.50', tagged >= 0.25 && tagged <= 0.5, tagged.toFixed(3));
  const media = ops.filter((o) => (o.type === 'post' || o.type === 'quote') && o.mediaUrl).length / postCount;
  check('media share 0.04–0.14', media >= 0.04 && media <= 0.14, media.toFixed(3));
  const nested = ops.filter((o) => o.type === 'reply' && o.parentRef.startsWith('r')).length;
  check('nested replies present', nested > 0, `${nested}`);
  const linkOps = ops.filter((o) => o.content && o.content.includes('{{link:')).length;
  check('link placeholders present', linkOps > 0, `${linkOps}`);
  if (summary) {
    check('summary counts match parsed stats', Object.keys(stats).every((k) => stats[k] === summary.counts[k]), JSON.stringify(stats));
  }
  const bobFollowers = ops.filter((o) => o.type === 'follow' && o.target === bob?.idx).length;
  const carolFollowers = ops.filter((o) => o.type === 'follow' && o.target === carol?.idx).length;
  const followerCounts = new Map();
  for (const o of ops) if (o.type === 'follow') followerCounts.set(o.target, (followerCounts.get(o.target) ?? 0) + 1);
  const fc = [...followerCounts.values()].sort((a, b) => a - b);
  const medianFollowers = fc[Math.floor(fc.length / 2)] ?? 0;
  check('bob and carol above-median reach', bobFollowers > medianFollowers && carolFollowers > medianFollowers, `bob ${bobFollowers}, carol ${carolFollowers}, median ${medianFollowers}`);
  return { checks, stats, ops: ops.length };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const selfTest = flag('self-test', false) === true;
  const quiet = flag('quiet', false) === true;
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const topology = String(flag('topology', 'v6'));
  const banksDir = resolve(String(flag('banks', '.seed-corpus.local/banks')));
  if (selfTest) {
    const outDir = join(tmpdir(), `yappr-corpus-selftest-${process.pid}`);
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, 'selftest');
    const t0 = Date.now();
    // Load banks once so a bank file appearing mid-test cannot break the determinism check.
    const loadedBanks = existsSync(banksDir) ? loadBanks(banksDir) : null;
    const result = generate({ users: 80, posts: 1500, ops: 12000, seed: 7, topology, mix: DEFAULT_MIX, banksDir, loadedBanks, log });
    const files = writeOutputs(out, result);
    const { checks } = validateOutputs(files, topology, result.summary);
    // determinism: regenerate and compare
    const again = generate({ users: 80, posts: 1500, ops: 12000, seed: 7, topology, mix: DEFAULT_MIX, banksDir, loadedBanks, log });
    checks.push({ name: 'deterministic for a fixed seed', ok: JSON.stringify(again.ops) === JSON.stringify(result.ops) && JSON.stringify(again.personas) === JSON.stringify(result.personas), detail: '' });
    let failed = 0;
    for (const c of checks) {
      if (!c.ok) failed += 1;
      console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    console.log(`self-test: ${checks.length - failed}/${checks.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s (banks: ${result.summary.content.bankSource}, out: ${out}.*)`);
    process.exit(failed ? 1 : 0);
  }

  const users = Number(flag('users', 1000));
  const posts = Number(flag('posts', 100000));
  const opsN = Number(flag('ops', 1000000));
  const seed = Number(flag('seed', 42));
  const out = String(flag('out', '.seed-corpus.local/mass'));
  const mix = parseMix(flag('mix', null));
  if (!(users >= 4) || !(posts >= 4) || !(opsN >= posts)) throw new Error('need --users ≥ 4, --posts ≥ 4, --ops ≥ --posts');
  log(`generating: users=${users} posts=${posts} ops=${opsN} seed=${seed} topology=${topology}\nbanks: ${banksDir}`);
  const t0 = Date.now();
  const result = generate({ users, posts, ops: opsN, seed, topology, mix, banksDir, log });
  log(`generated ${result.ops.length} ops in ${((Date.now() - t0) / 1000).toFixed(1)}s (banks: ${result.summary.content.bankSource}${result.summary.content.missingBanks.length ? `, missing: ${result.summary.content.missingBanks.join(',')}` : ''})`);
  const files = writeOutputs(out, result);
  log(`wrote ${files.personasFile}\n      ${files.corpusFile}\n      ${files.summaryFile}`);
  const t1 = Date.now();
  const { checks } = validateOutputs(files, topology, result.summary);
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  log(`validation ${failed.length ? 'FAILED' : 'passed'} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (failed.length) process.exit(1);
  log(JSON.stringify({ counts: result.summary.counts, hero: result.summary.hero, likes: result.summary.likes }, null, 1));
}

if (process.argv[1] && process.argv[1].endsWith('generate-corpus.mjs')) {
  main().catch((e) => { console.error(e.stack ?? e); process.exit(1); });
}
