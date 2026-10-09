/**
 * Storefront v7 chain fixtures for the write specs: the seller's store and a
 * variant listing, created in Node with the action fees the app agrees to
 * (`store` 1,000M, `storeItem` 50M), so a spec signs in the browser only what
 * it asserts. Nothing here logs key material.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import bs58 from 'bs58'
import { expect } from '@playwright/test'
import storefrontContract from '../../contracts/yappr-storefront-contract.json'
import { b58, nodeSdk, queryDocs, signingFor, type DmBot } from './dm'

const ENV_FILE = process.env.E2E_ENV_FILE?.trim() || '.env.testing'
function envValue(name: string): string {
  if (process.env[name] !== undefined) return process.env[name] ?? ''
  const match = readFileSync(join(__dirname, '..', '..', ENV_FILE), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))
  return match?.[1]?.trim() ?? ''
}

export const STOREFRONT_CONTRACT_ID = envValue('NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID')
export const STOREFRONT_V7_BUILD = envValue('NEXT_PUBLIC_STOREFRONT_TOPOLOGY') === 'v7' && STOREFRONT_CONTRACT_ID !== ''
export const NOT_V7_REASON = 'E2E_ENV_FILE does not select a storefront v7 deployment — the typed variants table only exists there'

type SeedLib = {
  buildDocument: (options: Record<string, unknown>) => { document: unknown }
  createWithAgreement: (sdk: unknown, options: Record<string, unknown>) => Promise<unknown>
  feeAgreementFor: (sdk: unknown, docType: string, schemas: unknown) => Promise<unknown>
  randomEntropy: () => Uint8Array
}
const seedLib = async () => (await import('../../scripts/seed/seed-lib.mjs')) as unknown as SeedLib

/** A priced create (store, storeItem) signed by `bot` with the declared agreement; resolves once `landed()` sees it. */
async function createPriced(bot: DmBot, docType: string, data: Record<string, unknown>, landed: () => Promise<string | null>): Promise<string> {
  const sdk = await nodeSdk()
  const who = await signingFor(bot)
  const { createWithAgreement, feeAgreementFor, randomEntropy } = await seedLib()
  const agreement = await feeAgreementFor(sdk, docType, storefrontContract.documentSchemas)
  let derived: string | null = null
  try {
    await createWithAgreement(sdk, {
      contractId: STOREFRONT_CONTRACT_ID, docType, ownerId: who.ownerId, wif: who.wif, identityKey: who.identityKey,
      data, entropy: randomEntropy(), agreement, onDerivedId: (id: string) => { derived = id },
    })
  } catch {
    // A create that threw after broadcasting (the DAPI timeout) counts if it landed.
  }
  let found: string | null = null
  await expect.poll(async () => (found = await landed().catch(() => null)) !== null, { timeout: 120_000, intervals: [3_000] }).toBe(true)
  return found ?? derived ?? ''
}

export interface VariantListing {
  storeId: string
  itemId: string
  title: string
  /** The label the checkout shows for the store's one payment method. */
  paymentLabel: string
}

const PAYMENT_LABEL = 'Dash (e2e)'

/**
 * The seller's store (reused across runs; stores are one per owner and never
 * deleted) and a fresh digital listing of 2 option types: Red and Green in a
 * single piece and a 4 pack, Blue as a single piece only (so Blue / 4 Pack is
 * the combination that is NOT offered), prices 100 and 353 (USD cents), stock
 * and a SKU per combination.
 */
export async function ensureVariantListing(seller: DmBot, tag: string): Promise<VariantListing> {
  const ownStore = async () => {
    const [store] = await queryDocs(STOREFRONT_CONTRACT_ID, 'store', { where: [['$ownerId', '==', seller.identityId]], limit: 1 })
    return store ? b58(store.$id) : null
  }
  const storeId = (await ownStore()) ?? await createPriced(seller, 'store', {
    name: 'E2E Variant Shop', status: 'active', category: 'e2e-goods', defaultCurrency: 'USD',
    description: 'Storefront v7 end-to-end fixture.',
    paymentUris: JSON.stringify([{ scheme: 'dash:', uri: 'dash:yQo2wFCgzwkHE1jbJUxM4Q4jWgcupT5S6R', label: PAYMENT_LABEL }]),
  }, ownStore)

  const title = `E2E Squishy ${tag}`
  // Options in first-seen order: Red=1, Single Piece=2, 4 Pack=3, Blue=4, Green=5.
  const variants = {
    axes: ['Primary color', 'Pack Size'], options: ['Red', 'Blue', 'Green', 'Single Piece', '4 Pack'],
    optionIds: [1, 4, 5, 2, 3], optionAxes: [0, 0, 0, 1, 1], nextOptionId: 6,
    selectors: [Uint8Array.of(1, 2), Uint8Array.of(1, 3), Uint8Array.of(4, 2), Uint8Array.of(5, 2), Uint8Array.of(5, 3)],
    prices: [100, 353, 100, 100, 353], stocks: [9, 4, 7, 5, 2], skus: ['SQ-RED-S', 'SQ-RED-4', 'SQ-BLU-S', 'SQ-GRN-S', 'SQ-GRN-4'],
  }
  const listed = async () => {
    const items = await queryDocs(STOREFRONT_CONTRACT_ID, 'storeItem', {
      where: [['storeId', '==', storeId]], orderBy: [['storeId', 'asc'], ['$createdAt', 'desc']], limit: 20,
    })
    const item = items.find((candidate) => candidate.title === title)
    return item ? b58(item.$id) : null
  }
  const itemId = await createPriced(seller, 'storeItem', {
    storeId: bs58.decode(storeId), title, status: 'active', currency: 'USD', fulfillment: 'digital',
    description: 'Slow-rise foam. Storefront v7 end-to-end fixture.', variants,
  }, listed)
  return { storeId, itemId, title, paymentLabel: PAYMENT_LABEL }
}
