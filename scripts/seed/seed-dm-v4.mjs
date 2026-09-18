/**
 * Seeds REALISTIC direct-message traffic onto the **DM v4 contract**
 * (`contracts/yappr-dm-contract-v4.json`, docs/DM_V4.md) so the /devnet
 * deployment's Messages page has something lived-in to show.
 *
 * This is NOT the registration-day battery (scripts/verify-dm-v4.mjs). The
 * battery writes random bytes because it is testing the CONTRACT; this script
 * writes ciphertext the deployed app can actually DECRYPT, because it is
 * producing content a human will read. It therefore has to reproduce
 * `lib/message-encryption.ts` and the key-selection rules in
 * `lib/services/direct-message-service.ts` exactly:
 *
 *   conversationId = SHA-256("<lowerId>:<higherId>").slice(0, 10)      (sorted pair)
 *   aesKey         = HKDF-SHA256(ECDH_x(myPriv, theirPub),
 *                                salt "yappr-dm-v1", info "aes-key")
 *   encryptedContent = iv(12) || AES-256-GCM(aesKey, utf8(text))
 *
 * WHICH KEY DOES THE ECDH USE? The field to read is
 * `DirectMessageService.getPublicKeyFromIdentity`: it picks the identity's
 * **HIGH-security AUTHENTICATION secp256k1** key — NOT the `encryption`-purpose
 * key. In the seed identity layout (`IDENTITY_KEY_ROLES` in seed-lib.mjs) that
 * is **key id 2**; key 4 (encryption/medium) is never consulted by the DM path.
 * So every message here is sealed with key 2 on both sides, and the script
 * refuses to write anything until it has confirmed, against the ON-CHAIN
 * identity, that the app's own selection rule lands on the same key.
 *
 * Consequence for whoever demos this: log in as a persona with its **key 2
 * (authentication / HIGH)** WIF. Signing accepts CRITICAL or HIGH
 * (`state-transition-service.ts`), but decryption only works with the key the
 * other side encrypted to, and that is the HIGH one.
 *
 * Invites are written the way the app writes them, not the way the schema
 * merely allows: `sendMessage` creates the sender's own `conversationInvite`
 * the first time it finds none, so a genuine two-way exchange ends up with an
 * invite in BOTH directions — that is what is seeded. `senderPubKey` is
 * omitted exactly when `identityUsesHash160` would say to omit it (it always
 * does here: these identities carry a full secp256k1 point at HIGH).
 *
 * Read receipts are the other half of "lived-in": `$updatedAt` IS the
 * last-read timestamp, and there is no way to backdate it, so a conversation
 * that should show unread gets its reader's receipt written PART-WAY through
 * the dialogue and the rest of the messages land after it. Conversations that
 * should show zero get both receipts written after the final message.
 *
 * Run:
 *   NETWORK=devnet node scripts/seed/seed-dm-v4.mjs [--contract <id>]
 *   NETWORK=devnet node scripts/seed/seed-dm-v4.mjs --dry-run
 *   NETWORK=devnet node scripts/seed/seed-dm-v4.mjs --verify-only
 *   NETWORK=devnet node scripts/seed/seed-dm-v4.mjs --verify-only --prune-foreign
 *
 * Deterministic: the dialogue bank is fixed, the scenario draw comes from a
 * seeded PRNG (`--seed`), and every document id is derived from a SHA-256 of
 * its coordinates rather than random entropy. Idempotent and resumable: the
 * journal is `.seed-dm.local.json`, but correctness does not depend on it —
 * a retry rebuilds a byte-identical id, so a write that already landed simply
 * reads back. Per-actor writes are strictly sequential (identity nonce);
 * conversations run in parallel behind a semaphore.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { IdentitySigner, ensureInitialized } from '@dashevo/evo-sdk';
import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import {
  CRITICAL_AUTH_KEY_ID,
  NONCE_DESYNC,
  REPO_ROOT,
  RETRYABLE,
  TRANSPORT_COLLAPSE,
  WAIT_MAYBE_LANDED,
  buildDocument,
  createSdkHandle,
  describeErr,
  ledgerEntry,
  loadLedger,
  network,
  readEnvFile,
  readback,
  sleep,
  wifFromHex,
} from './seed-lib.mjs';

// ---- Constants mirrored from the client ---------------------------------------

/** `lib/message-encryption.ts`: HKDF salt/info for the DM AES key. */
const DM_KDF_SALT = new TextEncoder().encode('yappr-dm-v1');
const DM_KDF_INFO = new TextEncoder().encode('aes-key');
/** `lib/crypto/aes-gcm.ts`: the IV is prepended to the ciphertext. */
const AES_GCM_IV_LENGTH = 12;
/**
 * The identity key the DM path does ECDH with. `getPublicKeyFromIdentity`
 * resolves purpose=AUTHENTICATION(0) + securityLevel=HIGH(2) +
 * type=ECDSA_SECP256K1(0), which is key id 2 in the seed layout.
 */
const DM_ECDH_KEY_ID = 2;
const KEY_PURPOSE_AUTHENTICATION = 0;
const KEY_SECURITY_LEVEL_HIGH = 2;
const KEY_TYPE_ECDSA_SECP256K1 = 0;

const STATE_FILE = join(REPO_ROOT, '.seed-dm.local.json');
const SDK_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
/** Reads settle behind the write quorum. */
const SETTLE_MS = 3_000;
const SETTLE_POLLS = 3;
/**
 * Extra pause after a MID-conversation read receipt. `$updatedAt` and the next
 * message's `$createdAt` are both block times; if they collide, the message
 * the receipt was supposed to precede stops counting as unread. One block of
 * daylight is cheap insurance for the only number this script is trying to
 * make non-zero.
 */
const RECEIPT_GAP_MS = 6_000;
/** Parallel unread-count reads during verification (matches the client's pool). */
const VERIFY_CONCURRENCY = 6;

// ---- Actors -------------------------------------------------------------------
//
// Three personas left over from the v4 battery plus five provisioned for this
// script (scripts/seed/personas.dm.json). The graph below is deliberately
// lopsided: `chatty-cal3` talks to six people, `quiet-quinn7` to exactly one.

const ACTORS = [220, 221, 222, 290, 291, 292, 293, 294];

// ---- Dialogue bank -------------------------------------------------------------
//
// One hand-written dialogue per pair, so voices match the personas rather than
// being shuffled into someone else's mouth. `a` is the lower persona index of
// the pair, `b` the higher; `turns` alternate only as often as real chat does
// (people double- and triple-text). Lengths run 9–40 messages.

/** `t(who, text)` — a single turn. `who` is 'a' or 'b'. */
const t = (who, text) => ({ who, text });

