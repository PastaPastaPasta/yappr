#!/usr/bin/env node
/**
 * Author the text BANKS the corpus generator composes from, using the headless
 * Claude CLI (`claude -p`). Outputs are cached under
 * `.seed-corpus.local/banks/<name>.json`; re-runs only author what is missing
 * (or everything with --force). Nothing here touches the network beyond the
 * CLI itself.
 *
 *   node scripts/seed/author-banks.mjs [--banks .seed-corpus.local/banks] [--only foodie,memer]
 *                                      [--concurrency 4] [--force] [--dry-run]
 *
 * Bank shapes (all strings may contain {slot} placeholders — see
 * corpus-archetypes.mjs GLOBAL_SLOTS; replies/quotes may use {name} for the
 * parent author's first name):
 *
 *   <archetype>.json  { posts: string[], openers: string[], tails: string[],
 *                       replies: { agree, disagree, question, joke, fact, answer: string[] },
 *                       quotes: string[], slots: { [slot]: string[] } }
 *   generic.json      { posts: string[], followups: {agree,disagree,question,joke,fact: string[]},
 *                       replies: {...}, quotes: string[] }
 *   hero.json         { replies: [{ role, intent, content }], quotes: string[] }
 *
 * The generator falls back to FALLBACK_BANK / GENERIC_FALLBACK from
 * corpus-archetypes.mjs for any missing file and reports which it used.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARCHETYPES, ARCHETYPE_KEYS, GLOBAL_SLOTS } from './corpus-archetypes.mjs';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const BANK_DIR = resolve(flag('banks', '.seed-corpus.local/banks'));
const ONLY = flag('only', null) ? String(flag('only')).split(',') : null;
const CONCURRENCY = Number(flag('concurrency', 4));
const FORCE = flag('force', false) === true;
const DRY = flag('dry-run', false) === true;
const MODEL = flag('model', null);
const ROUNDS = String(flag('rounds', '1')).split(',').map((r) => Number(r)).filter((r) => r >= 1);

// Extra rounds author `<archetype>.r<N>.json` files holding only posts + replies
// on a distinct theme, so the generator has more distinct base lines to draw
// from (lower per-line reuse at 100k posts). Round 1 is the full bank.
export const ROUND_THEMES = {
  2: 'Theme for this round: everyday life OUTSIDE their main interest — family, weather, commute, errands, sleep, small joys, minor disasters, things overheard — still unmistakably in their voice, with their interests only as occasional seasoning.',
  3: 'Theme for this round: opinions and reactions — hot takes, things they changed their mind about, questions posed to their followers, rankings, recommendations, unpopular opinions, "am I the only one", and reactions to (unnamed, invented) news in their field.',
  4: 'Theme for this round: running bits and project updates — numbered updates (day {n}, part {n}, attempt {nn}), before/after, milestones, failures, callbacks to a recurring nemesis or project, progress reports, retrospectives, and "update on the thing from last week".',
  5: 'Theme for this round: social and community — replying-to-the-timeline style posts (without naming anyone), meetups, thanking people, asking for help, sharing something someone taught them, local scenes, first-person stories with a small twist at the end.',
  6: 'Theme for this round: tiny observations and one-liners — at least half the lines under 70 characters; overheard things, small absurdities, weather-of-the-mind, "today I learned", micro-reviews, single-sentence confessions, deadpan status updates; the rest short stories of 100-200 chars with a specific detail.',
  8: 'Theme for this round: work, money and errands — jobs, bosses, invoices, bills, the price of things, commutes, admin, appointments, queues, customer service, small wins at work, quitting fantasies — in their voice, with their interests as seasoning only.',
  9: 'Theme for this round: seasons, holidays and places — weather turning, first/last of the season, holidays and family gatherings, trips and staycations, neighbourhoods, markets, parks, cafés, the view from a window, "this time last year" — concrete and sensory, in their voice.',
  10: 'Theme for this round: gear, tools and objects — the things they own, use, break, covet, repair, or refuse to buy; reviews of one object at a time; "the best {price} I ever spent"; inventory of a bag, a desk, a shelf; things that outlived their expectations — in their voice.',
  11: 'Theme for this round: people and conversations — things a friend, relative, stranger, colleague, neighbour, or child said (unnamed, invented); overheard lines; advice received and ignored; arguments won and lost; small kindnesses; the barber, the driver, the vendor — in their voice, mostly short.',
  12: 'Theme for this round: learning and mistakes — TIL posts, things they got wrong for years, skills picked up this month, tutorials that lied, beginner questions they are not ashamed of, what they would tell themselves at 20, corrections to their own earlier takes — in their voice.',
  13: 'Theme for this round: numbers and lists — posts built on a specific count, price, time, score, or streak; two- or three-item lists in prose; rankings of exactly three things; "day {nn} of"; percentages; before/after figures; tally-style updates — concrete, in their voice.',
  14: 'Theme for this round: mornings and evenings — first hours and last hours of the day; routines, failures of routines, what the light is doing, what is for breakfast, what went wrong by 9am, what got saved by 9pm; nights out and nights in — sensory and concrete.',
  15: 'Theme for this round: complaints and gratitude — half the lines are specific, funny, small complaints (queues, apps, packaging, noise, prices, weather, other people\'s music); half are specific, unsentimental gratitude (a stranger, a tool that worked, a good sandwich, a friend who showed up).',
  16: 'Theme for this round: plans and predictions — what they will do this weekend, this year, when it stops raining; predictions for their field or their street; promises to themselves; things they will definitely not do again; countdowns; "next time".',
  17: 'Theme for this round: memories and then-vs-now — this time last year, ten years ago, first jobs, first gigs, childhood versions of their current interest, old photos found, things that no longer exist, and a specific detail that dates each memory.',
  18: 'Theme for this round: micro-stories — each line is a tiny complete story with a beginning, a turn, and an end in 90-220 chars; someone wants something, something goes sideways, there is a last line. Concrete nouns, no morals.',
  19: 'Theme for this round: the internet and the timeline — posting about posting, group chats, notifications, screenshots described in words, replies they regret, things the algorithm (which does not exist here) would never show them, logging off, coming back.',
  7: 'Theme for this round: asks and recommendations — questions to followers, polls phrased as posts, "what should I", requests for tips, then the other half: recommendations, reviews, rankings, "underrated:", "overrated:", things they would tell a beginner.',
};

const SLOT_NAMES = Object.keys(GLOBAL_SLOTS);
const SLOT_HELP = `You may use these placeholders sparingly (at most one or two per line, and only where a random fill would still read naturally): ${SLOT_NAMES.filter((s) => s !== 'name').map((s) => `{${s}}`).join(' ')}. {city} is a city; {year} 2013-2025; {n} 2-12; {nn} 10-99; {big} 100-9999; {pct} 5-95; {price} a price like 3.50 or 14; {hour} a time; {Day}/{day} a weekday; {drink}/{snack}/{dish} things to consume; {shop}/{game}/{genre}/{team}/{petname} names. Replies and quotes may also use {name} for the first name of the person being replied to.`;

const RULES = `Rules: plain text only, no markdown, no hashtags (the generator adds those), no @mentions, no URLs, no quotation marks around the whole line, no numbered prefixes, no real private individuals, nothing hateful or sexual. Each line must be a complete, standalone post that could plausibly appear on a real social network in 2026. Lines must be DISTINCT from one another in topic, structure, and opening word — never start several lines the same way. Vary length: some under 60 chars, most 80-220, a few up to 400. Keep every line under 420 characters. Output ONLY valid JSON, no code fences, no commentary.`;

function archetypePrompt(key, round = 1) {
  const a = ARCHETYPES[key];
  if (round > 1) return roundPrompt(key, round);
  const dash = ['dashdev', 'masternode', 'merchant', 'privacy', 'venezuela'].includes(key)
    ? 'This persona lives on a Dash-flavoured social network (Yappr, built on Dash Platform). Dash lore is welcome where natural: Jan 18 2014 / block 1, XCoin→Darkcoin→Dash, X11, 1000-DASH masternodes, ChainLocks, InstantSend, CoinJoin, DIP-3 deterministic masternodes, DIP-24, Evan Duffield, Dash Evolution/Platform, DPNS names, "Dash is Digital Cash", Caracas adoption, grovedb/Merkle proofs ("every count on Yappr is a Merkle proof"), "don\'t trust, verify". Keep it tasteful and specific, not shilling.'
    : 'This persona is a normal person on a general social network (which happens to run on Dash Platform; they mostly do not care). At most 2 of the posts may glance at crypto or Dash, and only in a way a normal person would (a shop taking it, a friend explaining it badly, InstantSend being surprisingly fast).';
  return `You are writing a reusable text BANK for a synthetic social-network corpus. Archetype: "${a.label}". Typical interests: ${a.interests.join(', ')}. Typical voice traits (mix and match; not every line uses every trait): ${a.styleTraits.join('; ')}.
${dash}
${SLOT_HELP}
${RULES}

Produce a JSON object with exactly these keys:
- "posts": 90 distinct top-level posts in this archetype's voice. Specific, opinionated, funny where the voice allows, with concrete details (numbers, places, objects). Include running bits (a recurring nemesis, a project, a rule of life), a few mild typos ONLY if the voice is casual, and emoji ONLY if the voice would use them (then in roughly a third of lines, never more than 2 per line).
- "openers": 8 short optional prefixes this voice might start a post with (e.g. "ok so", "PSA:", "Respectfully,"). Under 20 chars each.
- "tails": 8 short optional sign-offs (under 30 chars each).
- "replies": an object with keys "agree", "disagree", "question", "joke", "fact", "answer". Each is an array of 22 replies in this voice. "agree" lines agree with a post; "disagree" push back (politely or not, per voice); "question" ask something about the post; "joke" riff on it; "fact" add a relevant specific fact or experience; "answer" are what THIS persona says when someone replies to THEIR post (answering a question, thanking, doubling down). Replies must work as responses to a wide range of posts (do not reference specifics that would only fit one post) yet still sound like a real reply, 20-180 chars, most under 100. Use {name} in roughly a quarter of them.
- "quotes": 22 quote-post takes this voice would attach when sharing someone else's post (add a take, a reaction, or context; 15-160 chars; the quoted post is shown below the take automatically so do not describe it).
- "slots": an object of 2-4 archetype-specific slot names (lowercase letters only, not any of the global ones) each mapping to 8-12 fill values, used in your lines as {slotname}. Every custom placeholder you use in any line MUST be defined here.`;
}

function roundPrompt(key, round) {
  const a = ARCHETYPES[key];
  const dash = ['dashdev', 'masternode', 'merchant', 'privacy', 'venezuela'].includes(key)
    ? 'This persona lives on a Dash-flavoured social network (Yappr, on Dash Platform). Dash references (InstantSend, ChainLocks, masternodes, CoinJoin, DPNS, Merkle proofs, "don\'t trust, verify", Caracas) are welcome where natural but should appear in well under half the lines this round.'
    : 'This persona is a normal person on a general social network; at most 1 line may glance at crypto/Dash, in the way a normal person would.';
  return `You are writing an ADDITIONAL text bank (round ${round}) for a synthetic social-network corpus. Archetype: "${a.label}". Typical interests: ${a.interests.join(', ')}. Voice traits (mix and match): ${a.styleTraits.join('; ')}.
${dash}
${ROUND_THEMES[round] ?? ROUND_THEMES[2]}
${SLOT_HELP}
${RULES}

Produce a JSON object with exactly these keys:
- "posts": 120 distinct top-level posts on this round's theme, in this archetype's voice, with concrete specifics. Emoji only if the voice would use them (then in about a third of lines, max 2 per line). A few mild typos only if the voice is casual.
- "replies": an object with keys "agree", "disagree", "question", "joke", "fact", "answer", each an array of 14 replies in this voice that would work as responses to a wide range of posts (20-160 chars, most under 100). Use {name} in about a quarter.
- "quotes": 12 quote-post takes (15-160 chars) in this voice.
- "slots": an object of 2-3 archetype-specific slot names (lowercase letters only, not any global one) each mapping to 8-12 fill values. Every custom placeholder used in any line MUST be defined here.`;
}

function genericRoundPrompt(round) {
  return `You are writing an ADDITIONAL voice-neutral text bank (round ${round}) for a synthetic social-network corpus: everyday material any adult might post.
${ROUND_THEMES[round] ?? ROUND_THEMES[2]}
${SLOT_HELP}
${RULES}

Produce a JSON object with exactly these keys:
- "posts": 150 distinct everyday top-level posts on this round's theme. About a third lowercase-casual, a third proper sentences, a third in between. Emoji in at most 15% of lines.
- "replies": object with keys "agree", "disagree", "question", "joke", "fact": each an array of 24 short generic replies (5-90 chars) usable under almost any post.
- "followups": object with the same five keys, each an array of 18 short lines (8-120 chars) posted in response to a REPLY of that kind. Use {name} in about a fifth.
- "quotes": 30 short quote-post takes (5-120 chars).`;
}

function lorePrompt() {
  return `You are writing a bank of Dash "easter egg" lines for a synthetic social network (Yappr, built on Dash Platform). These are sprinkled into ~5% of posts across ALL kinds of users, so they must read as things a real person would post, not marketing.
Canon to draw on (be accurate): Dash launched January 18, 2014 (block 1) as XCoin, renamed Darkcoin, then Dash in March 2015; created by Evan Duffield; X11 hashing (11 chained algorithms); masternodes require 1000 DASH collateral and vote on a monthly treasury (~10% of block reward); DIP-3 deterministic masternode lists (2019); ChainLocks (LLMQ quorums sign the chain tip, killing reorgs / 51% attacks); InstantSend (quorum-locked payments in ~1-2 seconds); CoinJoin (formerly PrivateSend, mixing fixed denominations in rounds); DIP-24 rotating quorums; Dash Evolution / Dash Platform (documents, data contracts, identities, DPNS usernames, grovedb Merkle proofs, "every count on Yappr is a Merkle proof"); "Dash is Digital Cash"; heavy merchant adoption in Venezuela/Caracas circa 2018-2020; the meme "don't trust, verify"; block time 2.5 minutes; "Dash is dead" posts every year.
${SLOT_HELP}
${RULES}

Produce a JSON object with keys:
- "general": 150 distinct lines usable by ANY persona (foodies, parents, sports fans, skeptics, merchants...). Many are a normal-life observation with one Dash detail; some are jokes; some are affectionate history; some are skeptical or teasing; some are "friend explained it to me" stories; a few are short one-liners under 60 chars. No two should hinge on the same fact in the same way.
- "dev": 60 distinct lines for developer/operator personas: grovedb, Merkle proofs, root hashes, consensus errors quoted verbatim in backticks (invent plausible ones like \`ConsensusError(StateError(DocumentAlreadyPresentError))\` or \`InvalidProof: expected 1 element, got 0\`), DAPI 504s, quorum rotations, DIP numbers, wasm SDK woes, "trusted mode vs proofs mode", the 2.5-minute block metronome, proof-size jokes.
- "verify": 25 distinct short callbacks (under 80 chars) to "don't trust, verify" that people would post in unrelated contexts (recipes, sports, parenting, weather).`;
}

const LORE_ROUND_THEMES = {
  2: 'Theme for this round: history and people — dates, the Darkcoin era, the rename, Evan Duffield stepping back, X11, the 2017 run-up and hangover, treasury proposals and masternode voting culture, DIP numbers, the long wait for Evolution/Platform, "Dash is dead" posts every year, veterans reminiscing, newcomers discovering the history.',
  3: 'Theme for this round: everyday and social — shops and counters, friends and family explaining it badly, remittances, coffee, the feeling of a payment locking instantly, DPNS usernames as owned identity, Yappr itself being on chain (posts, likes, follows as documents with Merkle proofs), the block-height metronome, jokes normal people make, mild teasing from partners and skeptics.',
};

function loreRoundPrompt(round) {
  return `You are writing an ADDITIONAL bank (round ${round}) of Dash "easter egg" lines for a synthetic social network (Yappr, built on Dash Platform). Sprinkled into ~5% of posts across ALL kinds of users, so they must read as things real people post, not marketing.
Canon (be accurate): launched January 18, 2014 (block 1) as XCoin, renamed Darkcoin, then Dash in March 2015; created by Evan Duffield; X11 (11 chained hash algorithms); masternodes need 1000 DASH collateral and vote monthly on the treasury (~10% of block reward); DIP-3 deterministic masternode lists (2019); ChainLocks (LLMQ quorums sign the chain tip; reorgs/51% attacks are moot); InstantSend (quorum-locked payments in 1-2 seconds); CoinJoin (fixed denominations, rounds); DIP-24 rotating quorums; Dash Platform (documents, data contracts, identities, DPNS usernames, grovedb Merkle proofs — "every count on Yappr is a Merkle proof"); "Dash is Digital Cash"; merchant adoption in Venezuela/Caracas around 2018-2020; "don't trust, verify"; 2.5-minute blocks.
${LORE_ROUND_THEMES[round] ?? LORE_ROUND_THEMES[2]}
${SLOT_HELP}
${RULES}

Produce a JSON object with keys:
- "general": 120 distinct lines usable by ANY persona on this round's theme. No two should hinge on the same fact the same way. Mix one-liners under 60 chars with 100-250 char stories.
- "dev": 40 distinct lines for developer/operator personas on this round's theme (root hashes, proofs, consensus errors in backticks, quorum rotations, DAPI timeouts, SDK upgrades, the metronome).
- "verify": 15 distinct short "don't trust, verify" callbacks (under 80 chars) in unrelated everyday contexts.`;
}

function trendsPrompt() {
  const tags = ['dash', 'chainlocks', 'instantsend', 'caracas', 'football', 'finals', 'weather', 'f1', 'localnews', 'music', 'space', 'inflation'];
  const gloss = {
    dash: 'a day when the whole timeline is talking about Dash (Digital Cash): newcomers setting up wallets, veterans reminiscing, merchants chiming in, skeptics teasing, normal people shrugging',
    chainlocks: 'ChainLocks trending because some OTHER chain had a reorg/51% scare: explanations, relief, jokes about boring security, "the quorum signs the tip"',
    instantsend: 'people posting InstantSend timings vs card taps, counter stories, "the receipt printer is now the slow part"',
    caracas: 'Caracas / Venezuela Dash adoption stories resurfacing: shops, remittances, family, inflation, taxi drivers, panaderías',
    football: 'a big football (soccer) matchday: kickoff nerves, ref rage, half-time, VAR, superstitions, full-time joy or despair',
    finals: 'university finals week: library at 3am, rice cookers, curves, printers out of toner, walking out and remembering the answer',
    weather: 'a dramatic weather day everywhere at once: wrong jacket, cancelled plans, the sky doing a thing, the app being wrong',
    f1: 'a Formula 1 race weekend: quali, strategy calls, pit stops, safety cars, radio messages, the group chat becoming engineers',
    localnews: 'small-town local news day: road closures, council meetings, the bridge, a couch at the bus stop, a named pothole',
    music: 'new-music Friday: releases, EPs finally out, first listens, the fourth track being the one, the group chat arguing about a bridge',
    space: 'a big space day: a launch, a telescope image, a meteor shower, the station passing over, feeling small in the good way',
    inflation: 'inflation discourse: receipts, rent, the coffee that was 50 cents, grandma\'s prices, the economist in the replies',
  };
  return `You are writing a bank of "trending topic" posts for a synthetic social network. Each tag below gets a burst where many different users post about it within a short window, so lines must be varied in angle, mood, and structure, and written so ANY kind of person could post them (the generator applies each poster's voice tics). No hashtags in the text.
${SLOT_HELP}
${RULES}

Produce a JSON object with exactly these keys, each an array of 40 distinct lines (mostly 40-180 chars, a few longer):
${tags.map((t) => `- "${t}": ${gloss[t]}`).join('\n')}`;
}

function genericPrompt() {
  return `You are writing a reusable text BANK for a synthetic social-network corpus. This bank is voice-neutral everyday material any adult on a general social network might post.
${SLOT_HELP}
${RULES}

Produce a JSON object with exactly these keys:
- "posts": 120 distinct everyday top-level posts (commute, weather, small joys, mild complaints, food, shows, small observations, weekend plans, tiny victories). Warm, specific, human. About a third lowercase-casual, a third proper sentences, a third somewhere between. Emoji in at most 15% of lines.
- "replies": object with keys "agree", "disagree", "question", "joke", "fact": each an array of 30 short generic replies (5-90 chars) that work as a response to almost any post.
- "followups": object with the same five keys: each an array of 24 short lines (8-120 chars) that someone would post as a reply to a REPLY of that kind (e.g. followups.agree are things you say after someone agreed with you; followups.question are things you say after someone asked a question — answers, deflections, "good question"; followups.disagree are responses to pushback, both conceding and doubling down). Use {name} in about a fifth of them.
- "quotes": 40 short quote-post takes (5-120 chars) neutral enough to sit above almost any quoted post.`;
}

function heroPrompt() {
  return `You are writing the reply thread for the single most-liked post on a Dash-flavoured social network called Yappr (built on Dash Platform, where every post, like, and count is a document with a Merkle proof). The post, by Alice (@alice7), reads exactly:

"Every app you have ever used answered this question with a database you were not allowed to see."

Already written and fixed (do not repeat them): Bob (@bob8) replied "Every single one of them. It's such an obvious thing once you see it."; Carol (@carol9) replied "ok but how would you even check"; Alice replied to Carol "Don't trust. Verify."

${RULES}
Output ONLY valid JSON: an object with keys:
- "replies": an array of 26 objects {"role": <one of: dashdev, masternode, merchant, skeptic, privacy, venezuela, memer, foodie, gamer, fitness, musician, photographer, traveler, student, parent, smallbiz, sportsfan, bookworm, maker, localnews, economist, artist, gardener, filmbuff, scientist, techie, outdoors, petlover, finance, lurker>, "intent": <one of agree, disagree, question, joke, fact>, "target": <"post" or "carol" or "bob" or "alice_verify">, "content": <the reply text, 15-300 chars>}. Make them a realistic long tail: several agreeing with specifics, a skeptic and an economist arguing (one pointing out that a proof does not make the DATA true, only the DATABASE honest), a couple of genuine questions, three or four jokes (one about the database being "allowed to see you", one memer one-liner), exactly one "dashdev" reply that explains plainly that every count on Yappr — likes, follows, replies — is a Merkle proof from grovedb, so the number on your screen is a receipt, not an estimate; a masternode operator noting they have been keeping the receipts since 2014; a merchant relating it to receipts at the counter; a Venezuelan noting what it means when you cannot trust the bank; a photographer or artist saying something short and beautiful; one lurker saying it is the first thing that made them post; a parent making a relatable analogy; a "don't trust, verify" callback that is NOT by Alice. Roles must be varied (no role more than twice except lurker/memer at most three). "target" distribution: about 16 to the post, 4 to carol's reply, 3 to bob's reply, 3 to alice_verify.
- "quotes": 12 quote-post takes (15-200 chars) people would put above this post when sharing it: agreement, a skeptic's caveat, a joke, a "this is why I am here", a dev noting it is literally true on this network, a merchant angle, a privacy angle, a normal-person angle.`;
}

function runClaude(prompt) {
  return new Promise((resolvePromise, reject) => {
    const cliArgs = ['-p', '--bare', '--tools', '', '--no-session-persistence', '--output-format', 'text'];
    if (MODEL) cliArgs.push('--model', MODEL);
    const child = spawn('claude', cliArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${err.slice(0, 400)}`));
      else resolvePromise(out);
    });
    child.stdin.end(prompt);
  });
}

export function extractJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start > 0) t = t.slice(start);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (end !== -1) t = t.slice(0, end + 1);
  return JSON.parse(t);
}

function validateBank(name, bank) {
  const problems = [];
  const arr = (v, label, min) => {
    if (!Array.isArray(v) || v.length < min) problems.push(`${label}: expected ≥${min} strings, got ${Array.isArray(v) ? v.length : typeof v}`);
    else v.forEach((s, i) => { if (typeof s !== 'string' || s.length === 0 || s.length > 420) problems.push(`${label}[${i}]: bad string`); });
  };
  if (name === 'trends') {
    for (const t of ['dash', 'chainlocks', 'instantsend', 'caracas', 'football', 'finals', 'weather', 'f1', 'localnews', 'music', 'space', 'inflation']) arr(bank[t], `trends.${t}`, 15);
  } else if (/^dashlore(\.r\d+)?$/.test(name)) {
    arr(bank.general, `${name}.general`, 50);
    arr(bank.dev, `${name}.dev`, 20);
    arr(bank.verify, `${name}.verify`, 8);
  } else if (/\.r\d+$/.test(name)) {
    const base = name.replace(/\.r\d+$/, '');
    arr(bank.posts, `${name}.posts`, 50);
    const intents = base === 'generic' ? ['agree', 'disagree', 'question', 'joke', 'fact'] : ['agree', 'disagree', 'question', 'joke', 'fact', 'answer'];
    for (const k of intents) arr(bank.replies?.[k], `${name}.replies.${k}`, 6);
    if (base === 'generic') for (const k of intents) arr(bank.followups?.[k], `${name}.followups.${k}`, 6);
    arr(bank.quotes, `${name}.quotes`, 6);
    if (bank.slots && typeof bank.slots === 'object') {
      for (const [slot, vals] of Object.entries(bank.slots)) {
        if (!/^[a-z]+$/.test(slot) || slot in GLOBAL_SLOTS) problems.push(`${name}.slots.${slot}: bad slot name`);
        arr(vals, `${name}.slots.${slot}`, 3);
      }
    }
    const all = [bank.posts, bank.quotes, ...Object.values(bank.replies ?? {}), ...Object.values(bank.followups ?? {})].flat().filter((s) => typeof s === 'string');
    for (const s of all) {
      for (const m of s.matchAll(/\{([A-Za-z]+)\}/g)) {
        if (!(m[1] in GLOBAL_SLOTS) && !(bank.slots && m[1] in bank.slots)) problems.push(`${name}: undefined placeholder {${m[1]}} in "${s.slice(0, 40)}…"`);
      }
    }
  } else if (name === 'hero') {
    if (!Array.isArray(bank.replies) || bank.replies.length < 18) problems.push('hero.replies too short');
    else bank.replies.forEach((r, i) => {
      if (typeof r?.content !== 'string' || r.content.length < 5 || r.content.length > 420) problems.push(`hero.replies[${i}] content`);
      if (!ARCHETYPE_KEYS.includes(r?.role)) problems.push(`hero.replies[${i}] role ${r?.role}`);
    });
    arr(bank.quotes, 'hero.quotes', 6);
  } else if (name === 'generic') {
    arr(bank.posts, 'generic.posts', 60);
    for (const k of ['agree', 'disagree', 'question', 'joke', 'fact']) {
      arr(bank.replies?.[k], `generic.replies.${k}`, 12);
      arr(bank.followups?.[k], `generic.followups.${k}`, 10);
    }
    arr(bank.quotes, 'generic.quotes', 15);
  } else {
    arr(bank.posts, `${name}.posts`, 50);
    arr(bank.openers, `${name}.openers`, 3);
    arr(bank.tails, `${name}.tails`, 3);
    for (const k of ['agree', 'disagree', 'question', 'joke', 'fact', 'answer']) arr(bank.replies?.[k], `${name}.replies.${k}`, 10);
    arr(bank.quotes, `${name}.quotes`, 10);
    if (bank.slots && typeof bank.slots === 'object') {
      for (const [slot, vals] of Object.entries(bank.slots)) {
        if (!/^[a-z]+$/.test(slot) || slot in GLOBAL_SLOTS) problems.push(`${name}.slots.${slot}: bad slot name`);
        arr(vals, `${name}.slots.${slot}`, 3);
      }
    }
    // every custom placeholder must be defined
    const all = [bank.posts, bank.openers, bank.tails, bank.quotes, ...Object.values(bank.replies ?? {})].flat().filter((s) => typeof s === 'string');
    for (const s of all) {
      for (const m of s.matchAll(/\{([A-Za-z]+)\}/g)) {
        if (!(m[1] in GLOBAL_SLOTS) && !(bank.slots && m[1] in bank.slots)) problems.push(`${name}: undefined placeholder {${m[1]}} in "${s.slice(0, 40)}…"`);
      }
    }
  }
  return problems;
}

async function authorOne(name, prompt, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const raw = await runClaude(prompt);
      const bank = extractJson(raw);
      const problems = validateBank(name, bank);
      if (problems.length > 8) throw new Error(`bank invalid (${problems.length}): ${problems.slice(0, 5).join('; ')}`);
      // Drop the individually-bad placeholders rather than the whole bank.
      if (problems.length) bank._warnings = problems;
      return bank;
    } catch (e) {
      lastErr = e;
      process.stderr.write(`  [${name}] attempt ${i + 1} failed: ${e.message.slice(0, 200)}\n`);
    }
  }
  throw lastErr;
}

async function main() {
  mkdirSync(BANK_DIR, { recursive: true });
  const jobs = [];
  const want = (name) => !ONLY || ONLY.includes(name);
  for (const round of ROUNDS) {
    const suffix = round === 1 ? '' : `.r${round}`;
    for (const key of ARCHETYPE_KEYS) if (want(key)) jobs.push({ name: `${key}${suffix}`, prompt: archetypePrompt(key, round) });
    if (want('generic')) jobs.push({ name: `generic${suffix}`, prompt: round === 1 ? genericPrompt() : genericRoundPrompt(round) });
    if (round === 1) {
      if (want('hero')) jobs.push({ name: 'hero', prompt: heroPrompt() });
      if (want('dashlore')) jobs.push({ name: 'dashlore', prompt: lorePrompt() });
      if (want('trends')) jobs.push({ name: 'trends', prompt: trendsPrompt() });
    } else if (round <= 3 && want('dashlore')) {
      jobs.push({ name: `dashlore${suffix}`, prompt: loreRoundPrompt(round) });
    }
  }

  const pending = jobs.filter((j) => FORCE || !existsSync(join(BANK_DIR, `${j.name}.json`)));
  console.log(`banks dir: ${BANK_DIR}\n${jobs.length} banks total, ${pending.length} to author${DRY ? ' (dry run)' : ''}`);
  if (DRY) { for (const j of pending) console.log(`  would author ${j.name} (${j.prompt.length} char prompt)`); return; }

  let ok = 0;
  let failed = 0;
  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift();
      const t0 = Date.now();
      try {
        const bank = await authorOne(job.name, job.prompt);
        writeFileSync(join(BANK_DIR, `${job.name}.json`), JSON.stringify(bank, null, 1));
        const n = job.name === 'hero' ? bank.replies.length : job.name.startsWith('dashlore') ? bank.general.length : job.name === 'trends' ? Object.values(bank).flat().length : bank.posts.length;
        ok += 1;
        console.log(`  ok ${job.name} (${n} ${job.name === 'hero' ? 'replies' : 'posts'}, ${((Date.now() - t0) / 1000).toFixed(0)}s)${bank._warnings ? ` ${bank._warnings.length} warnings` : ''}`);
      } catch (e) {
        failed += 1;
        console.log(`  FAILED ${job.name}: ${e.message.slice(0, 200)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  const present = jobs.filter((j) => existsSync(join(BANK_DIR, `${j.name}.json`))).length;
  console.log(`done: ${ok} authored, ${failed} failed, ${present}/${jobs.length} requested banks present`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('author-banks.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

/**
 * Load every bank file present in `dir`. Round files (`foo.r2.json`) are merged
 * into their base bank: posts/quotes/reply arrays are concatenated and custom
 * slots unioned. Returns { banks, missing, files } where `missing` lists base
 * banks with no round-1 file (the generator falls back for those).
 */
