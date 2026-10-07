/**
 * Live proof of the beta.7 social v10 count consolidation (docs/SOCIAL_V10.md,
 * "Merged count indexes"). The re-cut drops every count-only index whose list
 * twin can carry the count, and the app then counts through the twins:
 *
 *   (like is copied too, unchanged by the re-cut, for the feed page's slots)
 *   post    ownerAndTime [$ownerId, $createdAt]   rangeCountable, ranked at $ownerId
 *           quotesOfPost / quotesOfReply [quoted…, $createdAt]  rangeCountable
 *           ownerAndQuotedPost / ownerAndQuotedReply   unique, skipIfAbsent (one repost/quote per target)
 *   reply   repliesOf [rootPostId, replyToReplyId, $createdAt]  rangeCountable, ranked at rootPostId
 *   follow  following [$ownerId, $createdAt]       rangeCountable
 *           followers [followingId, $createdAt]    rangeCountable, ranked at followingId
 *
 * rs-drive's count index picker (v4.2.0-beta.7, drive_document_count_query/
 * index_picker.rs) serves a count pinning every property but the last of a
 * rangeCountable index (the prefix-to-last form), and any contiguous pin at or
 * below the shallowest `at` level of a prefix-level ranking (the at-chain
 * form); the composite feed's count slots use the same picker. This script
 * proves each query shape the client issues against a THROWAWAY contract
 * whose post, reply, follow and like types are copied verbatim from
 * contracts/yappr-social-contract-v10.json (index lists, properties, rules,
 * references), minus what needs the contract's token or moderation (action
 * fees, token costs, moderator abilities). So what passes here is the exact index layout the
 * social contract publishes.
 *
 * Writes (3 owners A/B/C, 3 targets T1-T3), then asserts:
 *   q1-q4  quote counts: single `==`, batched `in` + groupBy, composite slot, list
 *   a1-a3  posts per author: single, batched, ranked top authors
 *   u1-u3  one quote/repost per author per target (40105), a post needs a body (10422)
 *   r1-r9  repliesOf: thread count, per-reply count, direct-to-root (null pin)
 *          list asc/desc + paging, children of a reply, whole-thread scan,
 *          batched per root, batched per reply, composite slot, ranked roots
 *   f1-f5  follower / following counts: single, batched, ranked
 *   c1-c4  composite count slots (feed page, a replies page, the author card,
 *          a by-id reply page with slots pinned to its root)
 *   w1-w2  bare reposts of a post and of a reply, read back
 *   o1-o2  the viewer's own quote/repost per target (ownerAndQuoted…, `in`)
 *   n1-n8  notifications: replies and quotes/reposts on 3.5-day windows
 *          (timeRange `newest` + `byStart` of the previous window, recipient
 *          pinned, deduped);
 *          mentions on the permanent mentionedUserAndTime (n3); n6x/n7x a
 *          windowed source cannot ride a composite; n8 the permanent sources
 *          (mentions included) bundle
 *   t1-t2  the whole thread at the app's page size, and paged with startAfter
 *   l1-l2  the quote lists at limit 100, of a post and of a reply
 *   c5     the For You page exactly as composite-feed-page builds it (timeline
 *          page; like, reply and quote counts; the quoted-post join; DPNS
 *          names; the viewer's hearts as one byPost read beside it), minus
 *          the profile slot (v10's profile is DashPay's, #602); c5x the
 *          combined count + hearts form is refused
 *   c6     a profile page (ownerAndTime) with the quoted-post join and counts
 *   g1     the following feed: `$ownerId in` + `$createdAt >` on ranked ownerAndTime
 *   c2x/c3x  a bound slot extending the page's own index path is refused
 *          ("lands at the merged root"): such counts are separate queries
 *   dc-*   likes (no byLiker; byAuthorPostTime / byAuthorReplyTime [author,
 *          target, $createdAt]): heart state on byPost/byReply, top creators
 *          and a profile's top posts, per-post like reads with keyset paging,
 *          recent posts and replies that gained likes, counts, unlike end to
 *          end, one `target in` read across targets (dc-k, dc-k2), the
 *          composite cap (dc-j2); dc-i and dc-j1 are reported, never failed
 *   rm1    a reply mention: reply.mentionedUserAndTime, alone and bundled
 *
 * ## Social v11 (`--contract-file contracts/yappr-social-contract-v11.json`)
 *
 * v11 (docs/SOCIAL_V11.md) keeps every v10 index but the like author index,
 * which drops `$createdAt` (byAuthorPost / byAuthorReply), and marks the two
 * trend windows `outlivesDelete`. The proof contract then also keeps the
 * post/reply moderator abilities (deleteKeepsFields, deleteWithin,
 * deleteSettled) and an elected declaration over post and reply, with
 * minutes-long stand-ins for the week-long values so expiry and settling are
 * observable in one sitting: `deleteWithin` PROOF_DELETE_WITHIN s, election
 * windows PROOF_ELECTION_WINDOW s, the trend grids PROOF_TREND_GRIDS, and no
 * owner protection. A fourth identity D (never on the team) authors what the
 * moderators remove. The dc-e/dc-h/dc-k like reads, which read `$createdAt`
 * off the author index, become:
 *   ol-*   timeless likes: likers per target on byPost (keyset on the
 *          `$ownerId` terminal), several targets in one author-pinned read
 *          on byAuthorPost/byAuthorReply (the target-only `in` is refused,
 *          ol-e3x/e5x), rankings,
 *          trending windows, recent posts that gained likes; unlike WITHOUT
 *          `$createdAt` (count and heart drop, the trend windows keep the
 *          entry), a re-like counts once, and the kept entries expire with
 *          their window (ol-x*)
 *   kf-*   removal records keep the post's hashtag and $createdAt and the
 *          reply's rootPostId and $createdAt (D4), read from the deletion and
 *          from documentRemovals
 *   tm-0*  before a team is seated: past the window even the interim owner's
 *          delete is refused (41116), and a team proposal is 41205
 *
 * ## Social v12 (`--contract-file contracts/yappr-social-contract-v12.json`)
 *
 * v12 (docs/SOCIAL_V12.md) is v11 whose like author and hashtag indexes are
 * `summableOffCountIndex` counters of byPost / byReply (one SumItem per post,
 * no like documents; platform#5250) and whose post and reply declare
 * `retractedWhen` (#5253). Every v11 phase runs; what the file declares
 * switches:
 *   ol-e4/ol-e6  the author-pinned liker reads are refused (ol-e4x, ol-e6x);
 *          the same targets' counters are read instead (grouped counts)
 *   ol-f4  the grouped per-post count reads the counters' sums
 *   cn-*   counters (D's fresh posts and replies): zero from creation (cn-0 totals, cn-0r range walks);
 *          point counts at the post, author and hashtag levels, each equal to
 *          sum(byPost) (cn-a); grouped per-post counts per `in` value and over
 *          a range grouped by postId, zero groups included (cn-b); a range
 *          TOTAL through a ranked level refused with the grouping hint, on
 *          byAuthorPost and on byPost (cn-c); ranked creators (count and
 *          sum(byPost)), hashtags, an author's and a tag's posts (cn-d);
 *          documents reads through the counters refused, likers per target on
 *          byPost (cn-e); likeReply counters off byReply, unranked (cn-f);
 *          unlikes take the counters down, a drained or fresh post stays at 0
 *          (cn-g). Drive's refusal of a batch moving one type's counters for
 *          two documents is not reachable through a state transition (cn-h).
 *   rw-*   the interim owner bans, then suspends D: D's edits are refused
 *          (41107 / 41108), a tombstone keeping text is 10422, its tombstones
 *          of its own post and reply land, a take-back and a new post are
 *          refused; both bars are lifted again
 *   tm-15–tm-22 (`--team-proof … --added-member <n>`, optional, any cut whose
 *          deleteSettled needs several approvals; platform#5260) the leader
 *          adds E after D wrote S5 and before S6: E's proposal and approval of
 *          S5 are 41212 while the elected members and the leader complete it;
 *          E's proposal of S6 counts; the leader takes E off again. E must have
 *          filed a join request for the seated team's submitted charter (an
 *          `addedModerator` names one); without it the phase skips.
 *
 * Then seat a team on the throwaway contract (the ops election tooling: a
 * charter by the leader, join requests, the apply; the windows are
 * PROOF_ELECTION_WINDOW s) and run the second phase:
 *   tm-*   (`--team-proof <contractId> --reason-doc <id>`) the team: seats and
 *          elected members; D writes fresh targets and they settle (so the
 *          phase can run again); a member's lone delete of a settled post 41116; a
 *          proposal (active, 1 approval), its signers, a second approval by the
 *          proposer 41208, a member's approval (2 of 3, still active), the
 *          leader's (closed: the post is gone); the record keeps its fields;
 *          a restore is 41209; per-member action counts; a proposal for an
 *          unsettled post 41206 while a lone member still deletes it; the same
 *          flow for a settled reply
 *
 * Usage (NETWORK=devnet; the devnet from the env or `.env.devnet`):
 *   node scripts/prove-merged-counts.mjs --bot 1 --bot 2 --bot 3
 *   node scripts/prove-merged-counts.mjs --identity-id <id> --key-wif-file <file> (×3, in order)
 *   node scripts/prove-merged-counts.mjs --dry-run      # offline: build + validate the contract and fixture
 *   node scripts/prove-merged-counts.mjs --contract-file contracts/yappr-social-contract-v11.json \
 *        --bot 0 --bot 1 --bot 2 --identity-id <D> --key-wif-file <file> [--state-file <json>]
 *   node scripts/prove-merged-counts.mjs --contract-file contracts/yappr-social-contract-v11.json \
 *        --team-proof <contractId> --reason-doc <reasonId> --bot 0 --bot 1 --bot 2 --identity-id <D> --key-wif-file <file>
 *   node scripts/prove-merged-counts.mjs --contract-file contracts/yappr-social-contract-v12.json \
 *        --bot 0 --bot 1 --bot 2 --bot 3            # v12: as v11, plus cn-* and rw-*
 *   node scripts/prove-merged-counts.mjs --contract-file contracts/yappr-social-contract-v12.json \
 *        --team-proof <contractId> --reason-doc <reasonId> --bot 0 --bot 1 --bot 2 --bot 3 [--added-member 4]
 *
 * The first identity (A) registers the throwaway contract, which costs about
 * 40 × 10⁹ credits; B and C need only a few document writes' worth.
 * `--bot <n>` signs as seed index n (E2E_SEED_PHRASE) with identity id n of
 * the pool (DEVNET_IDENTITY_IDS, else E2E_IDENTITY_IDS; `--bot n:<id>` names
 * it). A `--key-wif-file` holds one WIF of a HIGH or CRITICAL authentication
 * key of the identity before it. Never the maker: the contract is throwaway.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DataContract, PlatformVersion, PrivateKey, ensureInitialized } from '@dashevo/evo-sdk';
import initWasmDpp2, { DataContract as NodeRulesDataContract, PlatformVersion as NodeRulesPlatformVersion } from '@dashevo/wasm-dpp2';
import bs58 from 'bs58';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { devnetConfig, devnetSdk, envValue } from './sdk-env.mjs';
import { REPO_ROOT, createdId, findRecentByValues } from './seed/seed-lib.mjs';
import { buildDocument, randomIdBytes } from './verify-lib.mjs';
import { liftBar } from './social-battery-lib.mjs';

const SOCIAL_V10 = join(REPO_ROOT, 'contracts/yappr-social-contract-v10.json');
/** v11 stand-ins for week-long values, so settling and expiry happen within one run (see the header). */
const PROOF_DELETE_WITHIN = 90;
const PROOF_ELECTION_WINDOW = 60;
/** The trend grids at the real contract's ratios: posts 3 windows of 3 steps (72h/24h), tags 4 (24h/6h). */
const PROOF_TREND_GRIDS = { byTrendPost: { range: 360, step: 120 }, byTrendHashtagPost: { range: 240, step: 60 } };
const DRY_RUN_OWNER = '11111111111111111111111111111111';
/** The moderation charters system contract: the seated team's `addedModerator` and `joinRequest` documents (tm-15). */
const MODERATION_CHARTERS_CONTRACT_ID = 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88';
const SETTLE_MS = 3000;
const DUPLICATE_UNIQUE = /\bcode"?\s*[=:]\s*40105\b|duplicate unique properties/i;
const RULE_BROKEN = /\bcode"?\s*[=:]\s*10422\b|does not hold/i;
const CONSENSUS_CODE = /\bcode"?\s*[=:]\s*\d{4,5}\b/;

// ---- The throwaway contract -------------------------------------------------

/**
 * post, reply, follow, like and likeReply exactly as social v10 declares them (indexes,
 * properties, rules, references: the fixture satisfies every `where`, and the
 * feed's by-id quote join needs `refersTo`), minus what needs the contract's
 * token or moderation (token costs, action fees, moderator abilities).
 */
function proofContractSource(file) {
  const social = JSON.parse(readFileSync(file, 'utf8'));
  const v11 = likesOutliveDelete(social);
  const documentSchemas = {};
  for (const type of ['post', 'reply', 'follow', 'followRequest', 'like', 'likeReply']) {
    const schema = structuredClone(social.documentSchemas[type]);
    for (const key of ['actionFees', 'tokenCost']) delete schema[key];
    if (v11 && schema.moderatorAbilities?.deleteWithin) schema.moderatorAbilities.deleteWithin = PROOF_DELETE_WITHIN;
    else if (!v11) delete schema.moderatorAbilities;
    if (type === 'like' && v11) {
      for (const index of schema.indices) {
        const grid = PROOF_TREND_GRIDS[index.name];
        if (grid) index.timeRange = { ...index.timeRange, ...grid, ttl: grid.range };
      }
    }
    documentSchemas[type] = schema;
  }
  if (v11) {
    for (const type of ['report', 'yapprProfile']) if (documentSchemas[type]) throw new Error(`${type} is not in the proof contract`);
    for (const type of ['post', 'reply']) if (!documentSchemas[type].moderatorAbilities) throw new Error(`v11 ${type} declares no moderatorAbilities`);
  }
  const config = { ...social.config };
  if (v11) {
    const { moderators } = config.moderation;
    config.moderation = {
      ...config.moderation,
      moderators: {
        ...moderators,
        joinWindow: PROOF_ELECTION_WINDOW,
        voteWindow: PROOF_ELECTION_WINDOW,
        ownerProtected: false,
        moderatedDocumentTypes: { post: moderators.moderatedDocumentTypes.post, reply: moderators.moderatedDocumentTypes.reply },
      },
    };
  } else {
    delete config.moderation;
  }
  return { $formatVersion: social.$formatVersion, version: 1, config, documentSchemas };
}

/** True for a cut whose like trend windows outlive deletes (v11): no like index keeps `$createdAt`. */
function likesOutliveDelete(social) {
  return social.documentSchemas.like.indices.some((index) => index.outlivesDelete === true);
}

/** True for a cut whose like author indexes are `summableOffCountIndex` counters (v12): one counter per post, no like documents. */
function authorIndexesAreCounters(social) {
  return social.documentSchemas.like.indices.some((index) => index.summableOffCountIndex !== undefined);
}

/** True for a cut whose post and reply declare `retractedWhen` (v12): a barred author may still tombstone. */
function barredAuthorsRetract(social) {
  return ['post', 'reply'].every((type) => social.documentSchemas[type].retractedWhen !== undefined);
}

function contractJson(source, { id, ownerId }) {
  return { ...source, id, ownerId };
}

// ---- Arguments --------------------------------------------------------------

function parseArgs(argv) {
  const args = { actors: [], dryRun: false, contractFile: SOCIAL_V10, teamProof: null, reasonDoc: null, stateFile: null, addedMember: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract-file': args.contractFile = isAbsolute(argv[i + 1]) ? argv[++i] : join(REPO_ROOT, argv[++i]); break;
      case '--team-proof': args.teamProof = argv[++i]; break;
      case '--reason-doc': args.reasonDoc = argv[++i]; break;
      case '--state-file': args.stateFile = argv[++i]; break;
      case '--added-member': {
        const [index, id] = argv[++i].split(':');
        args.addedMember = { kind: 'bot', index: Number(index), id: id || null };
        break;
      }
      case '--bot': {
        const [index, id] = argv[++i].split(':');
        args.actors.push({ kind: 'bot', index: Number(index), id: id || null });
        break;
      }
      case '--identity-id': args.actors.push({ kind: 'wif', id: argv[++i], wifFile: null }); break;
      case '--key-wif-file': {
        const last = args.actors.at(-1);
        if (!last || last.kind !== 'wif' || last.wifFile) throw new Error('--key-wif-file follows its --identity-id');
        last.wifFile = argv[++i];
        break;
      }
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  const v11 = likesOutliveDelete(JSON.parse(readFileSync(args.contractFile, 'utf8')));
  if (!args.dryRun && args.actors.length !== (v11 ? 4 : 3)) {
    throw new Error(`name exactly ${v11 ? 'four' : 'three'} identities (--bot <n> or --identity-id <id> --key-wif-file <file>), in the order A B C${v11 ? ' D (D never on the team)' : ''}`);
  }
  if (args.teamProof && (!v11 || !args.reasonDoc)) throw new Error('--team-proof needs a v11 or v12 --contract-file and the charter\'s --reason-doc');
  if (args.addedMember && (!args.teamProof || !Number.isInteger(args.addedMember.index))) throw new Error('--added-member <n[:id]> (a seed bot) goes with --team-proof');
  for (const actor of args.actors) {
    if (actor.kind === 'bot' && !Number.isInteger(actor.index)) throw new Error('--bot takes a seed index (optionally <n>:<identityId>)');
    if (actor.kind === 'wif' && !actor.wifFile) throw new Error(`--identity-id ${actor.id} needs its --key-wif-file`);
  }
  return args;
}

function poolIds() {
  return (envValue('DEVNET_IDENTITY_IDS') || envValue('E2E_IDENTITY_IDS') || '').split(',').map((id) => id.trim()).filter(Boolean);
}

async function resolveActor(sdk, actor, label) {
  if (actor.kind === 'bot') {
    const ownerId = actor.id ?? poolIds()[actor.index];
    if (!ownerId) throw new Error(`no identity id for bot ${actor.index}: pass --bot ${actor.index}:<id> or set E2E_IDENTITY_IDS`);
    const owner = resolveOwner({ botIndex: actor.index, ownerId });
    return { label, ownerId, ...(await signerFor(sdk, owner)) };
  }
  const wif = readFileSync(actor.wifFile, 'utf8').trim();
  const hash = PrivateKey.fromWIF(wif).getPublicKeyHash();
  const identity = await sdk.identities.fetch(actor.id);
  if (!identity) throw new Error(`identity ${actor.id} not found`);
  const key = identity.publicKeys.find((candidate) => candidate.getPublicKeyHash() === hash
    && /^auth/i.test(candidate.purpose) && /^(critical|high)$/i.test(candidate.securityLevel));
  if (!key) throw new Error(`${actor.wifFile} is not a HIGH or CRITICAL authentication key of ${actor.id}`);
  return { label, ownerId: actor.id, ...(await signerFor(sdk, { ownerId: actor.id, keyId: key.keyId, wif })) };
}

// ---- Reporting --------------------------------------------------------------

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
/**
 * Grouped counts as sets: the node returns groups in key-byte order, and a
 * group with no documents is absent rather than 0.
 */
const sameCounts = (actual, expected) => {
  const nonZero = (counts) => Object.entries(counts).filter(([, n]) => n !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return same(nonZero(actual), nonZero(expected));
};
const COMPOSITE_MERGED_ROOT = /lands at the merged root/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- The SDK session ----------------------------------------------------------

/**
 * A quorum rotation can leave the trusted context without the quorum a proof
 * names ("Quorum not found in cache"), which no retry on the same instance
 * cures. The run therefore talks to `sdk`, a handle onto the session's current
 * instance, and a collapsed transport rebuilds the instance (connect, the
 * protocol-version ratchet, the contracts it reads) and runs the read again,
 * as verify-lib's battery handle does.
 */
const TRANSPORT_COLLAPSE = /no available addresses|invalid quorum|quorum not found/i;
/** A timeout or a gateway error: the read never reached a verdict, so it is no refusal. */
const TRANSIENT = /timed? ?out|timeout|deadline exceeded|bad gateway|gateway time|\b50[234]\b/i;
/** The node's refusal of a documents read through an index that holds no documents (a counter). */
const NON_INDEXED = /where clause on non indexed property/i;
const session = { sdk: null, config: null, contracts: new Set() };
const sdk = new Proxy({}, {
  get(_, property) {
    const value = session.sdk[property];
    return typeof value === 'function' ? value.bind(session.sdk) : value;
  },
});

async function connectSession(config) {
  const fresh = devnetSdk({ timeoutMs: 30000, config });
  await fresh.connect();
  await fresh.epoch.current(); // protocol-version ratchet (see verify-lib buildConnectedSdk)
  for (const contractId of session.contracts) await fresh.contracts.fetch(contractId);
  session.sdk = fresh;
  session.config = config;
}

/**
 * Runs `fn`, again on a fresh instance when the transport collapsed under it. The quorum
 * service can trail a rotation by a minute or two, so a missing quorum is waited out
 * (up to 6 tries, 15 s apart) rather than failed at once.
 */
async function withReconnect(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const reason = describeErr(e);
      if (attempt >= 6 || !TRANSPORT_COLLAPSE.test(reason)) throw e;
      console.log(`     (transport collapsed, reconnecting: ${reason.slice(0, 120)})`);
      if (attempt > 0) await sleep(15_000);
      await connectSession(session.config).catch(() => {});
    }
  }
}

