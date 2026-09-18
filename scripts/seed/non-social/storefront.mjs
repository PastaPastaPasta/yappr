/**
 * Storefront: stores, catalogs, shipping zones, orders, status histories and reviews, in the shape the APP writes
 * them (`lib/services/store-*.ts`) — JSON-string `tags`/`imageUrls`/`paymentUris`/`contactMethods`, integer minor-
 * unit prices, raw 32-byte identifiers, and orders encrypted to the seller with the checkout's real deterministic-
 * ephemeral ECIES. The buyer is an order's `$ownerId` (there is no buyerId copy) and `sellerId` is consensus-checked
 * against the store owner, so a review must come from that order's buyer with matching `sellerId`/`storeId` or the
 * writer gate refuses it. Orders, status updates and reviews are `documentsMutable: false`: editing the tables below
 * only affects a fresh contract.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { getPublicKey, getSharedSecret } from '@noble/secp256k1';
import { decodeIntGroupKey, id32, normalizeId, reportSelfTest } from '../../battery-lib.mjs';
import { YAPP_TOKEN_POSITION, addressFor, ledgerEntry } from '../seed-lib.mjs';
import {
  actorsFor, counts, createDocWriter, createRecorder, ensureTokens, entropySource, fakeId, loadCheckpoint,
  loadLedger, network, personaKeys, phaseRunner, pick, printTable, rngFrom, utf8,
} from '../feature-seed-lib.mjs';

const REVIEW_COST = { storeReview: 3n, itemReview: 1n };
/** Headroom over the computed review spend so a partial re-run never stalls on YAPP. */
const YAPP_HEADROOM = 20n;
const digest = (key) => sha256(utf8(`yappr/storefront-seed/v1/${key}`));
const photo = (seed, size = 900) => `https://picsum.photos/seed/${seed}/${size}/${size}`;

/**
 * The app matches a zone by testing `countryPattern` as `^(pattern)$` against the ISO-3166 alpha-2 country (shipping-
 * zone-service.ts), so a zone must spell its countries out; `'EU'` and `'*'` match nobody, and a store whose zones
 * all miss BLOCKS checkout (app/checkout/page.tsx). An ABSENT pattern matches all.
 */
const EU = 'AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|GR|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE';

