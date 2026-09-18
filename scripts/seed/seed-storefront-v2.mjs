/**
 * Content seeder for the **storefront v2 contract** on the moutai devnet
 * (`contracts/yappr-storefront-contract.json`, docs/STOREFRONT_V2.md).
 *
 * Fills the /devnet deployment's shop surfaces with plausible stores, catalogs,
 * orders, status histories and reviews so `/store`, `/store/view`, `/orders`
 * and the ranked "top rated" / "most ordered" strips have something real to
 * show. Every document is written in the shape the APP writes it
 * (`lib/services/store-*.ts`, `types/store.ts`): JSON-string `tags` /
 * `imageUrls` / `paymentUris` / `contactMethods`, integer minor-unit prices,
 * and orders encrypted to the seller with the real deterministic-ephemeral
 * ECIES the checkout uses. The buyer is an order's `$ownerId` — v2 carries no
 * buyerId copy — and `sellerId` is consensus-checked against the store owner.
 *
 * Determinism and resumability
 *   Every document id comes from `entropyFor(key)` = SHA-256 of a stable
 *   logical key, so a re-run rebuilds the same ids and converges instead of
 *   duplicating; all generated text is drawn from a seeded PRNG keyed the same
 *   way, so content never drifts between runs. `.seed-storefront.local.json`
 *   records what landed (skip on resume) but is only a cache — deleting it
 *   costs one existence read per document, never a duplicate; a cache written
 *   for a different contract is ignored rather than obeyed.
 *
 *   Re-running reconciles CONTENT only where Platform allows it: `store` and
 *   `shippingZone` are replaced when the table has changed. Orders, status
 *   updates and reviews are `documentsMutable: false` — once written, editing
 *   their table below only affects a fresh contract.
 *
 * Ordering
 *   Writes are strictly sequential per identity (identity contract nonce) and
 *   parallel across identities, in dependency phases: stores → items + zones →
 *   orders → status updates → reviews.
 *
 * Run:
 *   NETWORK=devnet node scripts/seed/seed-storefront-v2.mjs [--contract <id>]
 *     [--dry-run] [--progress <file>] [--concurrency 8] [--verify-only]
 */
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp256k1 from '@noble/secp256k1';
import { ensureInitialized } from '@dashevo/evo-sdk';
import { createBattery, id32 } from '../battery-lib.mjs';
import {
  REPO_ROOT,
  YAPP_TOKEN_POSITION,
  addressFor,
  buildDocument,
  createSdkHandle,
  describeErr,
  ledgerEntry,
  loadLedger,
  readEnvFile,
  socialContractId,
} from './seed-lib.mjs';

const PROGRESS_FILE = join(REPO_ROOT, '.seed-storefront.local.json');
const REVIEW_COST = { storeReview: 3n, itemReview: 1n };
/** Headroom over the computed review spend so a partial re-run never stalls on YAPP. */
const YAPP_HEADROOM = 20n;

// ---- Deterministic content --------------------------------------------------

const utf8 = (s) => new TextEncoder().encode(s);
const digest = (key) => sha256(utf8(`yappr/storefront-seed/v1/${key}`));
/** Stable 32-byte document entropy for a logical key — the id is a pure function of the key. */
const entropyFor = (key) => digest(key);

