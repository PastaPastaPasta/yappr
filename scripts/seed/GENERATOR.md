# Corpus generator — model and knobs

`generate-corpus.mjs` produces the persona + corpus files that
`provision-seed-identities.mjs` and `run-seeder.mjs` consume (formats in
`CORPUS_FORMAT.md`). It never touches the network. Output is deterministic
for a given `--seed`; the only non-deterministic step is authoring the text
banks, which is a separate, cached script.

```
scripts/seed/
  generate-corpus.mjs     the generator (+ --self-test)
  author-banks.mjs        authors text banks with `claude -p`, cached on disk
  corpus-archetypes.mjs   static vocabulary: archetypes, names, cities, tags,
                          slot fills, Dash lore, trend lines, fallback banks
  GENERATOR.md            this file
.seed-corpus.local/       (gitignored) banks/ + generated corpora
```

## Running

```bash
# 1. author the text banks once (needs the `claude` CLI; ~4–5 min per bank,
#    run in parallel; re-runs only author what is missing)
node scripts/seed/author-banks.mjs --concurrency 6            # round 1: full banks
node scripts/seed/author-banks.mjs --concurrency 6 --rounds 2,3,4   # extra themed post rounds (themes 2–19 defined in ROUND_THEMES)
node scripts/seed/author-banks.mjs --only generic --rounds 14,15,16 # generic-only rounds are cheap and lower reuse for every archetype

# 2. generate (≈3 s for 1M ops, ~90 MB) and validate with seed-lib
node scripts/seed/generate-corpus.mjs --users 1000 --posts 100000 --ops 1000000 \
     --seed 42 --out .seed-corpus.local/mass

# 3. quick invariant check on a tiny corpus (PASS/FAIL lines, exit 1 on FAIL)
node scripts/seed/generate-corpus.mjs --self-test
```

Outputs: `<out>.personas.json`, `<out>.corpus.jsonl`, `<out>.summary.json`.
After writing, the generator re-reads both files through `loadPersonas` and
`parseCorpus` (the exact validators the seeder uses) and runs its own
invariant checks (hero margin, zero-like share, follow placement, tag/media
shares, no duplicate contents, …). Any failure exits non-zero.

## CLI knobs

| flag | default | meaning |
|---|---|---|
| `--users N` | 1000 | personas (3 are the fixed heroes `alice7`/`bob8`/`carol9`) |
| `--posts N` | 100000 | top-level posts **+ quotes** |
| `--ops N` | 1000000 | total ops; hit exactly by topping up / trimming likes |
| `--seed N` | 42 | PRNG seed (sfc32); same seed + same banks ⇒ identical output |
| `--out PATH` | `.seed-corpus.local/mass` | output prefix |
| `--banks DIR` | `.seed-corpus.local/banks` | bank directory; missing banks fall back to the built-in ones |
| `--topology v4\|v5\|v6` | v6 | hashtag max length passed to `parseCorpus` |
| `--mix k=v,…` | see below | op-mix shares |
| `--quiet` | | only print failures |

`--mix` keys (shares of `--ops`, except `quoteShare` which is a share of
`--posts`): `quoteShare=0.10, replies=0.20, likes=0.55, likeReply=0.08,
repost=0.03, follow=0.035, bookmark=0.005`. Posts are `--posts × (1 −
quoteShare)`. Likes absorb the rounding so the total is exact.

## Text banks (`author-banks.mjs`)

Each archetype gets a bank JSON: ~90–120 top-level `posts`, `openers`,
`tails`, `replies` by intent (`agree / disagree / question / joke / fact /
answer`), `quotes`, and archetype-specific `slots`. There is also a
voice-neutral `generic` bank (posts, replies, `followups` keyed by the parent
reply's intent, quotes), a `hero` bank (26 hero-thread replies with
role/intent/target and 12 quote takes), a `dashlore` bank (general / dev /
"don't trust, verify" callbacks), and a `trends` bank (40 lines for each
trending tag).

Extra rounds (`--rounds 2,3,…`) write `<name>.r<N>.json` on a distinct theme
(everyday life, opinions, running bits, community, one-liners, asks, work,
seasons, gear, people, learning, numbers, …) and are merged into the base bank
at load time. More rounds ⇒ more distinct base lines ⇒ lower per-line reuse.