const STORES = [
  { key: 'coffee', persona: 200, name: 'Anvil & Ash Coffee', location: 'Portland, Oregon', currency: 'USD',
    description: 'Small-batch coffee roasted on a drum we rebuilt from a scrapyard find. Single origins rotate every Tuesday; the house blends never move. Roasted the day it ships, which is most days.',
    policies: 'Roasting & shipping: bags leave the roastery within 48 hours of roasting, Monday to Thursday.\nReturns: unopened bags within 30 days for a full refund. If a bag arrives stale or damaged, tell us and we will replace it.\nWholesale: five bags or more, get in touch before ordering.',
    contact: [{ platform: 'email', handle: 'hello@anvilash.coffee' }, { platform: 'twitter', handle: '@anvilash' }],
    zones: [{ name: 'US Domestic', countryPattern: 'US', rateType: 'flat', flatRate: 600, priority: 1 },
      { name: 'Canada & Mexico', countryPattern: 'CA|MX', rateType: 'flat', flatRate: 1600, priority: 2 },
      { name: 'Rest of World', rateType: 'flat', flatRate: 3200, priority: 3 }],
    items: [
      { key: 'ethiopia', title: 'Ethiopia Guji Natural — 12 oz', price: 1900, stock: 42, weight: 340, section: 'Coffee', category: 'Single Origin', subcategory: 'Africa', tags: ['ethiopia', 'natural', 'blueberry', 'filter'], description: 'Guji zone, 2,050 m, natural process. Blueberry jam, cane sugar, a long floral finish. Brews best as filter at 1:16; it will take an espresso dose if you like it loud.' },
      { key: 'colombia', title: 'Colombia Huila Washed — 12 oz', price: 1750, stock: 63, weight: 340, section: 'Coffee', category: 'Single Origin', subcategory: 'South America', tags: ['colombia', 'washed', 'caramel', 'everyday'], description: 'The one we drink at the roastery. Washed caturra from a five-farm collective in Huila. Red apple, brown sugar, clean finish that holds up to milk.' },
      { key: 'sumatra', title: 'Sumatra Mandheling Wet-Hulled — 12 oz', price: 1800, stock: 0, status: 'sold_out', weight: 340, section: 'Coffee', category: 'Single Origin', subcategory: 'Asia', tags: ['sumatra', 'wet-hulled', 'earthy', 'dark'], description: 'Cedar, dark chocolate, a savoury edge people either love or refuse. Back in three weeks when the next container lands.' },
      { key: 'houseblend', title: 'Anvil House Blend — 2 lb', price: 3400, stock: 28, weight: 907, section: 'Coffee', category: 'Blends', tags: ['blend', 'espresso', 'bulk', 'chocolate'], description: 'Brazil for body, Colombia for sweetness, a little Ethiopia on top. Milk chocolate and toasted almond. The cheapest way to keep a household caffeinated.' },
      { key: 'decaf', title: 'Swiss Water Decaf Brazil — 12 oz', price: 1650, stock: 21, weight: 340, section: 'Coffee', category: 'Blends', subcategory: 'Decaf', tags: ['decaf', 'brazil', 'swiss-water'], description: 'Chemical-free decaffeination, roasted a touch darker to hold sweetness. Hazelnut and cocoa. Genuinely good after dinner, which is a low bar most decaf still trips over.' },
      { key: 'sampler', title: 'Four-Origin Sampler Box', price: 4200, stock: 14, weight: 680, section: 'Coffee', category: 'Gifts', tags: ['sampler', 'gift', 'variety'], description: 'Four 5 oz bags of whatever is singing that week, with tasting notes and brew ratios on the card. The safest gift for a coffee person whose taste you cannot guess.' },
      { key: 'grinder', title: 'Hand Grinder, Stainless Conical Burr', price: 8900, stock: 6, weight: 620, section: 'Equipment', category: 'Grinders', tags: ['grinder', 'manual', 'burr', 'travel'], description: '38 mm stainless conical burrs, 24 detents from espresso to French press. Grinds a filter dose in about 25 seconds. Fits inside an AeroPress for travel.' },
      { key: 'dripper', title: 'Ceramic Cone Dripper, Size 02', price: 2600, stock: 33, weight: 380, section: 'Equipment', category: 'Brewers', tags: ['pourover', 'ceramic', 'dripper'], description: 'Thrown and glazed two towns over. Holds heat far better than plastic; brews 250 to 500 ml. Takes any size 02 paper filter.' },
      { key: 'filters', title: 'Bleached Paper Filters, Size 02 (100 ct)', price: 800, stock: 140, weight: 120, section: 'Equipment', category: 'Consumables', tags: ['filters', 'paper', 'consumable'], description: 'Oxygen-bleached, no papery taste, no rinse required if you are in a hurry. One hundred per box.' },
      { key: 'mug', title: 'Anvil Enamel Mug, 12 oz', price: 1400, stock: 0, status: 'sold_out', weight: 260, section: 'Merch', category: 'Drinkware', tags: ['mug', 'enamel', 'camping'], description: 'Speckled enamel over steel, our anvil mark on the side. Campfire-proof, dishwasher-tolerant, chips beautifully with age. Restocking in spring.' },
    ] },
  { key: 'vintage', persona: 202, name: 'Cygnet Vintage', location: 'Antwerp, Belgium', currency: 'EUR',
    description: 'One-of-one vintage pulled from Belgian estate sales and Italian deadstock. Everything is measured flat and photographed unretouched, flaws included. If it is listed, it is the only one.',
    policies: 'Every piece is second-hand and sold as described — read the measurements, they beat any size label.\nReturns accepted within 14 days if the item does not match its description; buyer pays return postage otherwise.\nItems are washed or dry-cleaned before they ship.',
    contact: [{ platform: 'email', handle: 'shop@cygnetvintage.be' }, { platform: 'telegram', handle: '@cygnetvintage' }],
    zones: [{ name: 'Benelux', countryPattern: 'BE|NL|LU', rateType: 'flat', flatRate: 450, priority: 1 },
      { name: 'European Union', countryPattern: EU, rateType: 'flat', flatRate: 1200, priority: 2 },
      { name: 'Rest of World', rateType: 'flat', flatRate: 2600, priority: 3 }],
    items: [
      { key: 'trench', title: '1970s Aquascutum Trench Coat, Club Check Lining', price: 28500, stock: 1, weight: 1800, section: 'Outerwear', category: 'Coats', tags: ['trench', '1970s', 'aquascutum', 'one-of-one'], description: 'Cotton gabardine, storm flap, original horn buttons, club check lining intact. Chest 54 cm flat, length 112 cm. One small ink mark inside the right cuff, photographed.' },
      { key: 'levis', title: 'Levi’s 501 Redline Selvedge, 1980s, W32', price: 19000, stock: 1, weight: 780, section: 'Denim', category: 'Jeans', tags: ['levis', '501', 'selvedge', 'redline'], description: 'Single-stitch, redline selvedge, care tag readable. Measures W32 L31 after a cold wash. Honest whiskering, no repairs, hem original.' },
      { key: 'silkscarf', title: 'Italian Silk Scarf, Hand-Rolled Hem, 1960s', price: 6500, stock: 1, weight: 90, section: 'Accessories', category: 'Scarves', tags: ['silk', 'italian', '1960s', 'hand-rolled'], description: '86 cm square, geometric print in ochre and teal, hand-rolled hem with no pulls. Unsigned. Presses flat with a cool iron and a cloth.' },
      { key: 'workjacket', title: 'French Chore Jacket, Faded Bleu de Travail', price: 12000, stock: 1, weight: 900, section: 'Outerwear', category: 'Jackets', tags: ['chore', 'french', 'workwear', 'indigo'], description: 'Moleskin cotton faded to that particular chalky blue you cannot fake. Three patch pockets, metal buttons. Chest 56 cm flat. Repaired left elbow, done well.' },
      { key: 'knit', title: 'Aran Hand-Knit Fisherman Sweater, Undyed Wool', price: 14500, stock: 1, weight: 1100, section: 'Knitwear', category: 'Sweaters', tags: ['aran', 'wool', 'hand-knit', 'cream'], description: 'Honeycomb and cable panels, undyed bainin wool, knitted in Donegal. Chest 58 cm flat, sleeve 50 cm. Heavy — this is a coat replacement, not a layer.' },
      { key: 'loafers', title: 'Bass Weejun Penny Loafers, Made in USA, EU 43', price: 9500, stock: 1, weight: 950, section: 'Footwear', category: 'Shoes', tags: ['loafers', 'bass', 'leather', 'made-in-usa'], description: 'Brown leather, original leather sole with maybe half its life left, heels recently replaced. Uppers creased but sound. Marked US 10 D.' },
      { key: 'beret', title: 'Laulhère Wool Beret, Deadstock, Navy', price: 4800, stock: 3, weight: 140, section: 'Accessories', category: 'Hats', tags: ['beret', 'deadstock', 'wool', 'france'], description: 'Deadstock from a Basque maker, merino felt, leather sweatband, paper label still attached. 11.5 inch diameter. Three left from a shop clearance.' },
      { key: 'tote', title: 'Belgian Linen Market Tote, Repaired Handle', price: 3200, stock: 0, status: 'sold_out', weight: 420, section: 'Accessories', category: 'Bags', tags: ['linen', 'tote', 'repaired'], description: 'Heavy undyed linen from a Ghent market stall, one handle re-stitched by us in waxed thread. Sold — a second one may surface in autumn.' },
    ] },
  { key: 'ceramics', persona: 270, name: 'Kintsugi Ceramics', location: 'Kyoto, Japan', currency: 'USD',
    description: 'Wood-fired stoneware thrown one at a time, and gold-seam repair for pots you are not ready to lose. Small kiln, small batches, long waits. Worth it, I am told.',
    policies: 'Each piece is thrown and fired individually; colour and size vary by a few percent and that variance is the point.\nWe pack in straw board and double-box. If something arrives broken, send a photo within 7 days and we remake it.\nKintsugi repair commissions: mail the pieces, expect 6 to 10 weeks.',
    contact: [{ platform: 'email', handle: 'mae@kintsugiceramics.jp' }],
    zones: [{ name: 'Japan Domestic', countryPattern: 'JP', rateType: 'flat', flatRate: 800, priority: 1 },
      { name: 'Worldwide Air', rateType: 'weight_tiered', priority: 2,
        tiers: { weightRate: 9, weightUnit: 'g', subtotalMultipliers: [{ upTo: 15000, percent: 100 }, { upTo: null, percent: 50 }] } }],
    items: [
      { key: 'teabowl', title: 'Wood-Fired Chawan, Ash Glaze', price: 12000, stock: 4, weight: 480, section: 'Tea', category: 'Bowls', tags: ['chawan', 'wood-fired', 'ash-glaze', 'tea'], description: 'Five days in the anagama, unglazed foot, natural ash deposit down one side. 12 cm across, 8 cm tall, roughly 350 ml to the shoulder. No two land the same colour.' },
      { key: 'mugpair', title: 'Stoneware Mug Pair, Iron Slip', price: 8800, stock: 9, weight: 820, section: 'Table', category: 'Drinkware', tags: ['mug', 'stoneware', 'pair', 'iron'], description: 'Two mugs, iron slip under a clear glaze, pulled handles that actually fit four fingers. 320 ml each. Dishwasher safe, though the glaze prefers a hand wash.' },
      { key: 'kintsugikit', title: 'Kintsugi Repair Kit, Urushi & Brass Powder', price: 15500, stock: 6, weight: 640, section: 'Workshop', category: 'Kits', tags: ['kintsugi', 'repair', 'urushi', 'kit'], description: 'Real urushi lacquer, rice paste, brass powder, three brushes, spatula, and a 20-page guide. Enough for four or five repairs. Patch-test the lacquer: some people react to it.' },
      { key: 'vase', title: 'Bottle Vase, Celadon, 24 cm', price: 19500, stock: 3, weight: 1300, section: 'Home', category: 'Vases', tags: ['vase', 'celadon', 'bottle'], description: 'Narrow-necked bottle form in a pale celadon that pools green in the throwing rings. 24 cm tall, holds a single branch better than a bouquet.' },
      { key: 'plateset', title: 'Dinner Plate Set of Four, Matte White', price: 22000, stock: 2, weight: 3400, section: 'Table', category: 'Plates', tags: ['plates', 'set', 'matte', 'dinnerware'], description: 'Four 26 cm plates, matte white over speckled stoneware, subtly different diameters because hands are not machines. Fires at cone 10, so they are hard to chip.' },
      { key: 'incense', title: 'Incense Holder, Gold Seam', price: 5400, stock: 11, weight: 220, section: 'Home', category: 'Objects', tags: ['incense', 'kintsugi', 'gold', 'small'], description: 'A small dish that cracked in the kiln and came back better. Gold-seam repaired by hand, sealed, safe for daily ash.' },
      { key: 'yunomi', title: 'Yunomi Tea Cup, Shino Glaze', price: 6800, stock: 0, status: 'sold_out', weight: 300, section: 'Tea', category: 'Drinkware', tags: ['yunomi', 'shino', 'tea'], description: 'Fat shino glaze with carbon trapping along the rim. 180 ml. The whole shino batch went in a day; the next firing is in six weeks.' },
    ] },
  { key: 'leather', persona: 271, name: 'Brandt Leatherworks', location: 'Madison, Wisconsin', currency: 'USD',
    description: 'Veg-tanned leather goods, hand-stitched with waxed linen on a stitching pony my grandfather built. No rivets where a saddle stitch will do. Everything is repairable, by me, forever.',
    policies: 'Lifetime repair on stitching, free, you cover postage one way.\nLeather is a natural material: scars, bug bites and range marks are part of the hide and are not defects.\nMade to order items ship in 3 to 5 weeks. Rush orders are not a thing here.',
    contact: [{ platform: 'email', handle: 'tom@brandtleather.com' }, { platform: 'signal', handle: 'brandtleather.42' }],
    zones: [{ name: 'US Domestic', countryPattern: 'US', rateType: 'flat', flatRate: 900, priority: 1 },
      { name: 'International', rateType: 'flat', flatRate: 4500, priority: 2 }],
    items: [
      { key: 'bifold', title: 'Four-Pocket Bifold, Horween Dublin', price: 12500, stock: 12, weight: 90, section: 'Small Goods', category: 'Wallets', tags: ['wallet', 'bifold', 'horween', 'hand-stitched'], description: 'Horween Dublin, edges burnished to glass, saddle-stitched in brown waxed linen. Four card pockets, one bill sleeve, no liner to bulk it out. Breaks in flat in about a month.' },
      { key: 'belt', title: 'Bridle Leather Belt, 1.5 inch, Solid Brass', price: 14500, stock: 8, weight: 300, section: 'Accessories', category: 'Belts', tags: ['belt', 'bridle', 'brass', 'made-to-order'], description: 'English bridle, 10 to 11 oz, solid cast brass buckle on Chicago screws so you can swap it. Cut to your measured waist — measure over the trousers you actually wear.' },
      { key: 'totebag', title: 'Market Tote, 12 oz Canvas & Leather', price: 21000, stock: 5, weight: 1100, section: 'Bags', category: 'Totes', tags: ['tote', 'canvas', 'leather', 'bag'], description: 'Waxed 12 oz canvas body, bridle leather base and handles, brass feet. Swallows two grocery bags or a laptop and a jumper. The canvas will go soft and blotchy, which is correct.' },
      { key: 'notebook', title: 'Refillable Notebook Cover, A5', price: 9500, stock: 0, status: 'sold_out', weight: 240, section: 'Small Goods', category: 'Covers', tags: ['notebook', 'a5', 'refillable'], description: 'Fits standard A5 softcovers, elastic spine, pen loop. The hide I was cutting these from ran out; the next side is ordered.' },
      { key: 'keyfob', title: 'Key Fob, Offcut Leather, Assorted', price: 2200, stock: 26, weight: 45, section: 'Small Goods', category: 'Keychains', tags: ['keychain', 'offcut', 'cheap', 'gift'], description: 'Made from whatever is left on the bench. Colour is a surprise; the brass hardware is not. A good way to find out whether you like the leather before spending real money.' },
      { key: 'valet', title: 'Desk Valet Tray, Stitched Corners', price: 7800, stock: 7, weight: 380, section: 'Home', category: 'Trays', tags: ['valet', 'tray', 'desk', 'corners'], description: '18 cm square tray, corners pulled up and stitched, sides stiffened with a second layer. Holds keys, a watch, and whatever else you empty out of your pockets.' },
    ] },
  { key: 'botanic', persona: 272, name: 'Verdant Botanicals', location: 'Lisbon, Portugal', currency: 'EUR',
    description: 'Herbal soaps, salves and teas from a rooftop garden in Alfama. Everything is grown, dried or infused here, except the olive oil, which comes from my aunt.',
    policies: 'Everything is made in small batches and labelled with its batch date. Soaps cure for six weeks before they ship.\nWe cannot accept returns on opened cosmetics for hygiene reasons; if a batch disagrees with your skin, write to us.\nNot medical advice. Patch-test anything new.',
    contact: [{ platform: 'email', handle: 'ola@verdantbotanicals.pt' }, { platform: 'twitter', handle: '@verdantlx' }],
    zones: [{ name: 'Portugal', countryPattern: 'PT', rateType: 'flat', flatRate: 350, priority: 1 },
      { name: 'European Union', countryPattern: EU, rateType: 'flat', flatRate: 900, priority: 2 },
      { name: 'Rest of World', rateType: 'flat', flatRate: 2200, priority: 3 }],
    items: [
      { key: 'olivesoap', title: 'Olive & Laurel Soap Bar, 120 g', price: 750, stock: 88, weight: 120, section: 'Bath', category: 'Soap', tags: ['soap', 'olive', 'laurel', 'cold-process'], description: 'Cold-process, 80 percent olive oil, 20 percent laurel berry, cured eight weeks. Almost no lather and an unreasonably good result. Unscented beyond the laurel itself.' },
      { key: 'rosemary', title: 'Rosemary & Sea Salt Soap, 120 g', price: 800, stock: 64, weight: 120, section: 'Bath', category: 'Soap', tags: ['soap', 'rosemary', 'salt', 'exfoliating'], description: 'Atlantic sea salt at 30 percent for a hard, squeaky bar, with rosemary cut from the roof. Give it a draining dish or it will dissolve in sulks.' },
      { key: 'calendula', title: 'Calendula Salve, 30 ml Tin', price: 1400, stock: 41, weight: 70, section: 'Skin', category: 'Salves', tags: ['calendula', 'salve', 'beeswax', 'dry-skin'], description: 'Calendula flowers infused in olive oil for six weeks, set with beeswax. For cracked knuckles, gardener hands and the patch of winter skin that never quite heals.' },
      { key: 'lipbalm', title: 'Beeswax Lip Balm, Unscented', price: 500, stock: 120, weight: 20, section: 'Skin', category: 'Balms', tags: ['lip-balm', 'beeswax', 'unscented'], description: 'Three ingredients: beeswax, olive oil, a little shea. No flavour, no tingle, no mystery. Melts at body temperature and stays put.' },
      { key: 'chamomile', title: 'Chamomile & Lemon Verbena Tea, 60 g', price: 1100, stock: 33, weight: 90, section: 'Kitchen', category: 'Tea', tags: ['tea', 'chamomile', 'verbena', 'caffeine-free'], description: 'Hand-picked chamomile heads and lemon verbena leaves, shade-dried. Steep 5 minutes, do not boil the life out of it. Roughly 25 cups per pouch.' },
      { key: 'mint', title: 'Moroccan Mint Tea, 60 g', price: 950, stock: 47, weight: 90, section: 'Kitchen', category: 'Tea', tags: ['tea', 'mint', 'green'], description: 'Gunpowder green cut with our own spearmint. Strong enough to survive the amount of sugar it traditionally receives.' },
      { key: 'bathsalt', title: 'Eucalyptus Bath Salt, 400 g Jar', price: 1600, stock: 19, weight: 450, section: 'Bath', category: 'Soak', tags: ['bath-salt', 'eucalyptus', 'epsom'], description: 'Epsom and coarse Atlantic salt with eucalyptus oil and dried leaf. Two handfuls per bath. The jar is reusable and we will refill it if you are local.' },
      { key: 'seedkit', title: 'Balcony Herb Seed Kit, Six Varieties', price: 1800, stock: 0, status: 'sold_out', weight: 260, section: 'Garden', category: 'Seeds', tags: ['seeds', 'herbs', 'kit', 'balcony'], description: 'Basil, parsley, coriander, thyme, oregano and the spearmint we use in the tea, with coir pellets and a planting calendar. Next batch after the spring harvest.' },
      { key: 'candle', title: 'Beeswax Pillar Candle, 15 cm', price: 1900, stock: 24, weight: 340, section: 'Home', category: 'Candles', tags: ['candle', 'beeswax', 'unscented'], description: 'Pure beeswax from a keeper outside Sintra, cotton wick, roughly 40 hours. Smells faintly of honey and nothing else. Burns cleanly if you keep the wick short.' },
    ] },
  { key: 'analog', persona: 273, name: 'Analog Supply Co.', location: 'São Paulo, Brazil', currency: 'USD',
    description: 'Working film cameras, fresh film, and paper worth writing on. Everything is tested before it is listed. Shipping from Brazil is slow and I will not pretend otherwise.',
    policies: 'Cameras are tested (shutter speeds, meter, seals) and the test notes are in the listing. Sold as working unless stated.\n30-day functional warranty on bodies; light seals and batteries are consumables.\nShipping from Brazil takes 2 to 6 weeks internationally. Please do not order if you need it next week.',
    contact: [{ platform: 'email', handle: 'raf@analogsupply.co' }, { platform: 'telegram', handle: '@analogsupplyco' }],
    zones: [{ name: 'Brazil', countryPattern: 'BR', rateType: 'flat', flatRate: 2500, priority: 1 },
      { name: 'Worldwide Registered', rateType: 'flat', flatRate: 5500, priority: 2 }],
    items: [
      { key: 'om1', title: 'Olympus OM-1n, Serviced, 50 mm f/1.8', price: 34500, stock: 2, weight: 700, section: 'Cameras', category: '35mm SLR', tags: ['olympus', 'om-1', 'slr', 'serviced'], description: 'Serviced in March: new light seals, prism cleaned, shutter within 1/3 stop at every speed. Meter reads accurately on a 1.35 V adapter (included). Clean glass, no fungus.' },
      { key: 'trip35', title: 'Olympus Trip 35, Refurbished', price: 12500, stock: 4, weight: 390, section: 'Cameras', category: 'Point & Shoot', tags: ['olympus', 'trip-35', 'zone-focus', 'no-battery'], description: 'Selenium meter still strong, seals replaced, lens cleaned. Zone focus, two shutter speeds, no batteries ever. The most forgiving camera to hand someone new to film.' },
      { key: 'portra', title: 'Kodak Portra 400, 35 mm, 5-Pack', price: 7500, stock: 16, weight: 250, section: 'Film', category: 'Colour Negative', tags: ['kodak', 'portra', '400', '35mm'], description: 'Five rolls, 36 exposures, cold-stored since arrival, expiry 2027-04. Prices are what they are; I am not marking it up further.' },
      { key: 'hp5', title: 'Ilford HP5 Plus, 35 mm, 5-Pack', price: 4200, stock: 22, weight: 250, section: 'Film', category: 'Black & White', tags: ['ilford', 'hp5', 'black-and-white', '35mm'], description: 'Five rolls of the most forgiving black and white film made. Push it to 1600 and it barely complains. Expiry 2028-01.' },
      { key: 'devkit', title: 'Home Development Starter Kit', price: 15800, stock: 3, weight: 1900, section: 'Darkroom', category: 'Kits', tags: ['developing', 'kit', 'tank', 'chemistry'], description: 'Two-reel tank, thermometer, cylinders, clips, changing bag, and enough D-76 and fixer for about 16 rolls. No chemistry ships by air, so this is surface post only.' },
      { key: 'notebookA6', title: 'Sewn A6 Notebook, Tomoe River 52 gsm', price: 2400, stock: 38, weight: 130, section: 'Paper', category: 'Notebooks', tags: ['notebook', 'tomoe-river', 'a6', 'fountain-pen'], description: '128 pages of 52 gsm Tomoe River, sewn signature, lays flat. No ghosting worth mentioning with a fine nib; a wet broad will show through and that is physics.' },
      { key: 'pen', title: 'Brass Bullet Pen, Refillable', price: 3200, stock: 15, weight: 80, section: 'Paper', category: 'Pens', tags: ['pen', 'brass', 'edc', 'refillable'], description: 'Solid brass, takes a standard D1 refill, patinas in a week and looks ten years old in a month. Short enough to live in a coin pocket.' },
      { key: 'canonet', title: 'Canonet QL17 GIII, As-Is', price: 9900, stock: 0, status: 'sold_out', weight: 720, section: 'Cameras', category: 'Rangefinder', tags: ['canon', 'canonet', 'as-is', 'project'], description: 'Sold as a project: shutter fires, meter dead, seals gone, rangefinder patch faint. Sold to someone braver than me. More project bodies land most months.' },
    ] },
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
 * The 25 orders: [key, buyer, store, lines, chain, carrier, storeRating, itemRatings]. Ratings are chosen so the
 * ranked surfaces are legible: Kintsugi is clearly top rated (4.75), Anvil & Ash is most ordered (8), Analog Supply
 * is polarising (5,1,5,1,2 → 2.8 with a bimodal distribution).
 */
const ORDERS = [
  ['o01', 'bo', 'coffee', [['ethiopia', 2], ['grinder', 1]], 'delivered5', 'usps', 5, [['ethiopia', 5], ['grinder', 4]]],
  ['o02', 'ivy', 'coffee', [['colombia', 1], ['filters', 2]], 'delivered3', 'ups', 4, [['colombia', 4]]],
  ['o03', 'otto', 'coffee', [['houseblend', 1], ['mug', 1]], 'delivered3', 'dhl', 5, [['houseblend', 5], ['mug', 5]]],
  ['o04', 'mae', 'coffee', [['sampler', 1]], 'cancelled', null, null, []],
  ['o05', 'nia', 'coffee', [['sampler', 1], ['dripper', 1]], 'delivered5', 'dhl', 5, [['sampler', 5]]],
  ['o06', 'bo', 'coffee', [['decaf', 1], ['dripper', 1]], 'delivered3', 'usps', 4, [['dripper', 4]]],
  ['o07', 'otto', 'coffee', [['sumatra', 1]], 'cancelled', null, null, []],
  ['o08', 'ivy', 'coffee', [['decaf', 2], ['filters', 1]], 'delivered3', 'ups', 3, [['decaf', 3]]],
  ['o09', 'ivy', 'ceramics', [['teabowl', 1], ['mugpair', 1]], 'delivered5', 'fedex', 5, [['teabowl', 5], ['mugpair', 5]]],
  ['o10', 'otto', 'ceramics', [['kintsugikit', 1]], 'delivered3', 'dhl', 5, [['kintsugikit', 5]]],
  ['o11', 'bo', 'ceramics', [['plateset', 1], ['incense', 1]], 'delivered3', 'fedex', 4, [['plateset', 4], ['incense', 5]]],
  ['o12', 'nia', 'ceramics', [['vase', 1]], 'refunded', 'dhl', null, []],
  ['o13', 'ivy', 'ceramics', [['teabowl', 1], ['incense', 2]], 'delivered3', 'fedex', 5, [['teabowl', 5], ['incense', 4]]],
  ['o14', 'otto', 'analog', [['om1', 1], ['portra', 1]], 'delivered3', 'dhl', 5, [['om1', 5], ['portra', 5]]],
  ['o15', 'bo', 'analog', [['devkit', 1]], 'refunded', 'usps', 1, [['devkit', 1]]],
  ['o16', 'ivy', 'analog', [['trip35', 1], ['hp5', 1]], 'delivered3', 'dhl', 5, [['trip35', 5]]],
  ['o17', 'mae', 'analog', [['notebookA6', 2], ['pen', 1]], 'refunded', 'usps', 1, [['pen', 1], ['notebookA6', 2]]],
  ['o18', 'otto', 'analog', [['hp5', 2], ['notebookA6', 1]], 'delivered3', 'dhl', 2, [['notebookA6', 2]]],
  ['o19', 'bo', 'vintage', [['levis', 1], ['beret', 1]], 'delivered3', 'dhl', 4, [['levis', 4], ['beret', 5]]],
  ['o20', 'nia', 'vintage', [['silkscarf', 1], ['beret', 1]], 'delivered3', 'ups', 4, [['silkscarf', 4], ['beret', 5]]],
  ['o21', 'otto', 'vintage', [['trench', 1]], 'inflight', null, null, []],
  ['o22', 'ivy', 'botanic', [['olivesoap', 3], ['calendula', 1]], 'delivered3', 'ups', 3, [['olivesoap', 4]]],
  ['o23', 'mae', 'botanic', [['chamomile', 2], ['candle', 1]], 'delivered3', 'dhl', null, [['chamomile', 5]]],
  ['o24', 'bo', 'botanic', [['bathsalt', 1], ['lipbalm', 2]], 'refunded', 'usps', null, [['bathsalt', 2]]],
  ['o25', 'otto', 'leather', [['bifold', 1], ['keyfob', 2]], 'inflight', null, null, [['bifold', 5]]],
].map(([key, buyer, store, lines, chain, carrier, rating, items]) => ({ key, buyer, store, lines, chain, carrier, rating, items }));

const REVIEW_TITLES = {
  5: ['Worth every bit of the wait', 'Exactly as described, and then some', 'No notes'],
  4: ['Very good, with one small caveat', 'Happy, but the postage was slow', 'Would buy again, eyes open'],
  3: ['Good, not quite great', 'Mixed: the product is fine, the shipping is not'],
  2: ['Disappointing for the price', 'The product survived, the packaging did not'],
  1: ['Weeks of chasing, then a refund', 'Arrived broken, refunded without argument'],
};
const REVIEW_BODIES = {
  5: ['Second order from {store} and the standard has not slipped. Packed properly, shipped when they said, and the quality is obvious on opening.',
    'Genuinely better in person than in the photographs, which almost never happens. Everything in the listing was accurate to the measurement.'],
  4: ['No complaints about the goods — exactly what {store} describes. It took a week longer than expected and tracking did not update for five days of it.',
    'Well made and fairly priced. One small thing the listing does not mention, which I would have liked to know, but nothing that changed my mind.'],
  3: ['Half of this order earns its keep and half was optimistic of me. {store} did nothing wrong; I ordered badly. More cardboard than the contents needed.',
    'The quality is fine and the price is fair. The experience around it — the wait, the box, the silence — is where {store} loses the two stars.'],
  2: ['The goods are what they claim to be, but one arrived crushed because it was packed loose against everything else. At this price it should be in a stiffener.',
    'Two weeks of no tracking and then a parcel that had clearly been sat on. {store} answered eventually, which is the only reason this is not one star.'],
  1: ['Tracking stopped at the export hub and never moved. Four emails over six weeks to get a refund. The goods may well be excellent. I would not know.',
    'Arrived with the contents split across the inside of the box. {store} refunded without argument, which is the one star, but it was a wasted two months.'],
};
const ITEM_NOTES = {
  5: ['{item} is the piece I reach for every day now. Exactly as described.', 'No notes on {item} — it beats things twice the price.'],
  4: ['{item} is very good; the one detail the listing skips cost it a star, not my custom.', 'Solid and well made, slightly smaller than I pictured.'],
  3: ['{item} is fine. Buy one before you buy three, which is advice I did not take.', 'Good enough, but the second was noticeably worse than the first.'],
  2: ['{item} arrived damaged in transit. Lovely thing underneath the damage.', 'Mine came with half of it crumpled. Refunded, but a shame.'],
  1: ['Cannot review what never showed up. Refund eventually issued.', '{item} arrived broken and leaking over everything else in the box.'],
};
const STATUS_MESSAGE = {
  pending: ['Order received — thank you!', 'Got it, thanks. Payment not seen yet.', 'Order logged, waiting on payment confirmation.'],
  payment_received: ['Payment confirmed, thank you.', 'Payment seen on chain, moving to packing.', 'Paid in full — queued for packing.'],
  processing: ['Packing this today.', 'Roasting/packing in progress.', 'Being made up now, should go out tomorrow.'],
  shipped: ['On its way.', 'Handed to the carrier this afternoon.', 'Shipped — tracking attached.'],
  delivered: ['Marked delivered by the carrier. Enjoy!', 'Delivery scan received. Any problems, just reply.', 'Delivered — thanks for the order.'],
  cancelled: ['Cancelled at the buyer’s request, nothing was charged.', 'Cancelled — the item sold out before payment cleared. Sorry about that.'],
  refunded: ['Refunded in full today. Sorry for the trouble.', 'Refund sent — apologies, this one went wrong at our end.'],
};

const fill = (template, values) => Object.entries(values).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, v), template);

