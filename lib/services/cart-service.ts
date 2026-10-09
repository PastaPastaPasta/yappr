import { logger } from '@/lib/logger';
/**
 * Cart Service
 *
 * Client-side cart management using localStorage.
 * No on-chain storage - purely browser-based.
 */

import type { Cart, CartItem, StoreItem } from '../../types';
import { storeItemService } from './store-item-service';
import { MAX_LINE_QUANTITY } from './digital-delivery-plan';
import { combinationImageUrl, variantOptionNames } from '../storefront/variant-codec';
import { storefrontVariantsAreTyped } from '../constants';
import { scopedKey } from '@/lib/storage-scope';

const CART_STORAGE_KEY = scopedKey('yappr_cart');

/**
 * The one currency a set of cart lines is priced in, or null when they mix
 * currencies. Prices are integers in each currency's smallest unit, so lines in
 * different currencies can never be summed into one subtotal.
 */
export function getCartCurrency(items: readonly CartItem[]): string | null {
  const currencies = new Set(items.map(item => item.currency || 'USD'));
  if (currencies.size > 1) return null;
  return currencies.values().next().value ?? 'USD';
}

export interface CartItemAvailability {
  /** The cart line, with its fulfillment brought up to date when the item could be read. */
  item: CartItem;
  maxQuantity: number;
  reason?: string;
}

/** A cart line carrying `fulfillment` (absent means shipped). */
function withFulfillment(line: CartItem, fulfillment: CartItem['fulfillment']): CartItem {
  if (line.fulfillment === fulfillment) return line;
  const next = { ...line };
  if (fulfillment) next.fulfillment = fulfillment;
  else delete next.fulfillment;
  return next;
}

/** Lines that must be shipped: everything not explicitly digital. */
export const shippableItems = (items: readonly CartItem[]) => items.filter(item => item.fulfillment !== 'digital');

/** What identifies a cart line (see {@link cartLineKey}). */
export type CartLineIdentity = Pick<CartItem, 'itemId' | 'variantId' | 'variantOptions'>;
/**
 * The one key every surface uses for a cart line (adding, stock counts,
 * quantity changes, removal, availability, list keys). On v7 the canonical
 * variant id is stable through renames and reorders, so it is the identity.
 * On v1–v6 ids follow option order, so the exact option names join it.
 */
export function cartLineKey(line: CartLineIdentity): string {
  return JSON.stringify(storefrontVariantsAreTyped()
    ? [line.itemId, line.variantId ?? null]
    : [line.itemId, line.variantId ?? null, line.variantOptions ?? null]);
}
/** Whether a stored line is the line `other` names. */
const isLine = (line: CartLineIdentity, other: CartLineIdentity) => cartLineKey(line) === cartLineKey(other);

class CartService {
  private cart: Cart | null = null;
  private listeners: Set<(cart: Cart) => void> = new Set();

  constructor() {
    // Load cart from localStorage on initialization
    if (typeof window !== 'undefined') {
      this.loadCart();
    }
  }

  /**
   * Load cart from localStorage
   */
  private loadCart(): Cart {
    try {
      const stored = localStorage.getItem(CART_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.cart = {
          // A line saved before variants had ids names its variant by a key no
          // listing answers to any more; it could never check out, so it goes.
          items: (parsed.items || []).filter((line: Partial<CartItem> & { variantKey?: unknown }) =>
            line.variantKey === undefined || typeof line.variantId === 'string'),
          updatedAt: new Date(parsed.updatedAt)
        };
      } else {
        this.cart = { items: [], updatedAt: new Date() };
      }
    } catch {
      logger.error('Failed to load cart from localStorage');
      this.cart = { items: [], updatedAt: new Date() };
    }
    return this.cart;
  }