/**
 * Runs one query, recording a thrown refusal as that query's FAIL instead of
 * aborting the run. A collapsed transport is retried once on a fresh instance;
 * `idempotent: false` (a write that must not be sent twice) is not.
 */
async function attempt(label, fn, verdict, { idempotent = true } = {}) {
  try {
    const value = idempotent ? await withReconnect(fn) : await fn();
    verdict(value);
  } catch (e) {
    check(label, false, `refused: ${describeErr(e).slice(0, 300)}`);
    // A write is never resent, but the next check must not inherit a dead instance.
    if (!idempotent && TRANSPORT_COLLAPSE.test(describeErr(e))) await connectSession(session.config).catch(() => {});
  }
}

/** One document create; a confirmation-wait fault is not a verdict, so the chain decides. */
async function createDocument(contractId, who, docType, data, retried = false) {
  const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, entropy: randomIdBytes() });
  const since = Date.now();
  let error = null;
  try {
    const created = await sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer });
    const createdAs = createdId(created);
    if (createdAs) return { ok: true, id: createdAs };
  } catch (e) {
    error = describeErr(e);
    if (CONSENSUS_CODE.test(error)) return { ok: false, error };
    // A quorum rotation can fault the proof of a write that landed: rebuild the instance and let the chain decide.
    if (TRANSPORT_COLLAPSE.test(error)) await connectSession(session.config).catch((reconnectError) => console.log(`     (reconnect failed: ${describeErr(reconnectError).slice(0, 120)})`));
  }
  for (let tries = 0; tries < 5; tries++) {
    await sleep(SETTLE_MS);
    const found = await findRecentByValues(sdk, { contractId, docType, ownerId: who.ownerId, data, since }).catch(() => null);
    if (found) return { ok: true, id: found };
  }
  // Resend at most once, after a last readback, and never a quote or repost (one per author
  // per target: a late-landing original would turn the resend into a 40105). A post or reply
  // whose original lands later still could be counted twice; the readback makes that rare.
  const unique = docType === 'post' && (data.quotedPostId || data.quotedReplyId);
  if (error && TRANSPORT_COLLAPSE.test(error) && !retried && !unique) {
    const late = await findRecentByValues(sdk, { contractId, docType, ownerId: who.ownerId, data, since }).catch(() => null);
    if (late) return { ok: true, id: late };
    return createDocument(contractId, who, docType, data, true);
  }
  return { ok: false, error: error ?? 'no document after the write' };
}

// ---- Result decoding --------------------------------------------------------

const toBase58 = (value) => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return /^[0-9a-f]{64}$/i.test(value) ? bs58.encode(Buffer.from(value, 'hex')) : value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  return bs58.encode(Uint8Array.from(value));
};
/** A count answer as `{ key → number }`, keys base58 (the total is keyed ''). */
const countEntries = (map) => Object.fromEntries([...map.entries()].map(([key, value]) => [key === '' ? '' : toBase58(key), Number(value)]));
const total = (map) => Number(map.get('') ?? 0n);
/** Where `keys` stand in grouped `entries`: a per-`in` read's zero groups are reported, not required (the book promises them for range walks only). */
const zeroGroups = (entries, keys) => keys.map((key) => `${key.slice(0, 6)}… ${key in entries ? `present at ${entries[key]}` : 'absent'}`).join(', ');
const docsOf = (result) => (result instanceof Map ? [...result.values()] : Object.values(result ?? {})).filter(Boolean);
const idOf = (doc) => toBase58(doc.id ?? doc.$id ?? doc.toObject?.().$id);
const createdAtOf = (doc) => Number(doc.createdAt ?? doc.$createdAt ?? doc.toObject?.().$createdAt ?? 0);
/** Exactly `expected` (as a set), newest first (writes in one block share a `$createdAt`). */
const newestFirst = (docs, expected) => {
  const got = docs.map(idOf);
  const times = docs.map(createdAtOf);
  return got.length === expected.length && expected.every((id) => got.includes(id)) && times.every((t, i) => i === 0 || t <= times[i - 1]);
};

