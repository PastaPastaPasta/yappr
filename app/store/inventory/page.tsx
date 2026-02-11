'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeftIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon
} from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { InventoryUploadModal, InventoryTable } from '@/components/store'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeService } from '@/lib/services/store-service'
import { storeItemService } from '@/lib/services/store-item-service'
import type { Store, StoreItem, VariantCombination } from '@/lib/types'

function InventoryPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('storeId')
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [store, setStore] = useState<Store | null>(null)
  const [items, setItems] = useState<StoreItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMoreItems, setHasMoreItems] = useState(false)
  const [showUploadModal, setShowUploadModal] = useState(false)

  const loadAllItems = useCallback(async (storeId: string) => {
    let allItems: StoreItem[] = []
    let cursor: string | undefined

    // Paginate through all items
    while (true) {
      const result = await storeItemService.getByStore(storeId, {
        limit: 100,
        startAfter: cursor
      })
      allItems = [...allItems, ...result.items]

      if (result.items.length < 100) break
      cursor = result.items[result.items.length - 1].id
    }

    setItems(allItems)
    setHasMoreItems(false)
  }, [])

  // Load store and items
  useEffect(() => {
    if (!sdkReady) return

    const loadData = async () => {
      if (!user?.identityId) return

      try {
        setIsLoading(true)

        // Get store ID
        let currentStoreId = storeId
        if (!currentStoreId) {
          const userStore = await storeService.getByOwner(user.identityId)
          if (userStore) {
            currentStoreId = userStore.id
            setStore(userStore)
          } else {
            router.push('/store/create')
            return
          }
        } else {
          const storeData = await storeService.getById(currentStoreId)
          if (!storeData || storeData.ownerId !== user.identityId) {
            router.push('/store')
            return
          }
          setStore(storeData)
        }

        // Load all items for inventory management
        await loadAllItems(currentStoreId)
      } catch (error) {
        console.error('Failed to load inventory:', error)
        toast.error('Failed to load inventory')
      } finally {
        setIsLoading(false)
      }
    }

    loadData().catch(console.error)
  }, [sdkReady, storeId, user?.identityId, router, loadAllItems])

  const handleEditItem = useCallback((item: StoreItem) => {
    router.push(`/store/item/add?itemId=${item.id}&storeId=${store?.id}`)
  }, [router, store?.id])

  const handleItemDeleted = useCallback((itemId: string) => {
    setItems(prev => prev.filter(item => item.id !== itemId))
    toast.success('Item deleted')
  }, [])

  const handleStockUpdate = useCallback((itemId: string, newStock: number, variantKey?: string) => {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item

      if (variantKey && item.variants) {
        return {
          ...item,
          variants: {
            ...item.variants,
            combinations: item.variants.combinations.map((c: VariantCombination) =>
              c.key === variantKey
                ? { ...c, stock: newStock === Infinity ? undefined : newStock }
                : c
            )
          }
        }
      }

      return {
        ...item,
        stockQuantity: newStock === Infinity ? undefined : newStock
      }
    }))
  }, [])

  const handleLoadMore = useCallback(async () => {
    if (!store?.id || isLoadingMore || !hasMoreItems) return

    setIsLoadingMore(true)
    try {
      const lastItem = items[items.length - 1]
      const result = await storeItemService.getByStore(store.id, {
        limit: 100,
        startAfter: lastItem?.id
      })
      setItems(prev => [...prev, ...result.items])
      setHasMoreItems(result.items.length >= 100)
    } catch (error) {
      console.error('Failed to load more items:', error)
      toast.error('Failed to load more items')
    } finally {
      setIsLoadingMore(false)
    }
  }, [store?.id, isLoadingMore, hasMoreItems, items])

  const handleExportCSV = useCallback(() => {
    if (items.length === 0) {
      toast.error('No items to export')
      return
    }

    const headers = [
      'Group',
      'Section',
      'Category',
      'Subcategory',
      'Item Name',
      'Description',
      'SKU',
      'Tags',
      'Variant',
      'Sub Variant',
      'Price',
      'Quantity',
      'Weight',
      'Image1',
      'Image2',
      'Image3',
      'Image4'
    ]

    const rows: string[][] = []

    for (const item of items) {
      if (item.variants && item.variants.combinations.length > 0) {
        // Export each variant as a row
        for (const combo of item.variants.combinations) {
          const [variant, subVariant] = combo.key.split('|')
          rows.push([
            item.id, // Use item ID as group
            item.section || '',
            item.category || '',
            item.subcategory || '',
            item.title,
            item.description || '',
            combo.sku || '',
            item.tags?.join(', ') || '',
            variant || '',
            subVariant || '',
            (combo.price / 100).toFixed(2),
            combo.stock?.toString() || '',
            item.weight?.toString() || '',
            combo.imageUrl || item.imageUrls?.[0] || '',
            item.imageUrls?.[1] || '',
            item.imageUrls?.[2] || '',
            item.imageUrls?.[3] || ''
          ])
        }
      } else {
        // Export single item
        rows.push([
          '',
          item.section || '',
          item.category || '',
          item.subcategory || '',
          item.title,
          item.description || '',
          item.sku || '',
          item.tags?.join(', ') || '',
          '',
          '',
          ((item.basePrice || 0) / 100).toFixed(2),
          item.stockQuantity?.toString() || '',
          item.weight?.toString() || '',
          item.imageUrls?.[0] || '',
          item.imageUrls?.[1] || '',
          item.imageUrls?.[2] || '',
          item.imageUrls?.[3] || ''
        ])
      }
    }

    // Escape CSV values
    const escapeCSV = (value: string) => {
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`
      }
      return value
    }

    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(escapeCSV).join(','))
    ].join('\n')

    // Download
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `inventory-${store?.name || 'export'}-${new Date().toISOString().split('T')[0]}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    toast.success('Inventory exported')
  }, [items, store?.name])

  const handleUploadComplete = useCallback((addedCount: number) => {
    setShowUploadModal(false)
    if (addedCount > 0) {
      toast.success(`Added ${addedCount} item${addedCount !== 1 ? 's' : ''} to inventory`)
      // Reload all items
      if (store?.id) {
        loadAllItems(store.id).catch(console.error)
      }
    }
  }, [store?.id, loadAllItems])

  if (isLoading) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[900px] md:border-x border-gray-200 dark:border-gray-800 flex items-center justify-center">
            <Spinner />
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  if (!store) {
    return null
  }

  if (!user?.identityId) {
    return null
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[900px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => router.push(`/store/manage?id=${store.id}`)}
                  className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
                >
                  <ArrowLeftIcon className="h-5 w-5" />
                </button>
                <div>
                  <h1 className="text-xl font-bold">Inventory</h1>
                  <p className="text-sm text-gray-500">{store.name}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportCSV}
                  disabled={items.length === 0}
                  className="flex items-center gap-1"
                >
                  <ArrowDownTrayIcon className="h-4 w-4" />
                  Export CSV
                </Button>
                <Button
                  size="sm"
                  onClick={() => setShowUploadModal(true)}
                  className="flex items-center gap-1"
                >
                  <ArrowUpTrayIcon className="h-4 w-4" />
                  Upload CSV
                </Button>
              </div>
            </div>
          </header>

          <div className="p-4">
            <InventoryTable
              items={items}
              storeId={store.id}
              ownerId={user.identityId}
              currency={store.defaultCurrency || 'USD'}
              onEditItem={handleEditItem}
              onItemDeleted={handleItemDeleted}
              onStockUpdate={handleStockUpdate}
            />
            {hasMoreItems && (
              <div className="py-4 text-center">
                <Button
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? 'Loading...' : 'Load More Items'}
                </Button>
              </div>
            )}
          </div>
        </main>
      </div>

      <RightSidebar />

      <InventoryUploadModal
        isOpen={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        storeId={store.id}
        ownerId={user.identityId}
        currency={store.defaultCurrency || 'USD'}
        onComplete={handleUploadComplete}
      />
    </div>
  )
}

export default withAuth(InventoryPage)