/** Deterministic-looking carrier tracking number for an order. */
function trackingFor(key, carrier) {
  const rng = rngFrom(`tracking/${key}`);
  const digits = (n) => Array.from({ length: n }, () => Math.floor(rng() * 10)).join('');
  if (carrier === 'usps') return `9400 1${digits(3)} ${digits(4)} ${digits(4)} ${digits(4)} ${digits(2)}`;
  if (carrier === 'ups') return `1Z${digits(3)}W${digits(11)}`;
  if (carrier === 'fedex') return digits(12);
  return `JJD${digits(15)}`;
}

const ORDER_AAD = utf8('yappr/order/v1');
const KEY_SIZE = 32;
const NONCE_SIZE = 24;
/** Compressed secp256k1 public key: the ECIES wire format's prefix length. */
const PUBKEY_SIZE = 33;

const concatBytes = (...arrays) => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
};
const ecdhSharedX = (privateKey, publicKey) => getSharedSecret(privateKey, publicKey, true).slice(1, 1 + KEY_SIZE);
const eciesKeyAndNonce = (sharedX, ephemeralPubKey) => {
  const derived = hkdf(sha256, sha256(sharedX), ephemeralPubKey, utf8('yappr/ecies/v1'), KEY_SIZE + NONCE_SIZE);
  return { encKey: derived.slice(0, KEY_SIZE), nonce: derived.slice(KEY_SIZE, KEY_SIZE + NONCE_SIZE) };
};
const deriveOrderEphemeralKey = (buyerPrivateKey, nonce, storeId) =>
  hkdf(sha256, buyerPrivateKey, concatBytes(nonce, utf8(storeId)), utf8('yappr/order-eph/v1'), KEY_SIZE);