const DIALOGUES = [
  {
    pair: [220, 290], // dm-dana4 ↔ chatty-cal3 — repair café logistics
    turns: [
      t('b', 'ok so the repair café is ON 🎉'),
      t('b', 'church basement said yes, first saturday of the month, we just have to be out by 3'),
      t('a', 'that is genuinely great news. how many tables do we get?'),
      t('b', 'six! plus the little one by the door for signups'),
      t('a', 'Six is enough for four stations and a queue. Electronics, textiles, bikes, sharpening?'),
      t('b', 'yes exactly that'),
      t('b', 'although bikes might need to be outside, last time someone got chain oil on the carpet and i am still hearing about it'),
      t('a', 'outside it is. weather permitting, which in march means never'),
      t('b', '😂 pessimist'),
      t('a', 'realist. i will bring the pop-up canopy just in case'),
      t('b', 'you are a treasure'),
      t('b', 'do you still have the soldering irons from the library thing?'),
      t('a', 'two of them, and one has a dodgy switch. i can get a third if we have twenty quid'),
      t('b', 'we have twenty quid'),
      t('a', 'we have twenty quid or you personally have twenty quid'),
      t('b', 'the second one but do not tell the treasurer'),
      t('a', 'I am the treasurer.'),
      t('b', 'oh'),
      t('b', 'well then'),
      t('a', 'buy the iron. i will put it through as consumables and we will both pretend that is normal'),
      t('b', 'this is why the repair café works'),
      t('a', 'one more thing. we need a sign-in sheet that actually asks what people brought, otherwise the grant report is guesswork again'),
      t('b', 'ugh you are right'),
      t('b', 'i will make a form tonight. name, item, outcome, and a box for whether they want to learn to do it themselves'),
      t('a', 'that last box is the whole point of the project, put it first'),
      t('b', 'putting it first 🫡'),
    ],
  },
  {
    pair: [221, 290], // dm-eli5 ↔ chatty-cal3 — Cal at volume, Eli at a trickle
    turns: [
      t('b', 'eli!!'),
      t('b', 'are you around this weekend'),
      t('b', 'there is a thing'),
      t('b', 'it is a good thing i promise'),
      t('a', 'what thing'),
      t('b', 'record fair at the old bus depot, saturday 10-4, and my friend has a stall'),
      t('b', 'she has the entire back catalogue of that label you would not shut up about in january'),
      t('a', 'which label'),
      t('b', 'the one with the orange sleeves!!'),
      t('a', 'ah. yes. i will come.'),
      t('b', 'HE SPEAKS'),
      t('a', '10:30. i am not queueing.'),
    ],
  },
  {
    pair: [222, 290], // dm-fay6 ↔ chatty-cal3 — a band, a bad night, a good one
    turns: [
      t('a', 'did you survive the gig'),
      t('b', 'barely!! the monitor died two songs in and i spent the rest of the set lip reading the bass player'),
      t('a', 'how did it sound out front though'),
      t('b', 'apparently fine?? three separate people told me it was the best we have played'),
      t('a', 'so the monitor was the problem all along'),
      t('b', '😭 do not say that'),
      t('a', 'i am saying it'),
      t('b', 'ok but seriously the room was PACKED. like turn-people-away packed'),
      t('a', 'that is the fourth sold out one in a row. you know what that means'),
      t('b', 'that we should charge more?'),
      t('a', 'that you should book a bigger room'),
      t('b', 'the bigger room is £400 and terrifying'),
      t('a', 'you would clear that on the door at your current numbers and you know it'),
      t('b', 'i do know it'),
      t('b', 'i am going to sit with that feeling for a week and then probably do it'),
      t('a', 'that is the correct amount of time to sit with it'),
      t('b', 'come to the next one? i will put you on the list'),
      t('a', 'obviously'),
    ],
  },
  {
    pair: [290, 292], // chatty-cal3 ↔ nora-nights5 — the long one, 40 messages
    turns: [
      t('b', 'you awake'),
      t('a', 'always 😇 what is up'),
      t('b', 'four hours into a twelve and someone brought in a cake for the day shift and left a note saying NIGHTS DO NOT TOUCH'),
      t('a', 'WHAT'),
      t('a', 'that is a war crime'),
      t('b', 'i know'),
      t('b', 'i ate a slice out of principle'),
      t('a', 'as you should. as ANYONE should'),
      t('a', 'how is the ward tonight otherwise'),
      t('b', 'quiet in the way that makes you nervous. two admissions and then nothing for three hours'),
      t('a', 'i hate the quiet ones for you'),
      t('b', 'the quiet ones are fine, it is the quiet ones that end at 4am that get you'),
      t('a', 'ok changing the subject to something nice. the monstera'),
      t('b', 'THE MONSTERA'),
      t('b', 'new leaf unfurled on tuesday and it has a fenestration. a real one. not the sad little slit the last one did'),
      t('a', 'send a photo when you are home i want to see this leaf'),
      t('b', 'i will, it is genuinely the highlight of my month which tells you something about my month'),
      t('a', 'tell me about your month then'),
      t('b', 'nothing bad! just long. i picked up two extra shifts for the trip fund and now i am tired and slightly richer'),
      t('a', 'the trip is still on though?'),
      t('b', 'september, yes. flights booked, accommodation absolutely not'),
      t('a', 'classic'),
      t('b', 'i will do it in august like a normal panicking adult'),
      t('a', 'i can help look, i am unemployable but i am extremely good at finding places with a kitchen near a train station'),
      t('b', 'that is an oddly specific and very useful skill'),
      t('a', 'it is my only one'),
      t('b', 'not true. you are also good at getting forty people to show up somewhere on a tuesday'),
      t('a', 'ok two skills'),
      t('b', 'speaking of which, what happened with the repair café space'),
      t('a', 'we got it!! church basement, first saturday, six tables'),
      t('b', 'cal that is brilliant'),
      t('a', 'i know 🎉 dana is doing the money and i am doing the shouting'),
      t('b', 'a perfect division of labour'),
      t('a', 'you should come, even just to sit and drink tea. you do not have to fix anything'),
      t('b', 'if it is a saturday after a run of nights i will be asleep, but if it lands right i would like that'),
      t('a', 'first saturday of every month, no pressure, ever'),
      t('b', 'ok'),
      t('b', 'genuinely thank you, this shift got a lot shorter'),
      t('a', 'go eat more of that cake'),
      t('b', 'i am going to eat more of that cake 🌿'),
    ],
  },
  {
    pair: [290, 293], // chatty-cal3 ↔ theo-builds8 — commissioning a bench
    turns: [
      t('a', 'theo! question'),
      t('a', 'if i wanted a bench that lives outside and survives about a hundred people sitting on it a month, what am i looking at'),
      t('b', 'Oak or larch. Larch if the budget is real, oak if it is imaginary and you want it to still be there in thirty years.'),
      t('a', 'the budget is community-grant real. so, small but it exists'),
      t('b', 'Then larch, unfinished, and you let it go silver. No stain, nothing to maintain, nothing for anyone to get wrong.'),
      t('a', 'i love a thing with no maintenance'),
      t('b', 'Everything has maintenance. This one just has less of it than the version you were about to ask for.'),
      t('a', '😂 fair'),
      t('a', 'how long to build'),
      t('b', 'Three weekends. Two if you can find me someone to help lift it, it will be about 90 kilos finished.'),
      t('a', 'i can find you six people to lift it, that is the one thing i am reliably good at'),
      t('b', 'Six is four too many. Send two who can follow instructions.'),
      t('a', 'that is a much harder ask than six'),
      t('b', 'I know. Take your time.'),
    ],
  },
  {
    pair: [290, 294], // chatty-cal3 ↔ iris-maps6 — bike lanes and a map
    turns: [
      t('a', 'iris i need a map person and you are the only map person i know'),
      t('b', 'That is how I get most of my work, yes. What are we mapping?'),
      t('a', 'the bike route from the station to the estate. the council says it is continuous. it is not continuous'),
      t('b', 'How not-continuous are we talking?'),
      t('a', 'it stops dead at a roundabout and resumes 200m later on the other side of a dual carriageway'),
      t('b', 'Ah. A "gap of strategic ambiguity". Those are my favourite. 🗺️'),
      t('a', 'can you draw it so a councillor can understand it in four seconds'),
      t('b', 'Yes. The trick is to draw the route as one line and break it exactly where the provision breaks. No legend, no colours beyond two. They will get it instantly and hate it.'),
      t('a', 'that is EXACTLY what i want'),
      t('b', 'Do you have the GPS traces or do I need to ride it?'),
      t('a', 'i have about thirty traces from the group ride last month'),
      t('b', 'Thirty is plenty. Send them as GPX if you can, not screenshots.'),
      t('a', 'they are screenshots'),
      t('b', 'Of course they are.'),
      t('a', 'i will get the gpx 😅'),
      t('b', 'Thank you. One more thing: do you have the date the council claimed it was complete?'),
      t('a', 'march 2023, it is in the cabinet minutes'),
      t('b', 'Good. That goes in the corner in small type. It does more work than anything else on the page.'),
      t('a', 'you are quietly ruthless and i respect it enormously'),
      t('b', 'I make transit maps for a living. Ruthless is the job.'),
      t('a', 'when can you have a draft'),
      t('b', 'Send the GPX tonight and you will have something Thursday.'),
    ],
  },
  {
    pair: [220, 292], // dm-dana4 ↔ nora-nights5 — long friendship thread
    turns: [
      t('a', 'how did the appointment go?'),
      t('b', 'fine! genuinely fine. bloods are normal, she just wants me to sleep during the day like a person'),
      t('a', 'a radical prescription'),
      t('b', 'i told her my job is literally to not do that and she said "yes, i know" in the tone'),
      t('a', 'the tone'),
      t('b', 'THE tone'),
      t('a', 'I am glad it is fine. I have been low key worrying since you mentioned it.'),
      t('b', 'i know you have, that is why i texted the second i got out'),
      t('a', 'appreciated'),
      t('b', 'how is the new place'),
      t('a', 'boxes. so many boxes. i have found the kettle and nothing else'),
      t('b', 'the kettle is the only essential box'),
      t('a', 'this is the correct attitude and also exactly what i said to myself at 11pm last night while eating crackers'),
      t('b', 'crackers for dinner is a recognised moving-in tradition'),
      t('a', 'The light in the front room is unbelievable though. South facing, huge window, I keep just standing in it.'),
      t('b', 'oh you are going to become a plant person'),
      t('a', 'i am not becoming a plant person'),
      t('b', 'you are absolutely becoming a plant person, i have seen this exact sequence four times'),
      t('a', 'what would you even put there'),
      t('b', 'AND SO IT BEGINS'),
      t('a', '😂'),
      t('b', 'ok genuinely: a rubber plant, because it is impossible to kill, and a pilea because it makes babies and you can give them away and feel generous'),
      t('a', 'the second one is very much my personality, yes'),
      t('b', 'i will bring you a pilea baby. i have six and they are getting aggressive'),
      t('a', 'is six aggressive'),
      t('b', 'six is aggressive when the windowsill fits four'),
      t('a', 'come round when you are next off nights and bring the excess plants'),
      t('b', 'next week? i have thursday and friday'),
      t('a', 'thursday. i will have found more than the kettle by then, probably'),
      t('b', 'no promises needed, i will bring food'),
      t('a', 'you do not have to bring food'),
      t('b', 'i am bringing food'),
      t('a', 'thank you'),
      t('b', 'see you thursday 🌿'),
    ],
  },
  {
    pair: [291, 292], // quiet-quinn7 ↔ nora-nights5 — Quinn's only conversation
    turns: [
      t('b', 'hi quinn! sorry to message out of nowhere. the local history group said you might know about the old fever hospital records'),
      t('a', 'Not out of nowhere at all. I do, yes. Admissions ledgers from 1889 to 1948, and a partial staff register.'),
      t('b', 'that is amazing. is any of it digitised'),
      t('a', 'The staff register is. The ledgers are not, and probably will not be in my lifetime — they are fragile and nobody funds fragile.'),
      t('b', 'can they be looked at in person?'),
      t('a', 'Yes. Tuesdays and Thursdays, by appointment, pencil only. I will put you down for a Thursday if you tell me which year you want.'),
      t('b', '1918 if that is possible 🙏'),
      t('a', 'It is possible, and it is the year everyone asks for, so I will warn you: it is difficult reading.'),
      t('b', 'understood. thank you, genuinely'),
    ],
  },
  {
    pair: [292, 294], // nora-nights5 ↔ iris-maps6 — a hike
    turns: [
      t('b', 'Are you still up for the ridge walk, or has the rota eaten it?'),
      t('a', 'rota has NOT eaten it, i am off the 14th and 15th'),
      t('b', 'Excellent. The 14th then. It is about 16km with 700m of ascent, and the last hour is the only genuinely steep bit.'),
      t('a', 'that is very precise and i appreciate it more than you know'),
      t('b', 'I have the contours in front of me. It would be strange to be vague. ⛰️'),
      t('a', 'what is the bailout if my legs give up'),
      t('b', 'There is a lane at the 11km mark that drops you to a bus stop in twenty minutes. Two buses an hour until six.'),
      t('a', 'perfect. that is exactly the information that makes me confident i will not need it'),
      t('b', 'That is usually how it works.'),
      t('a', 'weather?'),
      t('b', 'Too early to say honestly. Ask me on the 12th and I will give you a real answer instead of a comforting one.'),
      t('a', 'i respect the refusal to make something up'),
      t('b', 'Start at eight? The light on that ridge in the morning is the entire reason to do it.'),
      t('a', 'eight is fine, i will have slept, probably'),
      t('b', 'Bring the flask. Nothing at the top.'),
      t('a', 'flask acquired in advance, i am a changed woman 🌿'),
    ],
  },
  {
    pair: [220, 221], // dm-dana4 ↔ dm-eli5
    turns: [
      t('a', 'did you get a chance to look at the budget sheet?'),
      t('b', 'yes'),
      t('a', 'and?'),
      t('b', 'line 14 is wrong'),
      t('a', 'wrong how'),
      t('b', 'you have the venue hire in twice. once in facilities and once in events.'),
      t('a', 'oh no'),
      t('a', 'oh NO, that is why the total looked healthy'),
      t('b', 'yes'),
      t('a', 'so we are 400 short not 400 up'),
      t('b', 'correct'),
      t('a', 'ok. ok. that is fixable, it is just annoying'),
      t('b', 'the sharpening station was the expensive bit and nobody used it last time'),
      t('a', 'cut it?'),
      t('b', 'cut it. bring one stone and a volunteer.'),
      t('a', 'that is 380 of the 400 right there'),
      t('b', 'yes'),
      t('a', 'you could have led with the solution instead of the problem, you know'),
      t('b', 'i could have'),
      t('a', 'thank you eli'),
    ],
  },
  {
    pair: [293, 294], // theo-builds8 ↔ iris-maps6 — craft talk
    turns: [
      t('b', 'Odd question. Do you have a way of drawing a curve that is repeatable by hand?'),
      t('a', 'Repeatable how — same curve twice, or same curve by two different people?'),
      t('b', 'The second. I want a map symbol that anyone in the team can redraw without tracing.'),
      t('a', 'Then you want a rule, not a curve. Three fixed points and a bent batten. Any two people with the same three points get the same line to within a millimetre.'),
      t('b', 'That is exactly the answer I was hoping for and not expecting.'),
      t('a', 'It is how boat builders have done it for four hundred years. The batten does the maths.'),
      t('b', 'What thickness of batten?'),
      t('a', 'Thin enough to bend without forcing, stiff enough that it does not wobble. For a desk-sized drawing, 3mm spruce. It will find the fairest curve through your points on its own.'),
      t('b', '"It will find the fairest curve on its own" is going straight into the style guide.'),
      t('a', 'Do not credit me, I stole it from a man in a shed in 1998.'),
      t('b', 'Crediting the man in the shed then.'),
      t('a', 'He would like that.'),
      t('b', 'How is the bench commission going, by the way? Cal mentioned it.'),
      t('a', 'Cal mentions everything. It is going well. Larch, unfinished, three weekends if the weather cooperates.'),
      t('b', 'Unfinished by choice?'),
      t('a', 'Always. A finish is a promise that somebody will renew it, and nobody ever does. Bare larch goes silver and keeps working.'),
      t('b', 'That is the same argument I make about map legends.'),
      t('a', 'Go on.'),
      t('b', 'Every legend is a promise that someone will keep it in sync with the map. They never do. So I try to design maps that do not need one.'),
      t('a', 'Then we are in the same trade with different materials.'),
      t('b', 'I think we might be.'),
      t('a', 'Come and see the bench when it is up. You can tell me whether the proportions read correctly from thirty feet, which is the only distance that matters for public furniture.'),
      t('b', 'I will bring a tape measure and be insufferable about it.'),
      t('a', 'That is the correct way to visit a workshop.'),
    ],
  },
  {
    pair: [222, 293], // dm-fay6 ↔ theo-builds8
    turns: [
      t('a', 'theo do you ever build anything small'),
      t('b', 'Define small.'),
      t('a', 'pedalboard sized. i need something that survives being thrown in a van twice a week'),
      t('b', 'Then not small — light and stiff. Birch ply, 12mm, rebated corners, and a felt lining so the pedals stop marching about.'),
      t('a', 'that sounds so much nicer than the one i have which is a shelf from a skip'),
      t('b', 'The shelf from the skip has lasted how long?'),
      t('a', 'four years 😅'),
      t('b', 'Then the shelf from the skip is a good design and you should be careful what you replace it with.'),
      t('a', 'that is either very wise or you do not want the job'),
      t('b', 'Both can be true. Send me the dimensions and I will tell you which.'),
      t('a', 'measuring it tonight!'),
    ],
  },
];