  /**
   * Save cart to localStorage
   */
  private saveCart(): void {
    if (!this.cart) return;

    try {
      this.cart.updatedAt = new Date();
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(this.cart));
      this.notifyListeners();
    } catch {
      logger.error('Failed to save cart to localStorage');
    }
  }

  /**
   * Notify all listeners of cart changes
   */
  private notifyListeners(): void {
    if (!this.cart) return;
    // Create a new object reference so React detects the change
    const cartCopy = { ...this.cart, items: [...this.cart.items] };
    Array.from(this.listeners).forEach(listener => {
      listener(cartCopy);
    });
  }

  /**
   * Subscribe to cart changes
   */
  subscribe(listener: (cart: Cart) => void): () => void {
    this.listeners.add(listener);
    // Immediately call with current cart
    if (this.cart) {
      listener(this.cart);
    }
    // Return unsubscribe function
    return () => this.listeners.delete(listener);
  }

  /**
   * Get current cart
   */
  getCart(): Cart {
    return this.cart ?? this.loadCart();
  }

  /**
   * Get cart items
   */
  getItems(): CartItem[] {
    return this.getCart().items;
  }

  /**
   * Get items for a specific store
   */
  getItemsForStore(storeId: string): CartItem[] {
    return this.getItems().filter(item => item.storeId === storeId);
  }

  /**
   * Get unique store IDs in cart
   */
  getStoreIds(): string[] {
    const storeIds = new Set<string>();
    for (const item of this.getItems()) {
      storeIds.add(item.storeId);
    }
    return Array.from(storeIds);
  }

  /**
   * Add item to cart
   */
  addItem(item: {
    itemId: string;
    storeId: string;
    title: string;
    variantId?: string;
    variantLabel?: string;
    sku?: string;
    variantOptions?: string[];
    quantity: number;
    unitPrice: number;
    imageUrl?: string;
    currency: string;
    fulfillment?: CartItem['fulfillment'];
  }): void {
    const cart = this.getCart();

    // One line per item and variant: adding the same again raises its quantity.
    const existingIndex = cart.items.findIndex(i => isLine(i, item));

    if (existingIndex >= 0) {
      // Update quantity
      cart.items[existingIndex].quantity += item.quantity;
    } else {
      // Add new item
      cart.items.push(item);
    }

    this.saveCart();
  }

  /** The line choosing `variantId` of `storeItem` would be. */
  lineIdentity(storeItem: StoreItem, variantId?: string): CartLineIdentity {
    const combination = storeItemService.getCombination(storeItem, variantId);
    return {
      itemId: storeItem.id,
      ...(combination ? { variantId: combination.id } : {}),
      ...(combination && storeItem.variants ? { variantOptions: variantOptionNames(storeItem.variants, combination) } : {}),
    };
  }

  /** How many of that line the cart holds already. */
  quantityInCart(line: CartLineIdentity): number {
    return this.getItems().find(item => isLine(item, line))?.quantity ?? 0;
  }

  /**
   * Add item from StoreItem with variant selection (`variantId`, the
   * canonical id of the chosen combination; required on a variant item).
   */
  addStoreItem(storeItem: StoreItem, variantId?: string, quantity: number = 1): void {
    const stock = storeItemService.getStock(storeItem, variantId);
    const combination = storeItemService.getCombination(storeItem, variantId);
    const { variantOptions } = this.lineIdentity(storeItem, variantId);
    const existingQuantity = this.quantityInCart(this.lineIdentity(storeItem, variantId));
    if (storeItem.status !== 'active' || (storeItem.variants && !combination)) {
      throw new Error('This item is no longer available');
    }
    if (existingQuantity + quantity > stock) {
      throw new Error(stock === 0 ? 'Out of stock' : `Only ${stock} available, including items already in your cart`);
    }

    // One checkout pays one amount in one currency, so a store's cart lines must share it.
    const currency = storeItem.currency || 'USD';
    const storeItems = this.getItemsForStore(storeItem.storeId);
    const storeCurrency = getCartCurrency(storeItems);
    if (storeItems.length > 0 && storeCurrency !== currency) {
      throw new Error(`Your cart has items from this store priced in ${storeCurrency ?? 'other currencies'}. Check out or remove them before adding one priced in ${currency}.`);
    }

    const variantLabel = storeItemService.getVariantLabel(storeItem, variantId);
    const sku = storeItemService.getSku(storeItem, { variantId: combination?.id, variantOptions });
    this.addItem({
      itemId: storeItem.id,
      storeId: storeItem.storeId,
      title: storeItem.title,
      ...(combination ? { variantId: combination.id } : {}),
      ...(variantLabel ? { variantLabel } : {}),
      ...(sku ? { sku } : {}),
      ...(variantOptions ? { variantOptions } : {}),
      quantity,
      unitPrice: storeItemService.getPrice(storeItem, variantId),
      imageUrl: combinationImageUrl(storeItem.imageUrls, combination),
      currency,
      ...(storeItem.fulfillment === 'digital' ? { fulfillment: 'digital' as const } : {})
    });
  }

  /**
   * Update item quantity
   */
  updateQuantity(line: CartLineIdentity, quantity: number): void {
    const cart = this.getCart();
    const index = cart.items.findIndex(i => isLine(i, line));

    if (index >= 0) {
      if (quantity <= 0) {
        // Remove item
        cart.items.splice(index, 1);
      } else {
        cart.items[index].quantity = quantity;
      }
      this.saveCart();
    }
  }

  /**
   * Remove item from cart
   */
  removeItem(line: CartLineIdentity): void {
    const cart = this.getCart();
    cart.items = cart.items.filter(i => !isLine(i, line));
    this.saveCart();
  }

  /**
   * Remove all items for a store
   */
  removeStoreItems(storeId: string): void {
    const cart = this.getCart();
    cart.items = cart.items.filter(i => i.storeId !== storeId);
    this.saveCart();
  }

  /**
   * Clear entire cart
   */
  clearCart(): void {
    this.cart = { items: [], updatedAt: new Date() };
    this.saveCart();
  }

  /**
   * Get cart item count
   */
  getItemCount(): number {
    return this.getItems().reduce((sum, item) => sum + item.quantity, 0);
  }

  /**
   * Get cart subtotal (for a specific store or all)
   */
  getSubtotal(storeId?: string): number {
    const items = storeId ? this.getItemsForStore(storeId) : this.getItems();
    return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  }

  /**
   * Get total weight (for shipping calculation): each line's variant weight,
   * else its item's. Digital lines weigh nothing.
   * Note: This requires fetching items from the service
   */
  async getTotalWeight(storeId?: string): Promise<number> {
    const items = shippableItems(storeId ? this.getItemsForStore(storeId) : this.getItems());
    let totalWeight = 0;

    for (const cartItem of items) {
      const item = await storeItemService.get(cartItem.itemId);
      const weight = item ? storeItemService.getWeight(item, cartItem.variantId) : undefined;
      if (weight) {
        totalWeight += weight * cartItem.quantity;
      }
    }

    return totalWeight;
  }

  /**
   * Check if cart is empty
   */
  isEmpty(): boolean {
    return this.getItems().length === 0;
  }

  /**
   * Check if cart has items from multiple stores
   */
  hasMultipleStores(): boolean {
    return this.getStoreIds().length > 1;
  }

  /**
   * Read current inventory without the document cache. The one write: a line
   * whose product the seller switched to (or from) digital is updated in the
   * stored cart, and returned updated, so it checks out the way it now ships.
   */
  async getAvailability(items: CartItem[] = this.getItems()): Promise<CartItemAvailability[]> {
    return Promise.all(items.map(async (cartItem) => {
      try {
        // query() propagates read failures; get() caches and converts failures to null.
        const { documents } = await storeItemService.query({
          where: [['$id', '==', cartItem.itemId]],
          limit: 1
        });
        const item = documents[0];
        if (!item || item.status !== 'active') {
          return { item: cartItem, maxQuantity: 0, reason: 'Item is no longer available' };
        }
        if ((item.variants || cartItem.variantId) && !storeItemService.getLineCombination(item, cartItem)) {
          return { item: cartItem, maxQuantity: 0, reason: 'Selected option is no longer available' };
        }
        const synced = withFulfillment(cartItem, item.fulfillment === 'digital' ? 'digital' : undefined);
        if (synced !== cartItem) this.syncFulfillment(synced);
        const stock = storeItemService.getStock(item, cartItem.variantId);
        // A digital line is delivered for at most MAX_LINE_QUANTITY units: refuse more before payment.
        if (synced.fulfillment === 'digital' && cartItem.quantity > MAX_LINE_QUANTITY && stock >= cartItem.quantity) {
          return { item: synced, maxQuantity: MAX_LINE_QUANTITY, reason: `At most ${MAX_LINE_QUANTITY} per order` };
        }
        return {
          item: synced,
          maxQuantity: synced.fulfillment === 'digital' ? Math.min(stock, MAX_LINE_QUANTITY) : stock,
          reason: stock < cartItem.quantity
            ? stock === 0 ? 'Out of stock' : `Only ${stock} available`
            : undefined
        };
      } catch {
        return {
          item: cartItem,
          maxQuantity: cartItem.quantity,
          reason: 'Could not check availability. Please try again.'
        };
      }
    }));
  }

  /** Store `line`'s fulfillment on every stored line of the same item. */
  private syncFulfillment(line: CartItem): void {
    const cart = this.getCart();
    cart.items = cart.items.map(stored => stored.itemId === line.itemId ? withFulfillment(stored, line.fulfillment) : stored);
    this.saveCart();
  }

  /** Validate a checkout snapshot, including only the selected store's items. */
  async validateItems(items: CartItem[] = this.getItems()): Promise<CartItemAvailability[]> {
    return (await this.getAvailability(items)).filter(result => result.reason);
  }
}

export const cartService = new CartService();