/** mulberry32 seeded from the key's digest: same key, same stream, any run. */
function rngFor(key) {
  const d = digest(`rng/${key}`);
  let a = (d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3];
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
const photo = (seed, size = 900) => `https://picsum.photos/seed/${seed}/${size}/${size}`;
const logo = (seed) => `https://api.dicebear.com/7.x/shapes/svg?seed=${seed}`;

/** Deterministic-looking carrier tracking number for an order. */
function trackingFor(key, carrier) {
  const rng = rngFor(`tracking/${key}`);
  const digits = (n) => Array.from({ length: n }, () => Math.floor(rng() * 10)).join('');
  if (carrier === 'usps') return `9400 1${digits(3)} ${digits(4)} ${digits(4)} ${digits(4)} ${digits(2)}`;
  if (carrier === 'ups') return `1Z${digits(3)}W${digits(11)}`;
  if (carrier === 'fedex') return digits(12);
  return `JJD${digits(15)}`;
}

/**
 * The app matches a zone by testing `countryPattern` as `^(pattern)$` against
 * the ISO-3166 alpha-2 country on the address (shipping-zone-service.ts), so a
 * zone must spell its countries out; `'EU'` and `'*'` match nobody, and a store
 * whose zones all miss BLOCKS checkout (app/checkout/page.tsx).
 */
const EU_COUNTRIES = 'AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|GR|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE';

// ---- Catalog ----------------------------------------------------------------
//
// Six shops on six identities (`store` is unique per $ownerId, so one each).
// 200 and 202 already carry the registration battery's throwaway stores; this
// seeder replaces those documents in place rather than stranding them.

const STORES = [
  {
    key: 'coffee',
    persona: 200,
    name: 'Anvil & Ash Coffee',
    description:
      'Small-batch coffee roasted on a drum we rebuilt from a scrapyard find. Single origins rotate every Tuesday; the house blends never move. Roasted the day it ships, which is most days.',
    location: 'Portland, Oregon',
    currency: 'USD',
    policies:
      'Roasting & shipping: bags leave the roastery within 48 hours of roasting, Monday to Thursday.\nReturns: unopened bags within 30 days for a full refund. If a bag arrives stale or damaged, tell us and we will replace it — no return shipping needed.\nWholesale: five bags or more, get in touch before ordering.',
    contact: [
      { platform: 'email', handle: 'hello@anvilash.coffee' },
      { platform: 'twitter', handle: '@anvilash' },
    ],
    zones: [
      { name: 'US Domestic', countryPattern: 'US', rateType: 'flat', flatRate: 600, priority: 1 },
      { name: 'Canada & Mexico', countryPattern: 'CA|MX', rateType: 'flat', flatRate: 1600, priority: 2 },
      // No countryPattern: the app's matchesCountryPattern treats an absent pattern as "matches all".
      { name: 'Rest of World', rateType: 'flat', flatRate: 3200, priority: 3 },
    ],
    items: [
      { key: 'ethiopia', title: 'Ethiopia Guji Natural — 12 oz', price: 1900, stock: 42, weight: 340, section: 'Coffee', category: 'Single Origin', subcategory: 'Africa', tags: ['ethiopia', 'natural', 'blueberry', 'filter'], description: 'Guji zone, 2,050 m, natural process. Blueberry jam, cane sugar, a long floral finish. Brews best as filter at 1:16; it will take an espresso dose if you like it loud.' },
      { key: 'colombia', title: 'Colombia Huila Washed — 12 oz', price: 1750, stock: 63, weight: 340, section: 'Coffee', category: 'Single Origin', subcategory: 'South America', tags: ['colombia', 'washed', 'caramel', 'everyday'], description: 'The one we drink at the roastery. Washed caturra from a five-farm collective in Huila. Red apple, brown sugar, clean finish that holds up to milk.' },
      { key: 'sumatra', title: 'Sumatra Mandheling Wet-Hulled — 12 oz', price: 1800, stock: 0, status: 'sold_out', weight: 340, section: 'Coffee', category: 'Single Origin', subcategory: 'Asia', tags: ['sumatra', 'wet-hulled', 'earthy', 'dark'], description: 'Cedar, dark chocolate, a savoury edge people either love or refuse. Back in three weeks when the next container lands.' },
      { key: 'houseblend', title: 'Anvil House Blend — 2 lb', price: 3400, stock: 28, weight: 907, section: 'Coffee', category: 'Blends', tags: ['blend', 'espresso', 'bulk', 'chocolate'], description: 'Brazil for body, Colombia for sweetness, a little Ethiopia on top. Milk chocolate and toasted almond. The two-pound bag is the cheapest way to keep a household caffeinated.' },
      { key: 'decaf', title: 'Swiss Water Decaf Brazil — 12 oz', price: 1650, stock: 21, weight: 340, section: 'Coffee', category: 'Blends', subcategory: 'Decaf', tags: ['decaf', 'brazil', 'swiss-water'], description: 'Chemical-free decaffeination, roasted a touch darker to hold sweetness. Hazelnut and cocoa. Genuinely good after dinner, which is a low bar most decaf still trips over.' },
      { key: 'sampler', title: 'Four-Origin Sampler Box', price: 4200, stock: 14, weight: 680, section: 'Coffee', category: 'Gifts', tags: ['sampler', 'gift', 'variety'], description: 'Four 5 oz bags of whatever is singing that week, with tasting notes and brew ratios on the card. The safest gift for a coffee person whose taste you cannot guess.' },
      { key: 'grinder', title: 'Hand Grinder, Stainless Conical Burr', price: 8900, stock: 6, weight: 620, section: 'Equipment', category: 'Grinders', tags: ['grinder', 'manual', 'burr', 'travel'], description: '38 mm stainless conical burrs, 24 detents from espresso to French press. Grinds a filter dose in about 25 seconds. Fits inside an AeroPress for travel.' },
      { key: 'dripper', title: 'Ceramic Cone Dripper, Size 02', price: 2600, stock: 33, weight: 380, section: 'Equipment', category: 'Brewers', tags: ['pourover', 'ceramic', 'dripper'], description: 'Thrown and glazed two towns over. Holds heat far better than plastic; brews 250 to 500 ml. Takes any size 02 paper filter.' },
      { key: 'filters', title: 'Bleached Paper Filters, Size 02 (100 ct)', price: 800, stock: 140, weight: 120, section: 'Equipment', category: 'Consumables', tags: ['filters', 'paper', 'consumable'], description: 'Oxygen-bleached, no papery taste, no rinse required if you are in a hurry. One hundred per box.' },
      { key: 'mug', title: 'Anvil Enamel Mug, 12 oz', price: 1400, stock: 0, status: 'sold_out', weight: 260, section: 'Merch', category: 'Drinkware', tags: ['mug', 'enamel', 'camping'], description: 'Speckled enamel over steel, our anvil mark on the side. Campfire-proof, dishwasher-tolerant, chips beautifully with age. Restocking in spring.' },
    ],
  },
  {
    key: 'vintage',
    persona: 202,
    name: 'Cygnet Vintage',
    description:
      'One-of-one vintage pulled from Belgian estate sales and Italian deadstock. Everything is measured flat and photographed unretouched, flaws included. If it is listed, it is the only one.',
    location: 'Antwerp, Belgium',
    currency: 'EUR',
    policies:
      'Every piece is second-hand and sold as described — read the measurements, they beat any size label.\nReturns accepted within 14 days if the item does not match its description; buyer pays return postage otherwise.\nItems are washed or dry-cleaned before they ship.',
    contact: [
      { platform: 'email', handle: 'shop@cygnetvintage.be' },
      { platform: 'telegram', handle: '@cygnetvintage' },
    ],
    zones: [
      { name: 'Benelux', countryPattern: 'BE|NL|LU', rateType: 'flat', flatRate: 450, priority: 1 },
      { name: 'European Union', countryPattern: EU_COUNTRIES, rateType: 'flat', flatRate: 1200, priority: 2 },
      { name: 'Rest of World', rateType: 'flat', flatRate: 2600, priority: 3 },
    ],
    items: [
      { key: 'trench', title: '1970s Aquascutum Trench Coat, Club Check Lining', price: 28500, stock: 1, weight: 1800, section: 'Outerwear', category: 'Coats', tags: ['trench', '1970s', 'aquascutum', 'one-of-one'], description: 'Cotton gabardine, storm flap, original horn buttons, club check lining intact. Chest 54 cm flat, length 112 cm. One small ink mark inside the right cuff, photographed. Wears like a 40-42.' },
      { key: 'levis', title: 'Levi’s 501 Redline Selvedge, 1980s, W32', price: 19000, stock: 1, weight: 780, section: 'Denim', category: 'Jeans', tags: ['levis', '501', 'selvedge', 'redline'], description: 'Single-stitch, redline selvedge, care tag readable. Measures W32 L31 after a cold wash. Honest whiskering, no repairs, hem original.' },
      { key: 'silkscarf', title: 'Italian Silk Scarf, Hand-Rolled Hem, 1960s', price: 6500, stock: 1, weight: 90, section: 'Accessories', category: 'Scarves', tags: ['silk', 'italian', '1960s', 'hand-rolled'], description: '86 cm square, geometric print in ochre and teal, hand-rolled hem with no pulls. Unsigned. Presses flat with a cool iron and a cloth.' },
      { key: 'workjacket', title: 'French Chore Jacket, Faded Bleu de Travail', price: 12000, stock: 1, weight: 900, section: 'Outerwear', category: 'Jackets', tags: ['chore', 'french', 'workwear', 'indigo'], description: 'Moleskin cotton faded to that particular chalky blue you cannot fake. Three patch pockets, metal buttons. Chest 56 cm flat. Repaired left elbow, done well, shown in photo four.' },
      { key: 'knit', title: 'Aran Hand-Knit Fisherman Sweater, Undyed Wool', price: 14500, stock: 1, weight: 1100, section: 'Knitwear', category: 'Sweaters', tags: ['aran', 'wool', 'hand-knit', 'cream'], description: 'Honeycomb and cable panels, undyed bainin wool, knitted in Donegal. Chest 58 cm flat, sleeve 50 cm. Heavy — this is a coat replacement, not a layer.' },
      { key: 'loafers', title: 'Bass Weejun Penny Loafers, Made in USA, EU 43', price: 9500, stock: 1, weight: 950, section: 'Footwear', category: 'Shoes', tags: ['loafers', 'bass', 'leather', 'made-in-usa'], description: 'Brown leather, original leather sole with maybe half its life left, heels recently replaced. Uppers creased but sound. Marked US 10 D.' },
      { key: 'beret', title: 'Laulhère Wool Beret, Deadstock, Navy', price: 4800, stock: 3, weight: 140, section: 'Accessories', category: 'Hats', tags: ['beret', 'deadstock', 'wool', 'france'], description: 'Deadstock from a Basque maker, merino felt, leather sweatband, paper label still attached. 11.5 inch diameter. Three left from a shop clearance.' },
      { key: 'tote', title: 'Belgian Linen Market Tote, Repaired Handle', price: 3200, stock: 0, status: 'sold_out', weight: 420, section: 'Accessories', category: 'Bags', tags: ['linen', 'tote', 'repaired'], description: 'Heavy undyed linen from a Ghent market stall, one handle re-stitched by us in waxed thread. Sold — a second one may surface in autumn.' },
    ],
  },
  {
    key: 'ceramics',
    persona: 270,
    name: 'Kintsugi Ceramics',
    description:
      'Wood-fired stoneware thrown one at a time, and gold-seam repair for pots you are not ready to lose. Small kiln, small batches, long waits. Worth it, I am told.',
    location: 'Kyoto, Japan',
    currency: 'USD',
    policies:
      'Each piece is thrown and fired individually; colour and size vary by a few percent and that variance is the point.\nWe pack in straw board and double-box. If something arrives broken, send a photo within 7 days and we remake it.\nKintsugi repair commissions: mail the pieces, expect 6 to 10 weeks.',
    contact: [{ platform: 'email', handle: 'mae@kintsugiceramics.jp' }],
    zones: [
      { name: 'Japan Domestic', countryPattern: 'JP', rateType: 'flat', flatRate: 800, priority: 1 },
      {
        name: 'Worldwide Air',
        rateType: 'weight_tiered',
        priority: 2,
        tiers: { weightRate: 9, weightUnit: 'g', subtotalMultipliers: [{ upTo: 15000, percent: 100 }, { upTo: null, percent: 50 }] },
      },
    ],
    items: [
      { key: 'teabowl', title: 'Wood-Fired Chawan, Ash Glaze', price: 12000, stock: 4, weight: 480, section: 'Tea', category: 'Bowls', tags: ['chawan', 'wood-fired', 'ash-glaze', 'tea'], description: 'Five days in the anagama, unglazed foot, natural ash deposit down one side. 12 cm across, 8 cm tall, roughly 350 ml to the shoulder. No two land the same colour.' },
      { key: 'mugpair', title: 'Stoneware Mug Pair, Iron Slip', price: 8800, stock: 9, weight: 820, section: 'Table', category: 'Drinkware', tags: ['mug', 'stoneware', 'pair', 'iron'], description: 'Two mugs, iron slip under a clear glaze, pulled handles that actually fit four fingers. 320 ml each. Dishwasher and microwave safe, though the glaze prefers a hand wash.' },
      { key: 'kintsugikit', title: 'Kintsugi Repair Kit, Urushi & Brass Powder', price: 15500, stock: 6, weight: 640, section: 'Workshop', category: 'Kits', tags: ['kintsugi', 'repair', 'urushi', 'kit'], description: 'Real urushi lacquer, rice paste, brass powder, three brushes, spatula, and a 20-page guide I wrote after teaching this for six years. Enough for four or five repairs. Patch-test the lacquer: some people react to it.' },
      { key: 'vase', title: 'Bottle Vase, Celadon, 24 cm', price: 19500, stock: 3, weight: 1300, section: 'Home', category: 'Vases', tags: ['vase', 'celadon', 'bottle'], description: 'Narrow-necked bottle form in a pale celadon that pools green in the throwing rings. 24 cm tall, holds a single branch better than a bouquet.' },
      { key: 'plateset', title: 'Dinner Plate Set of Four, Matte White', price: 22000, stock: 2, weight: 3400, section: 'Table', category: 'Plates', tags: ['plates', 'set', 'matte', 'dinnerware'], description: 'Four 26 cm plates, matte white over speckled stoneware, subtly different diameters because hands are not machines. Stacks cleanly. Fires at cone 10, so they are hard to chip.' },
      { key: 'incense', title: 'Incense Holder, Gold Seam', price: 5400, stock: 11, weight: 220, section: 'Home', category: 'Objects', tags: ['incense', 'kintsugi', 'gold', 'small'], description: 'A small dish that cracked in the kiln and came back better. Gold-seam repaired by hand, sealed, safe for daily ash.' },
      { key: 'yunomi', title: 'Yunomi Tea Cup, Shino Glaze', price: 6800, stock: 0, status: 'sold_out', weight: 300, section: 'Tea', category: 'Drinkware', tags: ['yunomi', 'shino', 'tea'], description: 'Fat shino glaze with carbon trapping along the rim. 180 ml. The whole shino batch went in a day; the next firing is in six weeks.' },
    ],
  },
  {
    key: 'leather',
    persona: 271,
    name: 'Brandt Leatherworks',
    description:
      'Veg-tanned leather goods, hand-stitched with waxed linen on a stitching pony my grandfather built. No rivets where a saddle stitch will do. Everything is repairable, by me, forever.',
    location: 'Madison, Wisconsin',
    currency: 'USD',
    policies:
      'Lifetime repair on stitching, free, you cover postage one way.\nLeather is a natural material: scars, bug bites and range marks are part of the hide and are not defects.\nMade to order items ship in 3 to 5 weeks. Rush orders are not a thing here.',
    contact: [
      { platform: 'email', handle: 'tom@brandtleather.com' },
      { platform: 'signal', handle: 'brandtleather.42' },
    ],
    zones: [
      { name: 'US Domestic', countryPattern: 'US', rateType: 'flat', flatRate: 900, priority: 1 },
      { name: 'International', rateType: 'flat', flatRate: 4500, priority: 2 },
    ],
    items: [
      { key: 'bifold', title: 'Four-Pocket Bifold, Horween Dublin', price: 12500, stock: 12, weight: 90, section: 'Small Goods', category: 'Wallets', tags: ['wallet', 'bifold', 'horween', 'hand-stitched'], description: 'Horween Dublin, edges burnished to glass, saddle-stitched in brown waxed linen. Four card pockets, one bill sleeve, no liner to bulk it out. Breaks in flat in about a month.' },
      { key: 'belt', title: 'Bridle Leather Belt, 1.5 inch, Solid Brass', price: 14500, stock: 8, weight: 300, section: 'Accessories', category: 'Belts', tags: ['belt', 'bridle', 'brass', 'made-to-order'], description: 'English bridle, 10 to 11 oz, solid cast brass buckle on Chicago screws so you can swap it. Cut to your measured waist — measure over the trousers you actually wear.' },
      { key: 'totebag', title: 'Market Tote, 12 oz Canvas & Leather', price: 21000, stock: 5, weight: 1100, section: 'Bags', category: 'Totes', tags: ['tote', 'canvas', 'leather', 'bag'], description: 'Waxed 12 oz canvas body, bridle leather base and handles, brass feet. Swallows two grocery bags or a laptop and a jumper. The canvas will go soft and blotchy, which is correct.' },
      { key: 'notebook', title: 'Refillable Notebook Cover, A5', price: 9500, stock: 0, status: 'sold_out', weight: 240, section: 'Small Goods', category: 'Covers', tags: ['notebook', 'a5', 'refillable'], description: 'Fits standard A5 softcovers, elastic spine, pen loop. The hide I was cutting these from ran out; the next side is ordered.' },
      { key: 'keyfob', title: 'Key Fob, Offcut Leather, Assorted', price: 2200, stock: 26, weight: 45, section: 'Small Goods', category: 'Keychains', tags: ['keychain', 'offcut', 'cheap', 'gift'], description: 'Made from whatever is left on the bench. Colour is a surprise; the brass hardware is not. A good way to find out whether you like the leather before spending real money.' },
      { key: 'valet', title: 'Desk Valet Tray, Stitched Corners', price: 7800, stock: 7, weight: 380, section: 'Home', category: 'Trays', tags: ['valet', 'tray', 'desk', 'corners'], description: '18 cm square tray, corners pulled up and stitched, sides stiffened with a second layer. Holds keys, a watch, and whatever else you empty out of your pockets.' },
    ],
  },
  {
    key: 'botanic',
    persona: 272,
    name: 'Verdant Botanicals',
    description:
      'Herbal soaps, salves and teas from a rooftop garden in Alfama. Everything is grown, dried or infused here, except the olive oil, which comes from my aunt.',
    location: 'Lisbon, Portugal',
    currency: 'EUR',
    policies:
      'Everything is made in small batches and labelled with its batch date. Soaps cure for six weeks before they ship.\nWe cannot accept returns on opened cosmetics for hygiene reasons; if a batch disagrees with your skin, write to us and we will make it right.\nNot medical advice. Patch-test anything new.',
    contact: [
      { platform: 'email', handle: 'ola@verdantbotanicals.pt' },
      { platform: 'twitter', handle: '@verdantlx' },
    ],
    zones: [
      { name: 'Portugal', countryPattern: 'PT', rateType: 'flat', flatRate: 350, priority: 1 },
      { name: 'European Union', countryPattern: EU_COUNTRIES, rateType: 'flat', flatRate: 900, priority: 2 },
      { name: 'Rest of World', rateType: 'flat', flatRate: 2200, priority: 3 },
    ],
    items: [
      { key: 'olivesoap', title: 'Olive & Laurel Soap Bar, 120 g', price: 750, stock: 88, weight: 120, section: 'Bath', category: 'Soap', tags: ['soap', 'olive', 'laurel', 'cold-process'], description: 'Cold-process, 80 percent olive oil, 20 percent laurel berry, cured eight weeks. Almost no lather and an unreasonably good result. Unscented beyond the laurel itself.' },
      { key: 'rosemary', title: 'Rosemary & Sea Salt Soap, 120 g', price: 800, stock: 64, weight: 120, section: 'Bath', category: 'Soap', tags: ['soap', 'rosemary', 'salt', 'exfoliating'], description: 'Atlantic sea salt at 30 percent for a hard, squeaky bar, with rosemary cut from the roof. Gently scrubby. Give it a draining dish or it will dissolve in sulks.' },
      { key: 'calendula', title: 'Calendula Salve, 30 ml Tin', price: 1400, stock: 41, weight: 70, section: 'Skin', category: 'Salves', tags: ['calendula', 'salve', 'beeswax', 'dry-skin'], description: 'Calendula flowers infused in olive oil for six weeks, set with beeswax. For cracked knuckles, gardener hands and the patch of winter skin that never quite heals.' },
      { key: 'lipbalm', title: 'Beeswax Lip Balm, Unscented', price: 500, stock: 120, weight: 20, section: 'Skin', category: 'Balms', tags: ['lip-balm', 'beeswax', 'unscented'], description: 'Three ingredients: beeswax, olive oil, a little shea. No flavour, no tingle, no mystery. Melts at body temperature and stays put.' },
      { key: 'chamomile', title: 'Chamomile & Lemon Verbena Tea, 60 g', price: 1100, stock: 33, weight: 90, section: 'Kitchen', category: 'Tea', tags: ['tea', 'chamomile', 'verbena', 'caffeine-free'], description: 'Hand-picked chamomile heads and lemon verbena leaves, shade-dried. Steep 5 minutes, do not boil the life out of it. Roughly 25 cups per pouch.' },
      { key: 'mint', title: 'Moroccan Mint Tea, 60 g', price: 950, stock: 47, weight: 90, section: 'Kitchen', category: 'Tea', tags: ['tea', 'mint', 'green'], description: 'Gunpowder green cut with our own spearmint. Strong enough to survive the amount of sugar it traditionally receives.' },
      { key: 'bathsalt', title: 'Eucalyptus Bath Salt, 400 g Jar', price: 1600, stock: 19, weight: 450, section: 'Bath', category: 'Soak', tags: ['bath-salt', 'eucalyptus', 'epsom'], description: 'Epsom and coarse Atlantic salt with eucalyptus oil and dried leaf. Two handfuls per bath. The jar is reusable and we will refill it if you are local.' },
      { key: 'seedkit', title: 'Balcony Herb Seed Kit, Six Varieties', price: 1800, stock: 0, status: 'sold_out', weight: 260, section: 'Garden', category: 'Seeds', tags: ['seeds', 'herbs', 'kit', 'balcony'], description: 'Basil, parsley, coriander, thyme, oregano and the spearmint we use in the tea, with coir pellets and a planting calendar for mild climates. Next batch after the spring harvest.' },
      { key: 'candle', title: 'Beeswax Pillar Candle, 15 cm', price: 1900, stock: 24, weight: 340, section: 'Home', category: 'Candles', tags: ['candle', 'beeswax', 'unscented'], description: 'Pure beeswax from a keeper outside Sintra, cotton wick, roughly 40 hours. Smells faintly of honey and nothing else. Burns cleanly if you keep the wick short.' },
    ],
  },
  {
    key: 'analog',
    persona: 273,
    name: 'Analog Supply Co.',
    description:
      'Working film cameras, fresh film, and paper worth writing on. Everything is tested before it is listed. Shipping from Brazil is slow and I will not pretend otherwise.',
    location: 'São Paulo, Brazil',
    currency: 'USD',
    policies:
      'Cameras are tested (shutter speeds, meter, seals) and the test notes are in the listing. Sold as working unless stated.\n30-day functional warranty on bodies; light seals and batteries are consumables.\nShipping from Brazil takes 2 to 6 weeks internationally. Tracking is provided. Please do not order if you need it next week.',
    contact: [
      { platform: 'email', handle: 'raf@analogsupply.co' },
      { platform: 'telegram', handle: '@analogsupplyco' },
    ],
    zones: [
      { name: 'Brazil', countryPattern: 'BR', rateType: 'flat', flatRate: 2500, priority: 1 },
      { name: 'Worldwide Registered', rateType: 'flat', flatRate: 5500, priority: 2 },
    ],
    items: [
      { key: 'om1', title: 'Olympus OM-1n, Serviced, 50 mm f/1.8', price: 34500, stock: 2, weight: 700, section: 'Cameras', category: '35mm SLR', tags: ['olympus', 'om-1', 'slr', 'serviced'], description: 'Serviced in March: new light seals, prism cleaned, shutter within 1/3 stop at every speed. Meter reads accurately on a 1.35 V adapter (included). Zuiko 50 mm f/1.8 has clean glass, no fungus, no haze.' },
      { key: 'trip35', title: 'Olympus Trip 35, Refurbished', price: 12500, stock: 4, weight: 390, section: 'Cameras', category: 'Point & Shoot', tags: ['olympus', 'trip-35', 'zone-focus', 'no-battery'], description: 'Selenium meter still strong, seals replaced, lens cleaned. Zone focus, two shutter speeds, no batteries ever. The most forgiving camera to hand someone who has never shot film.' },
      { key: 'portra', title: 'Kodak Portra 400, 35 mm, 5-Pack', price: 7500, stock: 16, weight: 250, section: 'Film', category: 'Colour Negative', tags: ['kodak', 'portra', '400', '35mm'], description: 'Five rolls, 36 exposures, cold-stored since arrival, expiry 2027-04. Prices are what they are; I am not marking it up further.' },
      { key: 'hp5', title: 'Ilford HP5 Plus, 35 mm, 5-Pack', price: 4200, stock: 22, weight: 250, section: 'Film', category: 'Black & White', tags: ['ilford', 'hp5', 'black-and-white', '35mm'], description: 'Five rolls of the most forgiving black and white film made. Push it to 1600 and it barely complains. Expiry 2028-01.' },
      { key: 'devkit', title: 'Home Development Starter Kit', price: 15800, stock: 3, weight: 1900, section: 'Darkroom', category: 'Kits', tags: ['developing', 'kit', 'tank', 'chemistry'], description: 'Two-reel tank, thermometer, measuring cylinders, clips, changing bag, and enough D-76 and fixer for about 16 rolls. No chemistry ships by air, so this is surface post only.' },
      { key: 'notebookA6', title: 'Sewn A6 Notebook, Tomoe River 52 gsm', price: 2400, stock: 38, weight: 130, section: 'Paper', category: 'Notebooks', tags: ['notebook', 'tomoe-river', 'a6', 'fountain-pen'], description: '128 pages of 52 gsm Tomoe River, sewn signature, lays flat. No ghosting worth mentioning with a fine nib; a wet broad will show through and that is physics, not a defect.' },
      { key: 'pen', title: 'Brass Bullet Pen, Refillable', price: 3200, stock: 15, weight: 80, section: 'Paper', category: 'Pens', tags: ['pen', 'brass', 'edc', 'refillable'], description: 'Solid brass, takes a standard D1 refill, patinas in a week and looks ten years old in a month. Short enough to live in a coin pocket.' },
      { key: 'canonet', title: 'Canonet QL17 GIII, As-Is', price: 9900, stock: 0, status: 'sold_out', weight: 720, section: 'Cameras', category: 'Rangefinder', tags: ['canon', 'canonet', 'as-is', 'project'], description: 'Sold as a project: shutter fires, meter dead, seals gone, rangefinder patch faint. Sold to someone braver than me. More project bodies land most months.' },
    ],
  },
];

const STORE_BY_KEY = new Map(STORES.map((store) => [store.key, store]));


/** Shipping and billing personas for the buyer identities. */
const BUYERS = {
  bo: { persona: 201, name: 'Bo Nakamura', street: '412 Fremont St, Apt 6', city: 'Seattle', state: 'WA', postalCode: '98109', country: 'US', email: 'bo.nakamura@example.com' },
  ivy: { persona: 274, name: 'Ivy Chen', street: '88 Powell Street', city: 'Vancouver', state: 'BC', postalCode: 'V6A 1G2', country: 'CA', email: 'ivy.chen@example.com', phone: '+1 604 555 0174' },
  otto: { persona: 275, name: 'Otto Lindgren', street: 'Andra Långgatan 19', city: 'Göteborg', postalCode: '413 27', country: 'SE', email: 'otto.lindgren@example.com' },
  mae: { persona: 270, name: 'Mae Okonkwo', street: '3-14 Shinmonzen-dori', city: 'Kyoto', postalCode: '605-0087', country: 'JP', email: 'mae@kintsugiceramics.jp' },
  nia: { persona: 272, name: 'Nia Ferreira', street: 'Rua dos Remédios 42', city: 'Lisboa', postalCode: '1100-443', country: 'PT', email: 'ola@verdantbotanicals.pt' },
};

const CHAINS = {
  delivered5: ['pending', 'payment_received', 'processing', 'shipped', 'delivered'],
  delivered3: ['payment_received', 'shipped', 'delivered'],
  refunded: ['payment_received', 'processing', 'shipped', 'refunded'],
  cancelled: ['pending', 'cancelled'],
  inflight: ['pending', 'processing'],
};

/**
 * The 25 orders. `lines` are [itemKey, quantity]; `review` is the buyer's
 * store review (one per order, consensus-unique) and `items` the per-line item
 * reviews. Ratings are chosen so the ranked surfaces are legible: Kintsugi is
 * clearly top rated (4.75), Anvil & Ash is most ordered (8), Analog Supply is
 * polarising (5,1,5,1,2 → 2.8 with a bimodal distribution).
 */
const ORDERS = [
  { key: 'o01', buyer: 'bo', store: 'coffee', lines: [['ethiopia', 2], ['grinder', 1]], chain: 'delivered5', carrier: 'usps',
    review: { rating: 5, title: 'The grinder alone was worth it', content: 'Second order and the Guji is still the best natural I have had at this price. The hand grinder is overbuilt in the good way — it eats a filter dose in about twenty seconds and has not budged out of adjustment. Roast date was two days before it shipped.' },
    items: [['ethiopia', 5, 'Blueberry is not marketing here, it is just what it tastes like. Held up for three weeks in a sealed jar.'], ['grinder', 4, 'Excellent burrs, but the handle magnet is weak and it falls off in a bag. Four stars for that alone.']] },
  { key: 'o02', buyer: 'ivy', store: 'coffee', lines: [['colombia', 1], ['filters', 2]], chain: 'delivered3', carrier: 'ups',
    review: { rating: 4, title: 'Good everyday bag, slow to ship', content: 'No complaints about the coffee — the Huila is exactly the unfussy breakfast cup it claims to be. Took nine days to reach Vancouver though, and the tracking did not update for the first five.' },
    items: [['colombia', 4, 'Caramel and apple, disappears into milk nicely. Not exciting, and it is not trying to be.']] },
  { key: 'o03', buyer: 'otto', store: 'coffee', lines: [['houseblend', 1], ['mug', 1]], chain: 'delivered3', carrier: 'dhl',
    review: { rating: 5, title: 'Two pounds does not last as long as you think', content: 'Bought the big bag expecting a month and got through it in eighteen days. Chocolate and almond, forgiving on a moka pot, great as espresso if you grind coarser than you think. The enamel mug is a nice bit of tat.' },
    items: [['houseblend', 5, 'Genuinely hard to brew badly. I have tried.'], ['mug', 5, 'Chipped it in week two and it looks better for it.']] },
  { key: 'o04', buyer: 'mae', store: 'coffee', lines: [['sampler', 1]], chain: 'cancelled', carrier: null },
  { key: 'o05', buyer: 'nia', store: 'coffee', lines: [['sampler', 1], ['dripper', 1]], chain: 'delivered5', carrier: 'dhl',
    review: { rating: 5, title: 'Sampler box is the right gift', content: 'Sent this to my brother and then ordered a second one for myself. The tasting cards are actually useful — ratios and grind, not flavour poetry. Dripper arrived double-boxed and intact all the way to Lisbon.' },
    items: [['sampler', 5, 'Four bags, four genuinely different coffees, no filler origin to pad it out.']] },
  { key: 'o06', buyer: 'bo', store: 'coffee', lines: [['decaf', 1], ['dripper', 1]], chain: 'delivered3', carrier: 'usps',
    review: { rating: 4, title: 'Best decaf I have found, dripper is fine', content: 'The Swiss Water Brazil is the first decaf I have not resented. Dripper is well made but the size 02 cone is a tight fit for 500 ml, so plan on two pours.' },
    items: [['dripper', 4, 'Holds heat far better than the plastic one it replaced. Slightly too small for a full 500 ml brew.']] },
  { key: 'o07', buyer: 'otto', store: 'coffee', lines: [['sumatra', 1]], chain: 'cancelled', carrier: null },
  { key: 'o08', buyer: 'ivy', store: 'coffee', lines: [['decaf', 2], ['filters', 1]], chain: 'delivered3', carrier: 'ups',
    review: { rating: 3, title: 'Coffee good, packaging wasteful', content: 'Two bags and a box of filters arrived in a carton big enough for a bicycle, filled with paper. The coffee is fine, the decaf is genuinely good, but this is the second time and it is a lot of cardboard.' },
    items: [['decaf', 3, 'Good decaf. Second bag was noticeably flatter than the first — check your roast dates.']] },

  { key: 'o09', buyer: 'ivy', store: 'ceramics', lines: [['teabowl', 1], ['mugpair', 1]], chain: 'delivered5', carrier: 'fedex',
    review: { rating: 5, title: 'Worth the eleven-week wait', content: 'I ordered in January and it arrived in April and I would do it again. The chawan has an ash run down one side that photographs badly and looks extraordinary in person. Mae emailed me kiln photos while I waited.' },
    items: [['teabowl', 5, 'The foot is left raw and the whole thing sits perfectly. Balanced for one hand even full.'], ['mugpair', 5, 'Handles fit four fingers, which almost no handmade mug manages.']] },
  { key: 'o10', buyer: 'otto', store: 'ceramics', lines: [['kintsugikit', 1]], chain: 'delivered3', carrier: 'dhl',
    review: { rating: 5, title: 'The guide is the product', content: 'The urushi and brass are good, but the twenty-page guide is what makes this work. I repaired a bowl I had been keeping in a drawer for four years. Take the lacquer allergy warning seriously — I did not, and my forearm regretted it for a week.' },
    items: [['kintsugikit', 5, 'Enough material for four repairs and instructions written by someone who has taught this to beginners.']] },
  { key: 'o11', buyer: 'bo', store: 'ceramics', lines: [['plateset', 1], ['incense', 1]], chain: 'delivered3', carrier: 'fedex',
    review: { rating: 4, title: 'Beautiful plates, brutal shipping cost', content: 'The plates are superb — matte white over speckle, heavy, and they stack despite being hand-thrown. But 3.4 kg to Seattle cost more than one of the plates. Priced into my decision, not a surprise, but worth saying out loud.' },
    items: [['plateset', 4, 'Four plates, three slightly different diameters, all of them lovely. One had a glaze pinhole on the underside.'], ['incense', 5, 'Added at the last minute and it is the piece I look at most.']] },
  { key: 'o12', buyer: 'nia', store: 'ceramics', lines: [['vase', 1]], chain: 'refunded', carrier: 'dhl' },
  { key: 'o13', buyer: 'ivy', store: 'ceramics', lines: [['teabowl', 1], ['incense', 2]], chain: 'delivered3', carrier: 'fedex',
    review: { rating: 5, title: 'Second chawan, same standard', content: 'Ordered a second one to see how much variation there really is. Completely different colour, identical quality. The gold-seam incense dishes are small enough to give away and good enough that I did not.' },
    items: [['teabowl', 5, 'Different firing, different bowl, same care. This one came out oxblood where the first was oatmeal.'], ['incense', 4, 'Charming, and the gold seam is properly sealed. Slightly too shallow for the longer sticks.']] },

  { key: 'o14', buyer: 'otto', store: 'analog', lines: [['om1', 1], ['portra', 1]], chain: 'delivered3', carrier: 'dhl',
    review: { rating: 5, title: 'Service notes were accurate to the stop', content: 'The OM-1n arrived exactly as described: seals fresh, prism clean, meter tracking within a third of a stop against my handheld. Six weeks to Sweden, which Rafael told me up front. If you can wait, this is the best-tested body I have bought online.' },
    items: [['om1', 5, 'Shutter is quiet and accurate, glass is spotless, and the 1.35 V adapter was in the box as promised.'], ['portra', 5, 'Cold-stored, 2027 expiry, no surprises.']] },
  { key: 'o15', buyer: 'bo', store: 'analog', lines: [['devkit', 1]], chain: 'refunded', carrier: 'usps',
    review: { rating: 1, title: 'Seven weeks, then a refund', content: 'Chemistry cannot fly, which I understand, but the listing did not say surface post meant seven weeks. When it finally cleared customs the fixer had leaked into the changing bag. Rafael refunded without argument, which is the one star.' },
    items: [['devkit', 1, 'Arrived with the fixer bottle split and the changing bag ruined. Refunded, but a wasted two months.']] },
  { key: 'o16', buyer: 'ivy', store: 'analog', lines: [['trip35', 1], ['hp5', 1]], chain: 'delivered3', carrier: 'dhl',
    review: { rating: 5, title: 'Perfect camera to lend to people', content: 'Bought the Trip 35 to hand to friends who have never shot film and it has been through four rolls in three weekends. No batteries, two shutter speeds, almost impossible to get a useless frame out of it. Seals were clearly redone properly.' },
    items: [['trip35', 5, 'Selenium meter still strong, lens clean, and it costs less than a couple of rolls plus dev.']] },
  { key: 'o17', buyer: 'mae', store: 'analog', lines: [['notebookA6', 2], ['pen', 1]], chain: 'refunded', carrier: 'usps',
    review: { rating: 1, title: 'Never arrived, refunded after chasing', content: 'Tracking stopped at the São Paulo export hub in week two and never moved. It took three emails over six weeks to get a response, and the refund only came after I asked a fourth time. The stationery may well be excellent. I would not know.' },
    items: [['pen', 1, 'Cannot review what never showed up. Refund eventually issued.'], ['notebookA6', 2, 'Same order, same non-delivery. Two stars only because the refund did land in the end.']] },
  { key: 'o18', buyer: 'otto', store: 'analog', lines: [['hp5', 2], ['notebookA6', 1]], chain: 'delivered3', carrier: 'dhl',
    review: { rating: 2, title: 'Film fine, notebook crushed in transit', content: 'The HP5 is HP5 and was priced fairly. The A6 notebook arrived with a folded corner through half the block because it was packed loose against the film boxes. Small thing, but at this price it should be in a stiffener.' },
    items: [['notebookA6', 2, 'Tomoe River is lovely and the sewn binding lays flat. Mine arrived with forty crumpled pages.']] },

  { key: 'o19', buyer: 'bo', store: 'vintage', lines: [['levis', 1], ['beret', 1]], chain: 'delivered3', carrier: 'dhl',
    review: { rating: 4, title: 'Measurements were honest, wash was not mentioned', content: 'Redline is real, single-stitch is real, and the measurements matched to the centimetre — rare. They had clearly been washed hot at some point before I got them, which the listing did not say, so the fade is a little flatter than the photos suggest.' },
    items: [['levis', 4, 'Genuine 80s pair, no repairs, original hem. Slightly shorter in the leg than a modern 501 of the same tag size.'], ['beret', 5, 'Deadstock with the paper label still on it. Absurdly good for the money.']] },
  { key: 'o20', buyer: 'nia', store: 'vintage', lines: [['silkscarf', 1], ['beret', 1]], chain: 'delivered3', carrier: 'ups',
    review: { rating: 4, title: 'Lovely pieces, slow to post', content: 'Both exactly as photographed, and the scarf has a perfect hand-rolled hem with no pulls at all. Took eight days to leave Antwerp for Lisbon, which for an EU parcel is a lot of standing still.' },
    items: [['silkscarf', 4, 'Colours are true to the photos. Faint scent of storage that aired out in two days.'], ['beret', 5, 'Deadstock and it shows — the felt has not been sat on by forty years of shelf.']] },
  { key: 'o21', buyer: 'otto', store: 'vintage', lines: [['trench', 1]], chain: 'inflight', carrier: null },

  { key: 'o22', buyer: 'ivy', store: 'botanic', lines: [['olivesoap', 3], ['calendula', 1]], chain: 'delivered3', carrier: 'ups',
    review: { rating: 3, title: 'Salve is great, soap is an acquired taste', content: 'The calendula salve fixed knuckles that had been cracked since November, so that part earns its keep. The laurel soap barely lathers and smells medicinal — I knew that going in, but three bars was optimistic of me.' },
    items: [['olivesoap', 4, 'Hard bar, lasts forever, almost no lather. Buy one before you buy three.']] },
  { key: 'o23', buyer: 'mae', store: 'botanic', lines: [['chamomile', 2], ['candle', 1]], chain: 'delivered3', carrier: 'dhl',
    items: [['chamomile', 5, 'Whole flower heads, not dust. Tastes like chamomile actually should and the verbena keeps it from going flat.']] },
  { key: 'o24', buyer: 'bo', store: 'botanic', lines: [['bathsalt', 1], ['lipbalm', 2]], chain: 'refunded', carrier: 'usps',
    items: [['bathsalt', 2, 'Jar arrived cracked and half the salt was in the box. Refunded quickly and politely, but it is a heavy thing to ship in glass.']] },

  { key: 'o25', buyer: 'otto', store: 'leather', lines: [['bifold', 1], ['keyfob', 2]], chain: 'inflight', carrier: null,
    items: [['bifold', 5, 'Saddle stitch is dead even, edges are glass, and it was flat in the pocket inside a month. Worth the wait.']] },
];

/**
 * The stores the ranked surfaces are designed to showcase, derived from the
 * ORDERS table rather than hard-coded so re-balancing the data re-points the
 * verification with it.
 */
const storeOrderCount = (key) => ORDERS.filter((order) => order.store === key).length;
const storeRatings = (key) => ORDERS.filter((order) => order.store === key && order.review).map((order) => order.review.rating);
const MOST_ORDERED = STORES.reduce((best, store) => (storeOrderCount(store.key) > storeOrderCount(best.key) ? store : best));
/** Widest 1-5 spread: the store whose reviewers disagree most. */
const POLARISING = STORES.reduce((best, store) => {
  const spread = (key) => { const r = storeRatings(key); return r.length ? Math.max(...r) - Math.min(...r) : -1; };
  return spread(store.key) > spread(best.key) ? store : best;
});

// ---- Order payload encryption (ported from the app) --------------------------
//
// Byte-for-byte the checkout's scheme (lib/services/store-order-service.ts +
// private-feed-crypto-service.ts §11.5): a deterministic ephemeral key derived
// from the buyer's ENCRYPTION private key lets the buyer re-derive and read
// the order back, while the seller decrypts it with a plain ECIES as the
// recipient. Same AAD, same HKDF info strings, same wire format
// (ephemeralPubKey || XChaCha20-Poly1305 ciphertext).

const ORDER_AAD = utf8('yappr/order/v1');
const KEY_SIZE = 32;
const NONCE_SIZE = 24;
/** Compressed secp256k1 public key: the ECIES wire format's prefix length. */
const PUBKEY_SIZE = 33;

const concatBytes = (...arrays) => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};