// ---- Deterministic PRNG --------------------------------------------------------

/** mulberry32 — small, fast, and stable across Node versions. */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Crypto: a straight port of lib/message-encryption.ts ----------------------

const toArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/**
 * `generateConversationId`: first 10 bytes of SHA-256 over the base58 identity
 * ids sorted and joined with ':'. 10 bytes is the minimum that Platform's
 * byteArray auto-detection treats as bytes rather than a string.
 */
function conversationIdFor(identityIdA, identityIdB) {
  const sorted = [identityIdA, identityIdB].sort();
  return sha256(new TextEncoder().encode(`${sorted[0]}:${sorted[1]}`)).slice(0, 10);
}

/** HKDF-SHA256 over the ECDH shared x-coordinate — the key both sides derive. */
async function deriveMessageKey(privateKey, otherPublicKey) {
  const sharedX = secp256k1.getSharedSecret(privateKey, otherPublicKey, true).slice(1, 33);
  const material = await crypto.subtle.importKey('raw', toArrayBuffer(sharedX), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(DM_KDF_SALT), info: toArrayBuffer(DM_KDF_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** `encryptToBinary`: iv(12) || AES-256-GCM(text). */
async function encryptToBinary(text, senderPrivateKey, recipientPublicKey) {
  const key = await deriveMessageKey(senderPrivateKey, recipientPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(new TextEncoder().encode(text)))
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

/** `decryptFromBinary`: the recipient's half of the same derivation. */
async function decryptFromBinary(blob, recipientPrivateKey, senderPublicKey) {
  const key = await deriveMessageKey(recipientPrivateKey, senderPublicKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(blob.slice(0, AES_GCM_IV_LENGTH)) },
    key,
    toArrayBuffer(blob.slice(AES_GCM_IV_LENGTH))
  );
  return new TextDecoder().decode(plaintext);
}

// ---- Small helpers -------------------------------------------------------------

const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const bytesToHex = (bytes) => Buffer.from(bytes).toString('hex');
/** Base64 query operand for a plain byte-array property (`bytesToBase64QueryOperand`). */
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const shortId = (base58) => `${base58.slice(0, 8)}…`;

/** Bytes out of whatever shape the SDK handed back (Uint8Array, number[], base64, base58). */
function toBytes(value) {
  if (!value) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === 'string') {
    try {
      return bs58.decode(value);
    } catch {
      return Uint8Array.from(Buffer.from(value, 'base64'));
    }
  }
  return new Uint8Array(0);
}

/** Document ids are derived, never random, so every retry rebuilds the same id. */
function stableEntropy(...parts) {
  return sha256(new TextEncoder().encode(`yappr-seed-dm-v4 ${parts.join(' ')}`));
}

/** Runs `tasks` with at most `limit` in flight, preserving result order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

/** One in-flight state transition per identity: the identity contract nonce forbids more. */
function makeMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

// ---- State journal (.seed-dm.local.json) ---------------------------------------
//
// An optimisation and an audit trail, not a correctness dependency: document
// ids are derived from their coordinates, so a lost journal costs one readback
// per op, never a duplicate.

function loadState(file) {
  if (!existsSync(file)) return { network: network(), createdAt: new Date().toISOString(), conversations: {} };
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (state.network !== network()) {
    throw new Error(`${file} was written for network "${state.network}", current NETWORK is "${network()}"`);
  }
  state.conversations ??= {};
  return state;
}

function saveState(state, file) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

// ---- Plan ----------------------------------------------------------------------
//
// Read scenarios. "Unread" is only ever visible when the NEWEST message is the
// other party's — `countUnreadByConversation` reports 0 and skips the query
// when the viewer spoke last — so the reader is always chosen as the side that
// did NOT send the final message.
//
//   read  both sides' receipts are written after the final message → 0 / 0
//   stale the reader's receipt is written part-way through → a real unread count
//   cold  the reader never wrote a receipt at all → the whole thread is unread

/**
 * The full seeding plan. Deterministic in `seed`: the dialogue bank and the
 * pairing are fixed, and the PRNG only chooses which conversations carry
 * unread and how far back the reader's receipt sits.
 */
function buildPlan(actorsByIdx, seed) {
  const rng = makeRng(seed);
  // Half read, half not, dealt out in a fixed order and then shuffled.
  const half = Math.floor(DIALOGUES.length / 2);
  const deck = [
    ...Array.from({ length: DIALOGUES.length - half }, () => 'read'),
    ...Array.from({ length: half }, (_, i) => (i % 3 === 0 ? 'cold' : 'stale')),
  ];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return DIALOGUES.map((dialogue, index) => {
    const [idxA, idxB] = dialogue.pair;
    const actorA = actorsByIdx.get(idxA);
    const actorB = actorsByIdx.get(idxB);
    if (!actorA || !actorB) throw new Error(`dialogue ${index} needs personas ${idxA} and ${idxB}`);

    const messages = dialogue.turns.map((turn, position) => ({
      position,
      from: turn.who === 'a' ? actorA : actorB,
      to: turn.who === 'a' ? actorB : actorA,
      text: turn.text,
    }));
    const lastSpeaker = messages.at(-1).from;
    const reader = lastSpeaker === actorA ? actorB : actorA;

    const scenario = deck[index];
    // Receipt goes after this many messages; `null` means "at the end".
    // A stale receipt lands between 45% and 80% of the way through, so there
    // is always something after it and always something before it.
    const readAfter =
      scenario === 'stale'
        ? Math.max(1, Math.min(messages.length - 1, Math.floor(messages.length * (0.45 + rng() * 0.35))))
        : null;

    return {
      index,
      conversationIdBytes: conversationIdFor(actorA.identityId, actorB.identityId),
      get key() {
        return bs58.encode(this.conversationIdBytes);
      },
      actorA,
      actorB,
      messages,
      lastSpeaker,
      reader,
      scenario,
      readAfter,
      /** Receipts to write: owner → the message count that must precede it. */
      receipts:
        scenario === 'read'
          ? [
              { owner: actorA, after: messages.length },
              { owner: actorB, after: messages.length },
            ]
          : scenario === 'stale'
            ? [
                { owner: reader, after: readAfter },
                { owner: lastSpeaker, after: messages.length },
              ]
            : [{ owner: lastSpeaker, after: messages.length }],
    };
  });
}

// ---- Actors --------------------------------------------------------------------

/** Normalizes an identity public key from either the wasm getter or JSON shape. */
function keyFacts(key) {
  const asNumber = (value, names) => {
    if (typeof value === 'number') return value;
    const index = names.indexOf(String(value));
    return index === -1 ? null : index;
  };
  return {
    keyId: key.keyId ?? key.id,
    type: asNumber(key.keyTypeNumber ?? key.keyType ?? key.type, ['ecdsa_secp256k1', 'bls12_381', 'ecdsa_hash160', 'bip13_script_hash', 'eddsa_25519_hash160']),
    purpose: asNumber(key.purposeNumber ?? key.purpose, ['authentication', 'encryption', 'decryption', 'transfer', 'system', 'voting', 'owner']),
    securityLevel: asNumber(key.securityLevelNumber ?? key.securityLevel, ['master', 'critical', 'high', 'medium']),
    data: toBytes(typeof key.data === 'string' && /^[0-9a-f]+$/i.test(key.data) ? hexToBytes(key.data) : key.data),
  };
}

/**
 * Builds an actor and PROVES its ECDH key. The app resolves the other party's
 * public key with `getPublicKeyFromIdentity` (AUTHENTICATION + HIGH +
 * secp256k1); if the on-chain answer is not the ledger's key 2, every message
 * this script writes would be undecryptable in the browser, so that is a hard
 * stop rather than a warning.
 */
async function buildActor(battery, personaIdx) {
  const entry = ledgerEntry(loadLedger(), personaIdx);
  if (!entry) throw new Error(`persona ${personaIdx} is not in the seed ledger`);
  if (!entry.identityId) throw new Error(`persona ${personaIdx} (${entry.handle}) has no identity yet — provision it first`);

  const authKey = entry.identityKeys.find((key) => key.keyId === CRITICAL_AUTH_KEY_ID);
  const ecdhKey = entry.identityKeys.find((key) => key.keyId === DM_ECDH_KEY_ID);
  if (!authKey || !ecdhKey) throw new Error(`persona ${personaIdx} is missing key ${CRITICAL_AUTH_KEY_ID} or ${DM_ECDH_KEY_ID}`);

  const identity = await battery.readback(() => battery.sdk.identities.fetch(entry.identityId));
  if (!identity) throw new Error(`identity ${entry.identityId} (${entry.handle}) not found on this devnet`);

  const facts = identity.publicKeys.map(keyFacts);
  const appChoice =
    facts.find(
      (key) =>
        key.type === KEY_TYPE_ECDSA_SECP256K1 &&
        key.securityLevel === KEY_SECURITY_LEVEL_HIGH &&
        key.purpose === KEY_PURPOSE_AUTHENTICATION
    ) ?? facts.find((key) => key.type === KEY_TYPE_ECDSA_SECP256K1 && key.securityLevel === KEY_SECURITY_LEVEL_HIGH);
  if (!appChoice) throw new Error(`${entry.handle}: the identity has no HIGH secp256k1 key — the app could not encrypt to it`);
  if (bytesToHex(appChoice.data) !== ecdhKey.publicKeyHex) {
    throw new Error(
      `${entry.handle}: the app would do ECDH with on-chain key ${appChoice.keyId}, but the ledger's key ${DM_ECDH_KEY_ID} is a different point. ` +
        'Seeding with the ledger key would produce messages the app cannot decrypt.'
    );
  }
  // `identityUsesHash160`: false whenever any HIGH key carries a full point,
  // which is what we just proved. The app therefore omits senderPubKey.
  const usesHash160 = !facts.some((key) => key.securityLevel === KEY_SECURITY_LEVEL_HIGH && key.type === KEY_TYPE_ECDSA_SECP256K1);

  const signer = new IdentitySigner();
  signer.addKeyFromWif(wifFromHex(authKey.privateKeyHex));

  return {
    personaIdx,
    handle: entry.handle,
    identityId: entry.identityId,
    identityKey: identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID),
    signer,
    ecdhPrivateKey: hexToBytes(ecdhKey.privateKeyHex),
    ecdhPublicKey: hexToBytes(ecdhKey.publicKeyHex),
    usesHash160,
    lock: makeMutex(),
  };
}

// ---- Write plumbing ------------------------------------------------------------

/**
 * Creates a document, deciding acceptance by READBACK rather than by
 * throw/no-throw: a 504 on the confirmation wait does not mean the write was
 * refused, and a document a previous run already wrote reads back at once.
 */
function makeWriter({ handle, contractId, dryRun }) {
  const sdk = handle.sdk;
  const get = (docType, id) => readback(handle, async () => (await sdk.documents.get(contractId, docType, id)) ?? null);

  /**
   * Broadcasts and then asks the CHAIN whether it landed. A 504 on the
   * confirmation wait does not mean the write was refused, and a document an
   * earlier run already wrote satisfies `accepted` on the first poll.
   */
  async function attempt(actor, label, broadcast, accepted) {
    let lastError = null;
    for (let tries = 0; tries < MAX_ATTEMPTS; tries++) {
      try {
        await actor.lock(broadcast);
        return;
      } catch (e) {
        lastError = describeErr(e);
        if (TRANSPORT_COLLAPSE.test(lastError) || NONCE_DESYNC.test(lastError)) {
          await handle.reconnect(lastError);
          continue;
        }
        if (WAIT_MAYBE_LANDED.test(lastError) || RETRYABLE.test(lastError)) {
          for (let poll = 0; poll < SETTLE_POLLS; poll++) {
            await sleep(SETTLE_MS);
            if (await accepted()) return;
          }
          continue;
        }
        break;
      }
    }
    // Last word belongs to the chain, not to the SDK.
    for (let poll = 0; poll < SETTLE_POLLS; poll++) {
      await sleep(SETTLE_MS);
      if (await accepted()) return;
    }
    throw new Error(`${label} failed: ${lastError ?? 'the SDK reported no error, but the write is not on chain'}`);
  }

  async function create(actor, docType, data, entropy, { probeFirst = false } = {}) {
    const { document, id } = buildDocument({ contractId, docType, ownerId: actor.identityId, data, entropy });
    if (dryRun) return { id, skipped: 'dry-run' };
    if (probeFirst && (await get(docType, id))) return { id, skipped: 'already on chain' };
    await attempt(
      actor,
      `create ${docType} for ${actor.handle}`,
      () => sdk.documents.create({ document, identityKey: actor.identityKey, signer: actor.signer }),
      async () => (await get(docType, id)) !== null
    );
    return { id };
  }

  /** `markAsRead`'s update branch: a replace is what advances `$updatedAt`. */
  async function replace(actor, docType, id, data, revision) {
    const next = BigInt(revision) + 1n;
    const { document } = buildDocument({ contractId, docType, ownerId: actor.identityId, data, revision: next, id: bs58.decode(id) });
    if (dryRun) return { id, skipped: 'dry-run' };
    await attempt(
      actor,
      `replace ${docType} ${id} for ${actor.handle}`,
      () => sdk.documents.replace({ document, identityKey: actor.identityKey, signer: actor.signer }),
      async () => {
        const doc = await get(docType, id);
        return doc?.revision !== undefined && BigInt(doc.revision) >= next;
      }
    );
    return { id };
  }

  async function remove(actor, docType, id) {
    if (dryRun) return;
    await actor.lock(() =>
      sdk.documents.delete({
        document: { id, ownerId: actor.identityId, dataContractId: contractId, documentTypeName: docType },
        identityKey: actor.identityKey,
        signer: actor.signer,
      })
    );
    for (let poll = 0; poll < SETTLE_POLLS; poll++) {
      await sleep(SETTLE_MS);
      if (!(await get(docType, id))) return;
    }
    throw new Error(`delete ${docType} ${id} did not take effect`);
  }

  async function query(docType, shape) {
    return readback(handle, async () => {
      const page = await sdk.documents.query({ dataContractId: contractId, documentTypeName: docType, ...shape });
      return [...page.values()].map((doc) => doc.toObject());
    });
  }

  async function count(docType, where) {
    return readback(handle, async () => {
      const raw = await sdk.documents.count({ dataContractId: contractId, documentTypeName: docType, where });
      const total = raw instanceof Map ? raw.get('') : raw?.[''];
      return total === undefined || total === null ? 0 : Number(total);
    });
  }

  return { get, create, replace, remove, query, count, sdk, readback: (fn) => readback(handle, fn) };
}

// ---- Seeding -------------------------------------------------------------------

/**
 * `sendMessage` creates the sender's invite the first time it finds none, so a
 * real two-way exchange leaves an invite in both directions. `senderAndRecipient`
 * is unique on [$ownerId, recipientId] with NO conversationId, which means a
 * pair gets exactly one invite ever — including the throwaway one
 * scripts/verify-dm-v4.mjs writes with a per-run salted conversation id. Such
 * an invite would make the app render a phantom, empty conversation, so it is
 * replaced rather than left in place.
 */
async function ensureInvite(writer, state, from, to, conversationIdBytes, log) {
  const record = (state.invites ??= {});
  const key = `${from.personaIdx}->${to.personaIdx}`;
  if (record[key]) return 'journal';

  const existing = await writer.query('conversationInvite', {
    where: [
      ['$ownerId', '==', from.identityId],
      ['recipientId', '==', to.identityId],
    ],
    limit: 1,
  });
  if (existing.length > 0) {
    const onChain = toBytes(existing[0].conversationId ?? existing[0].data?.conversationId);
    if (bytesToHex(onChain) === bytesToHex(conversationIdBytes)) {
      record[key] = existing[0].$id ? bs58.encode(toBytes(existing[0].$id)) : 'existing';
      return 'existing';
    }
    const staleId = bs58.encode(toBytes(existing[0].$id));
    log(`     replacing ${from.handle}→${to.handle} invite ${shortId(staleId)}: it names conversation ${shortId(bs58.encode(onChain))}, not ${shortId(bs58.encode(conversationIdBytes))}`);
    await writer.remove(from, 'conversationInvite', staleId);
  }

  const data = {
    recipientId: bs58.decode(to.identityId),
    conversationId: conversationIdBytes,
    // Mirrors `identityUsesHash160`: only identities with no full-point HIGH
    // key need to publish the ECDH point in the invite.
    ...(from.usesHash160 ? { senderPubKey: from.ecdhPublicKey } : {}),
  };
  const { id } = await writer.create(from, 'conversationInvite', data, stableEntropy('invite', from.identityId, to.identityId));
  record[key] = id;
  return 'created';
}

/**
 * `markAsRead`, verbatim: replace the existing receipt if there is one,
 * otherwise create it. `userConversation` is unique on [$ownerId,
 * conversationId], so a receipt is a singleton per (reader, conversation) and
 * an earlier one — including the throwaway scripts/verify-dm-v4.mjs leaves
 * behind — is the SAME document this seeder wants, just with a stale
 * `$updatedAt`. Replacing advances it, which is the entire point: `$updatedAt`
 * IS the last-read timestamp.
 */
async function ensureReceipt(writer, entry, owner, conversationIdBytes, log) {
  const ownerKey = String(owner.personaIdx);
  if (entry.receipts[ownerKey]) return 'journal';

  const existing = (
    await writer.query('readReceipt', {
      where: [
        ['$ownerId', '==', owner.identityId],
        ['conversationId', '==', b64(conversationIdBytes)],
      ],
      limit: 1,
    })
  )[0];

  if (existing) {
    const id = bs58.encode(toBytes(existing.$id));
    log(`     ${owner.handle} already has a receipt here (${shortId(id)}) — replacing it to advance $updatedAt`);
    await writer.replace(owner, 'readReceipt', id, { conversationId: conversationIdBytes }, existing.$revision ?? 1n);
    entry.receipts[ownerKey] = id;
    return 'replaced';
  }

  const { id, skipped } = await writer.create(
    owner,
    'readReceipt',
    { conversationId: conversationIdBytes },
    stableEntropy('receipt', bs58.encode(conversationIdBytes), owner.identityId),
    { probeFirst: true }
  );
  entry.receipts[ownerKey] = id;
  return skipped ? 'existing' : 'created';
}

/** One conversation, strictly in order: invites, messages, and receipts interleaved. */
async function seedConversation(writer, plan, state, { dryRun, log, resume }) {
  const entry = (state.conversations[plan.key] ??= {
    pair: [plan.actorA.handle, plan.actorB.handle],
    scenario: plan.scenario,
    messages: {},
    invites: {},
    receipts: {},
  });
  entry.scenario = plan.scenario;

  // Reconcile against the chain before writing anything: if the journal was
  // lost, the count tree says how much of this conversation already exists.
  if (!dryRun && resume) {
    const onChain = await writer.count('directMessage', [['conversationId', '==', b64(plan.conversationIdBytes)]]);
    const known = Object.keys(entry.messages).length;
    if (onChain > known) log(`     ${plan.key.slice(0, 8)}… journal knows ${known} messages, the chain has ${onChain} — probing ids`);
  }

  const written = { invites: 0, messages: 0, receipts: 0 };
  const receiptsByPosition = new Map();
  for (const receipt of plan.receipts) receiptsByPosition.set(receipt.after, [...(receiptsByPosition.get(receipt.after) ?? []), receipt.owner]);

  for (const message of plan.messages) {
    if (!entry.invites[`${message.from.personaIdx}->${message.to.personaIdx}`]) {
      const outcome = dryRun ? 'dry-run' : await ensureInvite(writer, entry, message.from, message.to, plan.conversationIdBytes, log);
      if (outcome === 'created') written.invites += 1;
    }

    const slot = String(message.position);
    if (!entry.messages[slot]) {
      const encryptedContent = await encryptToBinary(message.text, message.from.ecdhPrivateKey, message.to.ecdhPublicKey);
      const { id, skipped } = await writer.create(
        message.from,
        'directMessage',
        { conversationId: plan.conversationIdBytes, encryptedContent },
        stableEntropy('message', plan.key, String(message.position), message.from.identityId),
        { probeFirst: resume }
      );
      entry.messages[slot] = id;
      if (!skipped) written.messages += 1;
    }

    for (const owner of receiptsByPosition.get(message.position + 1) ?? []) {
      if (entry.receipts[String(owner.personaIdx)]) continue;
      const outcome = await ensureReceipt(writer, entry, owner, plan.conversationIdBytes, log);
      if (outcome === 'created' || outcome === 'replaced') written.receipts += 1;
      // Only a receipt with messages still to come needs the gap.
      if (!dryRun && message.position + 1 < plan.messages.length) await sleep(RECEIPT_GAP_MS);
    }
  }

  return written;
}

// ---- Verification --------------------------------------------------------------

/**
 * Re-reads every conversation through the SHAPES THE APP USES — the count tree
 * for unread, a one-message newest-first page for the preview — and decrypts
 * that preview with the key the viewer would hold.
 */
async function verify(writer, plans, state) {
  return mapLimit(plans, VERIFY_CONCURRENCY, async (plan) => {
    const convB64 = b64(plan.conversationIdBytes);
    const total = await writer.count('directMessage', [['conversationId', '==', convB64]]);
    const planted = Object.keys(state.conversations[plan.key]?.messages ?? {}).length;
    const newest = (
      await writer.query('directMessage', {
        where: [
          ['conversationId', '==', convB64],
          ['$createdAt', '>', 0],
        ],
        orderBy: [['$createdAt', 'desc']],
        limit: 1,
      })
    )[0];

    const sides = await Promise.all(
      [plan.actorA, plan.actorB].map(async (viewer) => {
        const receipts = await writer.query('readReceipt', {
          where: [
            ['$ownerId', '==', viewer.identityId],
            ['conversationId', '==', convB64],
          ],
          limit: 1,
        });
        const lastReadAt = Number(receipts[0]?.$updatedAt ?? receipts[0]?.updatedAt ?? 0);
        // The client's rule: the viewer spoke last ⇒ 0, and no count query.
        const iSpokeLast = newest && bs58.encode(toBytes(newest.$ownerId)) === viewer.identityId;
        const unread = !newest || iSpokeLast
          ? 0
          : await writer.count('directMessage', [
              ['conversationId', '==', convB64],
              ['$createdAt', '>', lastReadAt],
            ]);
        return { viewer, lastReadAt, unread };
      })
    );

    let preview = null;
    let decryptError = null;
    if (newest) {
      const senderId = bs58.encode(toBytes(newest.$ownerId));
      const sender = senderId === plan.actorA.identityId ? plan.actorA : plan.actorB;
      const viewer = sender === plan.actorA ? plan.actorB : plan.actorA;
      try {
        preview = await decryptFromBinary(
          toBytes(newest.encryptedContent ?? newest.data?.encryptedContent),
          viewer.ecdhPrivateKey,
          sender.ecdhPublicKey
        );
      } catch (e) {
        decryptError = describeErr(e);
      }
    }

    return { plan, total, planted, foreign: total - planted, sides, preview, decryptError };
  });
}

/**
 * Deletes messages in a seeded conversation that this seeder did not write.
 *
 * `conversationId` is derived from the participant pair alone, so anything
 * that ever addressed the same pair shares the thread — including the
 * random-byte messages an older scripts/verify-dm-v4.mjs left behind before it
 * started salting its conversation ids. Those render as "[Could not decrypt
 * message]" in the middle of an otherwise readable thread, which is exactly
 * what this seeding exists to avoid. It also drops whole UNSEEDED conversations
 * that the actors' own invites still advertise, since the app builds its list
 * from invites and each one is a visible, permanently broken row. Opt-in
 * (`--prune-foreign`) because deleting documents nobody asked about should
 * never be a side effect; `--only` narrows phase 1 but phase 2 always sweeps
 * every actor, so run it without `--only`.
 */
async function pruneForeign(writer, plans, actors, state, log) {
  const byIdentity = new Map(actors.map((actor) => [actor.identityId, actor]));
  const seeded = new Set(plans.map((plan) => plan.key));
  let removed = 0;

  /** Deletes every message in `conversationKey` that is not in `keep`. */
  async function sweep(conversationKey, keep) {
    const docs = await writer.query('directMessage', {
      where: [['conversationId', '==', b64(bs58.decode(conversationKey))], ['$createdAt', '>', 0]],
      orderBy: [['$createdAt', 'asc']],
      limit: 100,
    });
    for (const doc of docs) {
      const id = bs58.encode(toBytes(doc.$id));
      if (keep.has(id)) continue;
      const owner = byIdentity.get(bs58.encode(toBytes(doc.$ownerId)));
      if (!owner) {
        log(`     ${conversationKey.slice(0, 8)}… message ${shortId(id)} belongs to an identity this seeder does not hold — leaving it`);
        continue;
      }
      log(`     ${conversationKey.slice(0, 8)}… deleting foreign message ${shortId(id)} (${owner.handle})`);
      await writer.remove(owner, 'directMessage', id);
      removed += 1;
    }
  }

  // Phase 1: leftovers sharing a SEEDED conversation. `conversationId` is
  // derived from the pair alone, so anything that ever addressed the same two
  // identities lands in the middle of the thread being seeded.
  for (const plan of plans) {
    await sweep(plan.key, new Set(Object.values(state.conversations[plan.key]?.messages ?? {})));
  }

  // Phase 2: whole conversations this seeder never planned but that the
  // actors' invites still surface. The app builds its list from invites, so a
  // stale invite is a visible row — the battery's throwaway pair conversations
  // show up as two undecryptable messages between two seeded personas. Delete
  // the messages and the invite that advertises them.
  for (const actor of actors) {
    const invites = await writer.query('conversationInvite', {
      where: [['$ownerId', '==', actor.identityId]],
      orderBy: [['recipientId', 'asc']],
      limit: 100,
    });
    for (const invite of invites) {
      const key = bs58.encode(toBytes(invite.conversationId ?? invite.data?.conversationId));
      if (seeded.has(key)) continue;
      const inviteId = bs58.encode(toBytes(invite.$id));
      log(`     ${actor.handle}: invite ${shortId(inviteId)} advertises unseeded conversation ${key.slice(0, 8)}… — removing it`);
      await sweep(key, new Set());
      await writer.remove(actor, 'conversationInvite', inviteId);
      removed += 1;
    }
  }
  return removed;
}

// ---- Reporting -----------------------------------------------------------------

function printTable(rows) {
  const columns = [
    ['conversation', 14],
    ['participants', 28],
    ['msgs', 5],
    ['extra', 5],
    ['scenario', 9],
    ['unread', 13],
    ['newest message (decrypted)', 46],
  ];
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(columns[i][1])).join('  ');
  console.log(`\n${line(columns.map((c) => c[0]))}`);
  console.log(columns.map((c) => '-'.repeat(c[1])).join('  '));
  for (const row of rows) {
    const [a, b] = row.sides;
    const unread = `${a.viewer.handle.slice(0, 5)}:${a.unread} ${b.viewer.handle.slice(0, 5)}:${b.unread}`;
    const preview = row.decryptError
      ? `DECRYPT FAILED: ${row.decryptError.slice(0, 30)}`
      : (row.preview ?? '(no messages)').replace(/\s+/g, ' ').slice(0, 44);
    console.log(
      line([
        row.plan.key.slice(0, 12),
        `${row.plan.actorA.handle} ↔ ${row.plan.actorB.handle}`.slice(0, 28),
        row.total,
        row.foreign || '-',
        row.plan.scenario,
        unread,
        preview,
      ])
    );
  }
}