function encryptOrderPayload(payload, buyerPrivateKey, sellerPublicKey, nonce, storeId) {
  const ephemeralPrivKey = deriveOrderEphemeralKey(buyerPrivateKey, nonce, storeId);
  const ephemeralPubKey = getPublicKey(ephemeralPrivKey, true);
  const { encKey, nonce: aeadNonce } = eciesKeyAndNonce(ecdhSharedX(ephemeralPrivKey, sellerPublicKey), ephemeralPubKey);
  return concatBytes(ephemeralPubKey, xchacha20poly1305(encKey, aeadNonce, ORDER_AAD).encrypt(utf8(JSON.stringify(payload))));
}

/** Both roles end here: ECDH(ephPriv, sellerPub) and ECDH(sellerPriv, ephPub) are the same point. */
function openOrder(sharedX, ciphertext) {
  const { encKey, nonce } = eciesKeyAndNonce(sharedX, ciphertext.slice(0, PUBKEY_SIZE));
  return JSON.parse(new TextDecoder().decode(xchacha20poly1305(encKey, nonce, ORDER_AAD).decrypt(ciphertext.slice(PUBKEY_SIZE))));
}

/** 24-byte order nonce, deterministic per order key so re-runs reproduce the ciphertext. */
const orderNonce = (key) => digest(`nonce/${key}`).slice(0, NONCE_SIZE);

