import { STOREFRONT_DOCUMENT_TYPES, YAPPR_STOREFRONT_CONTRACT_ID, storefrontIsV2, storefrontIsV6 } from '@/lib/constants'
import { moderatedContract } from '@/lib/moderated-contracts'
import { moderationServiceFor } from '@/lib/services/moderation-service'
import { contractReportProblem, contractReportService, type ContractReport, type ContractReportTarget } from '@/lib/services/contract-report-service'
import { StaleRevisionError } from '@/lib/services/document-service'
import { getEvoSdk } from '@/lib/services/evo-sdk-service'
import { itemReviewService } from '@/lib/services/item-review-service'
import { shippingZoneService } from '@/lib/services/shipping-zone-service'
import { storeItemService } from '@/lib/services/store-item-service'
import { storeOrderService } from '@/lib/services/store-order-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import { storeService } from '@/lib/services/store-service'
import { isStoreImageUrl, normalizeStoreCategory } from '@/lib/storefront/storefront-contract'
import { ListLimitError } from '@/lib/typed-array-codecs'
import { serializeStorePolicies, isPoliciesWithinLimit } from '@/lib/utils/policies'
import { parsePaymentUri } from '@/lib/utils/payment-uri'
import type {
  ItemFulfillment, ItemVariants, ParsedPaymentUri, ShippingPricingConfig, ShippingRateType, ShippingTier, StoreItemStatus, StorePolicy, StoreStatus,
} from '@/lib/types'
import { RpcError } from '../protocol/envelope'
import { badRequest, readFailure, requireViewer } from '../dto/hydrate'
import { NotSentError, type ProbeKit, type ProbeResult, type TicketStore, type WriteResult } from '../writes/tickets'
import { signer } from '../writes/handler-kit'
import { fromTransitionResult, wasConfirmed } from '../writes/lib-results'
import type { TicketDocument, WriteTicket } from '../writes/types'
import { storefrontDoc } from './store-shared'

export interface StoreFields {
  name: string
  description?: string
  /** Required on storefront v6+ (`manage().categoryRequired`): a slug, normalized here. */
  category?: string
  status?: StoreStatus
  defaultCurrency?: string
  location?: string
  policies?: StorePolicy[]
  /** Payment URIs as typed (`dash:X…`, `bitcoin:bc1…`): each parsed and checked. */
  paymentUris?: string[]
  logoUrl?: string
  bannerUrl?: string
}

export interface StoreSaveInput {
  /** Absent: create the viewer's store. */
  storeId?: string
  /** The revision the edit was made from: "check again" proves an update by the revision moving past it. */
  revision?: number
  fields: StoreFields
}

export interface ItemFields {
  title: string
  description?: string
  imageUrls?: string[]
  /** In the currency's smallest unit. */
  basePrice?: number
  currency?: string
  status?: Exclude<StoreItemStatus, 'deleted'>
  /** Undefined: no inventory tracking. */
  stockQuantity?: number
  sku?: string
  /** Grams. */
  weight?: number
  fulfillment?: ItemFulfillment
  /** v9: the zones it ships under; empty or absent = every zone. */
  shippingZoneIds?: string[]
  /** Kept as read when the editor does not touch variants. */
  variants?: ItemVariants
}

export interface ItemSaveInput {
  storeId: string
  /** Absent: create. */
  itemId?: string
  revision?: number
  /** `archive`: remove the listing (status `deleted`). */
  archive?: boolean
  fields?: ItemFields
}

export interface ZoneFields {
  name: string
  /** ISO country codes, comma separated, or `*` / empty for everywhere (web's zone editor). */
  countryPattern?: string
  postalPatterns?: string[]
  rateType: ShippingRateType
  flatRate?: number
  tiers?: ShippingTier[] | ShippingPricingConfig
  currency?: string
  priority?: number
}

export interface ZoneSaveInput {
  storeId: string
  zoneId?: string
  revision?: number
  delete?: boolean
  fields?: ZoneFields
}

export interface ReviewInput {
  orderId: string
  rating: number
  title?: string
  content?: string
  /** Per purchased item (v2+): ratings 1–5. */
  items?: { itemId: string; rating: number }[]
}

