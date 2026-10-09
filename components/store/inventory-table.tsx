'use client'

import { logger } from '@/lib/logger';
import React, { useState, useCallback, useMemo } from 'react'
import toast from 'react-hot-toast'
import {
  PencilIcon,
  TrashIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
  FunnelIcon,
  ArrowsUpDownIcon,
  CubeIcon
} from '@heroicons/react/24/outline'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { formatPrice } from '@/lib/utils/format'
import { storeItemService } from '@/lib/services/store-item-service'
import { combinationImageUrl, findCombination, tracksStock, updateCombination, variantLabel } from '@/lib/storefront/variant-codec'
import { parseCountInput } from '@/lib/storefront/variant-editor-model'
import { ListLimitError } from '@/lib/typed-array-codecs'
import { VARIANT_LIMITS } from '@/lib/storefront/storefront-contract'
import type { StoreItem, VariantCombination } from '@/lib/types'

/** What a stock edit changed on an item, for the page to merge into its copy. */
/** What a save changed, with the revision it wrote (the next variant save must start from it). */
export type InventoryItemChanges = Partial<Pick<StoreItem, 'stockQuantity' | 'variants' | '$revision'>>

interface InventoryTableProps {
  items: StoreItem[]
  storeId: string
  ownerId: string
  currency?: string
  onEditItem: (item: StoreItem) => void
  onItemDeleted: (itemId: string) => void
  onItemUpdated?: (itemId: string, changes: InventoryItemChanges) => void
}

type SortField = 'title' | 'price' | 'stock' | 'status' | 'createdAt'
type SortDirection = 'asc' | 'desc'

/** Unsaved stock per combination of one item: variant id → units. */
type StockDrafts = Record<string, number>

/** An item's units in all (with unsaved edits), or Infinity when it does not track stock. */
function totalStock(item: StoreItem, drafts: StockDrafts = {}): number {
  if (!item.variants) return storeItemService.getStock(item)
  if (!tracksStock(item.variants)) return Infinity
  return item.variants.combinations.reduce((sum, combination) => sum + (drafts[combination.id] ?? combination.stock ?? 0), 0)
}

/** A typed stock count, or null when it is not a whole number the contract stores (0 to 4,294,967,295). */
function parseStock(value: string): number | null {
  return parseCountInput(value, VARIANT_LIMITS.maxStock) ?? null
}