/** Encrypts and proves the ciphertext opens as BOTH parties, the way the app will. */
function sealOrder(order, payload, keys, storeId) {
  const nonce = orderNonce(order.key);
  const encryptedPayload = encryptOrderPayload(payload, keys.buyerPriv, keys.sellerPub, nonce, storeId);
  const asSeller = openOrder(ecdhSharedX(keys.sellerPriv, encryptedPayload.slice(0, PUBKEY_SIZE)), encryptedPayload);
  const asBuyer = openOrder(ecdhSharedX(deriveOrderEphemeralKey(keys.buyerPriv, nonce, storeId), keys.sellerPub), encryptedPayload);
  if (JSON.stringify(asSeller) !== JSON.stringify(payload) || JSON.stringify(asBuyer) !== JSON.stringify(payload)) {
    throw new Error(`order ${order.key}: round-trip decryption mismatch`);
  }
  return { encryptedPayload, nonce };
}

const storeData = (store, paymentUris) => ({
  name: store.name, status: 'active', description: store.description,
  logoUrl: `https://api.dicebear.com/7.x/shapes/svg?seed=${store.key}`,
  bannerUrl: photo(`${store.key}-banner`, 1200),
  paymentUris: JSON.stringify(paymentUris), defaultCurrency: store.currency,
  policies: store.policies, location: store.location, contactMethods: JSON.stringify(store.contact),
});

function itemData(store, item, storeIdBytes) {
  const rng = rngFrom(`sku/${store.key}/${item.key}`);
  return {
    storeId: storeIdBytes, title: item.title, status: item.status ?? 'active', description: item.description,
    section: item.section, category: item.category, ...(item.subcategory ? { subcategory: item.subcategory } : {}),
    tags: JSON.stringify(item.tags),
    imageUrls: JSON.stringify(Array.from({ length: 2 + Math.floor(rng() * 3) }, (_, n) => photo(`${store.key}-${item.key}-${n}`, 800))),
    basePrice: item.price, currency: store.currency, weight: item.weight, stockQuantity: item.stock,
    sku: `${store.key.slice(0, 3).toUpperCase()}-${item.key.slice(0, 4).toUpperCase()}-${Math.floor(rng() * 9000 + 1000)}`,
  };
}

