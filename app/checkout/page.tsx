'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon, CheckCircleIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import {
  AddressForm,
  DeliveryDetailsForm,
  ShippingSelector,
  PaymentSelector,
  PolicyAgreement,
  OrderReview,
  SaveAddressPrompt,
  SavedAddressModal
} from '@/components/checkout'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { cartService } from '@/lib/services/cart-service'
import { storeService } from '@/lib/services/store-service'
import { shippingZoneService } from '@/lib/services/shipping-zone-service'
import { storeOrderService } from '@/lib/services/store-order-service'
import { identityService } from '@/lib/services/identity-service'
import { parseStorePolicies } from '@/lib/utils/policies'
import { savedAddressService } from '@/lib/services/saved-address-service'
import { hasEncryptionKey, getEncryptionKeyBytes } from '@/lib/secure-storage'
import type { Store, CartItem, ShippingAddress, BuyerContact, ParsedPaymentUri, ShippingZone, StorePolicy, SavedAddress } from '@/lib/types'

/**
 * Normalize key data from various formats to Uint8Array
 */
function normalizeKeyData(data: unknown): Uint8Array | null {
  if (!data) return null
  if (data instanceof Uint8Array) return data
  if (Array.isArray(data)) return new Uint8Array(data)
  if (typeof data === 'string') {
    try {
      const binaryString = atob(data)
      return Uint8Array.from(binaryString, (c) => c.charCodeAt(0))
    } catch {
      return null
    }
  }
  return null
}

function CheckoutPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('storeId')
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [store, setStore] = useState<Store | null>(null)
  const [cartItems, setCartItems] = useState<CartItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [orderCreated, setOrderCreated] = useState(false)
  const [step, setStep] = useState<'address' | 'delivery' | 'shipping' | 'policies' | 'payment' | 'review'>('address')
  const [error, setError] = useState<string | null>(null)

  // Policies
  const [storePolicies, setStorePolicies] = useState<StorePolicy[]>([])
  const [agreedPolicies, setAgreedPolicies] = useState<Set<number>>(new Set())

  // Address form
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress>({
    name: '',
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'US'
  })

  // Contact
  const [buyerContact, setBuyerContact] = useState<BuyerContact>({})

  // Shipping
  const [matchedZone, setMatchedZone] = useState<ShippingZone | null>(null)
  const [shippingCost, setShippingCost] = useState(0)
  const [zonesLoadFailed, setZonesLoadFailed] = useState(false)
  const [hasNoZones, setHasNoZones] = useState(false)

  const fulfillmentSummary = useMemo(() => {
    const isPhysical = (item: CartItem) => (item.fulfillmentType || 'physical') === 'physical'
    const physicalItems = cartItems.filter(isPhysical)
    const digitalItems = cartItems.filter(item => !isPhysical(item))
    return {
      hasPhysicalItems: physicalItems.length > 0,
      hasDigitalItems: digitalItems.length > 0,
      physicalItems,
      digitalItems
    }
  }, [cartItems])

  const steps = useMemo(() => (
    fulfillmentSummary.hasPhysicalItems
      ? ['address', 'shipping', 'policies', 'payment', 'review']
      : ['delivery', 'policies', 'payment', 'review']
  ), [fulfillmentSummary.hasPhysicalItems])

  useEffect(() => {
    if (!fulfillmentSummary.hasPhysicalItems && (step === 'address' || step === 'shipping')) {
      setStep('delivery')
    }
    if (fulfillmentSummary.hasPhysicalItems && step === 'delivery') {
      setStep('address')
    }
  }, [fulfillmentSummary.hasPhysicalItems, step])

  // Payment
  const [selectedPaymentUri, setSelectedPaymentUri] = useState<ParsedPaymentUri | null>(null)
  const [txid, setTxid] = useState('')
  const [notes, setNotes] = useState('')
  const [refundAddress, setRefundAddress] = useState('')

  // Saved addresses
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([])
  const [selectedSavedAddressId, setSelectedSavedAddressId] = useState<string | null>(null)
  const [showSavePrompt, setShowSavePrompt] = useState(false)
  const [isSavingAddress, setIsSavingAddress] = useState(false)
  const [showAddressModal, setShowAddressModal] = useState(false)
  const [userHasEncryptionKey, setUserHasEncryptionKey] = useState(false)
  const [userEncryptionPubKey, setUserEncryptionPubKey] = useState<Uint8Array | null>(null)

  // Load store and cart items
  useEffect(() => {
    if (!sdkReady) return
    if (!storeId) {
      router.push('/cart')
      return
    }

    const loadData = async () => {
      try {
        setIsLoading(true)
        const [storeData, items] = await Promise.all([
          storeService.getById(storeId),
          Promise.resolve(cartService.getItemsForStore(storeId))
        ])

        if (!storeData || items.length === 0) {
          router.push('/cart')
          return
        }

        setStore(storeData)
        setCartItems(items)

        // Parse store policies
        if (storeData) {
          setStorePolicies(parseStorePolicies(storeData.policies))
        }

        // Select first payment URI by default
        if (storeData.paymentUris && storeData.paymentUris.length > 0) {
          setSelectedPaymentUri(storeData.paymentUris[0])
        }
      } catch (error) {
        console.error('Failed to load checkout data:', error)
        router.push('/cart')
      } finally {
        setIsLoading(false)
      }
    }

    loadData().catch(console.error)
  }, [sdkReady, storeId, router])

  // Load saved addresses
  useEffect(() => {
    if (!sdkReady || !user?.identityId) return

    const loadSavedAddresses = async () => {
      try {
        // Check if user has encryption key
        const hasKey = hasEncryptionKey(user.identityId)
        setUserHasEncryptionKey(hasKey)

        if (!hasKey) return

        // Get user's encryption public key
        const pubKey = await savedAddressService.getUserEncryptionPublicKey(user.identityId)
        if (pubKey) {
          setUserEncryptionPubKey(pubKey)
        }

        // Get user's encryption private key
        const privKey = getEncryptionKeyBytes(user.identityId)
        if (!privKey) return

        // Load and decrypt saved addresses
        const addresses = await savedAddressService.getDecryptedAddresses(user.identityId, privKey)
        setSavedAddresses(addresses)

        // Auto-select default if exists
        const defaultAddr = savedAddressService.getDefaultAddress(addresses)
        if (defaultAddr) {
          setSelectedSavedAddressId(defaultAddr.id)
          // Pre-fill form with default address
          setShippingAddress(defaultAddr.address)
          setBuyerContact(defaultAddr.contact)
        }
      } catch (error) {
        console.error('Failed to load saved addresses:', error)
      }
    }

    loadSavedAddresses().catch(console.error)
  }, [sdkReady, user?.identityId])

  // Calculate shipping when address changes
  useEffect(() => {
    if (!sdkReady || !storeId || !fulfillmentSummary.hasPhysicalItems) {
      setMatchedZone(null)
      setShippingCost(0)
      setZonesLoadFailed(false)
      setHasNoZones(false)
      return
    }
    if (!shippingAddress.postalCode || !shippingAddress.country) return

    const calculateShipping = async () => {
      try {
        setZonesLoadFailed(false)

        // First try to get zones to check if store has any configured
        const zones = await shippingZoneService.getByStore(storeId)

        if (zones.length === 0) {
          // Store has no shipping zones - allow checkout without shipping cost
          setHasNoZones(true)
          setMatchedZone(null)
          setShippingCost(0)
          return
        }

        setHasNoZones(false)
        const weight = await cartService.getTotalWeight(storeId)

        const { zone, cost } = await shippingZoneService.calculateShipping(
          storeId,
          shippingAddress,
          { totalWeight: weight, subtotal: physicalSubtotal }
        )

        setMatchedZone(zone)
        setShippingCost(cost)
      } catch (error) {
        console.error('Failed to calculate shipping:', error)
        // If zones failed to load, allow checkout anyway
        setZonesLoadFailed(true)
        setMatchedZone(null)
        setShippingCost(0)
      }
    }

    calculateShipping().catch(console.error)
  }, [sdkReady, storeId, shippingAddress, physicalSubtotal, fulfillmentSummary.hasPhysicalItems])

  const subtotal = useMemo(() => {
    return cartItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
  }, [cartItems])

  const physicalSubtotal = useMemo(() => {
    return fulfillmentSummary.physicalItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
  }, [fulfillmentSummary.physicalItems])

  const total = useMemo(() => {
    return subtotal + shippingCost
  }, [subtotal, shippingCost])

  const currency = cartItems[0]?.currency || 'USD'
  const activeStep = (steps.includes(step) ? step : steps[0]) as typeof step
  const currentStepIndex = Math.max(steps.indexOf(activeStep), 0)

  const handleAddressSubmit = () => {
    // If using a saved address, go directly to shipping
    if (selectedSavedAddressId) {
      setStep('shipping')
      return
    }

    // If user has encryption key and entered a new address, show save prompt
    if (userHasEncryptionKey && userEncryptionPubKey) {
      setShowSavePrompt(true)
    } else {
      setStep('shipping')
    }
  }

  const handleDeliverySubmit = () => {
    setStep('policies')
  }

  const handleSavedAddressSelect = (id: string | null) => {
    setSelectedSavedAddressId(id)

    if (id) {
      // Fill form with selected address
      const selected = savedAddresses.find((a) => a.id === id)
      if (selected) {
        setShippingAddress(selected.address)
        setBuyerContact(selected.contact)
      }
    } else {
      // Clear to defaults when selecting "Use a different address"
      setShippingAddress({
        name: '',
        street: '',
        city: '',
        state: '',
        postalCode: '',
        country: 'US'
      })
      setBuyerContact({})
    }
  }

  const handleSaveAddress = async (label: string) => {
    if (!user?.identityId || !userEncryptionPubKey) return

    setIsSavingAddress(true)
    try {
      const privKey = getEncryptionKeyBytes(user.identityId)
      if (!privKey) {
        throw new Error('Encryption key not found')
      }

      const newAddress = await savedAddressService.addAddress(
        user.identityId,
        shippingAddress,
        buyerContact,
        label,
        userEncryptionPubKey,
        privKey
      )

      setSavedAddresses((prev) => [...prev, newAddress])
      setShowSavePrompt(false)
      setStep('shipping')
    } catch (error) {
      console.error('Failed to save address:', error)
      // Continue anyway
      setShowSavePrompt(false)
      setStep('shipping')
    } finally {
      setIsSavingAddress(false)
    }
  }

  const handleSkipSave = () => {
    setShowSavePrompt(false)
    setStep('shipping')
  }

  // Modal handlers for managing saved addresses
  const handleAddAddressFromModal = async (
    address: ShippingAddress,
    contact: BuyerContact,
    label: string
  ) => {
    if (!user?.identityId || !userEncryptionPubKey) return

    try {
      const privKey = getEncryptionKeyBytes(user.identityId)
      if (!privKey) throw new Error('Encryption key not found')

      const newAddress = await savedAddressService.addAddress(
        user.identityId,
        address,
        contact,
        label,
        userEncryptionPubKey,
        privKey
      )

      setSavedAddresses((prev) => [...prev, newAddress])
    } catch (err) {
      console.error('Failed to add address:', err)
      setError('Failed to save address. Please try again.')
    }
  }

  const handleUpdateAddressFromModal = async (
    id: string,
    updates: Partial<Pick<SavedAddress, 'label' | 'address' | 'contact' | 'isDefault'>>
  ) => {
    if (!user?.identityId || !userEncryptionPubKey) return

    try {
      const privKey = getEncryptionKeyBytes(user.identityId)
      if (!privKey) throw new Error('Encryption key not found')

      const updated = await savedAddressService.updateAddress(
        user.identityId,
        id,
        updates,
        userEncryptionPubKey,
        privKey
      )

      if (updated) {
        setSavedAddresses((prev) =>
          prev.map((a) => (a.id === id ? updated : updates.isDefault ? { ...a, isDefault: false } : a))
        )
      }
    } catch (err) {
      console.error('Failed to update address:', err)
      setError('Failed to update address. Please try again.')
    }
  }

  const handleDeleteAddressFromModal = async (id: string) => {
    if (!user?.identityId || !userEncryptionPubKey) return

    try {
      const privKey = getEncryptionKeyBytes(user.identityId)
      if (!privKey) throw new Error('Encryption key not found')

      await savedAddressService.removeAddress(user.identityId, id, userEncryptionPubKey, privKey)
      setSavedAddresses((prev) => prev.filter((a) => a.id !== id))

      // If we deleted the selected address, deselect it
      if (selectedSavedAddressId === id) {
        setSelectedSavedAddressId(null)
      }
    } catch (err) {
      console.error('Failed to delete address:', err)
      setError('Failed to delete address. Please try again.')
    }
  }

  const handleSetDefaultFromModal = async (id: string) => {
    if (!user?.identityId || !userEncryptionPubKey) return

    try {
      const privKey = getEncryptionKeyBytes(user.identityId)
      if (!privKey) throw new Error('Encryption key not found')

      await savedAddressService.setDefault(user.identityId, id, userEncryptionPubKey, privKey)
      setSavedAddresses((prev) =>
        prev.map((a) => ({ ...a, isDefault: a.id === id }))
      )
    } catch (err) {
      console.error('Failed to set default address:', err)
      setError('Failed to set default address. Please try again.')
    }
  }

  const handleShippingSubmit = () => {
    // Allow checkout if: zone matched, zones failed to load, or store has no zones
    if (!matchedZone && !zonesLoadFailed && !hasNoZones) {
      setError('We cannot ship to this address. Please check your shipping address.')
      return
    }
    setStep('policies')
  }

  const handlePoliciesSubmit = () => {
    setStep('payment')
  }

  const handlePaymentSubmit = () => {
    if (!selectedPaymentUri) return
    setStep('review')
  }

  const handlePolicyAgreementChange = (index: number, agreed: boolean) => {
    setAgreedPolicies((prev) => {
      const next = new Set(prev)
      if (agreed) {
        next.add(index)
      } else {
        next.delete(index)
      }
      return next
    })
  }

  const handlePlaceOrder = async () => {
    if (!user?.identityId || !store || !selectedPaymentUri) return
    if (!fulfillmentSummary.hasPhysicalItems && !buyerContact.email) {
      setError('Email is required for digital delivery.')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const payload = storeOrderService.buildOrderPayload(
        cartItems,
        fulfillmentSummary.hasPhysicalItems ? shippingAddress : undefined,
        buyerContact,
        shippingCost,
        selectedPaymentUri.uri,
        currency,
        notes || undefined,
        refundAddress || undefined
      )

      // Add txid if provided
      if (txid) {
        payload.txid = txid
      }

      // Fetch seller's encryption public key
      const sellerIdentity = await identityService.getIdentity(store.ownerId)
      if (!sellerIdentity) {
        throw new Error('Could not fetch seller identity')
      }

      const encryptionKey = sellerIdentity.publicKeys.find(
        (k) => k.purpose === 1 && k.type === 0 && !k.disabledAt
      )
      if (!encryptionKey?.data) {
        throw new Error('Seller does not have an encryption key')
      }

      const sellerPublicKey = normalizeKeyData(encryptionKey.data)
      if (!sellerPublicKey) {
        throw new Error('Could not parse seller encryption key')
      }

      // Get buyer's encryption private key for deterministic ephemeral key derivation
      const buyerPrivateKey = getEncryptionKeyBytes(user.identityId)
      if (!buyerPrivateKey) {
        throw new Error('Encryption key not found. Please set up your encryption key in Settings.')
      }

      // Generate random nonce (used in ephemeral key derivation for uniqueness)
      const nonce = new Uint8Array(24)
      crypto.getRandomValues(nonce)

      // Encrypt with deterministic ephemeral ECIES
      // Both buyer (via re-derived ephemeral key) and seller can decrypt
      const encryptedPayload = await storeOrderService.encryptOrderPayload(
        payload,
        buyerPrivateKey,
        sellerPublicKey,
        nonce,
        store.id
      )

      await storeOrderService.createOrder(user.identityId, {
        storeId: store.id,
        sellerId: store.ownerId,
        encryptedPayload,
        nonce
      })

      // Clear cart items for this store
      cartService.removeStoreItems(store.id)

      setOrderCreated(true)
    } catch (err) {
      console.error('Failed to create order:', err)
      setError(err instanceof Error ? err.message : 'Failed to create order')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yappr-500" />
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  if (orderCreated) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800 flex flex-col items-center justify-center p-8">
            <CheckCircleIcon className="h-20 w-20 text-green-500 mb-4" />
            <h1 className="text-2xl font-bold mb-2">Order Placed!</h1>
            <p className="text-gray-500 text-center max-w-sm mb-6">
              Your order has been sent to the seller. They will process it and provide updates.
            </p>
            <div className="flex gap-4">
              <Button variant="outline" onClick={() => router.push('/orders')}>
                View Orders
              </Button>
              <Button onClick={() => router.push('/store')}>
                Continue Shopping
              </Button>
            </div>
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center gap-4 p-4">
              <button
                onClick={() => {
                  if (currentStepIndex <= 0) {
                    router.back()
                    return
                  }
                  const previous = steps[currentStepIndex - 1]
                  if (previous) {
                    setStep(previous as typeof step)
                  }
                }}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <h1 className="text-xl font-bold">Checkout</h1>
            </div>

            {/* Progress Steps */}
            <div className="flex items-center px-4 pb-4">
              {steps.map((s, i) => {
                const isComplete = currentStepIndex > i
                const isCurrent = activeStep === s

                return (
                  <div key={s} className="flex items-center flex-1 last:flex-none">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0 ${
                        isCurrent
                          ? 'bg-yappr-500 text-white'
                          : isComplete
                            ? 'bg-green-500 text-white'
                            : 'bg-gray-200 dark:bg-gray-800 text-gray-500'
                      }`}
                    >
                      {i + 1}
                    </div>
                    {i < steps.length - 1 && (
                      <div
                        className={`flex-1 h-0.5 mx-2 ${
                          isComplete ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-800'
                        }`}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </header>

          {error && (
            <div className="m-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* Address Step */}
          {step === 'address' && !showSavePrompt && (
            <AddressForm
              address={shippingAddress}
              contact={buyerContact}
              onAddressChange={setShippingAddress}
              onContactChange={setBuyerContact}
              onSubmit={handleAddressSubmit}
              requireEmail={fulfillmentSummary.hasDigitalItems}
              savedAddresses={savedAddresses}
              selectedSavedAddressId={selectedSavedAddressId}
              onSavedAddressSelect={handleSavedAddressSelect}
              onManageSavedAddresses={() => setShowAddressModal(true)}
            />
          )}

          {/* Save Address Prompt */}
          {step === 'address' && showSavePrompt && (
            <div className="p-4">
              <div className="mb-4">
                <h2 className="text-lg font-medium">Shipping to:</h2>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  {shippingAddress.name}<br />
                  {shippingAddress.street}<br />
                  {shippingAddress.city}, {shippingAddress.state} {shippingAddress.postalCode}<br />
                  {shippingAddress.country}
                </p>
              </div>
              <SaveAddressPrompt
                onSave={handleSaveAddress}
                onSkip={handleSkipSave}
                isSaving={isSavingAddress}
                hasEncryptionKey={userHasEncryptionKey}
                onSetupEncryption={() => router.push('/settings?section=privacy')}
              />
            </div>
          )}

          {/* Delivery Details Step (digital-only) */}
          {step === 'delivery' && (
            <DeliveryDetailsForm
              contact={buyerContact}
              onContactChange={setBuyerContact}
              onSubmit={handleDeliverySubmit}
            />
          )}

          {/* Shipping Step */}
          {step === 'shipping' && fulfillmentSummary.hasPhysicalItems && (
            <ShippingSelector
              matchedZone={matchedZone}
              shippingCost={shippingCost}
              currency={currency}
              city={shippingAddress.city}
              country={shippingAddress.country}
              zonesLoadFailed={zonesLoadFailed}
              hasNoZones={hasNoZones}
              onSubmit={handleShippingSubmit}
            />
          )}

          {/* Policies Step */}
          {step === 'policies' && (
            <PolicyAgreement
              policies={storePolicies}
              agreedIndexes={agreedPolicies}
              onAgreementChange={handlePolicyAgreementChange}
              onSubmit={handlePoliciesSubmit}
            />
          )}

          {/* Payment Step */}
          {step === 'payment' && (
            <PaymentSelector
              paymentUris={store?.paymentUris || []}
              selected={selectedPaymentUri}
              onSelect={setSelectedPaymentUri}
              txid={txid}
              onTxidChange={setTxid}
              onSubmit={handlePaymentSubmit}
              orderTotal={total}
              orderCurrency={currency}
            />
          )}

          {/* Review Step */}
          {step === 'review' && (
            <OrderReview
              store={store}
              items={cartItems}
              shippingAddress={fulfillmentSummary.hasPhysicalItems ? shippingAddress : undefined}
              buyerContact={buyerContact}
              shippingCost={shippingCost}
              subtotal={subtotal}
              total={total}
              currency={currency}
              notes={notes}
              onNotesChange={setNotes}
              refundAddress={refundAddress}
              onRefundAddressChange={setRefundAddress}
              paymentScheme={selectedPaymentUri?.scheme}
              onSubmit={handlePlaceOrder}
              isSubmitting={isSubmitting}
            />
          )}
        </main>
      </div>

      <RightSidebar />

      {/* Saved Address Management Modal */}
      <SavedAddressModal
        isOpen={showAddressModal}
        onClose={() => setShowAddressModal(false)}
        addresses={savedAddresses}
        onAdd={handleAddAddressFromModal}
        onUpdate={handleUpdateAddressFromModal}
        onDelete={handleDeleteAddressFromModal}
        onSetDefault={handleSetDefaultFromModal}
      />
    </div>
  )
}

export default withAuth(CheckoutPage)
