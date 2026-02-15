'use client'

import React, { useState, useCallback, useMemo } from 'react'
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
import type { StoreItem, VariantCombination } from '@/lib/types'

interface InventoryTableProps {
  items: StoreItem[]
  storeId: string
  ownerId: string
  currency?: string
  onEditItem: (item: StoreItem) => void
  onItemDeleted: (itemId: string) => void
  onStockUpdate?: (itemId: string, newStock: number, variantKey?: string) => void
}

type SortField = 'title' | 'price' | 'stock' | 'status' | 'createdAt'
type SortDirection = 'asc' | 'desc'

export function InventoryTable({
  items,
  storeId,
  ownerId,
  currency = 'USD',
  onEditItem,
  onItemDeleted,
  onStockUpdate
}: InventoryTableProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<SortField>('createdAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [editingStock, setEditingStock] = useState<{
    itemId: string
    variantKey?: string
    value: string
  } | null>(null)
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Filter and sort items
  const filteredItems = useMemo(() => {
    let filtered = items

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(item =>
        item.title.toLowerCase().includes(query) ||
        item.sku?.toLowerCase().includes(query) ||
        item.category?.toLowerCase().includes(query) ||
        item.tags?.some(tag => tag.toLowerCase().includes(query))
      )
    }

    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(item => item.status === statusFilter)
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
      let comparison = 0

      switch (sortField) {
        case 'title':
          comparison = a.title.localeCompare(b.title)
          break
        case 'price':
          comparison = (a.basePrice || 0) - (b.basePrice || 0)
          break
        case 'stock': {
          const stockA = storeItemService.getStock(a)
          const stockB = storeItemService.getStock(b)
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
  }, [items, searchQuery, statusFilter, sortField, sortDirection])

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

  const handleStockEdit = useCallback((itemId: string, currentStock: number, variantKey?: string) => {
    setEditingStock({
      itemId,
      variantKey,
      value: currentStock === Infinity ? '' : currentStock.toString()
    })
  }, [])

  const handleStockSave = useCallback(async () => {
    if (!editingStock) return

    const newStock = editingStock.value === '' ? undefined : parseInt(editingStock.value, 10)

    if (newStock !== undefined && (isNaN(newStock) || newStock < 0)) {
      setEditingStock(null)
      return
    }

    try {
      const item = items.find(i => i.id === editingStock.itemId)
      if (!item) return

      if (editingStock.variantKey && item.variants) {
        // Update variant stock
        const updatedCombinations = item.variants.combinations.map(c =>
          c.key === editingStock.variantKey
            ? { ...c, stock: newStock }
            : c
        )

        await storeItemService.updateItem(
          editingStock.itemId,
          ownerId,
          storeId,
          {
            variants: {
              ...item.variants,
              combinations: updatedCombinations
            }
          }
        )
      } else {
        // Update base stock
        await storeItemService.updateItem(
          editingStock.itemId,
          ownerId,
          storeId,
          { stockQuantity: newStock }
        )
      }

      onStockUpdate?.(editingStock.itemId, newStock ?? Infinity, editingStock.variantKey)
    } catch (err) {
      console.error('Failed to update stock:', err)
    }

    setEditingStock(null)
  }, [editingStock, items, ownerId, storeId, onStockUpdate])

  const handleDelete = useCallback(async () => {
    if (!deleteItemId) return

    try {
      setIsDeleting(true)
      await storeItemService.delete(deleteItemId, ownerId)
      onItemDeleted(deleteItemId)
    } catch (err) {
      console.error('Failed to delete item:', err)
    } finally {
      setIsDeleting(false)
      setDeleteItemId(null)
    }
  }, [deleteItemId, ownerId, onItemDeleted])

  const renderStockCell = useCallback((
    item: StoreItem,
    stock: number,
    variantKey?: string
  ) => {
    const isEditing = editingStock?.itemId === item.id && editingStock?.variantKey === variantKey

    if (isEditing) {
      return (
        <input
          type="number"
          value={editingStock.value}
          onChange={(e) => setEditingStock({ ...editingStock, value: e.target.value })}
          onBlur={() => { handleStockSave().catch((err) => console.error('Failed to save stock:', err)) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleStockSave().catch((err) => console.error('Failed to save stock:', err))
            if (e.key === 'Escape') setEditingStock(null)
          }}
          placeholder="Unlimited"
          min="0"
          autoFocus
          className="w-20 px-2 py-1 text-sm bg-white dark:bg-gray-800 border border-yappr-500 rounded focus:outline-none"
        />
      )
    }

    return (
      <button
        onClick={() => handleStockEdit(item.id, stock, variantKey)}
        className="text-right hover:bg-gray-100 dark:hover:bg-gray-800 px-2 py-1 rounded transition-colors"
      >
        {stock === Infinity ? (
          <span className="text-gray-400">Unlimited</span>
        ) : stock === 0 ? (
          <span className="text-red-500 font-medium">Out of stock</span>
        ) : stock <= 5 ? (
          <span className="text-yellow-500 font-medium">{stock}</span>
        ) : (
          <span>{stock}</span>
        )}
      </button>
    )
  }, [editingStock, handleStockEdit, handleStockSave])

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
        </div>
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
                const hasVariants = item.variants && item.variants.combinations.length > 0
                const isExpanded = expandedItems.has(item.id)
                const priceRange = storeItemService.getPriceRange(item)
                const totalStock = hasVariants
                  ? item.variants!.combinations.reduce((sum, c) => {
                      const s = c.stock ?? Infinity
                      return s === Infinity ? Infinity : (sum === Infinity ? Infinity : sum + s)
                    }, 0)
                  : storeItemService.getStock(item)

                const variantRows = hasVariants && isExpanded
                  ? item.variants!.combinations.map((combo: VariantCombination) => (
                      <tr
                        key={`${item.id}-${combo.key}`}
                        className="bg-gray-50 dark:bg-gray-800/30"
                      >
                        <td className="px-3 py-2"></td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-3 pl-6">
                            {combo.imageUrl ? (
                              <img
                                src={combo.imageUrl}
                                alt={combo.key}
                                className="w-8 h-8 object-cover rounded"
                              />
                            ) : (
                              <div className="w-8 h-8 bg-gray-200 dark:bg-gray-700 rounded" />
                            )}
                            <span className="text-gray-600 dark:text-gray-400">
                              {combo.key.replace(/\|/g, ' / ')}
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
                          {renderStockCell(item, combo.stock ?? Infinity, combo.key)}
                        </td>
                        <td className="px-3 py-2"></td>
                        <td className="px-3 py-2"></td>
                      </tr>
                    ))
                  : null

                return (
                  <React.Fragment key={item.id}>
                    <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
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
                                {item.variants!.combinations.length} variants
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
                          <span className="text-gray-500">
                            {totalStock === Infinity ? 'Varies' : totalStock}
                          </span>
                        ) : (
                          renderStockCell(item, totalStock)
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

      {/* Delete Confirmation */}
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
    </div>
  )
}