const ecdhSharedX = (privateKey, publicKey) => secp256k1.getSharedSecret(privateKey, publicKey, true).slice(1, 1 + KEY_SIZE);

function eciesKeyAndNonce(sharedX, ephemeralPubKey) {
  const derived = hkdf(sha256, sha256(sharedX), ephemeralPubKey, utf8('yappr/ecies/v1'), KEY_SIZE + NONCE_SIZE);
  return { encKey: derived.slice(0, KEY_SIZE), nonce: derived.slice(KEY_SIZE, KEY_SIZE + NONCE_SIZE) };
}

const deriveOrderEphemeralKey = (buyerPrivateKey, nonce, storeId) =>
  hkdf(sha256, buyerPrivateKey, concatBytes(nonce, utf8(storeId)), utf8('yappr/order-eph/v1'), KEY_SIZE);

function encryptOrderPayload(payload, buyerPrivateKey, sellerPublicKey, nonce, storeId) {
  const ephemeralPrivKey = deriveOrderEphemeralKey(buyerPrivateKey, nonce, storeId);
  const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, true);
  const { encKey, nonce: aeadNonce } = eciesKeyAndNonce(ecdhSharedX(ephemeralPrivKey, sellerPublicKey), ephemeralPubKey);
  const plaintext = utf8(JSON.stringify(payload));
  return concatBytes(ephemeralPubKey, xchacha20poly1305(encKey, aeadNonce, ORDER_AAD).encrypt(plaintext));
}