export interface StoreReportTarget { docType: 'store' | 'storeItem' | 'storeReview' | 'itemReview'; targetId: string; ownerId: string }

export interface StoreReportDTO {
  id: string
  reason: number
  note: string | null
  status: number | null
  resolution: string | null
}

/** Each typed payment URI checked by lib's parser (scheme and address); BAD_REQUEST names the first that is not one. */
function paymentUrisOf(values: string[]): ParsedPaymentUri[] {
  return values.map(value => value.trim()).filter(Boolean).map(value => {
    const parsed = parsePaymentUri(value)
    if (!parsed) throw badRequest(`"${value}" is not a payment address this store can take. Dash testnet addresses use tdash:, mainnet ones dash:.`)
    return parsed
  })
}

function storeData(fields: StoreFields) {
  if (!fields?.name?.trim()) throw badRequest('Give your store a name')
  const category = fields.category?.trim() ? normalizeStoreCategory(fields.category) : undefined
  if (storefrontIsV6() && !category) throw badRequest('Choose a category for your store')
  const policies = fields.policies?.filter(policy => policy.name.trim() || policy.content.trim()).map(policy => ({ name: policy.name.trim(), content: policy.content.trim() }))
  if (policies && !isPoliciesWithinLimit(policies)) throw badRequest('Your policies are too long. Shorten them to save.')
  for (const url of [fields.logoUrl, fields.bannerUrl]) if (url && !isStoreImageUrl(url)) throw badRequest('Images must be https:// or ipfs:// links')
  return {
    name: fields.name.trim(),
    description: fields.description?.trim() || undefined,
    status: fields.status ?? 'active',
    defaultCurrency: fields.defaultCurrency?.trim().toUpperCase() || undefined,
    location: fields.location?.trim() || undefined,
    policies: policies?.length ? serializeStorePolicies(policies) : undefined,
    paymentUris: fields.paymentUris ? paymentUrisOf(fields.paymentUris) : undefined,
    // Only what the editor sends: an omitted key keeps the stored value (updateStore clears a key given as undefined).
    ...('logoUrl' in fields ? { logoUrl: fields.logoUrl?.trim() || undefined } : {}),
    ...('bannerUrl' in fields ? { bannerUrl: fields.bannerUrl?.trim() || undefined } : {}),
    ...(category ? { category } : {}),
  }
}

function itemData(fields: ItemFields) {
  if (!fields?.title?.trim()) throw badRequest('Give the product a title')
  const price = fields.basePrice
  if (price !== undefined && !(Number.isInteger(price) && price >= 0)) throw badRequest('The price must be a whole amount in the smallest unit')
  const stock = fields.stockQuantity
  if (stock !== undefined && !(Number.isInteger(stock) && stock >= 0)) throw badRequest('Stock must be a whole number')
  // None is no list at all: an empty one is stored as null, which the contract refuses (10101).
  const images = fields.imageUrls?.map(url => url.trim()).filter(Boolean)
  const imageUrls = images?.length ? images : undefined
  // A product with options is priced and stocked per combination (v7 refuses both beside the table).
  const withOptions = (fields.variants?.combinations.length ?? 0) > 0
  return {
    title: fields.title.trim(),
    description: fields.description?.trim() || undefined,
    imageUrls,
    basePrice: withOptions ? undefined : price,
    currency: fields.currency?.trim().toUpperCase() || undefined,
    status: fields.status ?? 'active',
    stockQuantity: withOptions ? undefined : stock,
    sku: fields.sku?.trim() || undefined,
    weight: fields.weight,
    fulfillment: fields.fulfillment === 'digital' ? 'digital' as const : undefined,
    shippingZoneIds: fields.fulfillment === 'digital' ? undefined : fields.shippingZoneIds,
    // Given: written (none left clears them); absent: the stored table stays.
    ...(fields.variants ? { variants: withOptions ? fields.variants : undefined } : {}),
  }
}