// ---- The run ----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await Promise.all([ensureInitialized(), initWasmDpp2()]);
  const source = proofContractSource(args.contractFile);
  const v11 = likesOutliveDelete(source);
  const counters = authorIndexesAreCounters(source);
  const retracts = barredAuthorsRetract(source);

  // Offline: both parsers accept the throwaway contract, and every fixture document builds.
  DataContract.fromJSON(contractJson(source, { id: DRY_RUN_OWNER, ownerId: DRY_RUN_OWNER }), true, PlatformVersion.latest());
  NodeRulesDataContract.fromJSON(contractJson(source, { id: DRY_RUN_OWNER, ownerId: DRY_RUN_OWNER }), true, NodeRulesPlatformVersion.latest());
  const indexes = Object.fromEntries(Object.entries(source.documentSchemas).map(([type, schema]) => [type, schema.indices.map((index) => index.name)]));
  console.log(`throwaway contract parses (wasm-sdk + wasm-dpp2): ${JSON.stringify(indexes)}`);
  console.log(`phases: ${v11 ? 'ol (timeless likes), M (design M), kf/tm-0' : 'dc (like design C)'}${counters ? ', cn (v12 counters)' : ''}${retracts ? ', rw (v12 retractedWhen)' : ''}`);
  if (args.dryRun) {
    const id = bs58.encode(randomIdBytes());
    for (const [docType, data] of [['post', { content: 'x' }], ['post', { quotedPostId: bs58.decode(id), quotedPostOwnerId: bs58.decode(id) }], ['reply', { rootPostId: bs58.decode(id), parentOwnerId: bs58.decode(id), content: 'x' }], ['follow', { followingId: bs58.decode(id) }]]) {
      buildDocument({ contractId: DRY_RUN_OWNER, docType, ownerId: DRY_RUN_OWNER, data, entropy: randomIdBytes() });
    }
    const { devnetName, addresses } = devnetConfig();
    console.log(`fixture documents build; would register on devnet "${devnetName}" via ${addresses[0]} (+${addresses.length - 1} more)`);
    return 0;
  }

  const config = devnetConfig();
  await connectSession(config);
  const actors = await Promise.all(args.actors.map((actor, i) => resolveActor(sdk, actor, 'ABCD'[i])));
  const [A, B, C, D] = actors;
  console.log(`devnet "${config.devnetName}"; ${actors.map((who) => `${who.label}=${who.ownerId}`).join(' ')}`);
  if (new Set(actors.map((who) => who.ownerId)).size !== actors.length) throw new Error('the identities must all differ');
  if (args.teamProof) {
    await proveTeam(sdk, args, actors, source);
    console.log(failures === 0 ? 'ALL TEAM CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
    return failures === 0 ? 0 : 1;
  }

  // Register.
  const nonce = ((await sdk.identities.nonce(A.ownerId)) ?? 0n) + 1n;
  const draft = DataContract.fromJSON(contractJson(source, { id: DataContract.generateId(A.ownerId, nonce).toBase58(), ownerId: A.ownerId }), true, PlatformVersion.latest());
  const published = await sdk.contracts.publish({ dataContract: draft, identityKey: A.identityKey, signer: A.signer });
  const contractId = published.id.toBase58();
  session.contracts.add(contractId);
  console.log(`throwaway contract registered by A: ${contractId}`);
  await sleep(SETTLE_MS);
  await sdk.contracts.fetch(contractId);

  const id = (value) => bs58.decode(value);
  const create = (who, docType, data) => createDocument(contractId, who, docType, data);
  async function mustCreate(label, who, docType, data) {
    const outcome = await create(who, docType, data);
    if (!outcome.ok) throw new Error(`fixture write ${label} failed: ${(outcome.error ?? '').slice(0, 300)}`);
    return outcome.id;
  }

  // ---- Fixture ----
  console.log('\n--- writing the fixture ---');
  const T1 = await mustCreate('T1', A, 'post', { content: 'target one' });
  const T2 = await mustCreate('T2', A, 'post', { content: 'target two' });
  const T3 = await mustCreate('T3', A, 'post', { content: 'target three' });
  const q1 = await mustCreate('q1 (B quotes T1)', B, 'post', { content: 'quote one', quotedPostId: id(T1), quotedPostOwnerId: id(A.ownerId) });
  const q2 = await mustCreate('q2 (B reposts T2, no content)', B, 'post', { quotedPostId: id(T2), quotedPostOwnerId: id(A.ownerId) });
  const q3 = await mustCreate('q3 (C quotes T1)', C, 'post', { content: 'quote three', quotedPostId: id(T1), quotedPostOwnerId: id(A.ownerId) });
  const r1 = await mustCreate('r1 (B → T1)', B, 'reply', { content: 'r1', rootPostId: id(T1), parentOwnerId: id(A.ownerId) });
  await sleep(1100);
  const r2 = await mustCreate('r2 (C → T1)', C, 'reply', { content: 'r2', rootPostId: id(T1), parentOwnerId: id(A.ownerId) });
  const r3 = await mustCreate('r3 (A → r1)', A, 'reply', { content: 'r3', rootPostId: id(T1), replyToReplyId: id(r1), parentOwnerId: id(B.ownerId) });
  await sleep(1100);
  const r4 = await mustCreate('r4 (C → r1)', C, 'reply', { content: 'r4', rootPostId: id(T1), replyToReplyId: id(r1), parentOwnerId: id(B.ownerId) });
  const r5 = await mustCreate('r5 (B → r3)', B, 'reply', { content: 'r5', rootPostId: id(T1), replyToReplyId: id(r3), parentOwnerId: id(A.ownerId) });
  const r6 = await mustCreate('r6 (A → T2)', A, 'reply', { content: 'r6', rootPostId: id(T2), parentOwnerId: id(A.ownerId) });
  const qr = await mustCreate('qr (A reposts r1)', A, 'post', { quotedReplyId: id(r1), quotedPostOwnerId: id(B.ownerId) });
  for (const [who, whom] of [[A, B], [C, B], [A, C], [B, A]]) await mustCreate(`${who.label} follows ${whom.label}`, who, 'follow', { followingId: id(whom.ownerId) });
  const m1 = await mustCreate('m1 (C mentions B)', C, 'post', { content: 'hello @b', mentionedUserId: id(B.ownerId) });
  // Likes are indexOnly: the create may report a fault after the broadcast, so
  // the like counts below decide (c5 and k check them).
  const likeWrite = (who, docType, data) => {
    const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, entropy: randomIdBytes() });
    return sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer }).catch((e) => console.log(`     (${docType} by ${who.label} reported: ${describeErr(e).slice(0, 120)})`));
  };
  for (const [who, target] of [[B, T1], [C, T1], [B, T2]]) await likeWrite(who, 'like', { postId: id(target), postAuthor: id(A.ownerId) });
  await likeWrite(A, 'likeReply', { replyId: id(r1), replyAuthor: id(B.ownerId) });
  await sleep(SETTLE_MS);

  const q = (documentTypeName, rest) => ({ dataContractId: contractId, documentTypeName, ...rest });
  const count = (documentTypeName, where, groupBy) => sdk.documents.count(q(documentTypeName, { where, ...(groupBy ? { groupBy } : {}) }));

  // ---- u: uniqueness and the body rule ----
  console.log('\n--- u. one quote/repost per author per target; a post needs a body ---');
  const u1 = await create(B, 'post', { content: 'quote again', quotedPostId: id(T1), quotedPostOwnerId: id(A.ownerId) });
  check('u1 B quoting T1 a second time is refused 40105 (ownerAndQuotedPost)', !u1.ok && DUPLICATE_UNIQUE.test(u1.error ?? ''), (u1.error ?? 'accepted').slice(0, 200));
  const u2 = await create(A, 'post', { quotedReplyId: id(r1), quotedPostOwnerId: id(B.ownerId) });
  check('u2 A reposting r1 a second time is refused 40105 (ownerAndQuotedReply)', !u2.ok && DUPLICATE_UNIQUE.test(u2.error ?? ''), (u2.error ?? 'accepted').slice(0, 200));
  const u3 = await create(C, 'post', { sensitive: true });
  check('u3 a post with no content, media, embed or quote is refused 10422 (notEmpty)', !u3.ok && RULE_BROKEN.test(u3.error ?? ''), (u3.error ?? 'accepted').slice(0, 200));

  // ---- q: quote (= repost) counts ----
  console.log('\n--- q. quote counts on quotesOfPost / quotesOfReply ---');
  await attempt('q1', () => count('post', [['quotedPostId', '==', T1]]), (m) => check('q1 quotes of T1: `quotedPostId ==` (prefix-to-last on quotesOfPost) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('q1b', () => count('post', [['quotedPostId', '==', T1], ['$createdAt', '>', 0]]), (m) => check('q1b same with a `$createdAt > 0` range (range-aggregate form) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('q2', () => count('post', [['quotedPostId', 'in', [T1, T2, T3]]], ['quotedPostId']), (m) => check('q2 batched `in` + groupBy: T1 2, T2 1, T3 absent (0)', sameCounts(countEntries(m), { [T1]: 2, [T2]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('q3', () => count('post', [['quotedReplyId', '==', r1]]), (m) => check('q3 reposts of reply r1 (quotesOfReply) = 1', total(m) === 1, JSON.stringify(countEntries(m))));
  await attempt('q4', () => sdk.documents.query(q('post', { where: [['quotedPostId', 'in', [T1]]], orderBy: [['quotedPostId', 'asc'], ['$createdAt', 'desc']], limit: 50 })), (r) => check('q4 the quote list (the app\'s `in [id]` shape) returns both quotes of T1', docsOf(r).length === 2, `${docsOf(r).length} doc(s)`));

  // ---- a: posts per author ----
  console.log('\n--- a. posts per author on ownerAndTime ---');
  await attempt('a1', () => count('post', [['$ownerId', '==', A.ownerId]]), (m) => check('a1 A\'s posts: `$ownerId ==` = 4', total(m) === 4, JSON.stringify(countEntries(m))));
  await attempt('a2', () => count('post', [['$ownerId', 'in', [A.ownerId, B.ownerId, C.ownerId]]], ['$ownerId']), (m) => check('a2 batched per author: A 4, B 2, C 2 (C\'s quote and mention)', sameCounts(countEntries(m), { [A.ownerId]: 4, [B.ownerId]: 2, [C.ownerId]: 2 }), JSON.stringify(countEntries(m))));
  await attempt('a3', () => sdk.documents.ranked(q('post', { groupBy: '$ownerId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 })), (r) => {
    const got = r.entries.map((entry) => [toBase58(entry.groupValue), Number(entry.value)]);
    const rest = Object.fromEntries(got.slice(1));
    check('a3 ranked top authors (rankedCountable at $ownerId): A 4 first, then B and C at 2', got.length === 3 && same(got[0], [A.ownerId, 4]) && rest[B.ownerId] === 2 && rest[C.ownerId] === 2, JSON.stringify(got));
  });

  // ---- r: replies on repliesOf ----
  console.log('\n--- r. replies on repliesOf [rootPostId, replyToReplyId, $createdAt] ---');
  const ids = (r) => docsOf(r).map(idOf);
  await attempt('r1', () => count('reply', [['rootPostId', '==', T1]]), (m) => check('r1 whole-thread count of T1 (at-chain, depth 1) = 5', total(m) === 5, JSON.stringify(countEntries(m))));
  await attempt('r2', () => count('reply', [['rootPostId', '==', T1], ['replyToReplyId', '==', r1]]), (m) => check('r2 replies to r1 (depth 2) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('r2b', () => count('reply', [['rootPostId', '==', T1], ['replyToReplyId', '==', null]]), (m) => check('r2b direct replies to T1 (null pin) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('r3', () => sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 10 })), (r) => check('r3 direct replies to T1, oldest first: r1, r2', same(ids(r), [r1, r2]), JSON.stringify(ids(r))));
  await attempt('r3b', () => sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'desc']], limit: 10 })), (r) => check('r3b the same newest first: r2, r1', same(ids(r), [r2, r1]), JSON.stringify(ids(r))));
  await attempt('r3c', async () => {
    const first = await sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 1 }));
    const next = await sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 1, startAfter: ids(first)[0] }));
    return [...ids(first), ...ids(next)];
  }, (got) => check('r3c paging (limit 1 + startAfter) walks r1 then r2', same(got, [r1, r2]), JSON.stringify(got)));
  await attempt('r4', () => sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1], ['replyToReplyId', '==', r1]], orderBy: [['$createdAt', 'asc']], limit: 10 })), (r) => check('r4 children of r1, oldest first: r3, r4', same(ids(r), [r3, r4]), JSON.stringify(ids(r))));
  await attempt('r5', () => sdk.documents.query(q('reply', { where: [['rootPostId', '==', T1]], orderBy: [['replyToReplyId', 'asc'], ['$createdAt', 'asc']], limit: 100 })), (r) => {
    const got = ids(r);
    check('r5 whole thread by prefix scan: all 5, grouped by parent (direct first, under null)', got.length === 5 && same(got.slice(0, 2), [r1, r2]) && new Set(got).size === 5 && got.includes(r5), JSON.stringify(got));
  });
  await attempt('r6', () => count('reply', [['rootPostId', 'in', [T1, T2, T3]]], ['rootPostId']), (m) => check('r6 batched thread counts: T1 5, T2 1, T3 0', sameCounts(countEntries(m), { [T1]: 5, [T2]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('r7', () => count('reply', [['rootPostId', '==', T1], ['replyToReplyId', 'in', [r1, r2, r3]]], ['replyToReplyId']), (m) => check('r7 batched per-reply counts under T1: r1 2, r3 1, r2 0', sameCounts(countEntries(m), { [r1]: 2, [r3]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('r8', () => sdk.documents.ranked(q('reply', { groupBy: 'rootPostId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 })), (r) => {
    const got = r.entries.map((entry) => [toBase58(entry.groupValue), Number(entry.value)]);
    check('r8 ranked most-replied roots (at rootPostId): T1 5, T2 1', same(got, [[T1, 5], [T2, 1]]), JSON.stringify(got));
  });

  // ---- f: follows ----
  console.log('\n--- f. follower / following counts ---');
  await attempt('f1', () => count('follow', [['followingId', '==', B.ownerId]]), (m) => check('f1 B\'s followers (followers, at-chain) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('f2', () => count('follow', [['$ownerId', '==', A.ownerId]]), (m) => check('f2 A follows (following, prefix-to-last) = 2', total(m) === 2, JSON.stringify(countEntries(m))));
  await attempt('f3', () => count('follow', [['followingId', 'in', [A.ownerId, B.ownerId, C.ownerId]]], ['followingId']), (m) => check('f3 batched followers: A 1, B 2, C 1', sameCounts(countEntries(m), { [A.ownerId]: 1, [B.ownerId]: 2, [C.ownerId]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('f4', () => count('follow', [['$ownerId', 'in', [A.ownerId, B.ownerId, C.ownerId]]], ['$ownerId']), (m) => check('f4 batched following: A 2, B 1, C 1', sameCounts(countEntries(m), { [A.ownerId]: 2, [B.ownerId]: 1, [C.ownerId]: 1 }), JSON.stringify(countEntries(m))));
  await attempt('f5', () => sdk.documents.ranked(q('follow', { groupBy: 'followingId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 })), (r) => {
    const got = r.entries.map((entry) => [toBase58(entry.groupValue), Number(entry.value)]);
    check('f5 ranked most followed (at followingId): B 2 first, then A and C at 1', got.length === 3 && same(got[0], [B.ownerId, 2]) && got.slice(1).every(([, n]) => n === 1), JSON.stringify(got));
  });

  // ---- c: the composite feed's count slots (one proof per page) ----
  console.log('\n--- c. composite count slots ---');
  await attempt('c1', () => sdk.documents.composite({
    dataContractId: contractId,
    documentType: 'post',
    where: [['$ownerId', '==', A.ownerId]],
    orderBy: [['$createdAt', 'asc']],
    limit: 10,
    subQueries: [
      { documentType: 'post', kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field: 'quotedPostId' } },
      { documentType: 'reply', kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field: 'rootPostId' } },
    ],
  }), (result) => {
    const [quotes, replies] = result.subResults.map((sub) => countEntries(sub.counts));
    check('c1 feed page slots: quotes per post (T1 2, T2 1) and replies per root (T1 5, T2 1)', quotes[T1] === 2 && quotes[T2] === 1 && !quotes[T3] && replies[T1] === 5 && replies[T2] === 1 && !replies[T3], `quotes ${JSON.stringify(quotes)} replies ${JSON.stringify(replies)}`);
  });
  // A limited page may not sit at the merged root: a bound sub-query whose
  // index path extends the page's is refused ("lands at the merged root").
  // c2/c3 are the shapes the client uses (page on another path); c2x/c3x pin
  // the refusal so the client never builds the conflicting shape.
  await attempt('c2', () => sdk.documents.composite({
    dataContractId: contractId,
    documentType: 'reply',
    where: [['$ownerId', '==', B.ownerId]],
    orderBy: [['$createdAt', 'asc']],
    limit: 10,
    subQueries: [
      { documentType: 'reply', kind: 'counts', where: [['rootPostId', '==', T1]], bind: { source: 'page', sourceProperty: '$id', field: 'replyToReplyId' } },
      { documentType: 'post', kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field: 'quotedReplyId' } },
    ],
  }), (result) => {
    const [children, reposts] = result.subResults.map((sub) => countEntries(sub.counts));
    check('c2 B\'s replies (ownerAndTime page) with per-reply slots pinned to T1: children r1 2, r5 0; reposts r1 1', children[r1] === 2 && !children[r5] && reposts[r1] === 1 && !reposts[r5], `children ${JSON.stringify(children)} reposts ${JSON.stringify(reposts)}`);
  });
  await attempt('c3', () => sdk.documents.composite({
    dataContractId: contractId,
    documentType: 'reply',
    where: [['$ownerId', '==', B.ownerId]],
    orderBy: [['$createdAt', 'asc']],
    limit: 1,
    subQueries: [
      { documentType: 'post', kind: 'counts', bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } },
      { documentType: 'follow', kind: 'counts', bind: { source: 'page', sourceProperty: '$ownerId', field: 'followingId' } },
      { documentType: 'follow', kind: 'counts', bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } },
    ],
  }), (result) => {
    const [posts, followers, following] = result.subResults.map((sub) => countEntries(sub.counts)[B.ownerId]);
    check('c3 author-card slots for B off a page of another doctype (the app roots on the profile): posts 2, followers 2, following 1', posts === 2 && followers === 2 && following === 1, `posts ${posts} followers ${followers} following ${following}`);
  });
  const expectMergedRootRefusal = async (label, query) => {
    try {
      await sdk.documents.composite(query);
      check(label, false, 'accepted');
    } catch (e) {
      check(label, COMPOSITE_MERGED_ROOT.test(describeErr(e)), describeErr(e).slice(0, 200));
    }
  };
  await expectMergedRootRefusal('c2x a repliesOf page with a repliesOf count slot is refused (merged root)', {
    dataContractId: contractId, documentType: 'reply', where: [['rootPostId', '==', T1], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 10,
    subQueries: [{ documentType: 'reply', kind: 'counts', where: [['rootPostId', '==', T1]], bind: { source: 'page', sourceProperty: '$id', field: 'replyToReplyId' } }],
  });
  await expectMergedRootRefusal('c3x a post page on $ownerId with a post slot bound to $ownerId is refused (merged root)', {
    dataContractId: contractId, documentType: 'post', where: [['$ownerId', '==', B.ownerId]], orderBy: [['$createdAt', 'asc']], limit: 1,
    subQueries: [{ documentType: 'post', kind: 'counts', bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } }],
  });

  await attempt('c4', () => sdk.documents.composite({
    dataContractId: contractId,
    documentType: 'reply',
    where: [['$id', 'in', [r1, r3, r4]]],
    limit: 3,
    subQueries: [
      { documentType: 'reply', kind: 'counts', where: [['rootPostId', '==', T1]], bind: { source: 'page', sourceProperty: '$id', field: 'replyToReplyId' } },
      { documentType: 'post', kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field: 'quotedReplyId' } },
    ],
  }), (result) => {
    const [children, reposts] = result.subResults.map((sub) => countEntries(sub.counts));
    check('c4 a by-id reply page (`$id in`) with slots pinned to T1: children r1 2, r3 1, r4 0; reposts r1 1', result.pageDocuments.length === 3 && children[r1] === 2 && children[r3] === 1 && !children[r4] && reposts[r1] === 1, `children ${JSON.stringify(children)} reposts ${JSON.stringify(reposts)}`);
  });

  // ---- w: the bare-repost writes, read back ----
  console.log('\n--- w. bare reposts (a post with a quote and nothing of its own) ---');
  const plainOf = async (docId) => (await sdk.documents.get(contractId, 'post', docId))?.toObject?.() ?? null;
  await attempt('w1', () => plainOf(q2), (doc) => check('w1 B\'s bare repost of T2 stored with its target and no content', doc !== null && toBase58(doc.quotedPostId) === T2 && !doc.content, doc ? `quotedPostId ${toBase58(doc.quotedPostId)} content ${JSON.stringify(doc.content ?? null)}` : 'missing'));
  await attempt('w2', () => plainOf(qr), (doc) => check('w2 A\'s bare repost of reply r1 stored with quotedReplyId and no content', doc !== null && toBase58(doc.quotedReplyId) === r1 && !doc.content, doc ? `quotedReplyId ${toBase58(doc.quotedReplyId)} content ${JSON.stringify(doc.content ?? null)}` : 'missing'));

  // ---- o: the viewer's own quote/repost (post-service getOwnQuotes) ----
  console.log('\n--- o. own quote or repost per target ---');
  await attempt('o1', () => sdk.documents.query(q('post', { where: [['$ownerId', '==', B.ownerId], ['quotedPostId', 'in', [T1, T2, T3]]], orderBy: [['$ownerId', 'asc'], ['quotedPostId', 'asc']], limit: 3 })), (r) => {
    const got = new Set(ids(r));
    check('o1 B\'s own quotes of T1-T3 (ownerAndQuotedPost, `in`): q1 and the bare repost q2', got.size === 2 && got.has(q1) && got.has(q2), JSON.stringify([...got]));
  });
  await attempt('o2', () => sdk.documents.query(q('post', { where: [['$ownerId', '==', A.ownerId], ['quotedReplyId', 'in', [r1, r2]]], orderBy: [['$ownerId', 'asc'], ['quotedReplyId', 'asc']], limit: 2 })), (r) => check('o2 A\'s own reposts of r1/r2 (ownerAndQuotedReply): qr', same(ids(r), [qr]), JSON.stringify(ids(r))));

  // ---- n: notifications (notification-service) ----
  // The windowed notification indexes are [$createdAt, recipient] on one grid
  // (3.5-day windows, ttl a week), read window by window, pinned on the
  // recipient. No `$createdAt >` clause (a raw clause cannot bind bucket keys)
  // and no time order inside a window: the client filters and sorts.
  console.log('\n--- n. notifications: reply/quote windows, permanent mentions ---');
  // 3.5-day windows written once, ttl a week: the current window (`newest`)
  // and the previous one hold the last 3.5-7 days. The node's `oldest` is the
  // oldest window still CONTAINING now (the current one on this grid), so the
  // previous window is named by its start (`byStart`).
  const WEEK = { range: 302400, step: 302400 };
  const previousStart = (Math.floor(Date.now() / (WEEK.step * 1000)) - 1) * WEEK.step * 1000;
  const windowed = (field, recipient, pick = { selector: 'newest' }) => ({ where: [[field, '==', recipient]], timeRange: [{ field: '$createdAt', ...pick, grid: WEEK }], limit: 100 });
  const bothWindows = async (docType, field, recipient) => {
    const [current, previous] = await Promise.all([{ selector: 'newest' }, { selector: 'byStart', startMs: previousStart }].map((pick) => sdk.documents.query(q(docType, windowed(field, recipient, pick)))));
    const byId = new Map([...docsOf(current), ...docsOf(previous)].map((d) => [idOf(d), d]));
    return { docs: [...byId.values()], current: docsOf(current).length, previous: docsOf(previous).length };
  };
  const sameSet = (got, expected) => got.length === expected.length && expected.every((x) => got.includes(x));
  await attempt('n1', () => bothWindows('reply', 'parentOwnerId', A.ownerId), ({ docs, current, previous }) => check('n1 replies to A in the current and the previous 3.5-day window (parentOwnerRecent, `newest` + `byStart`, deduped; the previous read is accepted): r1, r2, r5, r6, each with its exact $createdAt', sameSet(docs.map(idOf), [r1, r2, r5, r6]) && docs.every((d) => createdAtOf(d) > 0), `${JSON.stringify(docs.map(idOf))} (current window ${current}, previous window ${previous})`));
  await attempt('n2', () => bothWindows('post', 'quotedPostOwnerId', A.ownerId), ({ docs, current, previous }) => check('n2 quotes/reposts of A in the last two windows (quotedPostOwnerRecent): q1, q2, q3', sameSet(docs.map(idOf), [q1, q2, q3]), `${JSON.stringify(docs.map(idOf))} (current window ${current}, previous window ${previous})`));
  // Mentions stay permanent: the mentioning post's own [mentionedUserId, $createdAt].
  const mentionsOfB = { where: [['mentionedUserId', '==', B.ownerId], ['$createdAt', '>', 0]], orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'desc']], limit: 100 };
  await attempt('n3', () => sdk.documents.query(q('post', mentionsOfB)), (r) => check('n3 mentions of B (permanent mentionedUserAndTime, `$createdAt >`, newest first): m1', same(ids(r), [m1]) && docsOf(r).every((d) => createdAtOf(d) > 0), JSON.stringify(ids(r))));
  /**
   * A read the node must refuse: a collapsed transport is retried, and a timeout or a gateway
   * error is a FAIL rather than a refusal. With `pattern`, the refusal must also say why.
   */
  const expectRefusal = async (label, run, pattern) => {
    try {
      await withReconnect(run);
      check(label, false, 'accepted');
    } catch (e) {
      const reason = describeErr(e);
      const refused = !TRANSPORT_COLLAPSE.test(reason) && !TRANSIENT.test(reason) && (pattern === undefined || pattern.test(reason));
      check(label, refused, reason.slice(0, 200));
    }
  };
  // A windowed source cannot ride the notification bundle: composites take no
  // timeRange, and without one the windowed index is not admissible.
  const bundlePage = { dataContractId: contractId, documentType: 'follow', where: [['followingId', '==', A.ownerId], ['$createdAt', '>', 0]], orderBy: [['followingId', 'asc'], ['$createdAt', 'desc']], limit: 100 };
  await expectRefusal('n6x a windowed source as a composite sibling WITH timeRange is refused', () => sdk.documents.composite({ ...bundlePage, subQueries: [{ documentType: 'reply', ...windowed('parentOwnerId', A.ownerId) }] }));
  await expectRefusal('n7x a windowed index read WITHOUT a window (composite sibling or plain) is refused', () => sdk.documents.composite({ ...bundlePage, subQueries: [{ documentType: 'reply', where: [['parentOwnerId', '==', A.ownerId]], limit: 100 }] }));
  await attempt('n8', () => sdk.documents.composite({ ...bundlePage, subQueries: [
    { documentType: 'post', ...mentionsOfB },
    { documentType: 'follow', where: [['$ownerId', '==', B.ownerId], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 100 },
  ] }), (result) => {
    const [mentions, follows] = result.subResults.map((sub) => sub.documents);
    check('n8 the permanent sources bundle: follows of A, the mention of B (as a sibling), B\'s follows', result.pageDocuments.length === 1 && same(mentions.map(idOf), [m1]) && follows.length === 1, `page ${result.pageDocuments.length} mentions ${JSON.stringify(mentions.map(idOf))} follows ${follows.length}`);
  });

  // ---- t: the whole thread (reply-service getReplies on repliesOf) ----
  console.log('\n--- t. the whole thread, grouped by parent ---');
  const thread = { where: [['rootPostId', '==', T1]], orderBy: [['replyToReplyId', 'asc'], ['$createdAt', 'asc']] };
  let wholeThread = [];
  await attempt('t1', () => sdk.documents.query(q('reply', { ...thread, limit: 50 })), (r) => {
    wholeThread = ids(r);
    check('t1 the thread at the app\'s page size (50): all 5 replies, direct ones first', wholeThread.length === 5 && same(wholeThread.slice(0, 2), [r1, r2]), JSON.stringify(wholeThread));
  });
  await attempt('t2', async () => {
    const walked = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const docs = ids(await sdk.documents.query(q('reply', { ...thread, limit: 2, ...(cursor ? { startAfter: cursor } : {}) })));
      walked.push(...docs);
      if (docs.length < 2) break;
      cursor = docs.at(-1);
    }
    return walked;
  }, (walked) => check('t2 paging the thread 2 at a time with startAfter walks the same 5 in the same order', walked.length === 5 && same(walked, wholeThread), JSON.stringify(walked)));

  // ---- l: the quote lists (post-query-helpers fetchQuotePosts) ----
  console.log('\n--- l. quote lists ---');
  await attempt('l1', () => sdk.documents.query(q('post', { where: [['quotedPostId', 'in', [T1]]], orderBy: [['quotedPostId', 'asc'], ['$createdAt', 'desc']], limit: 100 })), (r) => check('l1 quotes of T1 at limit 100, newest first: q1 and q3', newestFirst(docsOf(r), [q1, q3]), JSON.stringify(ids(r))));
  await attempt('l2', () => sdk.documents.query(q('post', { where: [['quotedReplyId', 'in', [r1]]], orderBy: [['quotedReplyId', 'asc'], ['$createdAt', 'desc']], limit: 100 })), (r) => check('l2 quotes/reposts of reply r1 (quotesOfReply): qr', same(ids(r), [qr]), JSON.stringify(ids(r))));

  // ---- c5/c6/g1: the feed pages as the app builds them ----
  console.log('\n--- c5/c6/g1. feed pages ---');
  const dpnsId = envValue('NEXT_PUBLIC_DPNS_CONTRACT_ID') || 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
  const fromPage = (sourceProperty, field) => ({ source: 'page', sourceProperty, field });
  await attempt('c5', () => sdk.documents.composite({
    dataContractId: contractId,
    documentType: 'post',
    where: [['$createdAt', '>', 0]],
    orderBy: [['$createdAt', 'desc']],
    limit: 20,
    subQueries: [
      { documentType: 'like', kind: 'counts', bind: fromPage('$id', 'postId') },
      { documentType: 'reply', kind: 'counts', bind: fromPage('$id', 'rootPostId') },
      { documentType: 'post', kind: 'counts', bind: fromPage('$id', 'quotedPostId') },
      { documentType: 'post', bind: fromPage('quotedPostId', '$id') },
      { dataContractId: dpnsId, documentType: 'domain', bind: fromPage('$ownerId', 'records.identity'), limit: 100 },
    ],
  }).then(async (result) => {
    // The viewer's hearts sit on the like-count index (byPost, `$ownerId` its
    // terminal), which the composite cannot also walk as documents: they are
    // one plain read beside it (c5x pins the refusal of the combined form).
    const hearts = await sdk.documents.query(q('like', { where: [['postId', 'in', result.pageDocuments.map(idOf)], ['$ownerId', '==', B.ownerId]], orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 20 }));
    return { result, hearts };
  }), ({ result, hearts }) => {
    const [likes, replies, quotes] = result.subResults.slice(0, 3).map((sub) => countEntries(sub.counts));
    const quoted = new Set(result.subResults[3].documents.map(idOf));
    const myLikes = docsOf(hearts).length;
    check('c5 the For You page: likes T1 2 / T2 1, replies T1 5 / T2 1, quotes T1 2 / T2 1, quoted posts T1+T2 joined; B\'s hearts 2 (a separate byPost read)',
      likes[T1] === 2 && likes[T2] === 1 && replies[T1] === 5 && replies[T2] === 1 && quotes[T1] === 2 && quotes[T2] === 1 && quoted.has(T1) && quoted.has(T2) && myLikes === 2,
      `likes ${JSON.stringify(likes)} replies ${JSON.stringify(replies)} quotes ${JSON.stringify(quotes)} quoted ${JSON.stringify([...quoted])} myLikes ${myLikes}`);
  });
  await expectRefusal('c5x a like-count slot and a viewer-likes slot on byPost in one composite are refused (a count shares the documents lookup\'s index path)', () => sdk.documents.composite({
    dataContractId: contractId, documentType: 'post', where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']], limit: 20,
    subQueries: [
      { documentType: 'like', kind: 'counts', bind: fromPage('$id', 'postId') },
      { documentType: 'like', where: [['$ownerId', '==', B.ownerId]], bind: fromPage('$id', 'postId'), limit: 20 },
    ],
  }));
  await attempt('c6', () => sdk.documents.composite({
    dataContractId: contractId,
    documentType: 'post',
    where: [['$ownerId', '==', B.ownerId], ['$createdAt', '>', 0]],
    orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
    limit: 20,
    subQueries: [
      { documentType: 'post', kind: 'counts', bind: fromPage('$id', 'quotedPostId') },
      { documentType: 'reply', kind: 'counts', bind: fromPage('$id', 'rootPostId') },
      { documentType: 'post', bind: fromPage('quotedPostId', '$id') },
    ],
  }), (result) => {
    const quoted = new Set(result.subResults[2].documents.map(idOf));
    check('c6 B\'s profile page (ownerAndTime) with the quoted-post join: q1 and q2, quoting T1 and T2', result.pageDocuments.length === 2 && quoted.has(T1) && quoted.has(T2), `page ${result.pageDocuments.length} quoted ${JSON.stringify([...quoted])}`);
  });
  await attempt('g1', () => sdk.documents.query(q('post', { where: [['$ownerId', 'in', [B.ownerId, C.ownerId]], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 100 })), (r) => {
    const got = new Set(ids(r));
    check('g1 the following feed (`$ownerId in` + `$createdAt >`, ranked ownerAndTime): q1, q2, q3, m1', got.size === 4 && [q1, q2, q3, m1].every((x) => got.has(x)), JSON.stringify([...got]));
  });

  // ---- shared by the v11/v12 phases: an author's replace, judged by the chain ----
  /** `who`'s replace of `docId` with `data` at the next revision: `{ ok }`, or the consensus refusal. */
  const replaceDoc = async (who, docType, docId, data) => {
    const stored = await withReconnect(() => sdk.documents.get(contractId, docType, docId));
    const revision = BigInt(stored?.revision ?? stored?.toObject?.().$revision ?? 1) + 1n;
    const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, revision, id: bs58.decode(docId) });
    try {
      await sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer });
    } catch (e) {
      const error = describeErr(e);
      if (CONSENSUS_CODE.test(error)) return { ok: false, error };
    }
    await sleep(SETTLE_MS);
    const after = await sdk.documents.get(contractId, docType, docId);
    const landed = BigInt(after?.revision ?? after?.toObject?.().$revision ?? 0) >= revision;
    return landed ? { ok: true } : { ok: false, error: 'the replace did not land' };
  };
  const refusedWith = (label, outcome, pattern) => check(label, !outcome.ok && pattern.test(outcome.error ?? ''), (outcome.error ?? 'ACCEPTED').slice(0, 200));
  const IMMUTABLE = /\bcode"?\s*[=:]\s*40128\b|immutable/i;
  const BLANK = /\bcode"?\s*[=:]\s*10422\b.{0,400}tombstoneIsBlank|tombstoneIsBlank/i;
  const plain = (doc) => doc?.toJSON?.() ?? doc?.toObject?.() ?? {};

  // ---- dc: like design C (no byLiker; byAuthorPostTime / byAuthorReplyTime) ----
  async function proveDesignC() {
    console.log('\n--- dc. like design C: heart state on byPost/byReply, rankings, per-post notifications, unlike ---');
    const likeOf = (d) => d.toObject?.() ?? d;
    const pairsOf = (r, target) => docsOf(r).map(likeOf).map((l) => `${toBase58(l.$ownerId)}>${toBase58(l[target])}`);
    const fromPage = (sourceProperty, field) => ({ source: 'page', sourceProperty, field });
    // (a) the heart state on the count index: `$ownerId ==` pins its terminal.
    await attempt('dc-a1', () => sdk.documents.query(q('like', { where: [['postId', 'in', [T1, T2, T3]], ['$ownerId', '==', B.ownerId]], orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 3 })),
      (r) => check('dc-a1 "did B like these" on byPost (`postId in`, `$ownerId ==`): T1, T2', sameSet(pairsOf(r, 'postId'), [`${B.ownerId}>${T1}`, `${B.ownerId}>${T2}`]), JSON.stringify(pairsOf(r, 'postId'))));
    await attempt('dc-a2', () => sdk.documents.query(q('like', { where: [['postId', '==', T2], ['$ownerId', '==', B.ownerId]], limit: 1 })),
      (r) => check('dc-a2 the single form on byPost: B liked T2', same(pairsOf(r, 'postId'), [`${B.ownerId}>${T2}`]), JSON.stringify(pairsOf(r, 'postId'))));
    await attempt('dc-a3', () => sdk.documents.query(q('likeReply', { where: [['replyId', 'in', [r1, r2]], ['$ownerId', '==', A.ownerId]], orderBy: [['replyId', 'asc'], ['$ownerId', 'asc']], limit: 2 })),
      (r) => check('dc-a3 "did A like these replies" on byReply (countable, not rangeCountable): r1', same(pairsOf(r, 'replyId'), [`${A.ownerId}>${r1}`]), JSON.stringify(pairsOf(r, 'replyId'))));
    // (b) the feed page's viewer-likes slot, bound on the page's ids against byPost.
    await attempt('dc-b1', () => sdk.documents.composite({
      dataContractId: contractId, documentType: 'post', where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']], limit: 20,
      subQueries: [{ documentType: 'like', where: [['$ownerId', '==', B.ownerId]], bind: fromPage('$id', 'postId'), limit: 20 }],
    }), (result) => {
      const liked = result.subResults[0].documents.map(likeOf).map((l) => toBase58(l.postId));
      check('dc-b1 the feed composite\'s viewer-likes slot on byPost (limit = page size): B liked T1 and T2', sameSet(liked, [T1, T2]), JSON.stringify(liked));
    });
    await attempt('dc-b2', () => sdk.documents.composite({
      dataContractId: contractId, documentType: 'reply', where: [['$ownerId', '==', B.ownerId], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20,
      subQueries: [{ documentType: 'likeReply', where: [['$ownerId', '==', A.ownerId]], bind: fromPage('$id', 'replyId'), limit: 20 }],
    }), (result) => {
      const liked = result.subResults[0].documents.map(likeOf).map((l) => toBase58(l.replyId));
      check('dc-b2 a replies page\'s viewer-likes slot on byReply (limit = page size): A liked r1', same(liked, [r1]), JSON.stringify(liked));
    });
    // (c) top creators and (d) a profile's top posts: rankings at [postAuthor, postId].
    await attempt('dc-c', () => sdk.documents.ranked(q('like', { groupBy: 'postAuthor', aggregate: { type: 'count' }, direction: 'desc', limit: 10 })), (r) => {
      const got = r.entries.map((e) => [toBase58(e.groupValue), Number(e.value)]);
      check('dc-c top creators (ranked groupBy postAuthor on byAuthorPostTime): A 3', same(got, [[A.ownerId, 3]]), JSON.stringify(got));
    });
    await attempt('dc-d', () => sdk.documents.ranked(q('like', { where: [['postAuthor', '==', A.ownerId]], groupBy: 'postId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 })), (r) => {
      const got = r.entries.map((e) => [toBase58(e.groupValue), Number(e.value)]);
      check('dc-d a profile\'s top posts (ranked `postAuthor ==` groupBy postId): T1 2, T2 1', same(got, [[T1, 2], [T2, 1]]), JSON.stringify(got));
    });
    // (e) the per-post notification read, newest first, and its keyset paging.
    const perPost = (postId, extra = [], limit = 100) => sdk.documents.query(q('like', {
      where: [['postAuthor', '==', A.ownerId], ['postId', '==', postId], ...extra],
      orderBy: [['postAuthor', 'asc'], ['postId', 'asc'], ['$createdAt', 'desc']], limit,
    }));
    await attempt('dc-e1', () => perPost(T1, [['$createdAt', '>', 0]]), (r) => {
      const likes = docsOf(r).map(likeOf);
      check('dc-e1 likes of T1 since a watermark (`$createdAt >`, newest first, exact times): B and C', sameSet(likes.map((l) => toBase58(l.$ownerId)), [B.ownerId, C.ownerId]) && newestFirst(docsOf(r), docsOf(r).map(idOf)) && likes.every((l) => Number(l.$createdAt) > 0), JSON.stringify(likes.map((l) => [toBase58(l.$ownerId), String(l.$createdAt)])));
    });
    await attempt('dc-e2', async () => {
      const seen = new Map();
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        const likes = docsOf(await perPost(T1, cursor === null ? [] : [['$createdAt', '<=', cursor]], 1)).map(likeOf);
        const fresh = likes.filter((l) => !seen.has(toBase58(l.$ownerId)));
        for (const l of likes) seen.set(toBase58(l.$ownerId), Number(l.$createdAt));
        if (likes.length === 0 || fresh.length === 0) {
          // A page whose only entry was already seen: step below its time (entries sharing a block time are 1 page here).
          if (likes.length === 0 || cursor === null) break;
          cursor -= 1;
          continue;
        }
        cursor = Math.min(...likes.map((l) => Number(l.$createdAt)));
      }
      return [...seen.keys()];
    }, (got) => check('dc-e2 keyset paging 1 at a time (`$createdAt <=` + dedupe, no id cursor) walks both likers of T1', sameSet(got, [B.ownerId, C.ownerId]), JSON.stringify(got)));
    // The client's full-page fallback: one target, since the watermark AND at
    // or below the keyset cursor (a between range on $createdAt).
    await attempt('dc-e4', () => sdk.documents.query(q('like', { where: [['postAuthor', '==', A.ownerId], ['postId', 'in', [T1]], ['$createdAt', '>', 0], ['$createdAt', '<=', Date.now() + 3_600_000]], orderBy: [['postAuthor', 'asc'], ['postId', 'asc'], ['$createdAt', 'desc']], limit: 100 })),
      (r) => check('dc-e4 one target between the watermark and a keyset cursor (`$createdAt >` and `<=`): B and C liked T1', sameSet(docsOf(r).map(likeOf).map((l) => toBase58(l.$ownerId)), [B.ownerId, C.ownerId]), JSON.stringify(pairsOf(r, 'postId'))));
    // (f) which of my recent posts gained likes: A's latest posts, then one grouped count.
    await attempt('dc-f1', async () => {
      const posts = ids(await sdk.documents.query(q('post', { where: [['$ownerId', '==', A.ownerId], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20 })));
      return countEntries(await count('like', [['postId', 'in', posts]], ['postId']));
    }, (m) => check('dc-f1 A\'s latest 20 posts, liked ones by one grouped byPost count: T1 2, T2 1', sameCounts(m, { [T1]: 2, [T2]: 1 }), JSON.stringify(m)));
    await attempt('dc-f2', () => sdk.documents.composite({
      dataContractId: contractId, documentType: 'post', where: [['$ownerId', '==', A.ownerId], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20,
      subQueries: [{ documentType: 'like', kind: 'counts', bind: fromPage('$id', 'postId') }],
    }), (result) => {
      const m = countEntries(result.subResults[0].counts);
      check('dc-f2 the same through the profile-page composite count slot: T1 2, T2 1', sameCounts(m, { [T1]: 2, [T2]: 1 }), JSON.stringify(m));
    });
    // (g) like counts per post / per reply, batched.
    await attempt('dc-g1', () => count('like', [['postId', 'in', [T1, T2, T3]]], ['postId']), (m) => check('dc-g1 like counts (byPost, `in` + groupBy): T1 2, T2 1', sameCounts(countEntries(m), { [T1]: 2, [T2]: 1 }), JSON.stringify(countEntries(m))));
    await attempt('dc-g2', () => count('likeReply', [['replyId', 'in', [r1, r2]]], ['replyId']), (m) => check('dc-g2 reply like counts (byReply, `in` + groupBy): r1 1', sameCounts(countEntries(m), { [r1]: 1 }), JSON.stringify(countEntries(m))));
    // (i) a one-read unlike lookup (all three pinned, no time): expected refused. Reported, never failed.
    try {
      const r = await sdk.documents.query(q('like', { where: [['postAuthor', '==', A.ownerId], ['postId', '==', T1], ['$ownerId', '==', B.ownerId]], limit: 1 }));
      console.log(`INFO  dc-i \`postAuthor == A && postId == T1 && $ownerId == B\` with no time clause: ACCEPTED, ${docsOf(r).length} row(s)`);
    } catch (e) {
      console.log(`INFO  dc-i \`postAuthor == A && postId == T1 && $ownerId == B\` with no time clause: refused — ${describeErr(e).slice(0, 200)}`);
    }
    // (j) how many siblings a composite carries (the notification fan-out).
    const siblings = (n) => Array.from({ length: n }, (_, k) => ({ documentType: 'like', where: [['postAuthor', '==', A.ownerId], ['postId', '==', [T1, T2, T3][k % 3]], ['$createdAt', '>', k]], orderBy: [['postAuthor', 'asc'], ['postId', 'asc'], ['$createdAt', 'desc']], limit: 100 }));
    const followsPage = { dataContractId: contractId, documentType: 'follow', where: [['followingId', '==', A.ownerId], ['$createdAt', '>', 0]], orderBy: [['followingId', 'asc'], ['$createdAt', 'desc']], limit: 100 };
    // Per-post like reads share one index path, which a composite cannot tell
    // apart: the notification fan-out is plain queries (or dc-k's one `in`).
    // Per-post siblings in one composite: refused in one run, accepted in the
    // next; the client reads one `postId in` instead (dc-k). Reported only.
    try {
      await sdk.documents.composite({ ...followsPage, subQueries: siblings(3) });
      console.log('INFO  dc-j1 per-post like reads as composite siblings: ACCEPTED');
    } catch (e) {
      console.log(`INFO  dc-j1 per-post like reads as composite siblings: refused — ${describeErr(e).slice(0, 160)}`);
    }
    await attempt('dc-k', () => sdk.documents.query(q('like', { where: [['postAuthor', '==', A.ownerId], ['postId', 'in', [T1, T2]], ['$createdAt', '>', 0]], orderBy: [['postAuthor', 'asc'], ['postId', 'asc'], ['$createdAt', 'desc']], limit: 100 })), (r) => {
      const pairs = pairsOf(r, 'postId');
      check('dc-k ONE read for several posts (`postId in` + `$createdAt >`): B→T1, C→T1, B→T2', sameSet(pairs, [`${B.ownerId}>${T1}`, `${C.ownerId}>${T1}`, `${B.ownerId}>${T2}`]), JSON.stringify(pairs));
    });
    await expectRefusal('dc-j2 an 11th sibling is refused (10 sub-queries at most)', () => sdk.documents.composite({ ...followsPage, subQueries: siblings(11) }));
    // Reply likes, the same fan-out: the per-reply read since a watermark, the
    // replies-page composite count slot on byReply, one `replyId in` read.
    await attempt('dc-e3', () => sdk.documents.query(q('likeReply', { where: [['replyAuthor', '==', B.ownerId], ['replyId', '==', r1], ['$createdAt', '>', 0]], orderBy: [['replyAuthor', 'asc'], ['replyId', 'asc'], ['$createdAt', 'desc']], limit: 100 })),
      (r) => check('dc-e3 likes of B\'s reply r1 since a watermark (byAuthorReplyTime, newest first): A', same(pairsOf(r, 'replyId'), [`${A.ownerId}>${r1}`]) && docsOf(r).map(likeOf).every((l) => Number(l.$createdAt) > 0), JSON.stringify(pairsOf(r, 'replyId'))));
    await attempt('dc-f3', () => sdk.documents.composite({
      dataContractId: contractId, documentType: 'reply', where: [['$ownerId', '==', B.ownerId], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20,
      subQueries: [{ documentType: 'likeReply', kind: 'counts', bind: fromPage('$id', 'replyId') }],
    }), (result) => {
      const m = countEntries(result.subResults[0].counts);
      check('dc-f3 B\'s recent replies with their like counts (replies page + byReply count slot): r1 1', sameCounts(m, { [r1]: 1 }), JSON.stringify(m));
    });
    await attempt('dc-k2', () => sdk.documents.query(q('likeReply', { where: [['replyAuthor', '==', B.ownerId], ['replyId', 'in', [r1, r5]], ['$createdAt', '>', 0]], orderBy: [['replyAuthor', 'asc'], ['replyId', 'asc'], ['$createdAt', 'desc']], limit: 100 })),
      (r) => check('dc-k2 ONE read for several replies (`replyId in` + `$createdAt >`): A→r1', same(pairsOf(r, 'replyId'), [`${A.ownerId}>${r1}`]), JSON.stringify(pairsOf(r, 'replyId'))));
    // (h) unlike end to end: the time from (postAuthor, postId), newest first; delete; gone.
    const recoverTime = async (docType, author, authorId, target, targetId, likerId) => {
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        const docs = docsOf(await sdk.documents.query(q(docType, {
          where: [[author, '==', authorId], [target, '==', targetId], ...(cursor === null ? [] : [['$createdAt', '<=', cursor]])],
          orderBy: [[author, 'asc'], [target, 'asc'], ['$createdAt', 'desc']], limit: 100,
        }))).map(likeOf);
        const mine = docs.find((l) => toBase58(l.$ownerId) === likerId);
        if (mine) return Number(mine.$createdAt);
        if (docs.length < 100) return null;
        cursor = Math.min(...docs.map((l) => Number(l.$createdAt)));
      }
      return null;
    };
    await attempt('dc-h1', async () => {
      const at = await recoverTime('like', 'postAuthor', A.ownerId, 'postId', T2, B.ownerId);
      if (at === null) throw new Error('B\'s like of T2 not found on byAuthorPostTime');
      const { document } = buildDocument({ contractId, docType: 'like', ownerId: B.ownerId, data: { postId: id(T2), postAuthor: id(A.ownerId) }, createdAt: at });
      await sdk.documents.delete({ document, identityKey: B.identityKey, signer: B.signer }).catch((e) => console.log(`     (unlike reported: ${describeErr(e).slice(0, 140)})`));
      await sleep(SETTLE_MS);
      const [likeCount, heart] = await Promise.all([count('like', [['postId', '==', T2]]), sdk.documents.query(q('like', { where: [['postId', '==', T2], ['$ownerId', '==', B.ownerId]], limit: 1 }))]);
      return { at, likes: total(likeCount), heart: docsOf(heart).length };
    }, ({ at, likes, heart }) => check(`dc-h1 B unlikes T2 (time ${at} from byAuthorPostTime): count 0, heart off`, likes === 0 && heart === 0, `count ${likes}, heart ${heart}`));
    await attempt('dc-h2', async () => {
      const at = await recoverTime('likeReply', 'replyAuthor', B.ownerId, 'replyId', r1, A.ownerId);
      if (at === null) throw new Error('A\'s like of r1 not found on byAuthorReplyTime');
      const { document } = buildDocument({ contractId, docType: 'likeReply', ownerId: A.ownerId, data: { replyId: id(r1), replyAuthor: id(B.ownerId) }, createdAt: at });
      await sdk.documents.delete({ document, identityKey: A.identityKey, signer: A.signer }).catch((e) => console.log(`     (unlike reported: ${describeErr(e).slice(0, 140)})`));
      await sleep(SETTLE_MS);
      const [likeCount, heart] = await Promise.all([count('likeReply', [['replyId', '==', r1]]), sdk.documents.query(q('likeReply', { where: [['replyId', 'in', [r1]], ['$ownerId', '==', A.ownerId]], orderBy: [['replyId', 'asc'], ['$ownerId', 'asc']], limit: 1 }))]);
      return { at, likes: total(likeCount), heart: docsOf(heart).length };
    }, ({ at, likes, heart }) => check(`dc-h2 A unlikes reply r1 (time ${at} from byAuthorReplyTime): count 0, heart off`, likes === 0 && heart === 0, `count ${likes}, heart ${heart}`));
  }

  // ---- ol: timeless likes (v11: outlivesDelete trend windows, no `$createdAt` on any like index) ----
  async function proveOutlives() {
    console.log('\n--- ol. v11 likes: hearts, likers without time, rankings, trending windows, unlike without $createdAt, kept window entries ---');
    const likeOf = (d) => d.toObject?.() ?? d;
    const pairsOf = (r, target) => docsOf(r).map(likeOf).map((l) => `${toBase58(l.$ownerId)}>${toBase58(l[target])}`);
    const fromPage = (sourceProperty, field) => ({ source: 'page', sourceProperty, field });
    const ranked = (where, groupBy, extra = {}) => sdk.documents.ranked(q('like', { ...(where ? { where } : {}), groupBy, aggregate: { type: 'count' }, direction: 'desc', limit: 10, ...extra }));
    // Preallocated trees (design M) rank every post, liked or not: a zero is no like, so leaderboards drop it.
    const rankedPairs = (r) => r.entries.map((e) => [toBase58(e.groupValue), Number(e.value)]).filter(([, value]) => value !== 0);
    const grid = (name) => source.documentSchemas.like.indices.find((index) => index.name === name).timeRange;
    const oldestOf = (name) => ({ timeRange: [{ field: '$createdAt', selector: 'oldest', grid: { range: grid(name).range, step: grid(name).step } }] });
    const trendPosts = () => ranked(null, 'postId', oldestOf('byTrendPost'));
    const trendTags = () => ranked(null, 'hashtag', oldestOf('byTrendHashtagPost'));
    const tagValue = (e) => (typeof e.groupValue === 'string' ? e.groupValue : Buffer.from(e.groupValue).toString('utf8'));
    const tagPairs = (r) => r.entries.map((e) => [tagValue(e), Number(e.value)]);
    const likeCount = async (docType, field, target) => total(await count(docType, [[field, '==', target]]));
    const heartOf = async (docType, field, target, ownerId) => docsOf(await sdk.documents.query(q(docType, { where: [[field, 'in', [target]], ['$ownerId', '==', ownerId]], orderBy: [[field, 'asc'], ['$ownerId', 'asc']], limit: 1 }))).length;
    /** An unlike by values, carrying NO `$createdAt` (the row commits to none); the id is not checked. */
    const unlike = async (who, docType, data, extra = {}) => {
      const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, ...extra });
      await sdk.documents.delete({ document, identityKey: who.identityKey, signer: who.signer });
    };
    const reported = (label) => (e) => console.log(`     (${label} reported: ${describeErr(e).slice(0, 140)})`);
    // Expiry is measured from a like's own time: write the ones that will expire first. C's
    // like of T3 is unliked at once; C's tagged like of Th is unliked later (h3), and B likes
    // Th more than one tag-window step after C, so B's entry outlives C's (x1).
    const tag = 'olproof';
    const Th = await mustCreate('Th (A, #olproof)', A, 'post', { content: 'tagged target', hashtag: tag });
    const expiringAt = Date.now();
    await likeWrite(C, 'like', { postId: id(T3), postAuthor: id(A.ownerId) });
    const taggedAt = Date.now();
    await likeWrite(C, 'like', { postId: id(Th), postAuthor: id(A.ownerId), hashtag: tag });
    await sleep(SETTLE_MS);
    await unlike(C, 'like', { postId: id(T3), postAuthor: id(A.ownerId) }).catch(reported('C\'s unlike of T3'));
    await sleep(SETTLE_MS);

    // (a) hearts and (b) the feed slots: unchanged from v10 (byPost / byReply, `$ownerId` terminal).
    await attempt('dc-a1', () => sdk.documents.query(q('like', { where: [['postId', 'in', [T1, T2, T3]], ['$ownerId', '==', B.ownerId]], orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 3 })),
      (r) => check('dc-a1 "did B like these" on byPost (`postId in`, `$ownerId ==`): T1, T2', sameSet(pairsOf(r, 'postId'), [`${B.ownerId}>${T1}`, `${B.ownerId}>${T2}`]), JSON.stringify(pairsOf(r, 'postId'))));
    await attempt('dc-a3', () => sdk.documents.query(q('likeReply', { where: [['replyId', 'in', [r1, r2]], ['$ownerId', '==', A.ownerId]], orderBy: [['replyId', 'asc'], ['$ownerId', 'asc']], limit: 2 })),
      (r) => check('dc-a3 "did A like these replies" on byReply: r1', same(pairsOf(r, 'replyId'), [`${A.ownerId}>${r1}`]), JSON.stringify(pairsOf(r, 'replyId'))));
    await attempt('dc-b1', () => sdk.documents.composite({
      dataContractId: contractId, documentType: 'post', where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']], limit: 20,
      subQueries: [{ documentType: 'like', where: [['$ownerId', '==', B.ownerId]], bind: fromPage('$id', 'postId'), limit: 20 }],
    }), (result) => {
      const liked = result.subResults[0].documents.map(likeOf).map((l) => toBase58(l.postId));
      check('dc-b1 the feed composite\'s viewer-likes slot on byPost: B liked T1 and T2', sameSet(liked, [T1, T2]), JSON.stringify(liked));
    });
    // (c)/(d) top creators and a profile's top posts, now off byAuthorPost [postAuthor, postId].
    await attempt('ol-c', () => ranked(null, 'postAuthor'), (r) => check('ol-c top creators (ranked groupBy postAuthor on byAuthorPost): A 4 (T1 2, T2 1, Th 1; C\'s unliked T3 is gone)', same(rankedPairs(r), [[A.ownerId, 4]]), JSON.stringify(rankedPairs(r))));
    await attempt('ol-d', () => ranked([['postAuthor', '==', A.ownerId]], 'postId'), (r) => check('ol-d a profile\'s top posts (ranked `postAuthor ==` groupBy postId): T1 2, T2 1, Th 1', sameSet(rankedPairs(r).map(String), [[T1, 2], [T2, 1], [Th, 1]].map(String)) && rankedPairs(r)[0][0] === T1, JSON.stringify(rankedPairs(r))));
    // (e) likers without time: the timeless like notifications diff these against what a device saw.
    await attempt('ol-e1', () => sdk.documents.query(q('like', { where: [['postId', '==', T1]], orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 100 })),
      (r) => check('ol-e1 likers of T1 on byPost (`postId ==`, ordered by the `$ownerId` terminal): B and C, no time', sameSet(docsOf(r).map(likeOf).map((l) => toBase58(l.$ownerId)), [B.ownerId, C.ownerId]), JSON.stringify(pairsOf(r, 'postId'))));
    await attempt('ol-e2', async () => {
      const seen = [];
      for (let page = 0; page < 5; page++) {
        const after = seen.length === 0 ? [] : [['$ownerId', '>', seen.at(-1)]];
        const likers = docsOf(await sdk.documents.query(q('like', { where: [['postId', '==', T1], ...after], orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 1 }))).map(likeOf).map((l) => toBase58(l.$ownerId));
        if (likers.length === 0) break;
        seen.push(...likers);
      }
      return seen;
    }, (got) => check('ol-e2 keyset paging 1 at a time on the terminal (`$ownerId >` the last seen, no id cursor) walks both likers of T1 once', sameSet(got, [B.ownerId, C.ownerId]), JSON.stringify(got)));
    // Several targets in one read need the author pinned (ol-e4): on byPost the `in` sits on the
    // only property while the terminal ranges, which the node refuses.
    await expectRefusal(`ol-e3x ONE liker read across posts on byPost (\`postId in\`, no \`$ownerId ==\`) is refused; ${counters ? 'v12 reads each target on its own (ol-e1)' : 'the author-pinned byAuthorPost form serves it'}`, () => sdk.documents.query(q('like', { where: [['postId', 'in', [T1, T2]]], orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 100 })));
    if (counters) {
      // v12: byAuthorPost / byAuthorReply are counters of byPost / byReply. They hold no like
      // documents, so the author-pinned liker read is gone; what they answer is the count.
      await expectRefusal('ol-e4x (v12) the liker read off byAuthorPost (`postAuthor ==`, `postId in`) is refused: the counter keeps no like documents', () => sdk.documents.query(q('like', { where: [['postAuthor', '==', A.ownerId], ['postId', 'in', [T1, T2]]], orderBy: [['postAuthor', 'asc'], ['postId', 'asc']], limit: 100 })), NON_INDEXED);
      await attempt('ol-e4', () => count('like', [['postAuthor', '==', A.ownerId], ['postId', 'in', [T1, T2]]], ['postId']),
        (m) => check('ol-e4 (v12) the same targets\' counters off byAuthorPost (`postAuthor ==`, `postId in`, groupBy postId: the counters\' sums): T1 2, T2 1', sameCounts(countEntries(m), { [T1]: 2, [T2]: 1 }), JSON.stringify(countEntries(m))));
    } else {
      await attempt('ol-e4', () => sdk.documents.query(q('like', { where: [['postAuthor', '==', A.ownerId], ['postId', 'in', [T1, T2]]], orderBy: [['postAuthor', 'asc'], ['postId', 'asc']], limit: 100 })),
        (r) => check('ol-e4 the same off byAuthorPost (`postAuthor ==`, `postId in`): B→T1, C→T1, B→T2', sameSet(pairsOf(r, 'postId'), [`${B.ownerId}>${T1}`, `${C.ownerId}>${T1}`, `${B.ownerId}>${T2}`]), JSON.stringify(pairsOf(r, 'postId'))));
    }
    await expectRefusal('ol-e5x the same across replies on byReply (`replyId in`, no `$ownerId ==`) is refused', () => sdk.documents.query(q('likeReply', { where: [['replyId', 'in', [r1, r5]]], orderBy: [['replyId', 'asc'], ['$ownerId', 'asc']], limit: 100 })));
    if (counters) {
      await expectRefusal('ol-e6x (v12) the liker read off byAuthorReply (`replyAuthor ==`, `replyId in`) is refused: the counter keeps no like documents', () => sdk.documents.query(q('likeReply', { where: [['replyAuthor', '==', B.ownerId], ['replyId', 'in', [r1, r5]]], orderBy: [['replyAuthor', 'asc'], ['replyId', 'asc']], limit: 100 })), NON_INDEXED);
      await attempt('ol-e6', () => count('likeReply', [['replyAuthor', '==', B.ownerId], ['replyId', 'in', [r1, r5]]], ['replyId']),
        (m) => check('ol-e6 (v12) the replies\' counters off byAuthorReply (`replyAuthor ==`, `replyId in`, groupBy replyId): r1 1, r5 0 or absent', sameCounts(countEntries(m), { [r1]: 1 }), `${JSON.stringify(countEntries(m))}; zero group r5 ${zeroGroups(countEntries(m), [r5])}`));
    } else {
      await attempt('ol-e6', () => sdk.documents.query(q('likeReply', { where: [['replyAuthor', '==', B.ownerId], ['replyId', 'in', [r1, r5]]], orderBy: [['replyAuthor', 'asc'], ['replyId', 'asc']], limit: 100 })),
        (r) => check('ol-e6 the same off byAuthorReply (`replyAuthor ==`, `replyId in`): A→r1', same(pairsOf(r, 'replyId'), [`${A.ownerId}>${r1}`]), JSON.stringify(pairsOf(r, 'replyId'))));
    }
    // (f) which recent posts gained likes, (g) batched counts: unchanged from v10, plus the byAuthorPost form.
    await attempt('dc-f1', async () => {
      const posts = ids(await sdk.documents.query(q('post', { where: [['$ownerId', '==', A.ownerId], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20 })));
      return countEntries(await count('like', [['postId', 'in', posts]], ['postId']));
    }, (m) => check('dc-f1 A\'s latest 20 posts, liked ones by one grouped byPost count: T1 2, T2 1, Th 1', sameCounts(m, { [T1]: 2, [T2]: 1, [Th]: 1 }), JSON.stringify(m)));
    await attempt('ol-f4', () => count('like', [['postAuthor', '==', A.ownerId], ['postId', 'in', [T1, T2, T3, Th]]], ['postId']), (m) => (counters
      // v12: the counters' sums per `in` value; T3, liked and unliked, keeps its preallocated counter at 0.
      ? check('ol-f4 (v12) the same off the byAuthorPost counters (`postAuthor ==`, `postId in`, groupBy postId reads each counter\'s sum): T1 2, T2 1, Th 1, T3 (liked and unliked) 0 or absent', sameCounts(countEntries(m), { [T1]: 2, [T2]: 1, [Th]: 1 }), `${JSON.stringify(countEntries(m))}; zero group T3 ${zeroGroups(countEntries(m), [T3])}`)
      : check('ol-f4 the same off byAuthorPost (`postAuthor ==`, `postId in`, groupBy postId): T1 2, T2 1, Th 1', sameCounts(countEntries(m), { [T1]: 2, [T2]: 1, [Th]: 1 }), JSON.stringify(countEntries(m)))));
    await attempt('dc-f2', () => sdk.documents.composite({
      dataContractId: contractId, documentType: 'post', where: [['$ownerId', '==', A.ownerId], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20,
      subQueries: [{ documentType: 'like', kind: 'counts', bind: fromPage('$id', 'postId') }],
    }), (result) => {
      const m = countEntries(result.subResults[0].counts);
      check('dc-f2 the profile-page composite count slot: T1 2, T2 1, Th 1', sameCounts(m, { [T1]: 2, [T2]: 1, [Th]: 1 }), JSON.stringify(m));
    });
    await attempt('dc-f3', () => sdk.documents.composite({
      dataContractId: contractId, documentType: 'reply', where: [['$ownerId', '==', B.ownerId], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20,
      subQueries: [{ documentType: 'likeReply', kind: 'counts', bind: fromPage('$id', 'replyId') }],
    }), (result) => {
      const m = countEntries(result.subResults[0].counts);
      check('dc-f3 B\'s recent replies with their like counts (byReply count slot): r1 1', sameCounts(m, { [r1]: 1 }), JSON.stringify(m));
    });
    await attempt('dc-g2', () => count('likeReply', [['replyId', 'in', [r1, r2]]], ['replyId']), (m) => check('dc-g2 reply like counts (byReply, `in` + groupBy): r1 1', sameCounts(countEntries(m), { [r1]: 1 }), JSON.stringify(countEntries(m))));
    // (t) trending: the windows still hold C's unliked T3 (kept until its window passes).
    await attempt('ol-t1', trendPosts, (r) => check('ol-t1 top posts in the oldest open byTrendPost window: T1 2, T2 1, Th 1, and T3 1 though C unliked it (outlivesDelete keeps the entry)', sameSet(rankedPairs(r).map(String), [[T1, 2], [T2, 1], [Th, 1], [T3, 1]].map(String)), JSON.stringify(rankedPairs(r))));
    await attempt('ol-u0', () => Promise.all([likeCount('like', 'postId', T3), heartOf('like', 'postId', T3, C.ownerId)]),
      ([n, heart]) => check('ol-u0 C\'s unlike of T3 without $createdAt: count 0 and heart off on byPost', n === 0 && heart === 0, `count ${n}, heart ${heart}`));

    // B's tagged like, in a later tag-window step than C's, then the unlikes.
    const stepAfter = taggedAt + (2 * grid('byTrendHashtagPost').step + 5) * 1000 - Date.now();
    if (stepAfter > 0) { console.log(`     waiting ${Math.ceil(stepAfter / 1000)} s so B's tagged like lands two tag-window steps after C's`); await sleep(stepAfter); }
    await likeWrite(B, 'like', { postId: id(Th), postAuthor: id(A.ownerId), hashtag: tag });
    await sleep(SETTLE_MS);
    await attempt('ol-t2', trendTags, (r) => check(`ol-t2 trending tags in the oldest open byTrendHashtagPost window: ${tag} 2`, same(tagPairs(r), [[tag, 2]]), JSON.stringify(tagPairs(r))));
    await attempt('ol-t3', () => ranked([['hashtag', '==', tag]], 'postId', oldestOf('byTrendHashtagPost')), (r) => check('ol-t3 the tag\'s top posts in its window: Th 2', same(rankedPairs(r), [[Th, 2]]), JSON.stringify(rankedPairs(r))));
    await attempt('ol-t4', () => ranked([['hashtag', '==', tag]], 'postId'), (r) => check('ol-t4 hashtag Top all-time (byHashtagPost ranked `hashtag ==` groupBy postId): Th 2', same(rankedPairs(r), [[Th, 2]]), JSON.stringify(rankedPairs(r))));

    // (h) unlikes WITHOUT $createdAt. h0 first offers the time anyway: the SDK drops it on a
    // type whose rows commit to none, so it is reported, never failed.
    try {
      await unlike(B, 'like', { postId: id(T2), postAuthor: id(A.ownerId) }, { createdAt: Date.now() });
      await sleep(SETTLE_MS);
      const n = await likeCount('like', 'postId', T2);
      console.log(`INFO  ol-h0 an unlike carrying $createdAt was ACCEPTED (the SDK builder drops the time on this type); T2 count now ${n}`);
    } catch (e) {
      console.log(`INFO  ol-h0 an unlike carrying $createdAt is refused — ${describeErr(e).slice(0, 200)}`);
    }
    await attempt('ol-h1', async () => {
      if (await likeCount('like', 'postId', T2) > 0) await unlike(B, 'like', { postId: id(T2), postAuthor: id(A.ownerId) }).catch(reported('unlike'));
      await sleep(SETTLE_MS);
      const [n, heart, top, trend] = await Promise.all([likeCount('like', 'postId', T2), heartOf('like', 'postId', T2, B.ownerId), ranked([['postAuthor', '==', A.ownerId]], 'postId'), trendPosts()]);
      return { n, heart, top: rankedPairs(top), trend: rankedPairs(trend) };
    }, ({ n, heart, top, trend }) => check('ol-h1 B unlikes T2 with no $createdAt: count 0, heart off, gone from the profile Top; the 3-day trend window still counts it (T2 1)',
      n === 0 && heart === 0 && !top.some(([k]) => k === T2) && trend.some(([k, v]) => k === T2 && v === 1), `count ${n}, heart ${heart}, top ${JSON.stringify(top)}, trend ${JSON.stringify(trend)}`));
    await attempt('ol-h2', async () => {
      await unlike(A, 'likeReply', { replyId: id(r1), replyAuthor: id(B.ownerId) }).catch(reported('unlike'));
      await sleep(SETTLE_MS);
      return Promise.all([likeCount('likeReply', 'replyId', r1), heartOf('likeReply', 'replyId', r1, A.ownerId)]);
    }, ([n, heart]) => check('ol-h2 A unlikes reply r1 with no $createdAt (likeReply requires none): count 0, heart off', n === 0 && heart === 0, `count ${n}, heart ${heart}`));
    await attempt('ol-h3', async () => {
      await unlike(C, 'like', { postId: id(Th), postAuthor: id(A.ownerId), hashtag: tag }).catch(reported('unlike'));
      await sleep(SETTLE_MS);
      const [n, top, window] = await Promise.all([likeCount('like', 'postId', Th), ranked([['hashtag', '==', tag]], 'postId'), trendTags()]);
      return { n, top: rankedPairs(top), window: tagPairs(window) };
    }, ({ n, top, window }) => check(`ol-h3 C unlikes the tagged Th: count 1, hashtag Top all-time Th 1, the 24h tag window still ${tag} 2`, n === 1 && same(top, [[Th, 1]]) && same(window, [[tag, 2]]), `count ${n}, top ${JSON.stringify(top)}, window ${JSON.stringify(window)}`));
    await attempt('ol-h4', async () => {
      await likeWrite(B, 'like', { postId: id(T2), postAuthor: id(A.ownerId) });
      await sleep(SETTLE_MS);
      const [n, heart, trend] = await Promise.all([likeCount('like', 'postId', T2), heartOf('like', 'postId', T2, B.ownerId), trendPosts()]);
      return { n, heart, trend: rankedPairs(trend) };
    }, ({ n, heart, trend }) => check('ol-h4 B re-likes T2 while its kept entry stands: count 1, heart on, and the trend window still counts B once (T2 1: the create writes over the kept entry)',
      n === 1 && heart === 1 && trend.some(([k, v]) => k === T2 && v === 1), `count ${n}, heart ${heart}, trend ${JSON.stringify(trend)}`), { idempotent: false });

    // (x) the kept entries expire with their windows. A like at t leaves the oldest open window
    // once that window starts after t: at floor(t/step)·step + range. Block time trails the
    // local clock by up to a block or two, so each check polls from then until the expected
    // state shows, within a deadline.
    const leavesOldestAt = (t, name) => Math.floor(t / 1000 / grid(name).step) * grid(name).step * 1000 + grid(name).range * 1000;
    // An idle devnet makes a block only every few minutes, and a window passes in BLOCK time,
    // so the poll allows ten minutes past the expected expiry (100 s missed it on sakura).
    const EXPIRY_GRACE_MS = 600_000;
    const pollUntil = async (from, deadline, read, done) => {
      if (from > Date.now()) { console.log(`     waiting ${Math.ceil((from - Date.now()) / 1000)} s for a window to pass`); await sleep(from - Date.now()); }
      let value = await withReconnect(read);
      while (!done(value) && Date.now() < deadline) { await sleep(10_000); value = await withReconnect(read); }
      return value;
    };
    await attempt('ol-x1', () => pollUntil(leavesOldestAt(taggedAt, 'byTrendHashtagPost'), leavesOldestAt(taggedAt, 'byTrendHashtagPost') + EXPIRY_GRACE_MS,
      async () => ({ tags: tagPairs(await trendTags()), posts: rankedPairs(await ranked([['hashtag', '==', tag]], 'postId', oldestOf('byTrendHashtagPost'))) }),
      ({ tags }) => !same(tags, [[tag, 2]])), ({ tags, posts }) => check(`ol-x1 once its window passed, C's unliked tag entry has expired while B's later live like stays: ${tag} 1, Th 1 in the oldest open window`,
      same(tags, [[tag, 1]]) && same(posts, [[Th, 1]]), `${JSON.stringify(tags)} posts ${JSON.stringify(posts)}`));
    await attempt('ol-x2', () => pollUntil(leavesOldestAt(expiringAt, 'byTrendPost'), leavesOldestAt(expiringAt, 'byTrendPost') + EXPIRY_GRACE_MS,
      async () => rankedPairs(await trendPosts()), (got) => !got.some(([k]) => k === T3)),
    (got) => check('ol-x2 once its window passed, C\'s unliked T3 is gone from the 3-day trend window (never re-counted)', !got.some(([k]) => k === T3), JSON.stringify(got)));
    await attempt('ol-x3', () => Promise.all([likeCount('like', 'postId', Th), likeCount('like', 'postId', T1), ranked([['postAuthor', '==', A.ownerId]], 'postId')]),
      ([th, t1, top]) => check('ol-x3 the permanent indexes are untouched by the expiry: Th 1, T1 2, profile Top T1 2 / T2 1 / Th 1', th === 1 && t1 === 2 && sameSet(rankedPairs(top).map(String), [[T1, 2], [T2, 1], [Th, 1]].map(String)), `Th ${th}, T1 ${t1}, top ${JSON.stringify(rankedPairs(top))}`));
  }

  // ---- kf / tm-0: v11 moderation before a team is seated (the interim owner A moderates) ----
  async function proveRemovalRecordsAndWindow() {
    console.log('\n--- kf. removal records keep fields; tm-0. the delete window before a team is seated ---');
    const S1 = await mustCreate('S1 (D, #settle: the team deletes it once settled)', D, 'post', { content: 'settle one', hashtag: 'settle' });
    const S2 = await mustCreate('S2 (D, #settle: spare)', D, 'post', { content: 'settle two', hashtag: 'settle' });
    const SR = await mustCreate('SR (D, a thread root)', D, 'post', { content: 'thread root' });
    const S3 = await mustCreate('S3 (D replies to its SR: the team deletes it once settled)', D, 'reply', { content: 'settle reply', rootPostId: id(SR), parentOwnerId: id(D.ownerId) });
    const settledFrom = Date.now();
    const Pk = await mustCreate('Pk (D, #kept)', D, 'post', { content: 'kept fields', hashtag: 'kept' });
    const Rk = await mustCreate('Rk (D replies to SR)', D, 'reply', { content: 'kept reply', rootPostId: id(SR), parentOwnerId: id(D.ownerId) });
    const created = async (docType, docId) => createdAtOf(await sdk.documents.get(contractId, docType, docId));
    const [pkAt, rkAt] = await Promise.all([created('post', Pk), created('reply', Rk)]);
    const moderatorA = { identity: await sdk.identities.fetch(A.ownerId), signer: A.signer };
    await attempt('kf-1', () => sdk.contracts.moderatorDeleteDocument({ ...moderatorA, contractId, documentTypeName: 'post', documentId: Pk, reason: { text: 'kf-1 proof' } }), (record) => {
      const kept = record?.keptFields ?? {};
      check('kf-1 the interim owner removes D\'s post Pk within the window: the record keeps hashtag "kept" and its $createdAt',
        kept.hashtag === 'kept' && Number(kept.$createdAt) === pkAt && Object.keys(kept).length === 2, JSON.stringify(kept, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    }, { idempotent: false });
    await attempt('kf-2', () => sdk.contracts.moderatorDeleteDocument({ ...moderatorA, contractId, documentTypeName: 'reply', documentId: Rk, reason: { text: 'kf-2 proof' } }), (record) => {
      const kept = record?.keptFields ?? {};
      check('kf-2 the same for D\'s reply Rk: the record keeps rootPostId SR and its $createdAt', toBase58(kept.rootPostId) === SR && Number(kept.$createdAt) === rkAt, JSON.stringify({ rootPostId: toBase58(kept.rootPostId), $createdAt: String(kept.$createdAt) }));
    }, { idempotent: false });
    await attempt('kf-3', () => sdk.contracts.documentRemovals({ contractId, documentTypeName: 'post', documentIds: [Pk] }), (page) => {
      const kept = page.removals[0]?.keptFields ?? {};
      check('kf-3 documentRemovals by id returns the kept fields too (hashtag, $createdAt), and the post is gone', page.removals.length === 1 && kept.hashtag === 'kept' && Number(kept.$createdAt) === pkAt, JSON.stringify(kept, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    });
    const settledAt = settledFrom + (PROOF_DELETE_WITHIN + 20) * 1000;
    if (settledAt > Date.now()) { console.log(`     waiting ${Math.ceil((settledAt - Date.now()) / 1000)} s for S1-S3 to settle (deleteWithin ${PROOF_DELETE_WITHIN} s)`); await sleep(settledAt - Date.now()); }
    await expectCode('tm-0a past the window even the interim owner\'s lone delete of S1 is refused', '41116', () => sdk.contracts.moderatorDeleteDocument({ ...moderatorA, contractId, documentTypeName: 'post', documentId: S1, reason: { text: 'tm-0a' } }));
    await expectCode('tm-0b a settled-deletion proposal before any team is seated is refused', '41205', () => sdk.contracts.moderatorDeleteSettledDocument({ ...moderatorA, contractId, documentTypeName: 'post', documentId: S1, reason: { text: 'tm-0b' } }));
    return { contractId, D: D.ownerId, S1, S2, SR, S3 };
  }

  // ---- cn: v12 counters (summableOffCountIndex, platform#5250) ----
  // D authors fresh posts and replies (D has written nothing yet), so every total is exact.
  // byAuthorPost [postAuthor, postId] and byHashtagPost [hashtag, postId] keep one SumItem per
  // post holding its byPost entries, ranked at both levels; byAuthorReply [replyAuthor, replyId]
  // the same off byReply, unranked. All three are preallocated: a counter exists, at 0, from
  // the post's (reply's) creation.
  async function proveCounters() {
    console.log('\n--- cn. v12 counters: per post, author and hashtag; rankings; grouped per-post counts; zero groups; unlike; refused range totals; reply counters ---');
    const tag = 'cnproof';
    const MIN_ID = '11111111111111111111111111111111';
    const sum = (documentTypeName, where, sourceIndex, groupBy) => sdk.documents.sum(q(documentTypeName, { where, ...(groupBy ? { groupBy } : {}) }), sourceIndex);
    const ranked = (where, groupBy, aggregate = { type: 'count' }) => sdk.documents.ranked(q('like', { ...(where ? { where } : {}), groupBy, aggregate, direction: 'desc', limit: 100 }));
    const entriesOf = (r) => r.entries.map((e) => [toBase58(e.groupValue), Number(e.value)]);
    const nonZero = (r) => entriesOf(r).filter(([, value]) => value !== 0);
    const tagEntries = (r) => r.entries.map((e) => [typeof e.groupValue === 'string' ? e.groupValue : Buffer.from(e.groupValue).toString('utf8'), Number(e.value)]).filter(([, value]) => value !== 0);
    /** The groups of a grouped count, without the '' total. */
    const counts = (m) => Object.fromEntries(Object.entries(countEntries(m)).filter(([key]) => key !== ''));
    /** Exactly these groups, zero groups included: a range walk over a preallocated counter keeps them (index-only.md). */
    const exactly = (m, expected) => same(Object.entries(counts(m)).sort(), Object.entries(expected).sort());
    const zeros = (m, keys) => zeroGroups(counts(m), keys);
    const postLike = (target, extra = {}) => ({ postId: id(target), postAuthor: id(D.ownerId), ...extra });
    const replyLike = (target) => ({ replyId: id(target), replyAuthor: id(D.ownerId) });

    const C1 = await mustCreate('C1 (D, untagged)', D, 'post', { content: 'counter one' });
    const C2 = await mustCreate('C2 (D, #cnproof)', D, 'post', { content: 'counter two', hashtag: tag });
    const C3 = await mustCreate('C3 (D, never liked)', D, 'post', { content: 'counter three' });
    const C4 = await mustCreate('C4 (D, #cnproof)', D, 'post', { content: 'counter four', hashtag: tag });
    const R1 = await mustCreate('R1 (D replies to C1)', D, 'reply', { content: 'counter reply one', rootPostId: id(C1), parentOwnerId: id(D.ownerId) });
    const R2 = await mustCreate('R2 (D replies to C1, never liked)', D, 'reply', { content: 'counter reply two', rootPostId: id(C1), parentOwnerId: id(D.ownerId) });
    await sleep(SETTLE_MS);
    // An empty answer also totals 0, so the totals alone cannot tell a preallocated counter from
    // none; the range walks can: they list a preallocated counter's zero group.
    await attempt('cn-0', () => Promise.all([count('like', [['postAuthor', '==', D.ownerId]]), count('like', [['postAuthor', '==', D.ownerId], ['postId', '==', C1]]), count('like', [['hashtag', '==', tag]]), count('likeReply', [['replyAuthor', '==', D.ownerId]])]),
      (all) => check('cn-0 before any like, D\'s totals read 0 (or answer empty): author, C1, #cnproof, D\'s replies', all.every((m) => total(m) === 0), JSON.stringify(all.map(counts))));
    await attempt('cn-0r', () => Promise.all([count('like', [['postAuthor', '==', D.ownerId], ['postId', '>', MIN_ID]], ['postId']), count('likeReply', [['replyAuthor', '==', D.ownerId], ['replyId', '>', MIN_ID]], ['replyId'])]),
      ([posts, replies]) => check('cn-0r …and the range walks list every counter at 0 before any like (preallocated with each post and reply): C1..C4 0, R1 0, R2 0', exactly(posts, { [C1]: 0, [C2]: 0, [C3]: 0, [C4]: 0 }) && exactly(replies, { [R1]: 0, [R2]: 0 }), `posts ${JSON.stringify(counts(posts))} replies ${JSON.stringify(counts(replies))}`));

    // C1: A, B, C. C2 (#cnproof): A, B. C3: none. C4 (#cnproof): C. R1: A, B. → D 6, #cnproof 3, D's replies 2.
    for (const who of [A, B, C]) await likeWrite(who, 'like', postLike(C1));
    for (const who of [A, B]) await likeWrite(who, 'like', postLike(C2, { hashtag: tag }));
    await likeWrite(C, 'like', postLike(C4, { hashtag: tag }));
    for (const who of [A, B]) await likeWrite(who, 'likeReply', replyLike(R1));
    await sleep(SETTLE_MS);

    // (a) point counts at every level: count(*) reads the counters' sums; sum(byPost) agrees.
    await attempt('cn-a1', () => Promise.all([count('like', [['postId', '==', C1]]), count('like', [['postAuthor', '==', D.ownerId], ['postId', '==', C1]])]),
      ([source, counter]) => check('cn-a1 one post: byPost `postId ==` 3, the byAuthorPost counter (`postAuthor ==`, `postId ==`) 3', total(source) === 3 && total(counter) === 3, `byPost ${total(source)} counter ${total(counter)}`));
    await attempt('cn-a2', () => count('like', [['postAuthor', '==', D.ownerId]]),
      (m) => check('cn-a2 one author (`postAuthor ==`, the shallowest ranked level): count(*) 6', total(m) === 6, `count ${total(m)}`));
    await attempt('cn-a3', () => Promise.all([count('like', [['hashtag', '==', tag]]), count('like', [['hashtag', '==', tag], ['postId', '==', C2]])]),
      ([counted, post]) => check(`cn-a3 one hashtag (byHashtagPost \`hashtag ==\`): count(*) 3; #${tag} C2 alone 2`, total(counted) === 3 && total(post) === 2, `count ${total(counted)} C2 ${total(post)}`));
    // sum(byPost), named by the source index, reads the same sums (one attempt each: a refusal of one form loses no other).
    for (const [label, where, expected] of [['cn-a1s at C1\'s counter', [['postAuthor', '==', D.ownerId], ['postId', '==', C1]], 3], ['cn-a2s at D', [['postAuthor', '==', D.ownerId]], 6], [`cn-a3s at #${tag}`, [['hashtag', '==', tag]], 3]]) {
      await attempt(label, () => sum('like', where, 'byPost'), (m) => check(`${label}: sum(byPost) ${expected}, as count(*)`, total(m) === expected, `sum ${total(m)}`));
    }

    // (b) grouped per-post counts over an author's posts: per `in` value, and over a range grouped by the last property.
    const perPost = { [C1]: 3, [C2]: 2, [C3]: 0, [C4]: 1 };
    await attempt('cn-b1', () => count('like', [['postAuthor', '==', D.ownerId], ['postId', 'in', [C1, C2, C3, C4]]], ['postId']),
      (m) => check('cn-b1 `postAuthor ==`, `postId in` [C1..C4], groupBy postId (one counter per `in` value): C1 3, C2 2, C4 1, C3 0', sameCounts(counts(m), perPost), `${JSON.stringify(counts(m))}; zero group C3 ${zeros(m, [C3])}`));
    await attempt('cn-b2', () => count('like', [['postAuthor', '==', D.ownerId], ['postId', '>', MIN_ID]], ['postId']),
      (m) => check('cn-b2 `postAuthor ==`, a range on postId, groupBy postId: every one of D\'s posts with its likes, C3 at 0', exactly(m, perPost), JSON.stringify(counts(m))));
    await attempt('cn-b3', () => sum('like', [['postAuthor', '==', D.ownerId], ['postId', 'in', [C1, C2, C3, C4]]], 'byPost', ['postId']),
      (m) => check('cn-b3 the same as a grouped sum(byPost): C1 3, C2 2, C3 0, C4 1', sameCounts(counts(m), perPost), JSON.stringify(counts(m))));
    await attempt('cn-b4', () => count('like', [['hashtag', '==', tag], ['postId', '>', MIN_ID]], ['postId']),
      (m) => check(`cn-b4 #${tag}'s posts over a range, groupBy postId: C2 2, C4 1`, exactly(m, { [C2]: 2, [C4]: 1 }), JSON.stringify(counts(m))));

    // (c) a range TOTAL through a ranked level is refused (grovedb proves totals only through
    // unranked trees), with the hint to group by the last property. byPost is ranked at postId.
    await expectRefusal('cn-c1 a range total on byAuthorPost (`postAuthor ==`, `postId >`, no groupBy) is refused, naming the grouping instead', () => count('like', [['postAuthor', '==', D.ownerId], ['postId', '>', MIN_ID]]), /group/i);
    await expectRefusal('cn-c2 a range total on byPost (`postId >`, no groupBy) is refused the same way (byPost ranks its last property)', () => count('like', [['postId', '>', MIN_ID]]), /group|rank/i);

    // (d) rankings: creators and hashtags by likes (no pins), an author's and a tag's posts (pinned).
    await attempt('cn-d1', () => ranked(null, 'postAuthor'), (r) => check('cn-d1 top creators (ranked count(*) GROUP BY postAuthor, read off the sum ranking): D 6 first, then A 4', same(nonZero(r).slice(0, 2), [[D.ownerId, 6], [A.ownerId, 4]]), JSON.stringify(nonZero(r))));
    // rankedCountable on a counter declares the sum ranking (index-only.md), so a ranked sum(byPost) reads the same one.
    await attempt('cn-d1s', () => ranked(null, 'postAuthor', { type: 'sum', property: 'byPost' }), (r) => check('cn-d1s the same ranked by sum(byPost): D 6, then A 4', same(nonZero(r).slice(0, 2), [[D.ownerId, 6], [A.ownerId, 4]]), JSON.stringify(nonZero(r))));
    await attempt('cn-d2', () => ranked(null, 'hashtag'), (r) => {
      const got = tagEntries(r);
      const ordered = got.every(([, value], i) => i === 0 || got[i - 1][1] >= value);
      check(`cn-d2 trending hashtags all time (ranked GROUP BY hashtag on byHashtagPost): ${tag} 3 first, ordered`, ordered && same(got[0], [tag, 3]), JSON.stringify(got));
    });
    await attempt('cn-d3', () => ranked([['postAuthor', '==', D.ownerId]], 'postId'), (r) => check('cn-d3 D\'s top posts (`postAuthor ==` GROUP BY postId): C1 3, C2 2, C4 1, and C3 listed at 0 after them', same(nonZero(r), [[C1, 3], [C2, 2], [C4, 1]]) && entriesOf(r).some(([k, v]) => k === C3 && v === 0), JSON.stringify(entriesOf(r))));
    await attempt('cn-d4', () => ranked([['hashtag', '==', tag]], 'postId'), (r) => check(`cn-d4 #${tag}'s top posts (\`hashtag ==\` GROUP BY postId): C2 2, C4 1`, same(nonZero(r), [[C2, 2], [C4, 1]]), JSON.stringify(entriesOf(r))));

    // (e) the counters hold no documents: likers are read per target on byPost.
    await expectRefusal('cn-e1 a documents read through byAuthorPost (`postAuthor ==`, `postId in`) is refused', () => sdk.documents.query(q('like', { where: [['postAuthor', '==', D.ownerId], ['postId', 'in', [C1]]], orderBy: [['postAuthor', 'asc'], ['postId', 'asc']], limit: 100 })), NON_INDEXED);
    await expectRefusal('cn-e2 a documents read through byHashtagPost (`hashtag ==`) is refused', () => sdk.documents.query(q('like', { where: [['hashtag', '==', tag]], orderBy: [['hashtag', 'asc'], ['postId', 'asc']], limit: 100 })), NON_INDEXED);
    await attempt('cn-e3', () => sdk.documents.query(q('like', { where: [['postId', '==', C1]], orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 100 })),
      (r) => check('cn-e3 C1\'s likers on byPost (`postId ==`, the app\'s per-target read once a counter moved): A, B, C', sameSet(docsOf(r).map((d) => toBase58((d.toObject?.() ?? d).$ownerId)), [A.ownerId, B.ownerId, C.ownerId]), `${docsOf(r).length} row(s)`));

    // (f) reply counters: byAuthorReply off byReply, unranked.
    await attempt('cn-f1', () => Promise.all([count('likeReply', [['replyId', '==', R1]]), count('likeReply', [['replyAuthor', '==', D.ownerId], ['replyId', '==', R1]]), count('likeReply', [['replyAuthor', '==', D.ownerId]])]),
      ([source, counter, author]) => check('cn-f1 reply counters: byReply R1 2, the byAuthorReply counter of R1 2, D\'s replies 2', [source, counter, author].every((m) => total(m) === 2), JSON.stringify([source, counter, author].map(total))));
    await attempt('cn-f1s', () => sum('likeReply', [['replyAuthor', '==', D.ownerId]], 'byReply'), (m) => check('cn-f1s D\'s replies as sum(byReply): 2', total(m) === 2, `sum ${total(m)}`));
    await attempt('cn-f2', () => count('likeReply', [['replyAuthor', '==', D.ownerId], ['replyId', 'in', [R1, R2]]], ['replyId']),
      (m) => check('cn-f2 `replyAuthor ==`, `replyId in` [R1, R2], groupBy replyId: R1 2, R2 0', sameCounts(counts(m), { [R1]: 2 }), `${JSON.stringify(counts(m))}; zero group R2 ${zeros(m, [R2])}`));
    await attempt('cn-f2r', () => count('likeReply', [['replyAuthor', '==', D.ownerId], ['replyId', '>', MIN_ID]], ['replyId']),
      (m) => check('cn-f2r the same over a range on replyId, groupBy replyId: R1 2, R2 present at 0 (preallocated)', exactly(m, { [R1]: 2, [R2]: 0 }), JSON.stringify(counts(m))));
    await expectRefusal('cn-f3 a ranking on byAuthorReply (declared unranked) is refused', () => sdk.documents.ranked(q('likeReply', { where: [['replyAuthor', '==', D.ownerId]], groupBy: 'replyId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 })), /no ranked index covers/i);

    // (g) an unlike takes the counters down; a drained counter stays at 0 (preallocated); a fresh post starts at 0.
    const unlikeNow = async (who, docType, data) => {
      const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data });
      await sdk.documents.delete({ document, identityKey: who.identityKey, signer: who.signer }).catch((e) => console.log(`     (unlike reported: ${describeErr(e).slice(0, 140)})`));
    };
    await unlikeNow(C, 'like', postLike(C1));
    await unlikeNow(C, 'like', postLike(C4, { hashtag: tag }));
    await unlikeNow(A, 'likeReply', replyLike(R1));
    const C5 = await mustCreate('C5 (D, fresh after the unlikes)', D, 'post', { content: 'counter five' });
    await sleep(SETTLE_MS);
    await attempt('cn-g1', () => Promise.all([count('like', [['postId', '==', C1]]), count('like', [['postAuthor', '==', D.ownerId], ['postId', '==', C1]]), count('like', [['postAuthor', '==', D.ownerId]]), count('like', [['hashtag', '==', tag]])]),
      ([source, counter, author, hashtag]) => check('cn-g1 C unlikes C1 and C4: byPost C1 2, its counter 2, D 4, #cnproof 2', total(source) === 2 && total(counter) === 2 && total(author) === 4 && total(hashtag) === 2, JSON.stringify([source, counter, author, hashtag].map(total))));
    await attempt('cn-g2', () => Promise.all([count('like', [['postAuthor', '==', D.ownerId], ['postId', '>', MIN_ID]], ['postId']), count('like', [['postAuthor', '==', D.ownerId], ['postId', '==', C5]])]),
      ([m, fresh]) => check('cn-g2 per post after the unlikes (range, groupBy postId): C1 2, C2 2, C3 0, C4 0 (drained, kept at zero), C5 0 (fresh: its counter exists from creation); C5\'s point count 0', exactly(m, { [C1]: 2, [C2]: 2, [C3]: 0, [C4]: 0, [C5]: 0 }) && total(fresh) === 0, `${JSON.stringify(counts(m))} C5 point ${total(fresh)}`));
    await attempt('cn-g3', () => Promise.all([ranked(null, 'postAuthor'), ranked([['hashtag', '==', tag]], 'postId')]), ([creators, tagged]) => check('cn-g3 the rankings follow: D 4 among the creators; #cnproof top posts C2 2 alone above zero', nonZero(creators).some(([k, v]) => k === D.ownerId && v === 4) && same(nonZero(tagged), [[C2, 2]]), `creators ${JSON.stringify(nonZero(creators))} tag ${JSON.stringify(entriesOf(tagged))}`));
    await attempt('cn-g4', () => Promise.all([count('likeReply', [['replyAuthor', '==', D.ownerId], ['replyId', '==', R1]]), count('likeReply', [['replyAuthor', '==', D.ownerId]])]),
      ([reply, author]) => check('cn-g4 A unlikes R1: its counter 1, D\'s replies 1', total(reply) === 1 && total(author) === 1, JSON.stringify([total(reply), total(author)])));
    // (h) Drive refuses a batch moving one type's counters for two documents, but a consensus
    // batch carries one transition, so no SDK write can build one: not provable here.
    console.log('INFO  cn-h a batch moving one type\'s counters for two documents is refused by Drive; no state transition can carry one (one transition per documents batch), so it is not proved here');
  }

  // ---- rw: v12 retractedWhen (platform#5253): a barred author tombstones, and nothing else ----
  async function proveRetraction() {
    console.log('\n--- rw. v12 retractedWhen: banned and suspended, D tombstones its own post and reply; edits and take-backs are refused ---');
    const moderatorA = async () => ({ identity: await sdk.identities.fetch(A.ownerId), signer: A.signer });
    const BANNED = /\bcode"?\s*[=:]\s*41107\b|contractuserbanned|is banned/i;
    const SUSPENDED = /\bcode"?\s*[=:]\s*41108\b|contractusersuspended|is suspended/i;
    const fixtures = async (label) => {
      const post = await mustCreate(`${label} post (D)`, D, 'post', { content: `${label} post`, hashtag: 'rwproof' });
      const reply = await mustCreate(`${label} reply (D)`, D, 'reply', { content: `${label} reply`, rootPostId: id(post), parentOwnerId: id(D.ownerId) });
      return { post, reply };
    };
    const banned = await fixtures('rw banned');
    const suspended = await fixtures('rw suspended');
    const tombstoneOf = async (docType, docId) => { const stored = plain(await sdk.documents.get(contractId, docType, docId)); return stored.deleted === true && stored.content === undefined; };
    const underBar = async (prefix, { post, reply }, refusal, code) => {
      refusedWith(`${prefix}1 D's edit of its post while barred is refused (${code})`, await replaceDoc(D, 'post', post, { content: 'edited', hashtag: 'rwproof' }), refusal);
      refusedWith(`${prefix}2 a tombstone keeping the text passes the bar and is refused by tombstoneIsBlank (10422)`, await replaceDoc(D, 'post', post, { deleted: true, content: 'kept', hashtag: 'rwproof' }), BLANK);
      const tomb = await replaceDoc(D, 'post', post, { deleted: true, hashtag: 'rwproof' });
      check(`${prefix}3 D's tombstone of its own post is ACCEPTED while barred`, tomb.ok && (await tombstoneOf('post', post)), tomb.error ?? '');
      refusedWith(`${prefix}4 taking the tombstone back while barred is refused (${code})`, await replaceDoc(D, 'post', post, { content: 'back', hashtag: 'rwproof' }), refusal);
      refusedWith(`${prefix}5 D's edit of its reply while barred is refused (${code})`, await replaceDoc(D, 'reply', reply, { content: 'edited', rootPostId: id(post), parentOwnerId: id(D.ownerId) }), refusal);
      const replyTomb = await replaceDoc(D, 'reply', reply, { deleted: true, rootPostId: id(post), parentOwnerId: id(D.ownerId) });
      check(`${prefix}6 D's tombstone of its own reply is ACCEPTED while barred`, replyTomb.ok && (await tombstoneOf('reply', reply)), replyTomb.error ?? '');
      const fresh = await create(D, 'post', { content: `${prefix} new while barred` });
      check(`${prefix}7 a new post by D is still refused (${code})`, !fresh.ok && refusal.test(fresh.error ?? ''), (fresh.error ?? 'ACCEPTED').slice(0, 200));
    };
    // Once a bar was attempted it is always lifted (liftBar): a ban that threw after landing is
    // still live, and a "not barred" refusal only counts once repeated standing reads agree.
    const standing = () => withReconnect(() => sdk.contracts.moderationStatus({ contractId, identityId: D.ownerId, lists: ['banlist', 'suspensions'] }));
    const suspendedUntil = Date.now() + 10 * 60_000;
    try {
      await sdk.contracts.banUser({ ...(await moderatorA()), contractId, identityId: D.ownerId, reason: { text: 'rw proof ban' } });
      await sleep(SETTLE_MS);
      await underBar('rw-b', banned, BANNED, '41107');
    } catch (e) {
      check('rw-b the ban and the banned writes ran', false, describeErr(e).slice(0, 200));
    } finally {
      const { lifted, detail } = await liftBar({ kind: 'ban', identityId: D.ownerId, contractId, standing,
        lift: async () => sdk.contracts.unbanUser({ ...(await moderatorA()), contractId, identityId: D.ownerId }) });
      check('rw-b8 the interim owner unbans D (the banlist reads clear on repeated polls)', lifted, lifted ? detail : `${detail.slice(0, 160)} — D MAY STILL BE BANNED`);
    }
    await sleep(SETTLE_MS);
    try {
      await sdk.contracts.suspendUser({ ...(await moderatorA()), contractId, identityId: D.ownerId, until: BigInt(suspendedUntil), reason: { text: 'rw proof suspension' } });
      await sleep(SETTLE_MS);
      await underBar('rw-s', suspended, SUSPENDED, '41108');
    } catch (e) {
      check('rw-s the suspension and the suspended writes ran', false, describeErr(e).slice(0, 200));
    } finally {
      const { lifted, detail } = await liftBar({ kind: 'suspension', identityId: D.ownerId, contractId, standing,
        lift: async () => sdk.contracts.unsuspendUser({ ...(await moderatorA()), contractId, identityId: D.ownerId }) });
      check('rw-s8 the interim owner lifts D\'s suspension (the suspensions list reads clear on repeated polls)', lifted, lifted ? detail : `${detail.slice(0, 160)} — D MAY STILL BE SUSPENDED until ${new Date(suspendedUntil).toISOString()}`);
    }
    await sleep(SETTLE_MS);
    let after = await create(D, 'post', { content: 'rw after the bars' });
    if (!after.ok && SUSPENDED.test(after.error ?? '') && suspendedUntil > Date.now()) {
      // The lift failed: the later phases need D, so wait the suspension out rather than abort them.
      console.log(`     D is still suspended; waiting ${Math.ceil((suspendedUntil - Date.now()) / 1000) + 30} s for it to lapse`);
      await sleep(suspendedUntil - Date.now() + 30_000);
      after = await create(D, 'post', { content: 'rw after the bars' });
    }
    if (!after.ok && BANNED.test(after.error ?? '')) throw new Error(`D is still banned on ${contractId}: unban it by hand (the interim owner is A); the later phases write as D`);
    check('rw-9 with both bars lifted D writes again (the later phases need it)', after.ok, (after.error ?? '').slice(0, 200));
  }

  if (v11) await proveOutlives();
  else await proveDesignC();
  if (counters) await proveCounters();
  if (retracts) await proveRetraction();

  // ---- M: design M (moderated posts and replies, tombstones, preallocated like trees) ----
  async function proveDesignM() {
    console.log('\n--- M. design M: preallocated trees, tombstones, undo/redo repost, references that outlive a removal ---');
    const balanceOf = async (who) => BigInt((await sdk.identities.fetch(who.ownerId))?.balance ?? 0);
    const rankedRaw = (where, groupBy) => sdk.documents.ranked(q('like', { ...(where ? { where } : {}), groupBy, aggregate: { type: 'count' }, direction: 'desc', limit: 100 }));
    const entriesOf = (r) => r.entries.map((e) => [toBase58(e.groupValue), Number(e.value)]);

    // (pa) preallocated: a fresh post sits in its trees with zero likes; the first like costs what a later one does.
    const createdBefore = await balanceOf(D);
    const Pf = await mustCreate('Pf (D, #mproof, fresh)', D, 'post', { content: 'fresh post', hashtag: 'mproof' });
    console.log(`INFO  M-pa0 a tagged post with its preallocated like trees cost D ${createdBefore - (await balanceOf(D))} credits`);
    await sleep(SETTLE_MS);
    await attempt('M-pa1', () => Promise.all([rankedRaw([['postAuthor', '==', D.ownerId]], 'postId'), rankedRaw([['hashtag', '==', 'mproof']], 'postId'), count('like', [['postId', '==', Pf]])]), ([top, tag, n]) =>
      check('M-pa1 a fresh, unliked post is already in its preallocated trees: profile Top and hashtag Top list it at 0; its like count is 0', entriesOf(top).some(([k, v]) => k === Pf && v === 0) && entriesOf(tag).some(([k, v]) => k === Pf && v === 0) && total(n) === 0, `top ${JSON.stringify(entriesOf(top))} tag ${JSON.stringify(entriesOf(tag))} count ${JSON.stringify(countEntries(n))}`));
    await attempt('M-pa2', () => count('like', [['postId', 'in', [Pf]]], ['postId']), (m) => console.log(`INFO  M-pa2 grouped count of the fresh post (\`postId in\` + groupBy): ${JSON.stringify(countEntries(m))}`));
    const costOf = async (who, data) => { const before = await balanceOf(who); await likeWrite(who, 'like', data); await sleep(SETTLE_MS); return before - (await balanceOf(who)); };
    const firstLike = await costOf(B, { postId: id(Pf), postAuthor: id(D.ownerId), hashtag: 'mproof' });
    const secondLike = await costOf(C, { postId: id(Pf), postAuthor: id(D.ownerId), hashtag: 'mproof' });
    check(`M-pa3 the FIRST tagged like of a post costs about what the second does (the post paid the trees; only the trend windows, never preallocated, are new): ${firstLike} vs ${secondLike} credits`, firstLike > 0n && secondLike > 0n && Number(firstLike) <= Number(secondLike) * 1.3);

    // (tb) tombstones: the allowed and the refused cases, on D's post Pt and reply Rt.
    const Pt = await mustCreate('Pt (D, #mproof, to tombstone)', D, 'post', { content: 'to tombstone', hashtag: 'mproof' });
    const Rt = await mustCreate('Rt (D replies to Pt)', D, 'reply', { content: 'reply to tombstone', rootPostId: id(Pt), parentOwnerId: id(D.ownerId) });
    const del = await sdk.documents.delete({ document: { id: Pt, ownerId: D.ownerId, dataContractId: contractId, documentTypeName: 'post' }, identityKey: D.identityKey, signer: D.signer }).then(() => null, (e) => describeErr(e));
    check('M-tb1 an author cannot delete its post (canBeDeleted false)', del !== null && (await sdk.documents.get(contractId, 'post', Pt)) !== null, (del ?? 'ACCEPTED').slice(0, 200));
    refusedWith('M-tb2 an edit of the text without the flag is refused (40128)', await replaceDoc(D, 'post', Pt, { content: 'edited', hashtag: 'mproof' }), IMMUTABLE);
    refusedWith('M-tb3 a tombstone keeping the text is refused (10422 tombstoneIsBlank)', await replaceDoc(D, 'post', Pt, { deleted: true, content: 'kept', hashtag: 'mproof' }), BLANK);
    refusedWith('M-tb4 a tombstone changing the hashtag is refused (40128)', await replaceDoc(D, 'post', Pt, { deleted: true, hashtag: 'other' }), IMMUTABLE);
    // Adding a field the post never had counts as a change too ("differs" covers a value the stored document lacked).
    refusedWith('M-tb4b adding a mention the post never had, without the flag, is refused (40128)', await replaceDoc(D, 'post', Pt, { content: 'to tombstone', hashtag: 'mproof', mentionedUserId: id(B.ownerId) }), IMMUTABLE);
    refusedWith('M-tb4c marking it sensitive afterwards is refused (40128)', await replaceDoc(D, 'post', Pt, { content: 'to tombstone', hashtag: 'mproof', sensitive: true }), IMMUTABLE);
    const untagged = await mustCreate('Pu (D, untagged)', D, 'post', { content: 'untagged' });
    refusedWith('M-tb4d adding a hashtag to an untagged post is refused (40128: frozen by name)', await replaceDoc(D, 'post', untagged, { content: 'untagged', hashtag: 'late' }), IMMUTABLE);
    const tombBefore = await balanceOf(D);
    const tombstoned = await replaceDoc(D, 'post', Pt, { deleted: true, hashtag: 'mproof' });
    const tombCost = tombBefore - (await balanceOf(D));
    const tomb = plain(await sdk.documents.get(contractId, 'post', Pt));
    check(`M-tb5 the tombstone lands (deleted, hashtag kept, no content; cost ${tombCost} credits)`, tombstoned.ok && tomb.deleted === true && tomb.hashtag === 'mproof' && tomb.content === undefined, `${tombstoned.error ?? ''} ${JSON.stringify({ deleted: tomb.deleted, hashtag: tomb.hashtag, content: tomb.content ?? null })}`);
    refusedWith('M-tb6 a tombstone cannot be undone (40128: deleted frozen once set)', await replaceDoc(D, 'post', Pt, { content: 'back', hashtag: 'mproof' }), IMMUTABLE);
    refusedWith('M-tb7 nor refilled while flagged (10422)', await replaceDoc(D, 'post', Pt, { deleted: true, content: 'back', hashtag: 'mproof' }), BLANK);
    await attempt('M-tb8', () => Promise.all([sdk.documents.get(contractId, 'reply', Rt), count('reply', [['rootPostId', '==', Pt]])]), ([reply, n]) => check('M-tb8 the reply under the tombstoned post stays, counted', reply !== null && total(n) === 1, JSON.stringify(countEntries(n))));
    refusedWith('M-tb9 a reply edit without the flag is refused (40128)', await replaceDoc(D, 'reply', Rt, { content: 'edited', rootPostId: id(Pt), parentOwnerId: id(D.ownerId) }), IMMUTABLE);
    refusedWith('M-tb10 a reply tombstone that drops its thread root is refused (40128: the linkage is frozen)', await replaceDoc(D, 'reply', Rt, { deleted: true, parentOwnerId: id(D.ownerId) }), /\bcode"?\s*[=:]\s*(40128|10101)\b|immutable|required/i);
    const replyTomb = await replaceDoc(D, 'reply', Rt, { deleted: true, rootPostId: id(Pt), parentOwnerId: id(D.ownerId) });
    const rt = plain(await sdk.documents.get(contractId, 'reply', Rt));
    check('M-tb11 the reply tombstone lands, its linkage kept (the thread keeps its shape)', replyTomb.ok && rt.deleted === true && rt.content === undefined && toBase58(rt.rootPostId) === Pt, `${replyTomb.error ?? ''}`);

    // (rp) undo and redo a repost: B's bare repost q2 of T2.
    const repostsOfT2 = async () => total(await count('post', [['quotedPostId', '==', T2]]));
    const before = await repostsOfT2();
    const undo = await replaceDoc(B, 'post', q2, { deleted: true });
    await attempt('M-rp1', async () => ({ n: await repostsOfT2(), own: ids(await sdk.documents.query(q('post', { where: [['$ownerId', '==', B.ownerId], ['quotedPostId', 'in', [T2]]], orderBy: [['$ownerId', 'asc'], ['quotedPostId', 'asc']], limit: 1 }))) }),
      ({ n, own }) => check('M-rp1 B undoes its repost of T2 with a tombstone: the quote is cleared, the count drops by one and B\'s own-repost read finds nothing', undo.ok && n === before - 1 && own.length === 0, `${undo.error ?? ''} count ${before} → ${n}, own ${JSON.stringify(own)}`));
    const redo = await create(B, 'post', { quotedPostId: id(T2), quotedPostOwnerId: id(A.ownerId) });
    await sleep(SETTLE_MS);
    await attempt('M-rp2', repostsOfT2, (n) => check('M-rp2 …and reposts T2 again: the one-repost slot is free (no 40105), the count is back', redo.ok && n === before, `${redo.error ?? ''} count ${n}`));
    const third = await create(B, 'post', { quotedPostId: id(T2), quotedPostOwnerId: id(A.ownerId) });
    check('M-rp3 a second live repost is still refused (40105)', !third.ok && DUPLICATE_UNIQUE.test(third.error ?? ''), (third.error ?? 'ACCEPTED').slice(0, 160));

    // (mr) a moderator-removed post: its like, reply and quote stay valid and counted; the hashtag ranking keeps it.
    const Pm = await mustCreate('Pm (D, #mremoved)', D, 'post', { content: 'to be removed', hashtag: 'mremoved' });
    await likeWrite(B, 'like', { postId: id(Pm), postAuthor: id(D.ownerId), hashtag: 'mremoved' });
    const Rm = await mustCreate('Rm (C replies to Pm)', C, 'reply', { content: 'reply to removed', rootPostId: id(Pm), parentOwnerId: id(D.ownerId) });
    const Qm = await mustCreate('Qm (C quotes Pm)', C, 'post', { content: 'quote of removed', quotedPostId: id(Pm), quotedPostOwnerId: id(D.ownerId) });
    await sleep(SETTLE_MS);
    const moderatorA = { identity: await sdk.identities.fetch(A.ownerId), signer: A.signer };
    await attempt('M-mr1', () => sdk.contracts.moderatorDeleteDocument({ ...moderatorA, contractId, documentTypeName: 'post', documentId: Pm, reason: { text: 'M-mr proof' } }), (record) => check('M-mr1 the interim owner removes Pm; the record keeps its hashtag', record?.keptFields?.hashtag === 'mremoved', JSON.stringify(record?.keptFields ?? null, (k, v) => (typeof v === 'bigint' ? String(v) : v))), { idempotent: false });
    await sleep(SETTLE_MS);
    await attempt('M-mr2', () => Promise.all([sdk.documents.get(contractId, 'post', Pm), count('like', [['postId', '==', Pm]]), sdk.documents.get(contractId, 'reply', Rm), count('reply', [['rootPostId', '==', Pm]]), sdk.documents.get(contractId, 'post', Qm), count('post', [['quotedPostId', '==', Pm]])]),
      ([post, likes, reply, replies, quote, quotes]) => check('M-mr2 Pm is gone, but its like (1), its reply (1) and its quote (1) stay, readable and counted', !post && total(likes) === 1 && reply !== null && total(replies) === 1 && quote !== null && total(quotes) === 1, `post ${post ? 'still fetches' : 'gone'}, likes ${total(likes)} replies ${total(replies)} quotes ${total(quotes)}`));
    await attempt('M-mr3', () => rankedRaw([['hashtag', '==', 'mremoved']], 'postId'), (r) => check('M-mr3 the hashtag ranking (byHashtagPost, keyed by the kept hashtag) still lists the removed post at 1', entriesOf(r).some(([k, v]) => k === Pm && v === 1), JSON.stringify(entriesOf(r))));
    await likeWrite(C, 'like', { postId: id(Pm), postAuthor: id(D.ownerId), hashtag: 'mremoved' });
    await sleep(SETTLE_MS);
    const lateReply = await create(C, 'reply', { content: 'late reply', rootPostId: id(Pm), parentOwnerId: id(D.ownerId) });
    const likesNow = total(await withReconnect(() => count('like', [['postId', '==', Pm]])));
    check('M-mr4 after the removal a new like of the post does not land, and a new reply to it is refused', likesNow === 1 && !lateReply.ok, `likes ${likesNow}; reply ${lateReply.ok ? 'ACCEPTED' : (lateReply.error ?? '').slice(0, 140)}`);
    const qTomb = await replaceDoc(C, 'post', Qm, { deleted: true });
    const rTomb = await replaceDoc(C, 'reply', Rm, { deleted: true, rootPostId: id(Pm), parentOwnerId: id(D.ownerId) });
    check('M-mr5 a quote of the removed post and a reply under it can still be tombstoned by their authors (the references resolve to the removal record)', qTomb.ok && rTomb.ok, `${qTomb.error ?? ''} ${rTomb.error ?? ''}`.slice(0, 200));
  }
  if (v11) await proveDesignM();

  // ---- rm: reply mentions (written last, so no earlier count moves) ----
  console.log('\n--- rm. a reply names one mentioned identity ---');
  await attempt('rm1', async () => {
    const rm1 = await mustCreate('rm1 (C replies to T3 mentioning B)', C, 'reply', { content: 'reply @b', rootPostId: id(T3), parentOwnerId: id(A.ownerId), mentionedUserId: id(B.ownerId) });
    await sleep(SETTLE_MS);
    const mentions = { where: [['mentionedUserId', '==', B.ownerId], ['$createdAt', '>', 0]], orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'desc']], limit: 100 };
    const [replies, bundle] = await Promise.all([
      sdk.documents.query(q('reply', mentions)),
      sdk.documents.composite({ dataContractId: contractId, documentType: 'follow', where: [['followingId', '==', A.ownerId], ['$createdAt', '>', 0]], orderBy: [['followingId', 'asc'], ['$createdAt', 'desc']], limit: 100,
        subQueries: [{ documentType: 'post', ...mentions }, { documentType: 'reply', ...mentions },
          { documentType: 'followRequest', where: [['targetId', '==', B.ownerId], ['$createdAt', '>', 0]], orderBy: [['targetId', 'asc'], ['$createdAt', 'desc']], limit: 100 }] }),
    ]);
    return { rm1, replies: ids(replies), posts: bundle.subResults[0].documents.map(idOf), bundled: bundle.subResults[1].documents.map(idOf) };
  }, ({ rm1, replies, posts, bundled }) => check('rm1 B\'s mentions: the reply (reply.mentionedUserAndTime) and the post m1, alone and as siblings of the full permanent bundle (follows page, post and reply mentions, follow requests)', same(replies, [rm1]) && same(bundled, [rm1]) && same(posts, [m1]), `replies ${JSON.stringify(replies)} bundled ${JSON.stringify(bundled)} posts ${JSON.stringify(posts)}`));

  if (v11) {
    const state = await proveRemovalRecordsAndWindow();
    const stateFile = args.stateFile ?? defaultStateFile(contractId);
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`\nsettled targets for --team-proof written to ${stateFile}`);
  }

  console.log(`\nthrowaway contract ${contractId}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

// ---- Phase 2: the seated team (v11 deleteWithin + deleteSettled) -------------

async function proveTeam(sdk, args, actors, source) {
  const contractId = args.teamProof;
  const [A, B, C, D] = actors;
  session.contracts.add(contractId);
  await sdk.contracts.fetch(contractId);
  const reason = (text) => ({ text, reasonDocumentId: args.reasonDoc });
  const asModerator = async (who) => ({ identity: await sdk.identities.fetch(who.ownerId), signer: who.signer });
  const sameSet = (got, expected) => got.length === expected.length && expected.every((x) => got.includes(x));
  const bigintSafe = (value) => JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  const rule = source.documentSchemas.post.moderatorAbilities.deleteSettled;
  const maxAdded = source.config.moderation.moderators.maxAddedModerators ?? 0;

  console.log('\n--- tm. the seated team deletes settled documents together ---');
  const team = await sdk.moderationCharters.team(contractId);
  if (!team) throw new Error('no seated team on the throwaway contract: run the election first');
  const leaderId = toBase58(team.leaderId);
  const memberIds = team.members.map(toBase58);
  const byId = new Map([A, B, C, D].map((who) => [who.ownerId, who]));
  const L = byId.get(leaderId);
  const [M1, M2] = memberIds.map((member) => byId.get(member)).filter(Boolean);
  if (!L || !M1 || !M2) throw new Error(`the team (leader ${leaderId}, members ${memberIds.join(', ')}) must be three of A, B, C`);
  const seats = team.seats(maxAdded);
  const needed = Math.min(rule.approvals, seats);
  check(`tm-1 a seated team: leader ${L.label}, members ${M1.label} and ${M2.label}; seats(${maxAdded}) = ${seats}, so a settled deletion needs min(${rule.approvals}, ${seats}) = ${needed} approvals, the leader's among them; D is not on it`,
    memberIds.length === 2 && team.electedMembers.length === 2 && needed === 3 && rule.leader === true && !team.contains(D.ownerId), `elected ${bigintSafe(team.electedMembers.map(toBase58))}`);

  // Fresh targets by D, so this phase can run again: a tagged post, a thread root and a reply to it, left to settle.
  const fixture = async (label, docType, data) => {
    const outcome = await createDocument(contractId, D, docType, data);
    if (!outcome.ok) throw new Error(`fixture write ${label} failed: ${(outcome.error ?? '').slice(0, 300)}`);
    return outcome.id;
  };
  const writtenAt = Date.now();
  const state = { S1: await fixture('S1', 'post', { content: 'settle one', hashtag: 'settle' }), SR: await fixture('SR', 'post', { content: 'thread root' }) };
  state.S3 = await fixture('S3', 'reply', { content: 'settle reply', rootPostId: bs58.decode(state.SR), parentOwnerId: bs58.decode(D.ownerId) });
  const windowSeconds = source.documentSchemas.post.moderatorAbilities.deleteWithin;
  const settledAt = writtenAt + (windowSeconds + 30) * 1000;
  console.log(`     D wrote S1 ${state.S1}, SR ${state.SR}, S3 ${state.S3}; waiting ${Math.ceil((settledAt - Date.now()) / 1000)} s for them to settle (deleteWithin ${windowSeconds} s)`);
  await sleep(Math.max(0, settledAt - Date.now()));

  // Action counts reset only when the moderators pot pays out, so they are compared as deltas from here.
  const actionCounts = async () => Object.fromEntries((await sdk.contracts.moderationActionCounts(contractId)).counts.map((c) => [toBase58(c.identityId), Number(c.count)]));
  const countsBefore = await withReconnect(actionCounts);
  const countDeltas = async () => {
    const now = await actionCounts();
    return Object.fromEntries([L, M1, M2].map((who) => [who.label, (now[who.ownerId] ?? 0) - (countsBefore[who.ownerId] ?? 0)]));
  };
  const S1doc = await sdk.documents.get(contractId, 'post', state.S1);
  await expectCode('tm-2 a member\'s lone delete of the settled S1 is refused', '41116', async () => sdk.contracts.moderatorDeleteDocument({ ...(await asModerator(M1)), contractId, documentTypeName: 'post', documentId: state.S1, reason: reason('tm-2') }));
  let actionId = null;
  await attempt('tm-3', async () => sdk.contracts.moderatorDeleteSettledDocument({ ...(await asModerator(M1)), contractId, documentTypeName: 'post', documentId: state.S1, reason: reason('tm-3 proof: settled post') }), (result) => {
    actionId = toBase58(result.actionId);
    check(`tm-3 ${M1.label} proposes deleting S1: an active action (its own approval)`, result.status === 'active', `${actionId} ${result.status}`);
  }, { idempotent: false });
  if (!actionId) return;
  // A read right after a write can reach a node a block behind: retry briefly before calling it absent.
  const settled = async (read, ok) => {
    let value = await withReconnect(read);
    for (let tries = 0; !ok(value) && tries < 4; tries++) { await sleep(SETTLE_MS); value = await withReconnect(read); }
    return value;
  };
  const findAction = async (status, until = (action) => action !== null) => settled(async () => (await sdk.contracts.teamActions({ contractId, status, limit: 100 })).actions.find((a) => a.actionId === actionId) ?? null, until);
  const signersOf = async (status, count) => settled(async () => (await sdk.contracts.teamActionSigners({ contractId, status, actionId })).signerIds.map(toBase58), (signers) => signers.length === count);
  await attempt('tm-4', () => Promise.all([findAction('active'), signersOf('active', 1)]), ([action, signers]) => check('tm-4 teamActions(active) lists it with approvalCount 1 and its proposer; teamActionSigners = the proposer',
    action?.approvalCount === 1 && action.proposerId === M1.ownerId && same(signers, [M1.ownerId]), `${bigintSafe(action)} signers ${JSON.stringify(signers)}`));
  await expectCode('tm-5 the proposer approving its own action again is refused', '41208', async () => sdk.contracts.moderatorApproveTeamAction({ ...(await asModerator(M1)), contractId, actionId }));
  await attempt('tm-6', async () => {
    const result = await sdk.contracts.moderatorApproveTeamAction({ ...(await asModerator(M2)), contractId, actionId });
    return { result, action: await findAction('active', (action) => action?.approvalCount === 2), exists: Boolean(await sdk.documents.get(contractId, 'post', state.S1)) };
  }, ({ result, action, exists }) => check(`tm-6 ${M2.label} approves: 2 of 3, still active (the leader has not approved), S1 still there`, result.status === 'active' && action?.approvalCount === 2 && exists, `${result.status} ${bigintSafe(action)} exists ${exists}`), { idempotent: false });
  await attempt('tm-7', async () => {
    const result = await sdk.contracts.moderatorApproveTeamAction({ ...(await asModerator(L)), contractId, actionId });
    await sleep(SETTLE_MS);
    return { result, closed: await findAction('closed'), active: await findAction('active', (action) => action === null), signers: await signersOf('closed', 3), exists: Boolean(await sdk.documents.get(contractId, 'post', state.S1)) };
  }, ({ result, closed, active, signers, exists }) => check('tm-7 the leader approves: the action runs and closes with 3 approvals, all three signers listed, and S1 is deleted',
    result.status === 'closed' && closed?.approvalCount === 3 && active === null && sameSet(signers, [L.ownerId, M1.ownerId, M2.ownerId]) && !exists, `${result.status} ${bigintSafe(closed)} signers ${JSON.stringify(signers)} exists ${exists}`), { idempotent: false });
  await attempt('tm-8', () => sdk.contracts.documentRemovals({ contractId, documentTypeName: 'post', documentIds: [state.S1] }), (page) => {
    const entry = page.removals[0];
    check('tm-8 S1\'s removal record: deleted by the approval that met the rule (the leader), with the proposal\'s reason, keeping hashtag "settle" and $createdAt',
      entry?.moderatorId === L.ownerId && entry.reason?.reasonDocumentId === args.reasonDoc && entry.keptFields?.hashtag === 'settle' && Number(entry.keptFields?.$createdAt) === createdAtOf(S1doc), bigintSafe(entry));
  });
  await expectCode('tm-9 a team deletion cannot be restored, not even by the leader', '41209', async () => sdk.contracts.moderatorRestoreDocument({ ...(await asModerator(L)), contractId, documentTypeName: 'post', document: S1doc }));
  await attempt('tm-10', countDeltas, (delta) => check('tm-10 moderationActionCounts: the deletion counts once for each of the three approvers (+1 each since this phase began)', delta[L.label] === 1 && delta[M1.label] === 1 && delta[M2.label] === 1, JSON.stringify(delta)));

  const F1 = await (async () => {
    const { document } = buildDocument({ contractId, docType: 'post', ownerId: D.ownerId, data: { content: 'fresh', hashtag: 'fresh' }, entropy: randomIdBytes() });
    return createdId(await sdk.documents.create({ document, identityKey: D.identityKey, signer: D.signer }));
  })();
  await expectCode('tm-11a a proposal for D\'s fresh F1 (inside the window) is refused: use a lone delete', '41206', async () => sdk.contracts.moderatorDeleteSettledDocument({ ...(await asModerator(L)), contractId, documentTypeName: 'post', documentId: F1, reason: reason('tm-11a') }));
  await attempt('tm-11b', async () => sdk.contracts.moderatorDeleteDocument({ ...(await asModerator(M2)), contractId, documentTypeName: 'post', documentId: F1, reason: reason('tm-11b proof') }), (record) => check(`tm-11b inside the window ${M2.label} deletes F1 alone; the record keeps hashtag "fresh"`, record?.keptFields?.hashtag === 'fresh', bigintSafe(record?.keptFields)), { idempotent: false });

  let replyAction = null;
  await attempt('tm-12', async () => {
    const proposal = await sdk.contracts.moderatorDeleteSettledDocument({ ...(await asModerator(L)), contractId, documentTypeName: 'reply', documentId: state.S3, reason: reason('tm-12 proof: settled reply') });
    replyAction = toBase58(proposal.actionId);
    const first = await sdk.contracts.moderatorApproveTeamAction({ ...(await asModerator(M1)), contractId, actionId: replyAction });
    const last = await sdk.contracts.moderatorApproveTeamAction({ ...(await asModerator(M2)), contractId, actionId: replyAction });
    await sleep(SETTLE_MS);
    const page = await sdk.contracts.documentRemovals({ contractId, documentTypeName: 'reply', documentIds: [state.S3] });
    return { statuses: [proposal.status, first.status, last.status], entry: page.removals[0] };
  }, ({ statuses, entry }) => check('tm-12 a settled reply: the leader proposes, two members approve (active, active, closed); the record keeps rootPostId SR and $createdAt',
    same(statuses, ['active', 'active', 'closed']) && toBase58(entry?.keptFields?.rootPostId) === state.SR && Number(entry?.keptFields?.$createdAt) > 0 && entry?.moderatorId === M2.ownerId, `${JSON.stringify(statuses)} ${bigintSafe(entry?.keptFields)}`), { idempotent: false });
  await attempt('tm-13', countDeltas, (delta) => check('tm-13 the counts since this phase began: the leader +2, the first member +2, the second member +3 (two approvals and a lone delete)',
    delta[L.label] === 2 && delta[M1.label] === 2 && delta[M2.label] === 3, JSON.stringify(delta)));
  await expectCode('tm-14 approving a closed action is refused', '41210', async () => sdk.contracts.moderatorApproveTeamAction({ ...(await asModerator(M2)), contractId, actionId }));

  await proveAddedMember({ sdk, args, contractId, team, actors: { L, M1, M2, D }, rule, reason, asModerator, fixture, windowSeconds, settled });
}

/**
 * tm-15–tm-22 (platform#5260, optional): with `deleteSettled` needing more than one approval
 * and `approversPredateDocument` on (its default then), a member the LEADER added
 * (`addedModerator`) counts only for documents created after its addition; the leader and the
 * elected members always count. Needs `--added-member`, an identity that filed a join request
 * for the seated team's submitted charter (in the charter window, with the election tooling:
 * an `addedModerator` names a join request, and a join request needs bound encryption keys).
 * The leader adds it, and takes it off again at the end, so the phase can run again.
 */
async function proveAddedMember({ sdk, args, contractId, team, actors: { L, M1, M2, D }, rule, reason, asModerator, fixture, windowSeconds, settled }) {
  console.log('\n--- tm-15. #5260: a member the leader added counts only for documents created after its addition ---');
  if (!args.addedMember) {
    console.log('SKIP  tm-15–tm-22: pass --added-member <n[:id]>, an identity with a join request for this team\'s submitted charter, to prove a late-added member is refused (41212)');
    return;
  }
  // The checks below count three approvals with the leader's among them (v11/v12's rule).
  if (!(rule.approvals === 3 && rule.leader === true && rule.approversPredateDocument !== false)) {
    console.log(`SKIP  tm-15–tm-22: they assume post's deleteSettled { leader: true, approvals: 3 } dating added members; this cut declares ${JSON.stringify(rule)}`);
    return;
  }
  const E = await resolveActor(sdk, args.addedMember, 'E');
  if ([L, M1, M2, D].some((who) => who.ownerId === E.ownerId)) throw new Error('--added-member must be an identity other than A, B, C and D');
  session.contracts.add(MODERATION_CHARTERS_CONTRACT_ID);
  await sdk.contracts.fetch(MODERATION_CHARTERS_CONTRACT_ID);
  const charters = (documentTypeName, where) => sdk.documents.query({ dataContractId: MODERATION_CHARTERS_CONTRACT_ID, documentTypeName, where, limit: 1 });
  const [electedCharterId, submittedCharterId] = [team.electedCharterId, team.submittedCharterId].map(toBase58);
  const joined = docsOf(await withReconnect(() => charters('joinRequest', [['submittedCharterId', '==', submittedCharterId], ['$ownerId', '==', E.ownerId]])));
  if (joined.length === 0) {
    console.log(`SKIP  tm-15–tm-22: ${E.ownerId} filed no join request for the submitted charter ${submittedCharterId}; the leader can only add an identity that did`);
    return;
  }
  const additionOf = async () => docsOf(await withReconnect(() => charters('addedModerator', [['electedCharterId', '==', electedCharterId], ['memberId', '==', E.ownerId]])))[0] ?? null;
  const takeOff = (addition) => sdk.documents.delete({ document: { id: idOf(addition), ownerId: L.ownerId, dataContractId: MODERATION_CHARTERS_CONTRACT_ID, documentTypeName: 'addedModerator' }, identityKey: L.identityKey, signer: L.signer });
  // A previous run's addition predates this run's documents, which would let E count: take it off first.
  const stale = await additionOf();
  if (stale) {
    const error = await takeOff(stale).then(() => null, (e) => describeErr(e));
    if (error) { check('tm-15 a previous run\'s addition of E is taken off first', false, error.slice(0, 200)); return; }
    await sleep(SETTLE_MS);
  }

  const before = await fixture('S5 (D, before E is added)', 'post', { content: 'written before the addition' });
  await sleep(SETTLE_MS);
  const approve = async (who, actionId) => sdk.contracts.moderatorApproveTeamAction({ ...(await asModerator(who)), contractId, actionId });
  const propose = async (who, documentId, text) => sdk.contracts.moderatorDeleteSettledDocument({ ...(await asModerator(who)), contractId, documentTypeName: 'post', documentId, reason: reason(text) });
  const exists = async (documentId) => Boolean(await withReconnect(() => sdk.documents.get(contractId, 'post', documentId)));
  try {
    // Inside the try: a create whose confirmation faulted may still have landed (its readback
    // looks by $ownerId, which addedModerator does not index), and the finally takes it off.
    const added = await createDocument(MODERATION_CHARTERS_CONTRACT_ID, L, 'addedModerator', { electedCharterId: bs58.decode(electedCharterId), submittedCharterId: bs58.decode(submittedCharterId), memberId: bs58.decode(E.ownerId) });
    if (!added.ok) { check('tm-15 the leader adds E (addedModerator)', false, (added.error ?? '').slice(0, 200)); return; }
    await sleep(SETTLE_MS);
    const after = await fixture('S6 (D, after E was added)', 'post', { content: 'written after the addition' });
    const createdAt = async (dataContractId, docType, docId) => createdAtOf(await withReconnect(() => sdk.documents.get(dataContractId, docType, docId)));
    const [beforeAt, additionAt, afterAt] = [await createdAt(contractId, 'post', before), await createdAt(MODERATION_CHARTERS_CONTRACT_ID, 'addedModerator', added.id), await createdAt(contractId, 'post', after)];
    const seated = await withReconnect(() => sdk.moderationCharters.team(contractId));
    check('tm-15 the leader adds E: E is on the team but not elected; S5 predates the addition and S6 follows it (strictly, in block time)',
      seated?.contains(E.ownerId) && !seated.electedMembers.map(toBase58).includes(E.ownerId) && beforeAt < additionAt && additionAt < afterAt, `S5 ${beforeAt} addition ${additionAt} S6 ${afterAt}`);
    const settledAt = afterAt + (windowSeconds + 30) * 1000;
    console.log(`     waiting ${Math.max(0, Math.ceil((settledAt - Date.now()) / 1000))} s for S5 and S6 to settle (deleteWithin ${windowSeconds} s)`);
    await sleep(Math.max(0, settledAt - Date.now()));

    await expectCode('tm-16 E proposing the settled deletion of S5, written before E was added, is refused', '41212', () => propose(E, before, 'tm-16'));
    let action = null;
    await attempt('tm-17', () => propose(M1, before, 'tm-17 proof: settled before the addition'), (result) => {
      action = toBase58(result.actionId);
      check(`tm-17 ${M1.label} (elected) proposes S5 instead: an active action`, result.status === 'active', `${action} ${result.status}`);
    }, { idempotent: false });
    if (action) {
      await expectCode('tm-18 E approving that proposal is refused too', '41212', () => approve(E, action));
      await attempt('tm-19', async () => {
        const statuses = [(await approve(M2, action)).status, (await approve(L, action)).status];
        await sleep(SETTLE_MS);
        return { statuses, gone: !(await exists(before)) };
      }, ({ statuses, gone }) => check(`tm-19 ${M2.label} (elected) and the leader complete it (active, closed): the rule is not lowered for E, and the elected members count for S5`, same(statuses, ['active', 'closed']) && gone, `${JSON.stringify(statuses)} S5 ${gone ? 'deleted' : 'still there'}`), { idempotent: false });
    }
    let late = null;
    await attempt('tm-20', () => propose(E, after, 'tm-20 proof: settled after the addition'), (result) => {
      late = toBase58(result.actionId);
      check('tm-20 E proposes S6, written after its addition: accepted, its own approval counted (active)', result.status === 'active', `${late} ${result.status}`);
    }, { idempotent: false });
    if (late) {
      await attempt('tm-21', async () => {
        const statuses = [(await approve(L, late)).status, (await approve(M1, late)).status];
        await sleep(SETTLE_MS);
        const closed = await settled(async () => (await sdk.contracts.teamActions({ contractId, status: 'closed', limit: 100 })).actions.find((a) => a.actionId === late) ?? null, (a) => a !== null);
        return { statuses, closed, gone: !(await exists(after)) };
      }, ({ statuses, closed, gone }) => check('tm-21 the leader and a member complete it: closed with 3 approvals, E\'s among them, and S6 is deleted', same(statuses, ['active', 'closed']) && closed?.approvalCount === 3 && gone, `${JSON.stringify(statuses)} approvals ${closed?.approvalCount} S6 ${gone ? 'deleted' : 'still there'}`), { idempotent: false });
    }
  } finally {
    const addition = await additionOf().catch(() => null);
    const removed = addition ? await takeOff(addition).then(() => null, (e) => describeErr(e)) : null;
    if (removed) console.log(`     E MAY STILL BE ON THE TEAM: the leader's delete of its addedModerator ${idOf(addition)} failed; tm-1 of a later run fails until it is deleted`);
    await sleep(SETTLE_MS);
    const teamAfter = await withReconnect(() => sdk.moderationCharters.team(contractId)).catch(() => null);
    check('tm-22 the leader takes E off again (deletes the addition): the team no longer contains E', removed === null && teamAfter !== null && !teamAfter.contains(E.ownerId), removed ?? '');
  }
}

function defaultStateFile(contractId) {
  return join(tmpdir(), `prove-social-v11-${contractId}.json`);
}

/** A write expected to be refused with consensus `code`; any other outcome FAILs. */
async function expectCode(label, code, run) {
  try {
    await withReconnect(run);
    check(`${label} (${code})`, false, 'accepted');
  } catch (e) {
    const detail = describeErr(e);
    check(`${label} (${code})`, new RegExp(`\\b${code}\\b`).test(detail), detail.slice(0, 200));
  }
}

main().then((code) => process.exit(code), (e) => {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
});