/**
 * Opens `ephemeralPubKey || ciphertext` given whichever ECDH the caller could
 * reach. Both roles end here: ECDH(ephemeralPriv, sellerPub) and
 * ECDH(sellerPriv, ephemeralPub) are the same point.
 */
function openOrder(sharedX, ciphertext) {
  const ephemeralPubKey = ciphertext.slice(0, PUBKEY_SIZE);
  const { encKey, nonce } = eciesKeyAndNonce(sharedX, ephemeralPubKey);
  return JSON.parse(new TextDecoder().decode(
    xchacha20poly1305(encKey, nonce, ORDER_AAD).decrypt(ciphertext.slice(PUBKEY_SIZE))
  ));
}

/** The seller's view: plain ECIES as the recipient (what the app's seller order page does). */
const decryptAsSeller = (sellerPrivateKey, ciphertext) =>
  openOrder(ecdhSharedX(sellerPrivateKey, ciphertext.slice(0, PUBKEY_SIZE)), ciphertext);

/** The buyer's view: re-derive the ephemeral key and reach the same shared secret. */
const decryptAsBuyer = (buyerPrivateKey, sellerPublicKey, ciphertext, nonce, storeId) =>
  openOrder(ecdhSharedX(deriveOrderEphemeralKey(buyerPrivateKey, nonce, storeId), sellerPublicKey), ciphertext);