export function loadBanks(dir) {
  const banks = {};
  const missing = [];
  const files = [];
  const merge = (into, extra) => {
    for (const key of ['posts', 'quotes', 'general', 'dev', 'verify']) {
      if (Array.isArray(extra[key])) into[key] = [...(into[key] ?? []), ...extra[key]];
    }
    for (const key of Object.keys(extra)) {
      if (!['posts', 'quotes', 'general', 'dev', 'verify', 'replies', 'followups', 'slots', 'openers', 'tails', '_warnings'].includes(key) && Array.isArray(extra[key]) && Array.isArray(into[key])) {
        into[key] = [...into[key], ...extra[key]];
      }
    }
    for (const key of ['replies', 'followups']) {
      if (extra[key] && typeof extra[key] === 'object') {
        into[key] = into[key] ?? {};
        for (const [intent, lines] of Object.entries(extra[key])) {
          if (Array.isArray(lines)) into[key][intent] = [...(into[key][intent] ?? []), ...lines];
        }
      }
    }
    if (extra.slots && typeof extra.slots === 'object') {
      into.slots = into.slots ?? {};
      for (const [slot, vals] of Object.entries(extra.slots)) {
        if (Array.isArray(vals)) into.slots[slot] = [...(into.slots[slot] ?? []), ...vals];
      }
    }
    return into;
  };
  for (const name of [...ARCHETYPE_KEYS, 'generic', 'hero', 'dashlore', 'trends']) {
    const file = join(dir, `${name}.json`);
    if (!existsSync(file)) { missing.push(name); continue; }
    banks[name] = JSON.parse(readFileSync(file, 'utf8'));
    delete banks[name]._warnings;
    files.push(`${name}.json`);
    const rounds = readdirSync(dir)
      .map((f) => f.match(new RegExp(`^${name.replace('.', '\\.')}\\.r(\\d+)\\.json$`)))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    for (const round of rounds) {
      const rf = join(dir, `${name}.r${round}.json`);
      const extra = JSON.parse(readFileSync(rf, 'utf8'));
      merge(banks[name], extra);
      files.push(`${name}.r${round}.json`);
    }
  }
  return { banks, missing, files };
}