export function InventoryTable({
  items,
  storeId,
  ownerId,
  currency = 'USD',
  onEditItem,
  onItemDeleted,
  onItemUpdated
}: InventoryTableProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<SortField>('createdAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [editingStock, setEditingStock] = useState<{
    itemId: string
    variantId?: string
    value: string
  } | null>(null)
  // Variant stock edits wait here until the seller saves the item, once for all of them.
  const [stockDrafts, setStockDrafts] = useState<Record<string, StockDrafts>>({})
  const [savingItemId, setSavingItemId] = useState<string | null>(null)
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Bulk selection state
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false)
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState<{ current: number; total: number } | null>(null)

  // Derive unique categories from items
  const categories = useMemo(() => {
    const cats = items
      .filter(i => i.category)
      .map(i => i.category as string)
    return Array.from(new Set(cats)).sort()
  }, [items])

  // Filter and sort items
  const filteredItems = useMemo(() => {
    let filtered = items

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(item =>
        item.title.toLowerCase().includes(query) ||
        item.sku?.toLowerCase().includes(query) ||
        item.variants?.combinations.some(combo => combo.sku?.toLowerCase().includes(query)) ||
        item.category?.toLowerCase().includes(query) ||
        item.tags?.some(tag => tag.toLowerCase().includes(query))
      )
    }

    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(item => item.status === statusFilter)
    }

    // Category filter
    if (categoryFilter !== 'all') {
      filtered = filtered.filter(item => item.category === categoryFilter)
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
      let comparison = 0

      switch (sortField) {
        case 'title':
          comparison = a.title.localeCompare(b.title)
          break
        case 'price':
          comparison = storeItemService.getPriceRange(a).min - storeItemService.getPriceRange(b).min
          break
        case 'stock': {
          const stockA = totalStock(a)
          const stockB = totalStock(b)
          comparison = (stockA === Infinity ? 999999 : stockA) - (stockB === Infinity ? 999999 : stockB)
          break
        }
        case 'status':
          comparison = a.status.localeCompare(b.status)
          break
        case 'createdAt':
          comparison = a.createdAt.getTime() - b.createdAt.getTime()
          break
      }

      return sortDirection === 'asc' ? comparison : -comparison
    })

    return filtered
  }, [items, searchQuery, statusFilter, categoryFilter, sortField, sortDirection])

  // Clean up selection when filtered items change (remove items no longer visible)
  const filteredItemIds = useMemo(() => new Set(filteredItems.map(i => i.id)), [filteredItems])

  const activeSelectedCount = useMemo(
    () => Array.from(selectedItems).filter(id => filteredItemIds.has(id)).length,
    [selectedItems, filteredItemIds]
  )

  const allFilteredSelected = filteredItems.length > 0 && filteredItems.every(item => selectedItems.has(item.id))

  const toggleSelectAll = useCallback(() => {
    setSelectedItems(prev => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        // Deselect all filtered items
        for (const item of filteredItems) {
          next.delete(item.id)
        }
      } else {
        // Select all filtered items
        for (const item of filteredItems) {
          next.add(item.id)
        }
      }
      return next
    })
  }, [allFilteredSelected, filteredItems])

  const toggleSelectItem = useCallback((itemId: string) => {
    setSelectedItems(prev => {
      const next = new Set(prev)
      if (next.has(itemId)) {
        next.delete(itemId)
      } else {
        next.add(itemId)
      }
      return next
    })
  }, [])

  const handleBulkDelete = useCallback(async () => {
    const idsToDelete = Array.from(selectedItems).filter(id => filteredItemIds.has(id))
    const total = idsToDelete.length
    if (total === 0) return

    setIsDeleting(true)
    setBulkDeleteProgress({ current: 0, total })
    const failedIds: string[] = []

    for (let i = 0; i < idsToDelete.length; i++) {
      const itemId = idsToDelete[i]
      setBulkDeleteProgress({ current: i + 1, total })
      try {
        await storeItemService.archiveItem(itemId, ownerId, storeId)
        onItemDeleted(itemId)
      } catch (err) {
        failedIds.push(itemId)
        logger.error(`Failed to delete item ${itemId}:`, err)
      }
    }

    setSelectedItems(new Set(failedIds))
    setBulkDeleteProgress(null)
    setIsDeleting(false)
    if (failedIds.length > 0) {
      toast.error(`Failed to delete ${failedIds.length} item${failedIds.length === 1 ? '' : 's'}. Please try again.`)
    } else {
      setShowBulkDeleteDialog(false)
    }
  }, [selectedItems, filteredItemIds, ownerId, storeId, onItemDeleted])

  const toggleExpand = useCallback((itemId: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev)
      if (next.has(itemId)) {
        next.delete(itemId)
      } else {
        next.add(itemId)
      }
      return next
    })
  }, [])

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }, [sortField])

  const handleStockEdit = useCallback((itemId: string, currentStock: number, variantId?: string) => {
    setEditingStock({
      itemId,
      variantId,
      value: currentStock === Infinity ? '' : currentStock.toString()
    })
  }, [])

  /** Keep a combination's typed stock as an unsaved edit (dropped when it matches what is saved). */
  const setStockDraft = useCallback((item: StoreItem, variantId: string, stock: number) => {
    const saved = findCombination(item.variants, variantId)?.stock
    setStockDrafts((prev) => {
      const drafts = { ...prev[item.id] }
      if (stock === saved) delete drafts[variantId]
      else drafts[variantId] = stock
      const next = { ...prev }
      if (Object.keys(drafts).length > 0) next[item.id] = drafts
      else delete next[item.id]
      return next
    })
  }, [])

  const discardStockDrafts = useCallback((itemId: string) => {
    setStockDrafts((prev) => {
      const next = { ...prev }
      delete next[itemId]
      return next
    })
  }, [])

  /** Save every unsaved stock edit of a variant item in one update. */
  const saveStockDrafts = useCallback(async (item: StoreItem) => {
    const drafts = stockDrafts[item.id]
    if (!drafts || !item.variants || savingItemId) return
    const variants = Object.entries(drafts).reduce(
      (table, [variantId, stock]) => updateCombination(table, variantId, { stock }),
      item.variants
    )
    setSavingItemId(item.id)
    try {
      const updated = await storeItemService.updateItem(item.id, ownerId, storeId, { variants }, item.$revision)
      onItemUpdated?.(item.id, { variants, $revision: updated.$revision })
      // Only the edits this write carried: one typed while it was pending stays unsaved.
      setStockDrafts((prev) => {
        const left = Object.fromEntries(Object.entries(prev[item.id] ?? {}).filter(([variantId, stock]) => drafts[variantId] !== stock))
        const next = { ...prev }
        if (Object.keys(left).length > 0) next[item.id] = left
        else delete next[item.id]
        return next
      })
      toast.success('Stock saved')
    } catch (err) {
      logger.error('Failed to update stock:', err)
      toast.error(err instanceof ListLimitError ? err.message : 'Stock could not be saved. Please try again.')
    } finally {
      setSavingItemId(null)
    }
  }, [stockDrafts, savingItemId, ownerId, storeId, onItemUpdated])

  const handleStockSave = useCallback(async () => {
    if (!editingStock) return
    setEditingStock(null)

    const item = items.find(i => i.id === editingStock.itemId)
    if (!item) return

    if (editingStock.variantId) {
      // Every combination of a variant item is tracked or none is, so an empty or invalid entry changes nothing.
      const stock = parseStock(editingStock.value)
      if (stock !== null) setStockDraft(item, editingStock.variantId, stock)
      return
    }

    // A product without options saves at once; an empty entry stops tracking its stock.
    const stockQuantity = editingStock.value.trim() === '' ? undefined : parseStock(editingStock.value)
    if (stockQuantity === null || stockQuantity === item.stockQuantity) return
    try {
      const updated = await storeItemService.updateItem(item.id, ownerId, storeId, { stockQuantity })
      onItemUpdated?.(item.id, { stockQuantity, $revision: updated.$revision })
    } catch (err) {
      logger.error('Failed to update stock:', err)
      toast.error(err instanceof ListLimitError ? err.message : 'Stock could not be saved. Please try again.')
    }
  }, [editingStock, items, ownerId, storeId, onItemUpdated, setStockDraft])

  const handleDelete = useCallback(async () => {
    if (!deleteItemId) return

    try {
      setIsDeleting(true)
      await storeItemService.archiveItem(deleteItemId, ownerId, storeId)
      onItemDeleted(deleteItemId)
      setDeleteItemId(null)
    } catch (err) {
      logger.error('Failed to delete item:', err)
      toast.error('Failed to delete item. Please try again.')
    } finally {
      setIsDeleting(false)
    }
  }, [deleteItemId, ownerId, storeId, onItemDeleted])

  const renderStockCell = useCallback((
    item: StoreItem,
    stock: number,
    variantId?: string
  ) => {
    const isEditing = editingStock?.itemId === item.id && editingStock?.variantId === variantId
    const edited = variantId !== undefined && stockDrafts[item.id]?.[variantId] !== undefined
    // Edits wait for this item's save: one made meanwhile could be lost or undone by it.
    const isSaving = savingItemId === item.id

    if (isEditing) {
      return (
        <input
          type="number"
          value={editingStock.value}
          onChange={(e) => setEditingStock({ ...editingStock, value: e.target.value })}
          onBlur={() => { handleStockSave().catch((err) => logger.error('Failed to save stock:', err)) }}
          onKeyDown={(e) => {
            // Enter commits through the blur, so one edit is saved once.
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setEditingStock(null)
          }}
          placeholder={variantId ? undefined : 'Not tracked'}
          aria-label="Stock"
          min="0"
          autoFocus
          className="w-20 px-2 py-1 text-sm bg-white dark:bg-gray-800 border border-yappr-500 rounded focus:outline-none"
        />
      )
    }

    // A variant item that does not track stock tracks none of its combinations.
    if (variantId !== undefined && stock === Infinity) {
      return <span className="px-2 py-1 text-gray-400">Not tracked</span>
    }

    return (
      <button
        onClick={() => handleStockEdit(item.id, stock, variantId)}
        disabled={isSaving}
        title={edited ? 'Not saved yet' : undefined}
        className={`text-right hover:bg-gray-100 dark:hover:bg-gray-800 px-2 py-1 rounded transition-colors ${edited ? 'ring-1 ring-yappr-500' : ''}`}
      >
        {stock === Infinity ? (
          <span className="text-gray-400">Not tracked</span>
        ) : stock === 0 ? (
          <span className="text-red-500 font-medium">Out of stock</span>
        ) : stock <= 5 ? (
          <span className="text-yellow-500 font-medium">{stock}</span>
        ) : (
          <span>{stock}</span>
        )}
      </button>
    )
  }, [editingStock, stockDrafts, savingItemId, handleStockEdit, handleStockSave])

  const SortButton = useCallback(({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <button
      onClick={() => handleSort(field)}
      className="flex items-center gap-1 hover:text-gray-900 dark:hover:text-white"
    >
      {children}
      {sortField === field && (
        <ArrowsUpDownIcon className={`h-3 w-3 ${sortDirection === 'desc' ? 'rotate-180' : ''}`} />
      )}
    </button>
  ), [sortField, sortDirection, handleSort])

  if (items.length === 0) {
    return (
      <div className="py-12 text-center">
        <CubeIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-500">No inventory items yet</p>
      </div>
    )
  }

  const bulkDeleteMessage = bulkDeleteProgress
    ? `Deleting ${bulkDeleteProgress.current} of ${bulkDeleteProgress.total}...`
    : `Are you sure you want to delete ${activeSelectedCount} selected item${activeSelectedCount === 1 ? '' : 's'}? This action cannot be undone.`

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, SKU, or tag..."
            className="w-full pl-9 pr-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
          />
        </div>

        <div className="flex items-center gap-2">
          <FunnelIcon className="h-4 w-4 text-gray-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="sold_out">Sold Out</option>
            <option value="deleted">Deleted</option>
          </select>

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
          >
            <option value="all">All Categories</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        {activeSelectedCount > 0 && (
          <button
            onClick={() => setShowBulkDeleteDialog(true)}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
          >
            Delete Selected ({activeSelectedCount})
          </button>
        )}
      </div>

      {/* Results count */}
      <div className="text-sm text-gray-500">
        Showing {filteredItems.length} of {items.length} items
      </div>

      {/* Table */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
                  />
                </th>
                <th className="w-8 px-3 py-3"></th>
                <th className="text-left px-3 py-3 font-medium">
                  <SortButton field="title">Item</SortButton>
                </th>
                <th className="text-left px-3 py-3 font-medium">SKU</th>
                <th className="text-right px-3 py-3 font-medium">
                  <SortButton field="price">Price</SortButton>
                </th>
                <th className="text-right px-3 py-3 font-medium">
                  <SortButton field="stock">Stock</SortButton>
                </th>
                <th className="text-center px-3 py-3 font-medium">
                  <SortButton field="status">Status</SortButton>
                </th>
                <th className="w-24 px-3 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {filteredItems.map((item) => {
                const variants = item.variants
                const combinations = variants?.combinations ?? []
                const hasVariants = combinations.length > 0
                const isExpanded = expandedItems.has(item.id)
                const priceRange = storeItemService.getPriceRange(item)
                const drafts = stockDrafts[item.id] ?? {}
                const draftCount = Object.keys(drafts).length
                const itemStock = totalStock(item, drafts)

                const variantRows = variants && hasVariants && isExpanded
                  ? combinations.map((combo: VariantCombination) => {
                      const label = variantLabel(variants, combo)
                      const thumbnail = combinationImageUrl(item.imageUrls, combo)
                      return (
                      <tr
                        key={`${item.id}-${combo.id}`}
                        className="bg-gray-50 dark:bg-gray-800/30"
                      >
                        <td className="px-3 py-2"></td>
                        <td className="px-3 py-2"></td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-3 pl-6">
                            {thumbnail ? (
                              <img
                                src={thumbnail}
                                alt={label}
                                className="w-8 h-8 object-cover rounded"
                              />
                            ) : (
                              <div className="w-8 h-8 bg-gray-200 dark:bg-gray-700 rounded" />
                            )}
                            <span className="text-gray-600 dark:text-gray-400">
                              {label}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-500 text-sm">
                          {combo.sku || '-'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatPrice(combo.price, currency)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {renderStockCell(item, drafts[combo.id] ?? combo.stock ?? Infinity, combo.id)}
                        </td>
                        <td className="px-3 py-2"></td>
                        <td className="px-3 py-2"></td>
                      </tr>
                      )
                    })
                  : null

                return (
                  <React.Fragment key={item.id}>
                    <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selectedItems.has(item.id)}
                          onChange={() => toggleSelectItem(item.id)}
                          className="rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
                        />
                      </td>
                      <td className="px-3 py-3">
                        {hasVariants && (
                          <button
                            onClick={() => toggleExpand(item.id)}
                            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                          >
                            {isExpanded ? (
                              <ChevronDownIcon className="h-4 w-4" />
                            ) : (
                              <ChevronRightIcon className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          {item.imageUrls?.[0] ? (
                            <img
                              src={item.imageUrls[0]}
                              alt={item.title}
                              className="w-10 h-10 object-cover rounded"
                            />
                          ) : (
                            <div className="w-10 h-10 bg-gray-200 dark:bg-gray-700 rounded flex items-center justify-center">
                              <CubeIcon className="h-5 w-5 text-gray-400" />
                            </div>
                          )}
                          <div>
                            <div className="font-medium">{item.title}</div>
                            {item.category && (
                              <div className="text-xs text-gray-500">{item.category}</div>
                            )}
                            {hasVariants && (
                              <div className="text-xs text-yappr-500">
                                {combinations.length} variants
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-gray-500">
                        {item.sku || '-'}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {priceRange.min === priceRange.max
                          ? formatPrice(priceRange.min, currency)
                          : `${formatPrice(priceRange.min, currency)} - ${formatPrice(priceRange.max, currency)}`
                        }
                      </td>
                      <td className="px-3 py-3 text-right">
                        {hasVariants ? (
                          <div className="flex flex-col items-end gap-1">
                            <span className={itemStock === Infinity ? 'text-gray-400' : 'text-gray-500'}>
                              {itemStock === Infinity ? 'Not tracked' : itemStock}
                            </span>
                            {draftCount > 0 && (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => { saveStockDrafts(item).catch((err) => logger.error('Failed to save stock:', err)) }}
                                  disabled={savingItemId !== null}
                                  className="px-2 py-0.5 text-xs font-medium text-white bg-yappr-500 hover:bg-yappr-600 rounded disabled:opacity-50"
                                >
                                  {savingItemId === item.id ? 'Saving…' : `Save ${draftCount === 1 ? 'change' : `${draftCount} changes`}`}
                                </button>
                                <button
                                  onClick={() => discardStockDrafts(item.id)}
                                  disabled={savingItemId === item.id}
                                  className="px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-50"
                                >
                                  Discard
                                </button>
                              </div>
                            )}
                          </div>
                        ) : (
                          renderStockCell(item, itemStock)
                        )}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className={`inline-flex px-2 py-1 text-xs rounded-full ${
                          item.status === 'active'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : item.status === 'paused'
                              ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                              : item.status === 'sold_out'
                                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                        }`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => onEditItem(item)}
                            className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                            title="Edit"
                          >
                            <PencilIcon className="h-4 w-4 text-gray-500" />
                          </button>
                          <button
                            onClick={() => setDeleteItemId(item.id)}
                            className="p-2 hover:bg-red-100 dark:hover:bg-red-900/20 rounded"
                            title="Delete"
                          >
                            <TrashIcon className="h-4 w-4 text-red-500" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {variantRows}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Single Delete Confirmation */}
      <ConfirmDialog
        isOpen={deleteItemId !== null}
        onClose={() => setDeleteItemId(null)}
        onConfirm={handleDelete}
        title="Delete Item"
        message="Are you sure you want to delete this item? This action cannot be undone."
        confirmText="Delete"
        variant="danger"
        isLoading={isDeleting}
      />

      {/* Bulk Delete Confirmation */}
      <ConfirmDialog
        isOpen={showBulkDeleteDialog}
        onClose={() => setShowBulkDeleteDialog(false)}
        onConfirm={() => { handleBulkDelete().catch((err) => logger.error('Bulk delete failed:', err)) }}
        title="Delete Selected Items"
        message={bulkDeleteMessage}
        confirmText={bulkDeleteProgress ? `Deleting ${bulkDeleteProgress.current}/${bulkDeleteProgress.total}...` : `Delete ${activeSelectedCount} Items`}
        variant="danger"
        isLoading={isDeleting}
      />
    </div>
  )
}