/** 24-byte order nonce, deterministic per order key so re-runs reproduce the ciphertext. */
const orderNonce = (key) => digest(`nonce/${key}`).slice(0, NONCE_SIZE);

// ---- Progress file ----------------------------------------------------------

/**
 * Document ids mix in the contract id and the owner, so a cache written for a
 * different contract names documents that do not exist here — honouring it
 * would silently skip the whole run. A mismatch starts from empty.
 */
function loadProgress(file, contractId) {
  if (!existsSync(file)) return { docs: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed.contractId && parsed.contractId !== contractId) {
      console.log(`(progress file ${file} was written for ${parsed.contractId}; ignoring it)`);
      return { docs: {} };
    }
    return { docs: parsed.docs ?? {} };
  } catch {
    return { docs: {} };
  }
}

function saveProgress(file, state, contractId) {
  const tmp = `${file}.tmp-${process.pid}`;
  const body = { contractId, updatedAt: new Date().toISOString(), docs: state.docs };
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

// ---- Document shapes (mirroring lib/services/store-*.ts) ---------------------

const storeData = (store, paymentUris) => ({
  name: store.name,
  status: 'active',
  description: store.description,
  logoUrl: logo(store.key),
  bannerUrl: photo(`${store.key}-banner`, 1200),
  paymentUris: JSON.stringify(paymentUris),
  defaultCurrency: store.currency,
  policies: store.policies,
  location: store.location,
  contactMethods: JSON.stringify(store.contact),
});

function itemData(store, item, storeIdBytes) {
  const rng = rngFor(`sku/${store.key}/${item.key}`);
  const sku = `${store.key.slice(0, 3).toUpperCase()}-${item.key.slice(0, 4).toUpperCase()}-${Math.floor(rng() * 9000 + 1000)}`;
  const imageCount = 2 + Math.floor(rng() * 3);
  return {
    storeId: storeIdBytes,
    title: item.title,
    status: item.status ?? 'active',
    description: item.description,
    section: item.section,
    category: item.category,
    ...(item.subcategory ? { subcategory: item.subcategory } : {}),
    tags: JSON.stringify(item.tags),
    imageUrls: JSON.stringify(Array.from({ length: imageCount }, (_, n) => photo(`${store.key}-${item.key}-${n}`, 800))),
    basePrice: item.price,
    currency: store.currency,
    weight: item.weight,
    stockQuantity: item.stock,
    sku,
  };
}

const zoneData = (zone, store, storeIdBytes) => ({
  storeId: storeIdBytes,
  name: zone.name,
  rateType: zone.rateType,
  ...(zone.flatRate !== undefined ? { flatRate: zone.flatRate } : {}),
  ...(zone.tiers ? { tiers: JSON.stringify(zone.tiers) } : {}),
  ...(zone.countryPattern ? { countryPattern: zone.countryPattern } : {}),
  currency: store.currency,
  priority: zone.priority,
});

/**
 * The app's shipping maths, ported from lib/services/shipping-zone-service.ts
 * and lib/utils/weight.ts so a seeded order's `shippingCost` is the number the
 * store page quotes for the same address and basket.
 */
const WEIGHT_UNITS = { g: 1, oz: 28.3495, lb: 453.592, kg: 1000 };

/** Lowest-priority zone whose country pattern covers the address; absent pattern matches all. */
function findMatchingZone(zones, country) {
  const matches = (pattern) => {
    if (!pattern) return true;
    try {
      return new RegExp(`^(${pattern})$`, 'i').test(country);
    } catch {
      return false;
    }
  };
  return [...zones].sort((a, b) => a.priority - b.priority).find((zone) => matches(zone.countryPattern)) ?? null;
}

/** `(flatRate + weight x weightRate) x multiplier` for the combined config, else the flat rate. */
function zoneRate(zone, { totalWeight, subtotal }) {
  const config = zone.tiers && !Array.isArray(zone.tiers) ? zone.tiers : null;
  if (config) {
    const gramsPerUnit = WEIGHT_UNITS[(config.weightUnit ?? 'lb').toLowerCase()] ?? 1;
    const weightCharge = config.weightRate > 0 ? Math.round((totalWeight / gramsPerUnit) * config.weightRate) : 0;
    const tier = [...(config.subtotalMultipliers ?? [])]
      .sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : a.upTo - b.upTo))
      .find((t) => t.upTo === null || subtotal <= t.upTo);
    return Math.round(((zone.flatRate ?? 0) + weightCharge) * ((tier?.percent ?? 100) / 100));
  }
  return zone.rateType === 'flat' ? zone.flatRate ?? 0 : 0;
}

