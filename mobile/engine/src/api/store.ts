import { storeItemService } from '@/lib/services/store-item-service'
import { storeReviewService } from '@/lib/services/store-review-service'
import { itemReviewService } from '@/lib/services/item-review-service'
import { storeService } from '@/lib/services/store-service'
import type { ItemVariants, Store, StoreItem, StoreReview, ItemReview, StoreStatus, StoreItemStatus } from '@/types/store'
import { requireViewer } from '../dto/hydrate'

/** Storefront DTOs deliberately mirror lib's parsed models; dates and typed arrays cross the RPC codec safely. */
export interface StoreQuery { sort?: 'newest' | 'topRated' | 'mostOrdered'; limit?: number }
export interface StoreItemQuery { storeId: string; cursor?: string; activeOnly?: boolean; limit?: number }
export interface StoreWrite { name: string; description?: string; category?: string; status?: StoreStatus; defaultCurrency?: string; policies?: string; location?: string; paymentUris?: Store['paymentUris'] }
export interface ItemWrite { storeId: string; title: string; description?: string; imageUrls?: string[]; basePrice?: number; currency?: string; status?: StoreItemStatus; stockQuantity?: number; sku?: string; variants?: ItemVariants; fulfillment?: 'shipped' | 'digital'; shippingZoneIds?: string[] }
export interface ReviewWrite { storeId: string; orderId: string; sellerId: string; rating: number; title?: string; content?: string }
export interface ItemReviewWrite { storeId: string; itemId: string; orderId: string; rating: number; content?: string }

const cap = (value: number | undefined, fallback = 20) => Math.max(1, Math.min(50, Math.trunc(value ?? fallback)))

export const store = {
  async discover(query: StoreQuery = {}) {
    return storeService.getDiscoveryStores(query.sort ?? 'newest', cap(query.limit, 30))
  },
  async get(id: string): Promise<Store | null> { return storeService.getById(id) },
  async items(query: StoreItemQuery): Promise<{ items: StoreItem[]; nextCursor?: string }> {
    return storeItemService.getByStore(query.storeId, { limit: cap(query.limit), startAfter: query.cursor, activeOnly: query.activeOnly ?? true })
  },
  async item(id: string): Promise<StoreItem | null> { return storeItemService.getById(id) },
  async reviews(storeId: string, cursor?: string) { return storeReviewService.getStoreReviews(storeId, { limit: 20, startAfter: cursor }) },
  async itemReviews(itemId: string, cursor?: string) { return itemReviewService.getItemReviews(itemId, { limit: 20, startAfter: cursor }) },
  async mine(): Promise<Store | null> { return storeService.getByOwner(requireViewer('Your store')) },
  async create(input: StoreWrite): Promise<Store> { return storeService.createStore(requireViewer('Creating a store'), input) },
  async update(id: string, input: Partial<StoreWrite>): Promise<Store> { return storeService.updateStore(id, requireViewer('Updating your store'), input) },
  async createItem(input: ItemWrite): Promise<StoreItem> { return storeItemService.createItem(requireViewer('Adding a product'), input.storeId, input) },
  async updateItem(id: string, input: ItemWrite & { revision?: number }): Promise<StoreItem> {
    const { storeId, revision, ...changes } = input
    return storeItemService.updateItem(id, requireViewer('Updating a product'), storeId, changes, revision)
  },
  async archiveItem(id: string, storeId: string): Promise<StoreItem> { return storeItemService.archiveItem(id, requireViewer('Removing a product'), storeId) },
  async review(input: ReviewWrite): Promise<StoreReview> { return storeReviewService.createReview(requireViewer('Leaving a review'), input) },
  async itemReview(input: ItemReviewWrite): Promise<ItemReview> { return itemReviewService.createItemReview(requireViewer('Leaving a review'), input) },
}