const zoneData = (zone, store, storeIdBytes) => ({
  storeId: storeIdBytes, name: zone.name, rateType: zone.rateType,
  ...(zone.flatRate !== undefined ? { flatRate: zone.flatRate } : {}),
  ...(zone.tiers ? { tiers: JSON.stringify(zone.tiers) } : {}),
  ...(zone.countryPattern ? { countryPattern: zone.countryPattern } : {}),
  currency: store.currency, priority: zone.priority,
});

const WEIGHT_UNITS = { g: 1, oz: 28.3495, lb: 453.592, kg: 1000 };

/** Lowest-priority zone whose country pattern covers the address; absent pattern matches all. */
function findMatchingZone(zones, country) {
  const matches = (pattern) => {
    if (!pattern) return true;
    try { return new RegExp(`^(${pattern})$`, 'i').test(country); } catch { return false; }
  };
  return [...zones].sort((a, b) => a.priority - b.priority).find((zone) => matches(zone.countryPattern)) ?? null;
}

/** `(flatRate + weight x weightRate) x multiplier` for a tiered config, else the flat rate. */
function zoneRate(zone, { totalWeight, subtotal }) {
  const config = zone.tiers && !Array.isArray(zone.tiers) ? zone.tiers : null;
  if (!config) return zone.rateType === 'flat' ? zone.flatRate ?? 0 : 0;
  const gramsPerUnit = WEIGHT_UNITS[(config.weightUnit ?? 'lb').toLowerCase()] ?? 1;
  const weightCharge = config.weightRate > 0 ? Math.round((totalWeight / gramsPerUnit) * config.weightRate) : 0;
  const tier = [...(config.subtotalMultipliers ?? [])]
    .sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : a.upTo - b.upTo))
    .find((t) => t.upTo === null || subtotal <= t.upTo);
  return Math.round(((zone.flatRate ?? 0) + weightCharge) * ((tier?.percent ?? 100) / 100));
}

/** The OrderPayload the app's checkout builds, before encryption. */
function orderPayload(order, store, buyer, paymentUri, itemIdFor) {
  const rng = rngFrom(`payload/${order.key}`);
  const itemOf = (key) => store.items.find((candidate) => candidate.key === key);
  const items = order.lines.map(([itemKey, quantity]) => ({
    itemId: itemIdFor(itemKey), itemTitle: itemOf(itemKey).title, quantity,
    unitPrice: itemOf(itemKey).price, imageUrl: photo(`${store.key}-${itemKey}-0`, 800),
  }));
  const subtotal = items.reduce((total, line) => total + line.unitPrice * line.quantity, 0);
  const totalWeight = order.lines.reduce((total, [itemKey, quantity]) => total + (itemOf(itemKey).weight ?? 0) * quantity, 0);
  const zone = findMatchingZone(store.zones, buyer.country);
  if (!zone) throw new Error(`order ${order.key}: ${store.name} has no shipping zone covering ${buyer.country}`);
  const shippingCost = zoneRate(zone, { totalWeight, subtotal });
  return {
    items,
    shippingAddress: { name: buyer.name, street: buyer.street, city: buyer.city, ...(buyer.state ? { state: buyer.state } : {}), postalCode: buyer.postalCode, country: buyer.country },
    buyerContact: { email: buyer.email, ...(buyer.phone ? { phone: buyer.phone } : {}) },
    subtotal, shippingCost, total: subtotal + shippingCost, currency: store.currency, paymentUri,
    txid: Array.from(digest(`txid/${order.key}`)).map((b) => b.toString(16).padStart(2, '0')).join(''),
    ...(rng() < 0.35 ? { notes: pick(rng, ['Please leave with the neighbour if I am out.', 'No rush — away until the 20th.', 'Gift: please skip the invoice in the box.', 'Buzzer is broken, call on arrival.']) } : {}),
  };
}

const storeOf = (order) => STORE_BY_KEY.get(order.store);
const itemTitle = (order, key) => storeOf(order).items.find((item) => item.key === key).title;

function buildPlan() {
  const perStore = new Map(STORES.map((store) => [store.key, { orders: 0, ratings: [] }]));
  for (const order of ORDERS) {
    perStore.get(order.store).orders += 1;
    if (order.rating) perStore.get(order.store).ratings.push(order.rating);
  }
  const average = (bucket) => (bucket.ratings.length ? bucket.ratings.reduce((a, b) => a + b, 0) / bucket.ratings.length : 0);
  const reviews = ORDERS.map((order) => {
    const rng = rngFrom(`review/${order.key}`);
    const store = storeOf(order);
    return {
      order,
      store: order.rating ? {
        rating: order.rating,
        title: pick(rng, REVIEW_TITLES[order.rating]),
        content: fill(pick(rng, REVIEW_BODIES[order.rating]), { store: store.name }),
      } : null,
      items: order.items.map(([itemKey, rating]) => ({
        itemKey, rating, content: fill(pick(rng, ITEM_NOTES[rating]), { item: itemTitle(order, itemKey), store: store.name }),
      })),
    };
  });
  return {
    stores: STORES.length,
    items: STORES.reduce((n, store) => n + store.items.length, 0),
    zones: STORES.reduce((n, store) => n + store.zones.length, 0),
    orders: ORDERS.length,
    statuses: ORDERS.reduce((n, order) => n + CHAINS[order.chain].length, 0),
    storeReviews: reviews.filter((review) => review.store).length,
    itemReviews: reviews.reduce((n, review) => n + review.items.length, 0),
    reviews: new Map(reviews.map((review) => [review.order.key, review])),
    perStore, average,
    topRated: [...perStore.entries()].sort((a, b) => average(b[1]) - average(a[1]))[0][0],
    mostOrdered: [...perStore.entries()].sort((a, b) => b[1].orders - a[1].orders)[0][0],
    /** Widest 1-5 spread: the store whose reviewers disagree most. */
    polarising: [...perStore.entries()].sort((a, b) => {
      const spread = ([, bucket]) => (bucket.ratings.length ? Math.max(...bucket.ratings) - Math.min(...bucket.ratings) : -1);
      return spread(b) - spread(a);
    })[0][0],
  };
}

function printPlan(plan) {
  console.log(counts({ store: plan.stores, storeItem: plan.items, shippingZone: plan.zones, storeOrder: plan.orders,
    orderStatusUpdate: plan.statuses, storeReview: plan.storeReviews, itemReview: plan.itemReviews },
  ` — ${plan.stores + plan.items + plan.zones + plan.orders + plan.statuses + plan.storeReviews + plan.itemReviews} documents, `
    + `${plan.storeReviews * 3 + plan.itemReviews} YAPP`));
  printTable([['store', 24], ['persona', -7], ['items', -5], ['orders', -6], ['reviews', -7], ['expected avg', -12]],
    STORES.map((store) => {
      const bucket = plan.perStore.get(store.key);
      return [store.name, store.persona, store.items.length, bucket.orders, bucket.ratings.length,
        bucket.ratings.length ? plan.average(bucket).toFixed(2) : '—'];
    }));
}

/** Buyer/seller ECIES key material; offline runs fall back to deterministic stand-ins. */
function orderKeys(ledger, order, offline) {
  const buyer = personaKeys(ledger, BUYERS[order.buyer].persona, { purpose: 'encryption', offline });
  const seller = personaKeys(ledger, storeOf(order).persona, { purpose: 'encryption', offline });
  return { buyerPriv: buyer.privateKey, sellerPub: seller.publicKey, sellerPriv: seller.privateKey };
}