Lines may contain `{slot}` placeholders (see `GLOBAL_SLOTS` in
`corpus-archetypes.mjs`: `{city} {year} {n} {nn} {big} {pct} {price} {hour}
{Day} {drink} {snack} {dish} {shop} {game} {team} …`) plus `{name}` in replies
and quotes (the parent author's first name). Every prompt forbids hashtags,
URLs and @mentions in the text; the generator adds those.

If no banks exist the generator uses `FALLBACK_BANK` / `GENERIC_FALLBACK` /
`HERO_FALLBACK` / `DASH_LORE` from `corpus-archetypes.mjs` (~250 hand-written
lines) and reports `bankSource: "fallback"` in the summary; with some banks
missing it reports `"mixed"` and lists them.

## Personas

30 archetypes with population weights (`ARCHETYPES[*].weight`): Dash
core/platform devs, masternode operators, merchants, skeptics, privacy people,
Caracas adopters, memers, foodies, gamers, fitness, musicians, photographers,
travelers, students, parents, small-business owners, sports fans, bookworms,
makers, local-news posters, economists, artists, gardeners, film buffs,
scientists, techies, outdoors, pet people, finance, lurkers.

Per persona: name from ~190 first × ~150 last names (18% get a nickname-style
display name), unique handle derived from the name + a digit 2–9 (validated
with `validateHandle`), bio from archetype templates with slot fills (≤160),
city (≤50, 85% have one), optional https website, `avatarSeed`,
`style` (2–4 archetype traits + rendered tics), `interests`, `activity`.

`activity` is heavy-tailed: 15% near-lurkers in [0.03, 0.15], the rest
`0.55 × lognormal(0, 0.9)` clipped to [0.12, 8].

Tics (not written on chain, applied at render time): all-lowercase,
typo rate, emoji rate with an archetype palette, an optional signature tail,
and two one-off bits — one dashdev "quotes error messages verbatim" and one
operator "posts the current block height" (`BLOCK_HEIGHT_BASE` + a value that
grows along the timeline).

Hero personas are fixed: `alice7` (dashdev, "Alice"), `bob8` (techie, "Bob"),
`carol9` (skeptic, "Carol"), with extra follow prestige so they sit in the top
followed accounts (Bob and Carol therefore run well above the median in
likes-per-post).

## Follow graph

`--ops × follow` edges. Out-degree ∝ `activity^0.5 × lognormal`. Targets:
70% preferential attachment from an urn seeded with `prestige^1.4` and grown by
in-degree, 22% same-archetype, 8% uniform; 12% of edges reciprocate. Result
at 1k users / ~37k follows: a few accounts with 300–550 followers, median ~30.
85% of follow ops are placed in the first 2.5% of the corpus.

## Posts and engagement

Author of each base post is drawn ∝ `activity`; time is uniform over the
virtual line space. The hero post sits at 5%.

**λ (expected likes) per post** = `quality × reach`, with `reach =
(followers + 4)^0.8` and `quality` a two-component mixture: with probability
`pDead` a "nobody saw it" mass (`0.03 × lognormal`), otherwise
`lognormal(0, sigmaLive)`. λ is rescaled to the like budget, then `pDead` and
`sigmaLive` are auto-tuned (≤30 iterations) so the expected zero-like share
lands in 0.40–0.46 and the top-1% share in 0.15–0.25. The 12 highest-λ posts
are pinned to a viral ladder below the hero cap so there are always posts with
hundreds of likes; everything else is capped at 0.9× the hero cap ÷ 2.2.

From λ: `replies ~ Poisson(0.25 + λ^0.85)`, `quotes ∝ (λ+0.3)^1.3`,
`reposts ∝ (λ+0.2)^1.2`, `bookmarks ∝ λ+0.1`, each rescaled to its budget.
Likes come from the author's followers (60%), same-archetype accounts (15%)
or the activity urn; reposts/bookmarks/quotes mostly come from likers. Quotes
are new posts with their own smaller engagement.

**Threads**: replies attach to the post (top level) or, with rising
probability as the thread grows, to a recent reply (`parentRef` = a reply ⇒
`replyToReplyId`). The post author answers ~35% of nested replies with an
`answer` line. Reply text is chosen by (replier archetype × intent), with the
intent distribution biased per archetype (`INTENT_BIAS`), and nested replies
use the generic `followups[parentIntent]` pool half the time so they respond
to the kind of reply above them. `likeReply` λ = base × intent boost
(joke/fact 1.8, answer 1.2, else 0.8) × thread heat, normalised so the budget
lands.

**Hero thread** (`heroThreadFor`): the three fixed replies, then the hero
bank's replies from personas of the requested archetype attached to the
requested target (post / Bob / Carol / Alice's "Don't trust. Verify."),
Alice/Bob answering questions and pushback with hand-written `HERO_ANSWERS`,
plus a few nested follow-ups. Likes on the hero = 92% of all users; all other
posts are capped at that ÷ 2.2, so the ≥2× margin is structural. The hero
also gets 14 quotes, 12% reposts, 8% bookmarks and fixed `likeReply` counts on
the key replies.

**Timeline**: every op has a virtual time; engagement trails its target by a
lognormal delay (median ~1.5k lines for likes, ~600 for replies, 12× wider for
the hero) so a post's engagement is spread over the following few thousand
lines and refs are always defined before use. Ops are sorted by time, ties by
emission order.

## Content

- Base line choice per post: block-height bit (that persona only), trending
  burst line (60% while inside a burst window), Dash lore (6%, 10% for
  dev-ish archetypes; dev lore for them, `verify` callbacks sometimes for
  others), error-message lines (the "quotes errors" persona), else archetype
  bank or generic bank. The generic share per archetype is adaptive: big
  archetypes with small banks draw more generic lines so per-line reuse is
  balanced.
- Lines are dealt from shuffled decks (every line used k times before any is
  used k+1), then slot-filled and rendered with the persona's tics. Exact
  duplicates are impossible: a global content set is checked and colliding
  texts are re-rolled/varied (opener, tail, weekday prefix, …) until unique.
  Summary reports `postLineReuse` (max/mean/p95 uses of a bank post line) and
  `duplicateRescues`.
- Hashtags: 44% of bank posts (12% for lurkers, 20% of generic posts with a
  global tag) get ONE tag from the archetype's list weighted by Zipf rank in
  `HASHTAG_UNIVERSE` (74 tags); lore posts get a keyword-matched Dash tag half
  the time; trend posts always carry the burst tag. Tags are appended as
  `#tag` to the content as well as set in `hashtag`.
- Trending bursts: `round(posts / 14000)` tags from `TREND_CANDIDATES`, each
  a 0.6%-of-virtual-time window where 60% of posts use that tag's lines
  (`TREND_LINES` + the `trends` bank). The summary reports each burst's actual
  first/last line and post count (line index ≠ virtual time because
  engagement trails its post).
- Media: `https://picsum.photos/seed/<archetype word><n>/<size>` on 6% of
  posts (20% for photographers/artists/foodies), 3% of quotes; `sensitive:
  true` on 6% of media posts (~0.4% overall).
- Links: 1% of posts append/prefix a `{{link:REF}}` line pointing at a post
  from the previous ~4000 posts, only when the expanded length fits.
- Emoji only for personas with an emoji rate and an archetype palette; at
  most one appended per line, never on lines that already carry one.

## Summary JSON

Per-type counts, YAPP total + max per author (post/quote 10, reply 3,
like/likeReply/repost 1), estimated credits per type and total (post 188M,
reply 175M, like 90M untagged / 130M tagged, likeReply 54M, repost 66M, follow
46M, bookmark 18M), like distribution (max, top10, median, zero share, top-1%
share, posts ≥100 likes), hero stats (likes vs runner-up and ratio, replies,
quotes, reposts, bookmarks, Alice/Bob/Carol mean likes vs everyone), follow
distribution, thread stats, hashtag stats + burst windows, content stats
(media/sensitive/links/lore/trend counts, bank source and files, line reuse),
archetype census, the adaptive generic shares, and the λ calibration trace.