function zoneData(fields: ZoneFields) {
  if (!fields?.name?.trim()) throw badRequest('Give the zone a name')
  if (!['flat', 'weight_tiered', 'price_tiered'].includes(fields.rateType)) throw badRequest('Choose how the zone is priced')
  const country = fields.countryPattern?.trim().toUpperCase()
  return {
    name: fields.name.trim(),
    countryPattern: country && country !== '*' ? country : undefined,
    // Kept as stored unless the editor sends them (updateZone clears a key given as undefined).
    ...('postalPatterns' in fields ? { postalPatterns: fields.postalPatterns?.map(pattern => pattern.trim()).filter(Boolean) } : {}),
    rateType: fields.rateType,
    flatRate: fields.flatRate,
    tiers: fields.tiers,
    currency: fields.currency?.trim().toUpperCase() || undefined,
    priority: fields.priority ?? 0,
  }
}

/** A refusal lib raises before signing (its own checks), as a failed ticket that sent nothing. */
function beforeSigning(error: unknown): never {
  if (error instanceof ListLimitError) throw new NotSentError(badRequest(error.message))
  if (error instanceof StaleRevisionError) throw new NotSentError(badRequest('This changed since you opened it. Go back, reopen it and try again.'))
  throw error
}

/**
 * "Check again" for an update: the document's revision moved past the one the
 * edit was made from. A disagreement counts only when a second read agrees.
 */
/**
 * "Check again" for an update. A revision past the one the edit was made
 * from proves only that SOME update landed (another device may have won):
 * it is this edit only when the stored document also shows what this edit
 * wrote (`shows`). A newer revision showing something else stays unknown.
 * No newer revision, twice, is not applied.
 */
function revisionProbe<A extends UpdateArgs>(type: string, shows: (args: A) => Promise<boolean>) {
  return async (ticket: WriteTicket, args: A | undefined, kit: ProbeKit): Promise<ProbeResult> => {
    if (!args?.id || args.revision === undefined) return kit.proveDocuments(ticket.documents)
    const { id, revision: editedFrom } = args
    const moved = async () => {
      const sdk = await getEvoSdk()
      const document = await sdk.documents.get(YAPPR_STOREFRONT_CONTRACT_ID, type, id) as { revision?: unknown; $revision?: unknown } | null
      return Number(document?.revision ?? document?.$revision ?? 0) > editedFrom
    }
    try {
      if (!(await moved())) {
        await kit.recheckDelay()
        if (!(await moved())) return { state: 'not-applied' }
      }
      return (await shows(args)) ? { state: 'applied' } : { state: 'unknown', error: new Error('Another edit landed after this one was made') }
    } catch (error) {
      return { state: 'unknown', error }
    }
  }
}

const sameText = (stored: string | undefined, sent: string | undefined) => (stored ?? '').trim() === (sent ?? '').trim()

const zoneUpdateProbe = revisionProbe<ZoneSaveInput & UpdateArgs>(STOREFRONT_DOCUMENT_TYPES.SHIPPING_ZONE, async ({ id, storeId, fields }) => {
  const stored = (await shippingZoneService.getByStore(storeId)).find(zone => zone.id === id)
  return Boolean(stored) && sameText(stored?.name, fields?.name) && stored?.flatRate === fields?.flatRate && sameText(stored?.countryPattern, fields?.countryPattern)
})

/** Input checks run before anything is signed: a refusal there is a failed ticket that sent nothing. */
function checkedBeforeSending<T>(check: () => T): T {
  try {
    return check()
  } catch (error) {
    throw new NotSentError(error)
  }
}

/** A create's or update's result: created documents named for "check again"; an update lib could not confirm stays confirmed (web's reading). */
function created(type: string, document: { id: string } | null, ctx: { documents(docs: TicketDocument[]): void }): WriteResult {
  if (!document) return { state: 'confirmed' }
  const confirmed = wasConfirmed(document)
  ctx.documents([storefrontDoc(type, document.id, 'create', confirmed)])
  return { state: confirmed ? 'confirmed' : 'unconfirmed' }
}

interface UpdateArgs { id?: string; revision?: number }