async function run({ args, handle, battery, socialId, contractId }) {
  const plan = buildPlan();
  const writer = createDocWriter({ handle, contractId, entropyFor: entropySource('yappr/storefront-seed/v1'), paymentInfo: battery.paymentInfo });
  const tokenId = await battery.readback(() => battery.sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));
  const ledger = loadLedger();
  const actors = await actorsFor(battery, [...STORES.map((s) => s.persona), ...Object.values(BUYERS).map((b) => b.persona)]);
  const payoutAddress = (idx) => {
    const key = ledgerEntry(ledger, idx)?.identityKeys?.find((k) => k.purpose === 'transfer');
    if (!key) throw new Error(`persona ${idx} has no transfer key in the ledger`);
    return addressFor(key.publicKeyHex);
  };
  console.log(`actors: ${[...actors.values()].map((actor) => actor.label).join(', ')}`);
  const state = loadCheckpoint(args.state, { network: network(), contractId }, { docs: {} });
  const recorder = createRecorder({ writer, state, file: args.state });
  const { createDoc, id: idOf } = recorder;
  const storeIds = new Map();
  const itemIds = new Map();
  const orderIds = new Map();
  const byStore = (store) => store.persona;
  const byBuyer = (order) => BUYERS[order.buyer].persona;
  const phase = phaseRunner(args.concurrency);

  if (!args.verifyOnly) {
    await phase('stores', STORES, byStore, async (store) => {
      const actor = actors.get(store.persona);
      const uris = [{ scheme: 'dash:', uri: `dash:${payoutAddress(store.persona)}`, label: `${store.name} (Dash)` }];
      const data = storeData(store, uris);
      // `store` is unique per $ownerId and the registration battery leaves a
      // throwaway store on personas 200/202 on THIS contract, so a key-derived id
      // probe misses it and the create is refused 40105. Adopt the slot instead,
      // rewriting it in place when it is not already this store (stores cannot be
      // deleted, so the placeholder has to become the real one).
      const id = await createDoc(actor, 'store', `store/${store.key}`, data, {
        adopt: async () => {
          const [existing] = await battery.queryDocs('store',
            { where: [['$ownerId', '==', actor.ownerId]], orderBy: [['$ownerId', 'asc']], limit: 1 });
          if (!existing) return null;
          const existingId = normalizeId(existing.$id);
          if (existing.name !== store.name) {
            const outcome = await writer.replaceDoc(actor, 'store', existingId, data, existing.$revision ?? 1);
            console.log(`  rewrote ${existing.name} → ${store.name} (${outcome.id})`);
          }
          return existingId;
        },
      });
      if (id) storeIds.set(store.key, id);
    });
    for (const store of STORES) if (!storeIds.has(store.key)) throw new Error(`store ${store.key} was not created; cannot continue`);

    await phase('items and shipping zones', STORES, byStore, async (store) => {
      const actor = actors.get(store.persona);
      const storeIdBytes = id32(storeIds.get(store.key));
      for (const item of store.items) {
        const id = await createDoc(actor, 'storeItem', `item/${store.key}/${item.key}`, itemData(store, item, storeIdBytes));
        if (id) itemIds.set(`${store.key}/${item.key}`, id);
      }
      for (const zone of store.zones) {
        await createDoc(actor, 'shippingZone', `zone/${store.key}/${zone.name}`, zoneData(zone, store, storeIdBytes), {
          // `shippingZone` IS mutable, and a zone whose table row changed (a new
          // rate, or a countryPattern DROPPED so it becomes the catch-all) has to
          // be corrected in place or the store quotes the old price.
          reconcile: () => zoneData(zone, store, storeIdBytes),
        });
      }
      // The battery leaves `zone<runid>` fixtures on the stores it reused, all at
      // priority 1 with no country pattern — so they SHADOW the real zones in the
      // app's priority sort and quote the wrong rate. This table is the store's
      // whole zone list, so anything else of ours goes.
      const named = new Set(store.zones.map((zone) => zone.name));
      const onChain = await battery.queryDocs('shippingZone',
        { where: [['storeId', '==', storeIds.get(store.key)]], orderBy: [['storeId', 'asc'], ['priority', 'asc']], limit: 100 });
      for (const zone of onChain) {
        if (named.has(zone.name) || normalizeId(zone.$ownerId) !== actor.ownerId) continue;
        const outcome = await battery.attemptDelete(actor, 'shippingZone', normalizeId(zone.$id));
        if (outcome.ok) console.log(`  pruned stale shippingZone "${zone.name}" from ${store.name}`);
        else recorder.fail(`zone-prune/${store.key}/${zone.name}`, 'shippingZone', outcome.error);
      }
    });

    let sealed = 0;
    await phase('orders, encrypted to the seller', ORDERS, byBuyer, async (order) => {
      const store = storeOf(order);
      const storeId = storeIds.get(store.key);
      const payload = orderPayload(order, store, BUYERS[order.buyer], `dash:${payoutAddress(store.persona)}`,
        (itemKey) => itemIds.get(`${store.key}/${itemKey}`) ?? '');
      const { encryptedPayload, nonce } = sealOrder(order, payload, orderKeys(ledger, order, false), storeId);
      sealed += 1;
      // `sellerId` must equal the store's own $ownerId or consensus rejects (40127).
      const id = await createDoc(actors.get(BUYERS[order.buyer].persona), 'storeOrder', `order/${order.key}`,
        { storeId: id32(storeId), sellerId: id32(actors.get(store.persona).ownerId), encryptedPayload, nonce });
      if (id) orderIds.set(order.key, id);
    });
    console.log(`  ${sealed} order payloads encrypted and round-tripped (seller ECIES + buyer re-derived ephemeral)`);

    await phase('order status updates', STORES, byStore, async (store) => {
      for (const order of ORDERS.filter((candidate) => candidate.store === store.key)) {
        if (!orderIds.get(order.key)) continue;
        for (const status of CHAINS[order.chain]) {
          // Only the order's seller may write one: the signer IS the store persona,
          // which the writer gate checks against the order's sellerId.
          await createDoc(actors.get(store.persona), 'orderStatusUpdate', `status/${order.key}/${status}`, {
            orderId: id32(orderIds.get(order.key)), buyerId: id32(actors.get(BUYERS[order.buyer].persona).ownerId), status,
            message: pick(rngFrom(`status/${order.key}/${status}`), STATUS_MESSAGE[status]),
            ...(status === 'shipped' && order.carrier ? { trackingCarrier: order.carrier, trackingNumber: trackingFor(order.key, order.carrier) } : {}),
          });
        }
      }
    });

    const needed = new Map();
    for (const review of plan.reviews.values()) {
      const persona = BUYERS[review.order.buyer].persona;
      const cost = (review.store ? REVIEW_COST.storeReview : 0n) + BigInt(review.items.length) * REVIEW_COST.itemReview;
      needed.set(persona, (needed.get(persona) ?? 0n) + cost);
    }
    await ensureTokens(battery, tokenId, actors, needed, { headroom: YAPP_HEADROOM });
    // Reviews are written BY THE ORDER'S BUYER with the order's storeId/sellerId,
    // or the writer gate refuses them.
    await phase('reviews (3 YAPP store, 1 YAPP item)', [...plan.reviews.values()], (review) => byBuyer(review.order), async (review) => {
      const { order } = review;
      const store = storeOf(order);
      const orderId = orderIds.get(order.key);
      if (!orderId) return;
      const actor = actors.get(BUYERS[order.buyer].persona);
      const storeId = id32(storeIds.get(store.key));
      if (review.store) {
        await createDoc(actor, 'storeReview', `review/${order.key}`, {
          storeId, orderId: id32(orderId), sellerId: id32(actors.get(store.persona).ownerId),
          rating: review.store.rating, title: review.store.title, content: review.store.content,
        }, { tokenCost: REVIEW_COST.storeReview });
      }
      for (const item of review.items) {
        const itemId = itemIds.get(`${store.key}/${item.itemKey}`);
        if (itemId) {
          await createDoc(actor, 'itemReview', `itemreview/${order.key}/${item.itemKey}`,
            { storeId, itemId: id32(itemId), orderId: id32(orderId), rating: item.rating, content: item.content },
            { tokenCost: REVIEW_COST.itemReview });
        }
      }
    });
  } else {
    for (const store of STORES) {
      if (idOf(`store/${store.key}`)) storeIds.set(store.key, idOf(`store/${store.key}`));
      for (const item of store.items) if (idOf(`item/${store.key}/${item.key}`)) itemIds.set(`${store.key}/${item.key}`, idOf(`item/${store.key}/${item.key}`));
    }
    for (const order of ORDERS) if (idOf(`order/${order.key}`)) orderIds.set(order.key, idOf(`order/${order.key}`));
    if (storeIds.size === 0) throw new Error(`--verify-only needs a checkpoint for this contract; ${args.state} has no entries`);
  }

  // ---- Verification: the shapes lib/services/store-stats-service.ts issues.
  console.log('\n--- verification: reading back through the app’s query shapes ---');
  const { check } = battery;
  const directory = await battery.queryDocs('store', { where: [['$ownerId', 'in', STORES.map((s) => actors.get(s.persona).ownerId)]], orderBy: [['$ownerId', 'asc']], limit: 50 });
  check('store directory lists every seeded store', directory.length >= STORES.length, `${directory.length} stores`);

  // Every total is "at least what this seeder wrote": personas 200/202 also carry
  // the registration battery's fixtures. The proved average tree is checked
  // against the review documents themselves, which holds whatever else is there.
  for (const store of STORES) {
    const storeId = storeIds.get(store.key);
    if (!storeId) { check(`${store.name}: store id known`, false); continue; }
    const where = [['storeId', '==', storeId]];
    const order = { orderBy: [['storeId', 'asc'], ['$createdAt', 'asc']], limit: 100 };
    const items = await battery.queryDocs('storeItem', { where, ...order });
    const reviews = await battery.queryDocs('storeReview', { where, ...order });
    const avg = await battery.averageBy('storeReview', 'rating', where);
    const orders = await battery.countBy('storeOrder', where);
    const bucket = plan.perStore.get(store.key);
    const scanned = reviews.reduce((total, review) => total + review.rating, 0);
    check(`${store.name}: ${items.length} items, ${orders} orders, ${avg.count} reviews, avg ${(avg.count ? avg.sum / avg.count : 0).toFixed(2)}`,
      items.length >= store.items.length && orders >= bucket.orders && avg.count >= bucket.ratings.length && avg.count === reviews.length && avg.sum === scanned,
      `seeded items=${store.items.length} orders=${bucket.orders} reviews=${bucket.ratings.length}; average tree {${avg.count},${avg.sum}} vs scanned {${reviews.length},${scanned}}`);
  }

  const nameOf = (id) => STORES.find((s) => storeIds.get(s.key) === id)?.name ?? `${id.slice(0, 8)}…`;
  const topRated = await battery.ranked('storeReview', 'storeId', { type: 'avg', property: 'rating' }, { direction: 'desc', limit: 20 });
  const mostOrdered = await battery.ranked('storeOrder', 'storeId', { type: 'count' }, { direction: 'desc', limit: 20 });
  const scaled = ({ page }) => page.entries.slice(0, 8).map((entry) => [(Number(entry.value) / Number(page.valueScale)).toFixed(2), nameOf(entry.groupValue)]);
  printTable([['avg', -5], ['store', 30]], scaled(topRated), 'top rated stores (documents.ranked, avg over storeReview.rating)');
  printTable([['orders', -6], ['store', 30]],
    mostOrdered.page.entries.slice(0, 8).map((entry) => [String(entry.value), nameOf(entry.groupValue)]),
    'most ordered stores (documents.ranked, count over storeOrder)');

  // Rankings are contract-global, so assert the order among OUR stores rather
  // than the first row overall — other owners rank too.
  const ours = new Set([...storeIds.values()]);
  const firstOfOurs = ({ page }) => nameOf(page.entries.find((entry) => ours.has(entry.groupValue))?.groupValue ?? '');
  for (const [label, page, expected] of [['top-rated', topRated, plan.topRated], ['most-ordered', mostOrdered, plan.mostOrdered]]) {
    check(`the ${label} ranking puts ${STORE_BY_KEY.get(expected).name} first among the seeded stores`,
      firstOfOurs(page) === STORE_BY_KEY.get(expected).name, `first=${firstOfOurs(page)}`);
  }

  const polarising = STORE_BY_KEY.get(plan.polarising);
  const distribution = await battery.groupedCount('storeReview',
    [['storeId', '==', storeIds.get(polarising.key)], ['rating', 'in', [1, 2, 3, 4, 5]]], ['rating'], decodeIntGroupKey);
  console.log(`\n${polarising.name} rating distribution: ${[1, 2, 3, 4, 5].map((r) => `${r}★ ${distribution.get(r) ?? 0}`).join('  ')}`);
  check(`${polarising.name} is bimodal (1★ and 5★ both present)`, (distribution.get(1) ?? 0) > 0 && (distribution.get(5) ?? 0) > 0);

  const busiest = STORE_BY_KEY.get(plan.mostOrdered);
  const topItems = await battery.ranked('itemReview', 'itemId', { type: 'avg', property: 'rating' },
    { where: [['storeId', '==', storeIds.get(busiest.key)]], direction: 'desc', limit: 20 });
  const titleOf = (id) => [...itemIds].filter(([, value]) => value === id)
    .map(([key]) => STORE_BY_KEY.get(key.split('/')[0]).items.find((item) => item.key === key.split('/')[1]).title)[0] ?? `${id.slice(0, 8)}…`;
  printTable([['avg', -5], ['item', 46]],
    topItems.page.entries.slice(0, 6).map((entry) => [(Number(entry.value) / Number(topItems.page.valueScale)).toFixed(2), titleOf(entry.groupValue)]),
    `top items in ${busiest.name} (store-pinned ranked page)`);
  check('store-pinned item ranking returns items', topItems.page.entries.length > 0, `${topItems.page.entries.length} rated items`);
  return battery.report(`checkpoint: ${args.state}`) + recorder.summary();
}