// ---- Entry point ----------------------------------------------------------------

function dmContractId() {
  return process.env.NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID || readEnvFile(join(REPO_ROOT, '.env.devnet')).NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID;
}

function parseArgs(argv) {
  const args = { contract: null, seed: 20260917, dryRun: false, verifyOnly: false, pruneForeign: false, concurrency: 4, state: STATE_FILE, only: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--seed': args.seed = Number(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
      case '--verify-only': args.verifyOnly = true; break;
      case '--prune-foreign': args.pruneForeign = true; break;
      case '--concurrency': args.concurrency = Number(argv[++i]); break;
      case '--state': args.state = argv[++i]; break;
      case '--only': args.only = new Set(argv[++i].split(',').map((s) => Number(s.trim()))); break;
      default: throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  args.contract ??= dmContractId();
  if (!args.contract) throw new Error('Pass --contract <id> or set NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID');
  if (!Number.isFinite(args.seed)) throw new Error('--seed must be a number');
  return args;
}

/**
 * The dry run is fully OFFLINE: it builds the plan from the ledger's public key
 * material, encrypts every message and decrypts it back with the recipient's
 * key, and prints what would be written. Nothing here touches the devnet.
 */
async function dryRun(args) {
  const ledger = loadLedger();
  const actorsByIdx = new Map(
    ACTORS.map((personaIdx) => {
      const entry = ledgerEntry(ledger, personaIdx);
      if (!entry?.identityId) throw new Error(`persona ${personaIdx} is not provisioned in the seed ledger`);
      const ecdhKey = entry.identityKeys.find((key) => key.keyId === DM_ECDH_KEY_ID);
      return [
        personaIdx,
        {
          personaIdx,
          handle: entry.handle,
          identityId: entry.identityId,
          ecdhPrivateKey: hexToBytes(ecdhKey.privateKeyHex),
          ecdhPublicKey: hexToBytes(ecdhKey.publicKeyHex),
        },
      ];
    })
  );

  const plans = buildPlan(actorsByIdx, args.seed);
  let messages = 0;
  let receipts = 0;
  console.log(`DRY RUN — contract ${args.contract}, seed ${args.seed}, ${plans.length} conversations\n`);
  console.log(`${'conversation'.padEnd(14)}  ${'participants'.padEnd(28)}  ${'msgs'.padEnd(5)}  ${'scenario'.padEnd(9)}  receipts`);
  console.log(`${'-'.repeat(14)}  ${'-'.repeat(28)}  ${'-'.repeat(5)}  ${'-'.repeat(9)}  ${'-'.repeat(40)}`);
  for (const plan of plans) {
    messages += plan.messages.length;
    receipts += plan.receipts.length;
    const describe = plan.receipts.map((r) => `${r.owner.handle}@${r.after}`).join(' ');
    console.log(
      `${plan.key.slice(0, 12).padEnd(14)}  ${`${plan.actorA.handle} ↔ ${plan.actorB.handle}`.slice(0, 28).padEnd(28)}  ` +
        `${String(plan.messages.length).padEnd(5)}  ${plan.scenario.padEnd(9)}  ${describe}`
    );
  }

  // Encrypt/decrypt every planned message with the real key pair — the same
  // check the live run makes against the chain, minus the chain.
  let proved = 0;
  for (const plan of plans) {
    for (const message of plan.messages) {
      const blob = await encryptToBinary(message.text, message.from.ecdhPrivateKey, message.to.ecdhPublicKey);
      const back = await decryptFromBinary(blob, message.to.ecdhPrivateKey, message.from.ecdhPublicKey);
      if (back !== message.text) throw new Error(`round-trip mismatch in conversation ${plan.key} at ${message.position}`);
      proved += 1;
    }
  }
  console.log(
    `\n${plans.length} conversations, ${messages} directMessage, ${receipts} readReceipt, ` +
      `up to ${plans.length * 2} conversationInvite (both directions per pair).`
  );
  console.log(`${proved}/${messages} messages encrypted and decrypted back with the recipient's key 2 (offline round-trip).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) return dryRun(args);

  await ensureInitialized();
  const handle = createSdkHandle({ contractIds: [args.contract], timeoutMs: SDK_TIMEOUT_MS });
  const { protocolVersion } = await handle.connect();
  console.log(`connected (PV${protocolVersion}); DM v4 ${args.contract}`);

  const writer = makeWriter({ handle, contractId: args.contract, dryRun: false });
  const actors = await mapLimit(ACTORS, 8, (personaIdx) => buildActor(writer, personaIdx));
  const actorsByIdx = new Map(actors.map((actor) => [actor.personaIdx, actor]));
  console.log(`actors: ${actors.map((a) => `${a.handle}(${a.personaIdx})`).join(', ')}`);
  console.log(`ECDH key check: all ${actors.length} identities resolve key ${DM_ECDH_KEY_ID} (authentication/HIGH) — the key the app encrypts to`);

  const plans = buildPlan(actorsByIdx, args.seed).filter((plan) => !args.only || args.only.has(plan.index));
  const resume = existsSync(args.state);
  const state = loadState(args.state);
  state.contractId = args.contract;
  state.seed = args.seed;

  if (!args.verifyOnly) {
    // PROOF FIRST. One message is written and read back off the chain and
    // decrypted with the RECIPIENT's key before the other ~250 are spent.
    const pilot = plans[0];
    const pilotMessage = pilot.messages[0];
    console.log(`\nproving the ciphertext before writing the rest: ${pilot.actorA.handle} ↔ ${pilot.actorB.handle}`);
    const pilotEntry = (state.conversations[pilot.key] ??= { pair: [pilot.actorA.handle, pilot.actorB.handle], scenario: pilot.scenario, messages: {}, invites: {}, receipts: {} });
    await ensureInvite(writer, pilotEntry, pilotMessage.from, pilotMessage.to, pilot.conversationIdBytes, console.log);
    const blob = await encryptToBinary(pilotMessage.text, pilotMessage.from.ecdhPrivateKey, pilotMessage.to.ecdhPublicKey);
    const { id } = await writer.create(
      pilotMessage.from,
      'directMessage',
      { conversationId: pilot.conversationIdBytes, encryptedContent: blob },
      stableEntropy('message', pilot.key, '0', pilotMessage.from.identityId),
      { probeFirst: true }
    );
    pilotEntry.messages['0'] = id;
    saveState(state, args.state);

    const fetched = await writer.get('directMessage', id);
    if (!fetched) throw new Error(`the pilot message ${id} did not read back`);
    const plain = fetched.toObject?.() ?? fetched;
    const onChainBytes = toBytes(plain.encryptedContent ?? plain.data?.encryptedContent);
    const recovered = await decryptFromBinary(onChainBytes, pilotMessage.to.ecdhPrivateKey, pilotMessage.from.ecdhPublicKey);
    if (recovered !== pilotMessage.text) throw new Error(`decrypted "${recovered}" but wrote "${pilotMessage.text}"`);
    console.log(`PROOF  ${id}: ${pilotMessage.to.handle}'s key 2 decrypts ${pilotMessage.from.handle}'s on-chain ciphertext → ${JSON.stringify(recovered)}`);

    const started = Date.now();
    const totals = { invites: 0, messages: 0, receipts: 0 };
    const aborted = [];
    let done = 0;
    // One poisoned document must not cost the other eleven conversations their
    // run: a conversation that throws is recorded and reported, not rethrown.
    await mapLimit(plans, args.concurrency, async (plan) => {
      try {
        const written = await seedConversation(writer, plan, state, { dryRun: false, log: console.log, resume });
        totals.invites += written.invites;
        totals.messages += written.messages;
        totals.receipts += written.receipts;
        done += 1;
        console.log(`[${done}/${plans.length}] ${plan.actorA.handle} ↔ ${plan.actorB.handle}: +${written.messages} messages, +${written.invites} invites, +${written.receipts} receipts (${plan.scenario})`);
      } catch (e) {
        aborted.push({ plan, error: describeErr(e) });
        console.log(`ABORT ${plan.actorA.handle} ↔ ${plan.actorB.handle}: ${describeErr(e).slice(0, 200)}`);
      } finally {
        saveState(state, args.state);
      }
    });
    saveState(state, args.state);
    console.log(
      `\nwrote ${totals.messages} directMessage, ${totals.invites} conversationInvite, ${totals.receipts} readReceipt ` +
        `in ${Math.round((Date.now() - started) / 1000)}s` + (aborted.length ? `; ${aborted.length} conversation(s) aborted — re-run to resume` : '')
    );
  }

  if (args.pruneForeign) {
    const removed = await pruneForeign(writer, plans, actors, state, console.log);
    console.log(`pruned ${removed} document(s) this seeder did not write`);
  }

  const rows = await verify(writer, plans, state);
  printTable(rows);

  // A conversation fails when something THIS seeder is responsible for is
  // wrong. Documents it did not write are reported in the `extra` column and
  // cleaned up with --prune-foreign, not treated as a broken seed.
  const failures = rows.filter((row) => row.decryptError || row.planted !== row.plan.messages.length);
  const unreadConversations = rows.filter((row) => row.sides.some((side) => side.unread > 0));
  console.log(
    `\n${rows.length} conversations, ${rows.reduce((sum, row) => sum + row.total, 0)} messages on chain, ` +
      `${unreadConversations.length} with a non-zero unread count, ${rows.length - unreadConversations.length} fully read.`
  );
  console.log(`every conversation's newest message decrypted with the recipient's key: ${rows.length - rows.filter((r) => r.decryptError).length}/${rows.length}`);
  if (failures.length > 0) {
    for (const row of failures) {
      console.log(`FAIL  ${row.plan.key}: ${row.decryptError ?? `${row.planted} of ${row.plan.messages.length} planned messages written`}`);
    }
  }
  console.log(`state journal: ${args.state}`);
  return failures.length;
}

try {
  const failures = (await main()) ?? 0;
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
