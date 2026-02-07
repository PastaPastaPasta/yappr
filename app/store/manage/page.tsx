'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftIcon,
  BuildingStorefrontIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  CubeIcon,
  TruckIcon,
  Cog6ToothIcon,
  ShoppingBagIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  CreditCardIcon,
  ArrowUpTrayIcon,
  TableCellsIcon
} from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Spinner } from '@/components/ui/spinner'
import { ShippingZoneModal, PaymentMethodModal, InventoryUploadModal, PriceRangeDisplay } from '@/components/store'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { formatPrice } from '@/lib/utils/format'
import { getStoreStatusLabel, getStoreStatusDescription } from '@/lib/utils/store-status'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeService } from '@/lib/services/store-service'
import { storeItemService } from '@/lib/services/store-item-service'
import { shippingZoneService } from '@/lib/services/shipping-zone-service'
import { storeOrderService } from '@/lib/services/store-order-service'
import { identityService } from '@/lib/services/identity-service'
import type { Store, StoreItem, ShippingZone } from '@/lib/types'

function StoreManagePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('id')
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [store, setStore] = useState<Store | null>(null)
  const [items, setItems] = useState<StoreItem[]>([])
  const [zones, setZones] = useState<ShippingZone[]>([])
  const [pendingOrdersCount, setPendingOrdersCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'items' | 'shipping' | 'settings'>('items')
  const [hasEncryptionKey, setHasEncryptionKey] = useState<boolean | null>(null)

  // Modal state
  const [showZoneModal, setShowZoneModal] = useState(false)
  const [editingZone, setEditingZone] = useState<ShippingZone | null>(null)
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [showEncryptionKeyModal, setShowEncryptionKeyModal] = useState(false)
  const [showInventoryUpload, setShowInventoryUpload] = useState(false)

  // Delete confirmation state
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null)
  const [deleteZoneId, setDeleteZoneId] = useState<string | null>(null)
  const [deletePaymentIndex, setDeletePaymentIndex] = useState<number | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Load store data
  useEffect(() => {
    if (!sdkReady) return
    const loadData = async () => {
      if (!user?.identityId) return

      try {
        setIsLoading(true)

        // If no storeId, try to get user's store
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

        // Load items, zones, pending orders count, and check encryption key - handle each independently
        const [itemsResult, zonesResult, ordersResult, encKeyResult] = await Promise.allSettled([
          storeItemService.getByStore(currentStoreId, { limit: 100 }),
          shippingZoneService.getByStore(currentStoreId),
          storeOrderService.getSellerOrders(user.identityId, { limit: 100 }),
          identityService.hasEncryptionKey(user.identityId)
        ])

        if (itemsResult.status === 'fulfilled') {
          setItems(itemsResult.value.items)
        } else {
          console.error('Failed to load items:', itemsResult.reason)
        }

        if (zonesResult.status === 'fulfilled') {
          setZones(zonesResult.value)
        } else {
          console.error('Failed to load zones:', zonesResult.reason)
        }

        if (ordersResult.status === 'fulfilled') {
          setPendingOrdersCount(ordersResult.value.orders.length)
        } else {
          console.error('Failed to load orders:', ordersResult.reason)
        }

        if (encKeyResult.status === 'fulfilled') {
          setHasEncryptionKey(encKeyResult.value)
        } else {
          console.error('Failed to check encryption key:', encKeyResult.reason)
          setHasEncryptionKey(false)
        }
      } catch (error) {
        console.error('Failed to load store data:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadData().catch(console.error)
  }, [sdkReady, storeId, user?.identityId, router])

  const handleDeleteItem = async () => {
    if (!user?.identityId || !deleteItemId) return

    try {
      setIsDeleting(true)
      await storeItemService.delete(deleteItemId, user.identityId)
      setItems(items.filter(i => i.id !== deleteItemId))
      setDeleteItemId(null)
    } catch (error) {
      console.error('Failed to delete item:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleDeleteZone = async () => {
    if (!user?.identityId || !deleteZoneId) return

    try {
      setIsDeleting(true)
      await shippingZoneService.deleteZone(deleteZoneId, user.identityId)
      setZones(zones.filter(z => z.id !== deleteZoneId))
      setDeleteZoneId(null)
    } catch (error) {
      console.error('Failed to delete zone:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleCreateZone = async (data: {
    name: string
    rateType: 'flat' | 'weight_tiered' | 'price_tiered'
    flatRate?: number
    currency: string
    countryPattern?: string
    priority?: number
  }) => {
    if (!user?.identityId || !store?.id) return

    try {
      const newZone = await shippingZoneService.createZone(user.identityId, store.id, data)
      setZones([...zones, newZone])
      setShowZoneModal(false)
    } catch (err) {
      console.error('Failed to create shipping zone:', err)
      toast.error('Failed to create shipping zone')
    }
  }

  const handleUpdateZone = async (data: {
    name: string
    rateType: 'flat' | 'weight_tiered' | 'price_tiered'
    flatRate?: number
    currency: string
    countryPattern?: string
    priority?: number
  }) => {
    if (!user?.identityId || !editingZone) return

    try {
      const updatedZone = await shippingZoneService.updateZone(editingZone.id, user.identityId, editingZone.storeId, data)
      setZones(zones.map(z => z.id === editingZone.id ? updatedZone : z))
      setEditingZone(null)
    } catch (err) {
      console.error('Failed to update shipping zone:', err)
      toast.error('Failed to update shipping zone')
    }
  }

  const handleAddPayment = async (data: {
    scheme: string
    address: string
    label?: string
  }) => {
    if (!user?.identityId || !store?.id) return

    try {
      const newUri = {
        scheme: data.scheme,
        uri: `${data.scheme}${data.address}`,
        label: data.label
      }
      const currentUris = store.paymentUris || []
      const updatedStore = await storeService.patchStore(store.id, user.identityId, {
        paymentUris: [...currentUris, newUri]
      })
      setStore(updatedStore)
      setShowPaymentModal(false)
    } catch (error) {
      console.error('Failed to add payment method:', error)
      toast.error('Failed to add payment method')
    }
  }

  const handleRemovePayment = async () => {
    if (!user?.identityId || !store?.id || !store.paymentUris || deletePaymentIndex === null) return

    try {
      setIsDeleting(true)
      const updatedUris = store.paymentUris.filter((_, i) => i !== deletePaymentIndex)
      const updatedStore = await storeService.patchStore(store.id, user.identityId, {
        paymentUris: updatedUris
      })
      setStore(updatedStore)
      setDeletePaymentIndex(null)
    } catch (error) {
      console.error('Failed to remove payment method:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800 flex items-center justify-center">
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

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-gray-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => router.push('/store')}
                  className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
                >
                  <ArrowLeftIcon className="h-5 w-5" />
                </button>
                <h1 className="text-xl font-display font-bold truncate">Manage Store</h1>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/orders/seller')}
                className="flex items-center gap-1"
              >
                <ShoppingBagIcon className="h-4 w-4" />
                Orders
                {pendingOrdersCount > 0 && (
                  <span className="ml-1 w-5 h-5 bg-yappr-500 text-white text-xs rounded-full flex items-center justify-center">
                    {pendingOrdersCount}
                  </span>
                )}
              </Button>
            </div>

            {/* Store Info */}
            <div className="px-4 pb-4 flex items-center gap-4">
              <div className="w-16 h-16 rounded-xl bg-gray-200 dark:bg-gray-800 overflow-hidden flex-shrink-0">
                {store.logoUrl ? (
                  <img src={store.logoUrl} alt={store.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <BuildingStorefrontIcon className="h-8 w-8 text-gray-400" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-bold truncate">{store.name}</h2>
                <p className="text-sm text-gray-500">
                  {getStoreStatusLabel(store.status)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push(`/store/view?id=${store.id}`)}
              >
                View Store
              </Button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-800">
              <button
                onClick={() => setActiveTab('items')}
                className={`flex-1 py-3 text-center font-medium transition-colors relative flex items-center justify-center gap-2 ${
                  activeTab === 'items' ? 'text-gray-900 dark:text-white' : 'text-gray-500'
                }`}
              >
                <CubeIcon className="h-5 w-5" />
                Products
                {activeTab === 'items' && (
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-1 bg-yappr-500 rounded-full" />
                )}
              </button>
              <button
                onClick={() => setActiveTab('shipping')}
                className={`flex-1 py-3 text-center font-medium transition-colors relative flex items-center justify-center gap-2 ${
                  activeTab === 'shipping' ? 'text-gray-900 dark:text-white' : 'text-gray-500'
                }`}
              >
                <TruckIcon className="h-5 w-5" />
                Shipping
                {activeTab === 'shipping' && (
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-1 bg-yappr-500 rounded-full" />
                )}
              </button>
              <button
                onClick={() => setActiveTab('settings')}
                className={`flex-1 py-3 text-center font-medium transition-colors relative flex items-center justify-center gap-2 ${
                  activeTab === 'settings' ? 'text-gray-900 dark:text-white' : 'text-gray-500'
                }`}
              >
                <Cog6ToothIcon className="h-5 w-5" />
                Settings
                {activeTab === 'settings' && (
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-1 bg-yappr-500 rounded-full" />
                )}
              </button>
            </div>
          </header>

          {/* Setup Warnings */}
          {(hasEncryptionKey === false || (store && (!store.paymentUris || store.paymentUris.length === 0))) && (
            <div className="p-4 space-y-3">
              {hasEncryptionKey === false && (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <div className="flex items-start gap-3">
                    <ExclamationTriangleIcon className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-red-800 dark:text-red-200">Encryption Key Required</p>
                      <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                        Buyers cannot place orders until you add an encryption key to your identity. This key is needed to securely receive shipping addresses and order details.
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => setShowEncryptionKeyModal(true)}
                    className="mt-3 w-full bg-red-600 hover:bg-red-700 text-white"
                  >
                    <KeyIcon className="h-4 w-4 mr-2" />
                    Set Up Encryption Key
                  </Button>
                </div>
              )}
              {store && (!store.paymentUris || store.paymentUris.length === 0) && (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <div className="flex items-start gap-3">
                    <ExclamationTriangleIcon className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-red-800 dark:text-red-200">Payment Method Required</p>
                      <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                        Buyers cannot place orders until you add at least one payment method. This tells buyers where to send payment.
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setActiveTab('settings')
                      setTimeout(() => setShowPaymentModal(true), 100)
                    }}
                    className="mt-3 w-full bg-red-600 hover:bg-red-700 text-white"
                  >
                    <CreditCardIcon className="h-4 w-4 mr-2" />
                    Add Payment Method
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Content */}
          {activeTab === 'items' && (
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium">Products ({items.length})</h3>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex items-center gap-1"
                    onClick={() => setShowInventoryUpload(true)}
                  >
                    <ArrowUpTrayIcon className="h-4 w-4" />
                    Upload CSV
                  </Button>
                  {items.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex items-center gap-1"
                      onClick={() => router.push(`/store/inventory?storeId=${store?.id}`)}
                    >
                      <TableCellsIcon className="h-4 w-4" />
                      Inventory
                    </Button>
                  )}
                  <Button size="sm" className="flex items-center gap-1" onClick={() => router.push(`/store/item/add?storeId=${store?.id}`)}>
                    <PlusIcon className="h-4 w-4" />
                    Add Product
                  </Button>
                </div>
              </div>

              {items.length === 0 ? (
                <div className="py-12 text-center">
                  <CubeIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-500">No products yet</p>
                  <Button className="mt-4" onClick={() => router.push(`/store/item/add?storeId=${store?.id}`)}>
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Add Your First Product
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {items.map((item, index) => {
                    const priceRange = storeItemService.getPriceRange(item)

                    return (
                      <motion.div
                        key={item.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.03 }}
                        className="flex items-center gap-4 p-3 border border-gray-200 dark:border-gray-800 rounded-lg"
                      >
                        <div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden flex-shrink-0">
                          {item.imageUrls?.[0] ? (
                            <img src={item.imageUrls[0]} alt={item.title} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <CubeIcon className="h-6 w-6 text-gray-300" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium truncate">{item.title}</h4>
                          <PriceRangeDisplay
                            minPrice={priceRange.min}
                            maxPrice={priceRange.max}
                            currency={item.currency}
                            size="sm"
                          />
                          <p className="text-xs text-gray-500">
                            {item.status === 'active' ? 'Active' : item.status}
                            {item.stockQuantity !== undefined && ` • ${item.stockQuantity} in stock`}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => router.push(`/store/item/add?itemId=${item.id}&storeId=${store?.id}`)}
                            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
                          >
                            <PencilIcon className="h-4 w-4 text-gray-500" />
                          </button>
                          <button
                            onClick={() => setDeleteItemId(item.id)}
                            className="p-2 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-lg"
                          >
                            <TrashIcon className="h-4 w-4 text-red-500" />
                          </button>
                        </div>
                      </motion.div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'shipping' && (
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium">Shipping Zones ({zones.length})</h3>
                <Button size="sm" className="flex items-center gap-1" onClick={() => setShowZoneModal(true)}>
                  <PlusIcon className="h-4 w-4" />
                  Add Zone
                </Button>
              </div>

              {zones.length === 0 ? (
                <div className="py-12 text-center">
                  <TruckIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-500">No shipping zones configured</p>
                  <p className="text-sm text-gray-400 mt-1">Add zones to enable shipping calculations</p>
                  <Button className="mt-4" onClick={() => setShowZoneModal(true)}>
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Add Shipping Zone
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {zones.map((zone, index) => (
                    <motion.div
                      key={zone.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.03 }}
                      className="p-4 border border-gray-200 dark:border-gray-800 rounded-lg"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-medium">{zone.name}</h4>
                          <p className="text-sm text-gray-500">
                            {zone.rateType === 'flat'
                              ? `Flat rate: ${formatPrice(zone.flatRate || 0, zone.currency)}`
                              : zone.rateType === 'weight_tiered'
                                ? 'Weight-based tiers'
                                : 'Price-based tiers'
                            }
                          </p>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setEditingZone(zone)}
                            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
                          >
                            <PencilIcon className="h-4 w-4 text-gray-500" />
                          </button>
                          <button
                            onClick={() => setDeleteZoneId(zone.id)}
                            className="p-2 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-lg"
                          >
                            <TrashIcon className="h-4 w-4 text-red-500" />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="p-4 space-y-6">
              <div>
                <h3 className="font-medium mb-4">Store Settings</h3>

                <div className="space-y-4">
                  <div className="p-4 border border-gray-200 dark:border-gray-800 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <h4 className="font-medium">Store Status</h4>
                        <p className="text-sm text-gray-500">
                          {getStoreStatusDescription(store.status)}
                        </p>
                      </div>
                      <select
                        value={store.status}
                        onChange={async (e) => {
                          const newStatus = e.target.value as 'active' | 'paused' | 'closed'
                          try {
                            const updated = await storeService.patchStore(store.id, user!.identityId, {
                              status: newStatus
                            })
                            setStore(updated)
                          } catch (error) {
                            console.error('Failed to update status:', error)
                          }
                        }}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                      >
                        <option value="active">Active</option>
                        <option value="paused">Paused</option>
                        <option value="closed">Closed</option>
                      </select>
                    </div>
                  </div>

                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => router.push(`/store/create?id=${store.id}`)}
                  >
                    <PencilIcon className="h-4 w-4 mr-2" />
                    Edit Store Details
                  </Button>
                </div>
              </div>

              <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-medium">Payment Methods</h3>
                  <Button size="sm" variant="outline" onClick={() => setShowPaymentModal(true)}>
                    <PlusIcon className="h-4 w-4 mr-1" />
                    Add
                  </Button>
                </div>
                {store.paymentUris && store.paymentUris.length > 0 ? (
                  <div className="space-y-2">
                    {store.paymentUris.map((uri, i) => (
                      <div key={i} className="p-3 bg-gray-50 dark:bg-gray-950 rounded-lg flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{uri.label || uri.scheme.replace(':', '')}</p>
                          <p className="text-sm text-gray-500 font-mono truncate">{uri.uri}</p>
                        </div>
                        <button
                          onClick={() => setDeletePaymentIndex(i)}
                          className="p-2 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-lg ml-2"
                        >
                          <TrashIcon className="h-4 w-4 text-red-500" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <p className="text-sm text-gray-500 mb-3">No payment methods configured</p>
                    <Button size="sm" onClick={() => setShowPaymentModal(true)}>
                      <PlusIcon className="h-4 w-4 mr-1" />
                      Add Payment Method
                    </Button>
                  </div>
                )}
              </div>

            </div>
          )}
        </main>
      </div>

      <RightSidebar />

      {/* Modals */}
      <ShippingZoneModal
        isOpen={showZoneModal}
        onClose={() => setShowZoneModal(false)}
        onSave={handleCreateZone}
      />

      <ShippingZoneModal
        isOpen={!!editingZone}
        onClose={() => setEditingZone(null)}
        onSave={handleUpdateZone}
        zone={editingZone}
      />

      <PaymentMethodModal
        isOpen={showPaymentModal}
        onClose={() => setShowPaymentModal(false)}
        onSave={handleAddPayment}
      />

      <AddEncryptionKeyModal
        isOpen={showEncryptionKeyModal}
        onClose={() => setShowEncryptionKeyModal(false)}
        onSuccess={() => {
          setShowEncryptionKeyModal(false)
          setHasEncryptionKey(true)
        }}
        context="store"
      />

      <InventoryUploadModal
        isOpen={showInventoryUpload}
        onClose={() => setShowInventoryUpload(false)}
        storeId={store?.id || ''}
        ownerId={user?.identityId || ''}
        currency={store?.defaultCurrency || 'USD'}
        onComplete={(addedCount) => {
          setShowInventoryUpload(false)
          if (addedCount > 0) {
            toast.success(`Added ${addedCount} item${addedCount !== 1 ? 's' : ''} to your store`)
            // Reload items
            if (store?.id) {
              storeItemService.getByStore(store.id, { limit: 100 })
                .then(result => setItems(result.items))
                .catch(console.error)
            }
          }
        }}
      />

      {/* Delete Confirmation Dialogs */}
      <ConfirmDialog
        isOpen={deleteItemId !== null}
        onClose={() => setDeleteItemId(null)}
        onConfirm={handleDeleteItem}
        title="Delete Product"
        message="Are you sure you want to delete this product? This action cannot be undone."
        confirmText="Delete"
        variant="danger"
        isLoading={isDeleting}
      />

      <ConfirmDialog
        isOpen={deleteZoneId !== null}
        onClose={() => setDeleteZoneId(null)}
        onConfirm={handleDeleteZone}
        title="Delete Shipping Zone"
        message="Are you sure you want to delete this shipping zone? This action cannot be undone."
        confirmText="Delete"
        variant="danger"
        isLoading={isDeleting}
      />

      <ConfirmDialog
        isOpen={deletePaymentIndex !== null}
        onClose={() => setDeletePaymentIndex(null)}
        onConfirm={handleRemovePayment}
        title="Remove Payment Method"
        message="Are you sure you want to remove this payment method?"
        confirmText="Remove"
        variant="danger"
        isLoading={isDeleting}
      />
    </div>
  )
}

export default withAuth(StoreManagePage)