/** Offline, but the ECIES is real: every order payload is sealed and reopened as both parties. */
function dryRun(plan) {
  printPlan(plan);
  const ledger = loadLedger();
  for (const order of ORDERS) {
    const store = storeOf(order);
    const payload = orderPayload(order, store, BUYERS[order.buyer], `dash:${fakeId(`payout/${store.persona}`)}`,
      (itemKey) => fakeId(`item/${store.key}/${itemKey}`));
    sealOrder(order, payload, orderKeys(ledger, order, true), fakeId(`store/${store.key}`));
  }
  console.log(`\n${ORDERS.length}/${ORDERS.length} order payloads encrypted and reopened as BOTH seller (plain ECIES) `
    + 'and buyer (re-derived ephemeral), offline.');
  return 0;
}

function selfTest() {
  const plan = buildPlan();
  const analog = plan.perStore.get('analog').ratings;
  const tiered = zoneRate(STORE_BY_KEY.get('ceramics').zones[1], { totalWeight: 1300, subtotal: 19500 });
  return reportSelfTest('the storefront plan', [
    [`6 stores / 48 items / 15 zones (${plan.stores}/${plan.items}/${plan.zones})`, plan.stores === 6 && plan.items === 48 && plan.zones === 15],
    [`25 orders / 81 status updates (${plan.orders}/${plan.statuses})`, plan.orders === 25 && plan.statuses === 81],
    [`18 store reviews / 30 item reviews (${plan.storeReviews}/${plan.itemReviews})`, plan.storeReviews === 18 && plan.itemReviews === 30],
    ['the run costs 84 YAPP', plan.storeReviews * 3 + plan.itemReviews === 84],
    ['every order has a shipping zone covering its destination (an unmatched zone BLOCKS checkout)',
      ORDERS.every((order) => findMatchingZone(storeOf(order).zones, BUYERS[order.buyer].country))],
    ['every order line names an item its store actually lists',
      ORDERS.every((order) => order.lines.every(([key]) => storeOf(order).items.some((item) => item.key === key)))],
    ['every item review reviews something the same order bought',
      ORDERS.every((order) => order.items.every(([key]) => order.lines.some(([line]) => line === key)))],
    [`rankings stay legible (top=${plan.topRated}, ordered=${plan.mostOrdered}, polarising=${plan.polarising})`,
      plan.topRated === 'ceramics' && plan.mostOrdered === 'coffee' && plan.polarising === 'analog'],
    ['the polarising store is bimodal', analog.includes(1) && analog.includes(5)],
    [`the weight-tiered zone applies its subtotal multiplier (${tiered})`, tiered === Math.round(1300 * 9 * 0.5)],
    ['an absent country pattern is the catch-all', findMatchingZone(STORE_BY_KEY.get('coffee').zones, 'ZZ').name === 'Rest of World'],
    ['review prose is deterministic', JSON.stringify([...buildPlan().reviews.values()]) === JSON.stringify([...plan.reviews.values()])],
  ]);
}

export default {
  name: 'storefront',
  state: '.seed-storefront.local.json',
  contractEnv: ['STOREFRONT_CONTRACT_ID', 'NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID'],
  defaults: { concurrency: 8 },
  plan: buildPlan,
  dryRun,
  selfTest,
  run,
};