/** The OrderPayload the app's checkout builds, before encryption. */
function orderPayload(order, store, buyer, paymentUri, itemIdFor) {
  const rng = rngFor(`payload/${order.key}`);
  const items = order.lines.map(([itemKey, quantity]) => {
    const item = store.items.find((candidate) => candidate.key === itemKey);
    return {
      itemId: itemIdFor(itemKey),
      itemTitle: item.title,
      quantity,
      unitPrice: item.price,
      imageUrl: photo(`${store.key}-${item.key}-0`, 800),
    };
  });
  const subtotal = items.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const totalWeight = order.lines.reduce((sum, [itemKey, quantity]) =>
    sum + (store.items.find((candidate) => candidate.key === itemKey).weight ?? 0) * quantity, 0);
  const zone = findMatchingZone(store.zones, buyer.country);
  if (!zone) throw new Error(`order ${order.key}: ${store.name} has no shipping zone covering ${buyer.country}`);
  const shippingCost = zoneRate(zone, { totalWeight, subtotal });
  return {
    items,
    shippingAddress: { name: buyer.name, street: buyer.street, city: buyer.city, ...(buyer.state ? { state: buyer.state } : {}), postalCode: buyer.postalCode, country: buyer.country },
    buyerContact: { email: buyer.email, ...(buyer.phone ? { phone: buyer.phone } : {}) },
    subtotal,
    shippingCost,
    total: subtotal + shippingCost,
    currency: store.currency,
    paymentUri,
    txid: Array.from(digest(`txid/${order.key}`)).map((b) => b.toString(16).padStart(2, '0')).join(''),
    ...(rng() < 0.35 ? { notes: pick(rng, ['Please leave with the neighbour if I am out.', 'No rush — away until the 20th.', 'Gift: please skip the invoice in the box.', 'Buzzer is broken, call on arrival.']) } : {}),
  };
}

const STATUS_MESSAGE = {
  pending: ['Order received — thank you!', 'Got it, thanks. Payment not seen yet.', 'Order logged, waiting on payment confirmation.'],
  payment_received: ['Payment confirmed, thank you.', 'Payment seen on chain, moving to packing.', 'Paid in full — queued for packing.'],
  processing: ['Packing this today.', 'Roasting/packing in progress.', 'Being made up now, should go out tomorrow.'],
  shipped: ['On its way.', 'Handed to the carrier this afternoon.', 'Shipped — tracking attached.'],
  delivered: ['Marked delivered by the carrier. Enjoy!', 'Delivery scan received. Any problems, just reply.', 'Delivered — thanks for the order.'],
  cancelled: ['Cancelled at the buyer’s request, nothing was charged.', 'Cancelled — the item sold out before payment cleared. Sorry about that.'],
  refunded: ['Refunded in full today. Sorry for the trouble.', 'Refund sent — apologies, this one went wrong at our end.'],
};

// ---- Scheduling -------------------------------------------------------------

/** Runs each actor's task list sequentially (identity nonce) and the actors in parallel. */
async function runByActor(groups, concurrency) {
  const queues = [...groups.entries()];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, queues.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= queues.length) return;
      for (const task of queues[index][1]) await task();
    }
  });
  await Promise.all(workers);
}

/** Buckets `{actor, run}` tasks into one sequential queue per actor. */
function groupBy(tasks) {
  const groups = new Map();
  for (const { actor, run } of tasks) {
    if (!groups.has(actor)) groups.set(actor, []);
    groups.get(actor).push(run);
  }
  return groups;
}

// ---- Main -------------------------------------------------------------------