export function createStoreWrites(tickets: TicketStore) {
  tickets.register<StoreSaveInput & UpdateArgs>('store.save', {
    persistArgs: true,
    async run(input, ctx) {
      const owner = signer(ctx)
      const data = checkedBeforeSending(() => storeData(input.fields))
      if (!input.storeId) {
        if (await storeService.getByOwner(owner).catch(() => null)) throw new NotSentError(badRequest('You already have a store'))
        return created(STOREFRONT_DOCUMENT_TYPES.STORE, await storeService.createStore(owner, data).catch(beforeSigning), ctx)
      }
      await storeService.updateStore(input.storeId, owner, data).catch(beforeSigning)
      return { state: 'confirmed' }
    },
    probe: revisionProbe<StoreSaveInput & UpdateArgs>(STOREFRONT_DOCUMENT_TYPES.STORE, async ({ id, fields }) => {
      const stored = await storeService.getCurrent(id as string)
      return Boolean(stored) && sameText(stored?.name, fields.name) && stored?.status === (fields.status ?? 'active') && sameText(stored?.description, fields.description)
    }),
  })

  tickets.register<ItemSaveInput & UpdateArgs>('store.item', {
    persistArgs: true,
    async run(input, ctx) {
      const owner = signer(ctx)
      if (input.archive && input.itemId) {
        await storeItemService.archiveItem(input.itemId, owner, input.storeId).catch(beforeSigning)
        return { state: 'confirmed' }
      }
      const data = checkedBeforeSending(() => itemData(input.fields as ItemFields))
      // A saved options table is never cleared: its option ids live on in carts, orders and kits,
      // and a new table would hand them out again from 1.
      if (input.itemId && 'variants' in data && !data.variants) {
        const stored = await storeItemService.getById(input.itemId).catch((error: unknown) => { throw new NotSentError(readFailure(error)) })
        if (stored?.variants?.combinations.length) throw new NotSentError(badRequest("A product's options can't be removed. Pause it and list a new product instead."))
      }
      if (!input.itemId) return created(STOREFRONT_DOCUMENT_TYPES.STORE_ITEM, await storeItemService.createItem(owner, input.storeId, data).catch(beforeSigning), ctx)
      await storeItemService.updateItem(input.itemId, owner, input.storeId, data, input.revision).catch(beforeSigning)
      return { state: 'confirmed' }
    },
    probe: revisionProbe<ItemSaveInput & UpdateArgs>(STOREFRONT_DOCUMENT_TYPES.STORE_ITEM, async ({ id, archive, fields }) => {
      const [stored] = await storeItemService.getManyFresh([id as string])
      if (!stored) return false
      if (archive) return stored.status === 'deleted'
      return sameText(stored.title, fields?.title) && stored.status === (fields?.status ?? 'active') && stored.basePrice === fields?.basePrice && stored.stockQuantity === fields?.stockQuantity
    }),
  })

  tickets.register<ZoneSaveInput & UpdateArgs>('store.zone', {
    persistArgs: true,
    async run(input, ctx) {
      const owner = signer(ctx)
      if (input.delete && input.zoneId) {
        ctx.documents([storefrontDoc(STOREFRONT_DOCUMENT_TYPES.SHIPPING_ZONE, input.zoneId, 'delete')])
        const ok = await shippingZoneService.deleteZone(input.zoneId, owner)
        // lib answers false for any failure, a gateway timeout included: the probe decides.
        if (ok) return { state: 'confirmed', documents: [storefrontDoc(STOREFRONT_DOCUMENT_TYPES.SHIPPING_ZONE, input.zoneId, 'delete', true)] }
        const proof = await ctx.probe()
        if (proof.state === 'applied') return { state: 'confirmed' }
        return proof.state === 'not-applied' ? { state: 'failed', error: new Error('The zone could not be deleted') } : { state: 'unconfirmed' }
      }
      const data = checkedBeforeSending(() => zoneData(input.fields as ZoneFields))
      if (!input.zoneId) return created(STOREFRONT_DOCUMENT_TYPES.SHIPPING_ZONE, await shippingZoneService.createZone(owner, input.storeId, data).catch(beforeSigning), ctx)
      await shippingZoneService.updateZone(input.zoneId, owner, input.storeId, data).catch(beforeSigning)
      return { state: 'confirmed' }
    },
    probe: async (ticket, args, kit) => (args?.delete
      ? kit.proveDocuments(ticket.documents)
      : zoneUpdateProbe(ticket, args, kit)),
  })

  tickets.register<ReviewInput>('store.review', {
    persistArgs: true,
    stagedSends: true,
    async run(input, ctx) {
      const buyer = signer(ctx)
      ctx.stage('queued', true)
      const order = await storeOrderService.get(input.orderId).catch((error: unknown) => { throw new NotSentError(readFailure(error)) })
      if (!order) throw new NotSentError(badRequest('This order could not be found'))
      if (order.buyerId !== buyer) throw new NotSentError(badRequest('Only the buyer can review this order'))
      const rated = storefrontIsV2() ? (input.items ?? []).filter(item => item.rating >= 1 && item.rating <= 5) : []
      // A retry after an item review failed: the store review stands already (one per order), so only the
      // items go. A failed read is never "none": it sends nothing, and the retry reads again.
      const landed = (await storeReviewService.getOrderReviews([order.id]).catch((error: unknown) => { throw new NotSentError(readFailure(error)) })).get(order.id)
      ctx.stage('signing')
      ctx.progress(0, 1 + rated.length)
      const review = landed ?? await storeReviewService.createReview(buyer, {
        storeId: order.storeId, orderId: order.id, sellerId: order.sellerId, rating: input.rating,
        title: input.title?.trim() || undefined, content: input.content?.trim() || undefined,
      })
      const documents = [storefrontDoc(STOREFRONT_DOCUMENT_TYPES.STORE_REVIEW, review.id, 'create', landed ? true : wasConfirmed(review))]
      ctx.documents(documents)
      // Item reviews are separate documents; one that fails leaves the store review standing (web's ReviewModal).
      for (const [index, item] of rated.entries()) {
        ctx.progress(index + 1, 1 + rated.length)
        try {
          // A retry after a later item failed: an item review that landed already is never written twice.
          // The contract's unique (orderId, itemId) index answers it exactly; a failed read fails the write, never recreates.
          const prior = (await itemReviewService.query({ where: [['orderId', '==', order.id], ['itemId', '==', item.itemId]], limit: 1 })).documents[0]
          if (prior) {
            documents.push(storefrontDoc(STOREFRONT_DOCUMENT_TYPES.ITEM_REVIEW, prior.id, 'create', true))
            continue
          }
          const itemReview = await itemReviewService.createItemReview(buyer, { storeId: order.storeId, itemId: item.itemId, orderId: order.id, rating: item.rating })
          const doc = storefrontDoc(STOREFRONT_DOCUMENT_TYPES.ITEM_REVIEW, itemReview.id, 'create', wasConfirmed(itemReview))
          documents.push(doc)
          ctx.documents([doc])
        } catch (error) {
          return { state: 'failed', error, documents }
        }
      }
      ctx.progress(1 + rated.length, 1 + rated.length)
      return { state: documents.every(doc => doc.confirmed) ? 'confirmed' : 'unconfirmed', documents }
    },
    // Applied only when the store review and every requested item review are on chain (unique per order and item).
    async probe(ticket, input, kit) {
      if (!input) return kit.proveDocuments(ticket.documents)
      try {
        if (!(await storeReviewService.getOrderReviews([input.orderId])).has(input.orderId)) {
          await kit.recheckDelay()
          return (await storeReviewService.getOrderReviews([input.orderId])).has(input.orderId) ? { state: 'unknown', error: new Error('The review is still landing') } : { state: 'not-applied' }
        }
        const rated = storefrontIsV2() ? (input.items ?? []).filter(item => item.rating >= 1 && item.rating <= 5) : []
        for (const item of rated) {
          const found = (await itemReviewService.query({ where: [['orderId', '==', input.orderId], ['itemId', '==', item.itemId]], limit: 1 })).documents[0]
          if (!found) return { state: 'not-applied' }
        }
        return { state: 'applied' }
      } catch (error) {
        return { state: 'unknown', error }
      }
    },
  })

  tickets.register<ContractReportTarget & { reason: number; note: string }>('store.report', {
    persistArgs: true,
    async run(input, ctx) {
      const reporter = signer(ctx)
      const result = await contractReportService.file(reporter, input, input.reason, input.note)
      // file() refuses its own checks without sending anything.
      if (!result.success && !result.transactionHash && contractReportProblem(input.contract, input.reason, input.note)) throw new NotSentError(badRequest(result.error ?? 'Report refused'))
      return fromTransitionResult(result, result.success && result.transactionHash
        ? [{ contractId: moderatedContract(input.contract).contractId, type: 'report', id: result.transactionHash, action: 'create', confirmed: result.confirmed !== false }]
        : [])
    },
  })

  tickets.register<{ reportId: string }>('store.report.withdraw', {
    persistArgs: true,
    async run({ reportId }, ctx) {
      const reporter = signer(ctx)
      const doc: TicketDocument = { contractId: moderatedContract('storefront').contractId, type: 'report', id: reportId, action: 'delete', confirmed: false }
      ctx.documents([doc])
      const result = await contractReportService.withdraw(reporter, 'storefront', reportId)
      return fromTransitionResult(result, result.success ? [{ ...doc, confirmed: result.confirmed !== false }] : [doc])
    },
  })

  const submitAs = <A>(op: Parameters<TicketStore['submit']>[0]['op'], args: A, what: string): WriteTicket => {
    const viewer = requireViewer(what)
    return tickets.submit({ op, args, target: { identityId: viewer } })
  }

  return {
    /** Create the viewer's store, or update it (`storeId`). */
    async saveStore(input: StoreSaveInput): Promise<WriteTicket> {
      storeData(input?.fields)
      return submitAs('store.save', { ...input, id: input.storeId }, 'Saving a store')
    },
    /** Create, update or archive a listing. */
    async saveItem(input: ItemSaveInput): Promise<WriteTicket> {
      if (typeof input?.storeId !== 'string') throw badRequest('storeId is required')
      if (!input.archive) itemData(input.fields as ItemFields)
      return submitAs('store.item', { ...input, id: input.itemId }, 'Saving a product')
    },
    /** Create, update or delete a shipping zone. */
    async saveZone(input: ZoneSaveInput): Promise<WriteTicket> {
      if (typeof input?.storeId !== 'string') throw badRequest('storeId is required')
      if (!input.delete) zoneData(input.fields as ZoneFields)
      return submitAs('store.zone', { ...input, id: input.zoneId }, 'Saving a shipping zone')
    },
    /** Review an order's store (and its items). */
    async review(input: ReviewInput): Promise<WriteTicket> {
      if (!(Number.isInteger(input?.rating) && input.rating >= 1 && input.rating <= 5)) throw badRequest('Choose a rating from 1 to 5 stars')
      return submitAs('store.review', input, 'Leaving a review')
    },
    /** Whether reviews (and listings) can be written now: false while the storefront's first moderation team is not seated. */
    async reviewsOpen(): Promise<boolean> {
      try {
        return await moderationServiceFor('storefront').moderatedTypeOpen('storeReview')
      } catch (error) {
        throw readFailure(error)
      }
    },
    /** Report a store, listing or review to the storefront's moderators. */
    async report(target: StoreReportTarget, reason: number, note = ''): Promise<WriteTicket> {
      const full: ContractReportTarget = { contract: 'storefront', ...target }
      if (!moderatedContract('storefront').reportTargets().some(t => t.docType === target.docType)) throw new RpcError('Reporting is not available here', 'NOT_SUPPORTED')
      const problem = contractReportProblem('storefront', reason, note)
      if (problem) throw badRequest(problem)
      return submitAs('store.report', { ...full, reason, note }, 'Reporting')
    },
    async withdrawReport(reportId: string): Promise<WriteTicket> {
      return submitAs('store.report.withdraw', { reportId }, 'Withdrawing a report')
    },
    /** The viewer's own report on a storefront document, or null. */
    async ownReport(target: StoreReportTarget): Promise<StoreReportDTO | null> {
      const viewer = requireViewer('Your reports')
      let report: ContractReport | null
      try {
        report = await contractReportService.own(viewer, { contract: 'storefront', ...target })
      } catch (error) {
        throw readFailure(error)
      }
      return report ? { id: report.id, reason: report.reason, note: report.note ?? null, status: report.status ?? null, resolution: report.resolution ?? null } : null
    },
  }
}
