/**
 * Cart Service
 *
 * Client-side cart management using localStorage.
 * No on-chain storage - purely browser-based.
 */

import type { Cart, CartItem, StoreItem } from '../types';
import { storeItemService } from './store-item-service';

const CART_STORAGE_KEY = 'yappr_cart';

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
  private loadCart(): void {
    try {
      const stored = localStorage.getItem(CART_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.cart = {
          items: parsed.items || [],
          updatedAt: new Date(parsed.updatedAt)
        };
      } else {
        this.cart = { items: [], updatedAt: new Date() };
      }
    } catch {
      console.error('Failed to load cart from localStorage');
      this.cart = { items: [], updatedAt: new Date() };
    }
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
      console.error('Failed to save cart to localStorage');
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
    if (!this.cart) {
      this.loadCart();
    }
    return this.cart!;
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
    variantKey?: string;
    quantity: number;
    unitPrice: number;
    imageUrl?: string;
    currency: string;
  }): void {
    const cart = this.getCart();

    // Check if item already exists (same itemId + variantKey)
    const existingIndex = cart.items.findIndex(
      i => i.itemId === item.itemId && i.variantKey === item.variantKey
    );

    if (existingIndex >= 0) {
      // Update quantity
      cart.items[existingIndex].quantity += item.quantity;
    } else {
      // Add new item
      cart.items.push(item);
    }

    this.saveCart();
  }

  /**
   * Add item from StoreItem with variant selection
   */
  addStoreItem(storeItem: StoreItem, variantKey?: string, quantity: number = 1): void {
    const price = storeItemService.getPrice(storeItem, variantKey);
    const imageUrl = storeItem.imageUrls?.[0];

    // Get variant-specific image if available
    let variantImageUrl = imageUrl;
    if (variantKey && storeItem.variants) {
      const combo = storeItemService.getCombination(storeItem, variantKey);
      if (combo?.imageUrl) {
        variantImageUrl = combo.imageUrl;
      }
    }

    this.addItem({
      itemId: storeItem.id,
      storeId: storeItem.storeId,
      title: storeItem.title,
      variantKey,
      quantity,
      unitPrice: price,
      imageUrl: variantImageUrl,
      currency: storeItem.currency || 'USD'
    });
  }

  /**
   * Update item quantity
   */
  updateQuantity(itemId: string, variantKey: string | undefined, quantity: number): void {
    const cart = this.getCart();
    const index = cart.items.findIndex(
      i => i.itemId === itemId && i.variantKey === variantKey
    );

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
  removeItem(itemId: string, variantKey?: string): void {
    const cart = this.getCart();
    cart.items = cart.items.filter(
      i => !(i.itemId === itemId && i.variantKey === variantKey)
    );
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
   * Get total weight (for shipping calculation)
   * Note: This requires fetching items from the service
   */
  async getTotalWeight(storeId?: string): Promise<number> {
    const items = storeId ? this.getItemsForStore(storeId) : this.getItems();
    let totalWeight = 0;

    for (const cartItem of items) {
      const item = await storeItemService.get(cartItem.itemId);
      if (item?.weight) {
        totalWeight += item.weight * cartItem.quantity;
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
   * Validate cart items are still available
   * Returns list of unavailable items
   */
  async validateItems(): Promise<{ item: CartItem; reason: string }[]> {
    const unavailable: { item: CartItem; reason: string }[] = [];

    for (const cartItem of this.getItems()) {
      const item = await storeItemService.get(cartItem.itemId);

      if (!item) {
        unavailable.push({ item: cartItem, reason: 'Item no longer exists' });
        continue;
      }

      if (item.status !== 'active') {
        unavailable.push({ item: cartItem, reason: 'Item is no longer available' });
        continue;
      }

      const stock = storeItemService.getStock(item, cartItem.variantKey);
      if (stock < cartItem.quantity) {
        unavailable.push({
          item: cartItem,
          reason: stock === 0 ? 'Out of stock' : `Only ${stock} available`
        });
      }
    }

    return unavailable;
  }

  /**
   * Get variant display string
   */
  getVariantDisplay(variantKey?: string): string {
    if (!variantKey) return '';
    return variantKey.replace(/\|/g, ' / ');
  }
}

export const cartService = new CartService();