function parseArgs(argv) {
  const env = readEnvFile(join(REPO_ROOT, '.env.devnet'));
  const args = {
    contract: process.env.STOREFRONT_V2_CONTRACT_ID?.trim() || env.NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID || null,
    progress: PROGRESS_FILE,
    concurrency: 8,
    dryRun: false,
    verifyOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--progress': args.progress = argv[++i]; break;
      case '--concurrency': args.concurrency = Number(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
      case '--verify-only': args.verifyOnly = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error('Pass --contract <id> or set NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID');
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return args;
}

/** Mean of a per-store bucket's seeded ratings, 0 when the store has none. */
const averageRating = (bucket) =>
  bucket.ratings.length ? bucket.ratings.reduce((a, b) => a + b, 0) / bucket.ratings.length : 0;

/** What the run intends to write, computed from the tables alone (also the --dry-run report). */
function plan() {
  const perStore = new Map(STORES.map((store) => [store.key, { orders: 0, ratings: [] }]));
  for (const order of ORDERS) {
    const bucket = perStore.get(order.store);
    bucket.orders += 1;
    if (order.review) bucket.ratings.push(order.review.rating);
  }
  return {
    stores: STORES.length,
    items: STORES.reduce((n, store) => n + store.items.length, 0),
    zones: STORES.reduce((n, store) => n + store.zones.length, 0),
    orders: ORDERS.length,
    statuses: ORDERS.reduce((n, order) => n + CHAINS[order.chain].length, 0),
    storeReviews: ORDERS.filter((order) => order.review).length,
    itemReviews: ORDERS.reduce((n, order) => n + (order.items ?? []).length, 0),
    perStore,
  };
}

function printPlan(p) {
  console.log('\nplanned writes');
  console.log(`  store ${p.stores}  storeItem ${p.items}  shippingZone ${p.zones}  storeOrder ${p.orders}`);
  console.log(`  orderStatusUpdate ${p.statuses}  storeReview ${p.storeReviews}  itemReview ${p.itemReviews}`);
  console.log(`  total ${p.stores + p.items + p.zones + p.orders + p.statuses + p.storeReviews + p.itemReviews} documents; YAPP ${p.storeReviews * 3 + p.itemReviews}`);
  console.log('\nstore                      persona  items  orders  reviews  expected avg');
  for (const store of STORES) {
    const bucket = p.perStore.get(store.key);
    const avg = bucket.ratings.length ? averageRating(bucket).toFixed(2) : '   —';
    console.log(`  ${store.name.padEnd(24)} ${String(store.persona).padEnd(8)} ${String(store.items.length).padEnd(6)} ${String(bucket.orders).padEnd(7)} ${String(bucket.ratings.length).padEnd(8)} ${avg}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const p = plan();
  if (args.dryRun) {
    console.log(`DRY RUN — storefront v2 ${args.contract}`);
    printPlan(p);
    console.log('\nnothing broadcast.');
    return 0;
  }

  await ensureInitialized();
  const socialId = socialContractId();
  const handle = createSdkHandle({ contractIds: [socialId, args.contract] });
  const { protocolVersion } = await handle.connect();
  console.log(`connected (PV${protocolVersion}); storefront v2 ${args.contract}; YAPP from ${socialId}`);
  const battery = createBattery({ handle, contractId: args.contract, socialId });
  const { sdk, check, personaActor, attemptWrite, attemptReplace, attemptDelete, fetchDocument, paymentInfo, ensureYapp, queryDocs, ranked, averageBy, countBy, groupedCount, b58, report } = battery;
  const tokenId = await battery.readback(() => sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));

  const ledger = loadLedger();
  const personaIndexes = [...new Set([...STORES.map((s) => s.persona), ...Object.values(BUYERS).map((b) => b.persona)])];
  const actors = new Map();
  for (const idx of personaIndexes) actors.set(idx, await personaActor(idx));
  const encryptionKey = (idx, field) => {
    const key = ledgerEntry(ledger, idx)?.identityKeys?.find((k) => k.purpose === 'encryption');
    if (!key) throw new Error(`persona ${idx} has no encryption key in the ledger`);
    return Uint8Array.from(Buffer.from(key[field], 'hex'));
  };
  const payoutAddress = (idx) => {
    const key = ledgerEntry(ledger, idx)?.identityKeys?.find((k) => k.purpose === 'transfer');
    if (!key) throw new Error(`persona ${idx} has no transfer key in the ledger`);
    return addressFor(key.publicKeyHex);
  };
  console.log(`actors: ${personaIndexes.map((idx) => actors.get(idx).label).join(', ')}`);

  const progress = loadProgress(args.progress, args.contract);
  const written = { store: 0, storeItem: 0, shippingZone: 0, storeOrder: 0, orderStatusUpdate: 0, storeReview: 0, itemReview: 0 };
  const reused = { ...written };
  const failed = [];
  let pruned = 0;
  const flush = () => saveProgress(args.progress, progress, args.contract);
  const recordDoc = (key, docType, id) => { progress.docs[key] = { type: docType, id }; flush(); };
  /** One dependency phase: each actor's tasks in order, actors in parallel. */
  const runPhase = (tasks) => runByActor(groupBy(tasks), args.concurrency);

  /**
   * True when the on-chain document's scalar fields no longer match the table:
   * a changed value, or a field the table has since DROPPED (removing
   * `countryPattern` is exactly how a zone becomes a catch-all). Byte arrays
   * are index keys and never move, so they are not compared.
   */
  const drifted = (data, current) => {
    const scalars = (o) => Object.entries(o).filter(([f, v]) => !f.startsWith('$') && typeof v !== 'object');
    // Platform hands integers back as BigInt; compare by value, or every
    // numeric field looks changed and every re-run rewrites the document.
    const same = (a, b) =>
      typeof a === 'bigint' || typeof b === 'bigint' ? BigInt(a ?? 0) === BigInt(b ?? 0) : a === b;
    return scalars(data).some(([field, value]) => !same(current[field], value))
      || scalars(current).some(([field]) => !(field in data));
  };

  /**
   * Creates one document with a key-derived id, so a retry of a broadcast that
   * DID land converges on the same document instead of duplicating it.
   * Returns the document id either way.
   *
   * `reconcile` additionally REPLACES an existing document whose fields have
   * drifted from the table. Only pass it for a mutable doctype: `storeOrder`,
   * `orderStatusUpdate`, `storeReview` and `itemReview` are
   * `documentsMutable: false`, so their content is fixed at creation and a
   * corrected table can only reach the chain on a fresh contract.
   */
  async function createDoc(actor, docType, key, data, { tokenCost, reconcile } = {}) {
    const recorded = progress.docs[key];
    if (recorded?.id && !reconcile) { reused[docType] += 1; return recorded.id; }
    const { document, id } = buildDocument({
      contractId: args.contract, docType, ownerId: actor.ownerId, data, entropy: entropyFor(key),
    });
    const current = await fetchDocument(docType, id);
    if (current) {
      recordDoc(key, docType, id);
      const currentData = current.toObject ? current.toObject() : current;
      if (reconcile && drifted(data, currentData)) {
        const outcome = await attemptReplace(actor, docType, id, data, currentData.$revision ?? 1);
        if (outcome.ok) { written[docType] += 1; console.log(`  updated ${docType} ${key}`); return id; }
        failed.push({ key, docType, error: (outcome.error ?? '').slice(0, 200) });
      }
      reused[docType] += 1;
      return id;
    }
    const outcome = await attemptWrite(
      { accepted: async () => (await fetchDocument(docType, id)) !== null },
      () => sdk.documents.create({ document, identityKey: actor.identityKey, signer: actor.signer, ...paymentInfo(tokenCost) })
    );
    if (!outcome.ok) {
      failed.push({ key, docType, error: (outcome.error ?? '').slice(0, 200) });
      console.log(`  FAIL ${docType} ${key}: ${(outcome.error ?? '').slice(0, 160)}`);
      return null;
    }
    recordDoc(key, docType, id);
    written[docType] += 1;
    return id;
  }

  const storeIds = new Map();
  const itemIds = new Map();
  const orderIds = new Map();

  if (!args.verifyOnly) {
    // --- phase 1: stores (one per seller; `store` is unique per $ownerId) ----
    console.log('\n--- phase 1: stores ---');
    await runPhase(
    STORES.map((store) => ({
      actor: store.persona,
      run: async () => {
        const actor = actors.get(store.persona);
        const uris = [{ scheme: 'dash:', uri: `dash:${payoutAddress(store.persona)}`, label: `${store.name} (Dash)` }];
        const data = storeData(store, uris);
        const existing = await queryDocs('store', { where: [['$ownerId', '==', actor.ownerId]], orderBy: [['$ownerId', 'asc']], limit: 1 });
        if (existing.length > 0) {
          const current = existing[0];
          const id = b58(current.$id);
          storeIds.set(store.key, id);
          recordDoc(`store/${store.key}`, 'store', id);
          if (current.name === store.name) { reused.store += 1; return; }
          // The registration battery's placeholder store occupies the slot:
          // rewrite it in place (stores cannot be deleted).
          const outcome = await attemptReplace(actor, 'store', id, data, current.$revision ?? 1);
          if (outcome.ok) { written.store += 1; console.log(`  rewrote ${current.name} → ${store.name}`); }
          else failed.push({ key: `store/${store.key}`, docType: 'store', error: (outcome.error ?? '').slice(0, 200) });
          return;
        }
        const id = await createDoc(actor, 'store', `store/${store.key}`, data);
        if (id) storeIds.set(store.key, id);
      },
    }))
    );
    for (const store of STORES) if (!storeIds.has(store.key)) throw new Error(`store ${store.key} was not created; cannot continue`);

    // --- phase 2: catalog + shipping zones ----------------------------------
    console.log('\n--- phase 2: items and shipping zones ---');
    await runPhase(
    STORES.map((store) => ({
      actor: store.persona,
      run: async () => {
        const actor = actors.get(store.persona);
        const storeIdBytes = id32(storeIds.get(store.key));
        for (const item of store.items) {
          const id = await createDoc(actor, 'storeItem', `item/${store.key}/${item.key}`, itemData(store, item, storeIdBytes));
          if (id) itemIds.set(`${store.key}/${item.key}`, id);
        }
        for (const zone of store.zones) {
          await createDoc(actor, 'shippingZone', `zone/${store.key}/${zone.name}`, zoneData(zone, store, storeIdBytes), { reconcile: true });
        }
        // The registration battery leaves `zone<runid>` fixtures on the stores it
        // reused (personas 200/202), all at priority 1 with no country pattern —
        // so they SHADOW the real zones in the app's priority sort and quote the
        // wrong rate. This table is the store's whole zone list.
        const named = new Set(store.zones.map((zone) => zone.name));
        const onChain = await queryDocs('shippingZone', {
          where: [['storeId', '==', storeIds.get(store.key)]],
          orderBy: [['storeId', 'asc'], ['priority', 'asc']], limit: 100,
        });
        for (const zone of onChain) {
          if (named.has(zone.name) || b58(zone.$ownerId) !== actor.ownerId) continue;
          const outcome = await attemptDelete(actor, 'shippingZone', b58(zone.$id));
          if (outcome.ok) { pruned += 1; console.log(`  pruned stale shippingZone "${zone.name}" from ${store.name}`); }
          else failed.push({ key: `zone-prune/${store.key}/${zone.name}`, docType: 'shippingZone', error: (outcome.error ?? '').slice(0, 200) });
        }
      },
    }))
    );

    // --- phase 3: orders, encrypted to the seller ---------------------------
    console.log('\n--- phase 3: orders ---');
    let cryptoVerified = 0;
    await runPhase(
    ORDERS.map((order) => ({
      actor: BUYERS[order.buyer].persona,
      run: async () => {
        const store = STORE_BY_KEY.get(order.store);
        const buyer = BUYERS[order.buyer];
        const actor = actors.get(buyer.persona);
        const storeId = storeIds.get(store.key);
        const payload = orderPayload(order, store, buyer, `dash:${payoutAddress(store.persona)}`, (itemKey) => itemIds.get(`${store.key}/${itemKey}`) ?? '');
        const nonce = orderNonce(order.key);
        const buyerPriv = encryptionKey(buyer.persona, 'privateKeyHex');
        const sellerPub = encryptionKey(store.persona, 'publicKeyHex');
        const encryptedPayload = encryptOrderPayload(payload, buyerPriv, sellerPub, nonce, storeId);
        // Prove the ciphertext is the real thing both parties can open.
        const asSeller = decryptAsSeller(encryptionKey(store.persona, 'privateKeyHex'), encryptedPayload);
        const asBuyer = decryptAsBuyer(buyerPriv, sellerPub, encryptedPayload, nonce, storeId);
        if (JSON.stringify(asSeller) !== JSON.stringify(payload) || JSON.stringify(asBuyer) !== JSON.stringify(payload)) {
          throw new Error(`order ${order.key}: round-trip decryption mismatch`);
        }
        cryptoVerified += 1;
        const id = await createDoc(actor, 'storeOrder', `order/${order.key}`, {
          storeId: id32(storeId),
          // Must equal the store's own $ownerId or consensus rejects (40127).
          sellerId: id32(actors.get(store.persona).ownerId),
          encryptedPayload,
          nonce,
        });
        if (id) orderIds.set(order.key, id);
      },
    }))
    );
    console.log(`  ${cryptoVerified} order payloads encrypted and round-tripped (seller ECIES + buyer re-derived ephemeral)`);

    // --- phase 4: status chains, written by the seller ----------------------
    console.log('\n--- phase 4: order status updates ---');
    await runPhase(
    STORES.map((store) => ({
      actor: store.persona,
      run: async () => {
        const actor = actors.get(store.persona);
        for (const order of ORDERS.filter((o) => o.store === store.key)) {
          const orderId = orderIds.get(order.key);
          if (!orderId) continue;
          const buyerActor = actors.get(BUYERS[order.buyer].persona);
          for (const status of CHAINS[order.chain]) {
            const rng = rngFor(`status/${order.key}/${status}`);
            // Only the order's seller may write one: `actor` IS the store
            // persona, which the writer gate checks against the order's sellerId.
            await createDoc(actor, 'orderStatusUpdate', `status/${order.key}/${status}`, {
              orderId: id32(orderId),
              buyerId: id32(buyerActor.ownerId),
              status,
              message: pick(rng, STATUS_MESSAGE[status]),
              ...(status === 'shipped' && order.carrier
                ? { trackingCarrier: order.carrier, trackingNumber: trackingFor(order.key, order.carrier) }
                : {}),
            });
          }
        }
      },
    }))
    );

    // --- phase 5: reviews (3 YAPP store, 1 YAPP item) -----------------------
    console.log('\n--- phase 5: reviews ---');
    const needed = new Map();
    for (const order of ORDERS) {
      const persona = BUYERS[order.buyer].persona;
      const cost = (order.review ? REVIEW_COST.storeReview : 0n) + BigInt((order.items ?? []).length) * REVIEW_COST.itemReview;
      needed.set(persona, (needed.get(persona) ?? 0n) + cost);
    }
    for (const [persona, cost] of needed) {
      const actor = actors.get(persona);
      const balance = await ensureYapp(tokenId, actor, cost + YAPP_HEADROOM);
      console.log(`  ${actor.label}: ${balance} YAPP (needs ${cost})`);
      // ensureYapp swallows purchase failures; without the tokens every review
      // below would be refused, so stop before broadcasting ~50 doomed writes.
      if (balance < cost) throw new Error(`${actor.label} holds ${balance} YAPP but this run needs ${cost}`);
    }
    await runPhase(
    ORDERS.map((order) => ({
      actor: BUYERS[order.buyer].persona,
      run: async () => {
        const store = STORE_BY_KEY.get(order.store);
        const actor = actors.get(BUYERS[order.buyer].persona);
        const orderId = orderIds.get(order.key);
        if (!orderId) return;
        const storeIdBytes = id32(storeIds.get(store.key));
        if (order.review) {
          await createDoc(actor, 'storeReview', `review/${order.key}`, {
            storeId: storeIdBytes,
            orderId: id32(orderId),
            sellerId: id32(actors.get(store.persona).ownerId),
            rating: order.review.rating,
            title: order.review.title,
            content: order.review.content,
          }, { tokenCost: REVIEW_COST.storeReview });
        }
        for (const [itemKey, rating, content] of order.items ?? []) {
          const itemId = itemIds.get(`${store.key}/${itemKey}`);
          if (!itemId) continue;
          await createDoc(actor, 'itemReview', `itemreview/${order.key}/${itemKey}`, {
            storeId: storeIdBytes,
            itemId: id32(itemId),
            orderId: id32(orderId),
            rating,
            content,
          }, { tokenCost: REVIEW_COST.itemReview });
        }
      },
    }))
    );
  } else {
    if (Object.keys(progress.docs).length === 0) {
      throw new Error(`--verify-only needs a progress file for this contract; ${args.progress} has no entries`);
    }
    for (const [key, record] of Object.entries(progress.docs)) {
      const [kind, ...rest] = key.split('/');
      if (kind === 'store') storeIds.set(rest[0], record.id);
      if (kind === 'item') itemIds.set(rest.join('/'), record.id);
      if (kind === 'order') orderIds.set(rest[0], record.id);
    }
  }

  // --- verification: the shapes lib/services/store-stats-service.ts issues ---
  console.log('\n--- verification: reading back through the app’s query shapes ---');
  const expected = p.perStore;
  const directory = await queryDocs('store', { where: [['$ownerId', 'in', STORES.map((s) => actors.get(s.persona).ownerId)]], orderBy: [['$ownerId', 'asc']], limit: 50 });
  check('store directory lists every seeded store', directory.length >= STORES.length, `${directory.length} stores`);

  // Stores 200 and 202 also carry the registration battery's fixtures, so every
  // total is "at least what this seeder wrote". The average is checked against
  // the review documents themselves, which holds whatever else is on the store.
  for (const store of STORES) {
    const storeId = storeIds.get(store.key);
    if (!storeId) { check(`${store.name}: store id known`, false); continue; }
    const items = await queryDocs('storeItem', { where: [['storeId', '==', storeId]], orderBy: [['storeId', 'asc'], ['$createdAt', 'asc']], limit: 100 });
    const reviews = await queryDocs('storeReview', { where: [['storeId', '==', storeId]], orderBy: [['storeId', 'asc'], ['$createdAt', 'asc']], limit: 100 });
    const avg = await averageBy('storeReview', 'rating', [['storeId', '==', storeId]]);
    const orders = await countBy('storeOrder', [['storeId', '==', storeId]]);
    const bucket = expected.get(store.key);
    const scanned = reviews.reduce((sum, review) => sum + review.rating, 0);
    const got = avg.count ? avg.sum / avg.count : 0;
    const extra = items.length - store.items.length;
    check(
      `${store.name}: ${items.length} items, ${orders} orders, ${avg.count} reviews, avg ${got.toFixed(2)}${extra > 0 ? ` (+${extra} battery fixtures)` : ''}`,
      items.length >= store.items.length && orders >= bucket.orders && avg.count >= bucket.ratings.length && avg.count === reviews.length && avg.sum === scanned,
      `seeded items=${store.items.length} orders=${bucket.orders} reviews=${bucket.ratings.length}; proved average tree {count:${avg.count},sum:${avg.sum}} vs scanned {count:${reviews.length},sum:${scanned}}`
    );
  }

  const topStoreKey = [...expected.entries()].sort((a, b) => averageRating(b[1]) - averageRating(a[1]))[0][0];
  const topRated = await ranked('storeReview', 'storeId', { type: 'avg', property: 'rating' }, { direction: 'desc', limit: 20 });
  const mostOrdered = await ranked('storeOrder', 'storeId', { type: 'count' }, { direction: 'desc', limit: 20 });
  const nameOf = (id) => STORES.find((s) => storeIds.get(s.key) === id)?.name ?? `${id.slice(0, 8)}…`;

  console.log('\ntop rated stores (documents.ranked, avg over storeReview.rating)');
  for (const entry of topRated.page.entries.slice(0, 10)) {
    console.log(`  ${(Number(entry.value) / Number(topRated.page.valueScale)).toFixed(2)}  ${nameOf(entry.groupValue)}`);
  }
  console.log('\nmost ordered stores (documents.ranked, count over storeOrder)');
  for (const entry of mostOrdered.page.entries.slice(0, 10)) {
    console.log(`  ${String(entry.value).padStart(3)}  ${nameOf(entry.groupValue)}`);
  }

  // Rankings are contract-global, so assert the order among OUR stores rather
  // than the first row overall — other owners (the registration battery) rank too.
  const ours = new Set([...storeIds.values()]);
  const firstOfOurs = (page) => nameOf(page.entries.find((entry) => ours.has(entry.groupValue))?.groupValue ?? '');
  const topRatedFirst = firstOfOurs(topRated.page);
  const mostOrderedFirst = firstOfOurs(mostOrdered.page);
  const intendedTop = STORE_BY_KEY.get(topStoreKey).name;
  check('top-rated ranking puts the intended store first among the seeded stores', topRatedFirst === intendedTop, `first=${topRatedFirst} expected=${intendedTop}`);
  check(`most-ordered ranking puts ${MOST_ORDERED.name} first among the seeded stores`, mostOrderedFirst === MOST_ORDERED.name, `first=${mostOrderedFirst}`);

  const distribution = await groupedCount('storeReview', [['storeId', '==', storeIds.get(POLARISING.key)], ['rating', 'in', [1, 2, 3, 4, 5]]], ['rating'], (hex) => parseInt(hex, 16) - 0x80);
  console.log(`\n${POLARISING.name} rating distribution: ${[1, 2, 3, 4, 5].map((r) => `${r}★ ${distribution.get(r) ?? 0}`).join('  ')}`);
  check(`${POLARISING.name} is bimodal (1★ and 5★ both present)`, (distribution.get(1) ?? 0) > 0 && (distribution.get(5) ?? 0) > 0);

  const topItems = await ranked('itemReview', 'itemId', { type: 'avg', property: 'rating' }, { where: [['storeId', '==', storeIds.get(MOST_ORDERED.key)]], direction: 'desc', limit: 20 });
  const itemNameOf = (id) => {
    for (const [key, value] of itemIds) {
      if (value !== id) continue;
      const [storeKey, itemKey] = key.split('/');
      return STORE_BY_KEY.get(storeKey).items.find((item) => item.key === itemKey).title;
    }
    return `${id.slice(0, 8)}…`;
  };
  console.log(`\ntop items in ${MOST_ORDERED.name} (documents.ranked, store-pinned)`);
  for (const entry of topItems.page.entries.slice(0, 6)) {
    console.log(`  ${(Number(entry.value) / Number(topItems.page.valueScale)).toFixed(2)}  ${itemNameOf(entry.groupValue)}`);
  }
  check('store-pinned item ranking returns items', topItems.page.entries.length > 0, `${topItems.page.entries.length} rated items`);

  // --- summary --------------------------------------------------------------
  console.log('\n--- documents ---');
  console.log('doctype              written  already present');
  for (const docType of Object.keys(written)) {
    console.log(`  ${docType.padEnd(20)} ${String(written[docType]).padEnd(8)} ${reused[docType]}`);
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${String(Object.values(written).reduce((a, b) => a + b, 0)).padEnd(8)} ${Object.values(reused).reduce((a, b) => a + b, 0)}`);
  if (pruned > 0) console.log(`  ${pruned} stale shipping zone(s) pruned`);

  console.log('\n--- personas ---');
  console.log('persona  handle             role            credits              YAPP');
  for (const idx of personaIndexes) {
    const actor = actors.get(idx);
    const credits = await battery.readback(() => sdk.identities.balance(actor.ownerId));
    const yapp = await battery.yappBalance(tokenId, actor.ownerId);
    const role = [
      STORES.some((store) => store.persona === idx) ? 'seller' : null,
      Object.values(BUYERS).some((buyer) => buyer.persona === idx) ? 'buyer' : null,
    ].filter(Boolean).join('+');
    console.log(`  ${String(idx).padEnd(8)} ${ledgerEntry(ledger, idx).handle.padEnd(18)} ${role.padEnd(15)} ${String(credits).padEnd(20)} ${yapp}`);
  }

  if (failed.length > 0) {
    console.log(`\n--- ${failed.length} write(s) failed ---`);
    for (const f of failed) console.log(`  ${f.docType} ${f.key}: ${f.error}`);
  }
  return report(`progress: ${args.progress}`) + failed.length;
}

try {
  process.exit((await main()) === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
