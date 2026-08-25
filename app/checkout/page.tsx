'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon, CheckCircleIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  AddressForm,
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
import { findEncryptionKey } from '@/lib/crypto/encryption-key-lookup'
import { parseStorePolicies } from '@/lib/utils/policies'
import { savedAddressService } from '@/lib/services/saved-address-service'
import { hasEncryptionKey, getEncryptionKeyBytes } from '@/lib/secure-storage'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import type { Store, CartItem, ShippingAddress, BuyerContact, ParsedPaymentUri, ShippingZone, StorePolicy, SavedAddress } from '@/lib/types'

/**
 * Normalize key data from various formats to Uint8Array
 */
function normalizeKeyData(data: unknown): Uint8Array | null {
  if (!data) return null
  if (data instanceof Uint8Array) return data
  if (Array.isArray(data)) return new Uint8Array(data)
  if (typeof data === 'string') {
    const isValidSecpPublicKey = (bytes: Uint8Array) =>
      (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03)) ||
      (bytes.length === 65 && bytes[0] === 0x04)

    // Hex (common for stored keys)
    if (/^[0-9a-fA-F]+$/.test(data) && (data.length === 66 || data.length === 130)) {
      const bytes = new Uint8Array(data.length / 2)
      for (let i = 0; i < bytes.length; i++) {
        const byte = parseInt(data.substr(i * 2, 2), 16)
        if (Number.isNaN(byte)) return null
        bytes[i] = byte
      }
      if (isValidSecpPublicKey(bytes)) return bytes
    }

    // Base64
    try {
      const binaryString = atob(data)
      const bytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0))
      if (isValidSecpPublicKey(bytes)) return bytes
      return null
    } catch {
      return null
    }
  }
  return null
}

type CheckoutReadinessBlocker =
  | 'no-payment-methods'
  | 'missing-buyer-key'
  | 'missing-seller-key'
  | 'invalid-seller-key'
  | 'service-error'

type CheckoutReadinessState = {
  isReady: boolean
  blocker: CheckoutReadinessBlocker | null
  blockerMessage: string | null
  sellerEncryptionPublicKey: Uint8Array | null
  buyerEncryptionPrivateKey: Uint8Array | null
}

function getCheckoutReadinessMessage(blocker: CheckoutReadinessBlocker | null): string | null {
  if (!blocker) return null

  const messages: Record<CheckoutReadinessBlocker, string> = {
    'no-payment-methods': 'This store has not configured any payment methods.',
    'missing-buyer-key': 'Add your encryption key to continue to payment.',
    'missing-seller-key': 'This store has not published an active encryption key.',
    'invalid-seller-key': "This store's encryption key is invalid. Contact the store owner.",
    'service-error': 'Could not verify store encryption key. Please try again later.'
  }

  return messages[blocker]
}

function CheckoutPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('storeId')
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()

  const [store, setStore] = useState<Store | null>(null)
  const [cartItems, setCartItems] = useState<CartItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [orderCreated, setOrderCreated] = useState(false)
  const [step, setStep] = useState<'details' | 'policies' | 'payment'>('details')
  const [includeShipping, setIncludeShipping] = useState(false)
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
  const [checkoutReadiness, setCheckoutReadiness] = useState<CheckoutReadinessState>({
    isReady: false,
    blocker: null,
    blockerMessage: null,
    sellerEncryptionPublicKey: null,
    buyerEncryptionPrivateKey: null
  })

  const validateCheckoutReadiness = useCallback(async (storeToValidate: Store | null): Promise<CheckoutReadinessState> => {
    function blocked(
      blocker: CheckoutReadinessBlocker,
      buyerEncryptionPrivateKey: Uint8Array | null = null
    ): CheckoutReadinessState {
      return {
        isReady: false,
        blocker,
        blockerMessage: getCheckoutReadinessMessage(blocker),
        sellerEncryptionPublicKey: null,
        buyerEncryptionPrivateKey
      }
    }

    if (!storeToValidate?.paymentUris?.length) {
      const state = blocked('no-payment-methods')
      setCheckoutReadiness(state)
      return state
    }

    if (!user?.identityId) {
      const state = blocked('missing-buyer-key')
      setCheckoutReadiness(state)
      return state
    }

    const buyerPrivateKey = getEncryptionKeyBytes(user.identityId)
    if (!buyerPrivateKey) {
      const state = blocked('missing-buyer-key')
      setCheckoutReadiness(state)
      return state
    }

    try {
      const sellerIdentity = await identityService.getIdentity(storeToValidate.ownerId)
      const encryptionKey = sellerIdentity ? findEncryptionKey(sellerIdentity.publicKeys) : undefined

      if (!encryptionKey?.data) {
        const state = blocked('missing-seller-key', buyerPrivateKey)
        setCheckoutReadiness(state)
        return state
      }

      const sellerEncryptionPublicKey = normalizeKeyData(encryptionKey.data)
      if (!sellerEncryptionPublicKey) {
        const state = blocked('invalid-seller-key', buyerPrivateKey)
        setCheckoutReadiness(state)
        return state
      }

      const state: CheckoutReadinessState = {
        isReady: true,
        blocker: null,
        blockerMessage: null,
        sellerEncryptionPublicKey,
        buyerEncryptionPrivateKey: buyerPrivateKey
      }
      setCheckoutReadiness(state)
      return state
    } catch (err) {
      logger.error('Failed to validate checkout readiness', err)
      const state = blocked('service-error', buyerPrivateKey)
      setCheckoutReadiness(state)
      return state
    }
  }, [user?.identityId])

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
          cartService.getItemsForStore(storeId)
        ])

        if (!storeData || items.length === 0) {
          router.push('/cart')
          return
        }

        setStore(storeData)
        setCartItems(items)
        setStorePolicies(parseStorePolicies(storeData.policies))

        // Select first payment URI by default
        if (storeData.paymentUris && storeData.paymentUris.length > 0) {
          setSelectedPaymentUri(storeData.paymentUris[0])
        }

        await validateCheckoutReadiness(storeData)
      } catch (error) {
        logger.error('Failed to load checkout data:', error)
        router.push('/cart')
      } finally {
        setIsLoading(false)
      }
    }

    loadData().catch((error) => logger.error(error))
  }, [sdkReady, storeId, router, validateCheckoutReadiness])

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
        logger.error('Failed to load saved addresses:', error)
      }
    }

    loadSavedAddresses().catch((error) => logger.error(error))
  }, [sdkReady, user?.identityId])

  // Calculate shipping when address changes (only when shipping is included)
  useEffect(() => {
    if (!includeShipping) {
      setMatchedZone(null)
      setShippingCost(0)
      setHasNoZones(false)
      setZonesLoadFailed(false)
      setShowSavePrompt(false)
      return
    }

    if (!sdkReady || !storeId || !shippingAddress.postalCode || !shippingAddress.country) return

    const calculateShipping = async () => {
      try {
        setZonesLoadFailed(false)
        setMatchedZone(null)
        setShippingCost(0)
        setHasNoZones(false)

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
        const subtotal = cartItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
        const weight = await cartService.getTotalWeight(storeId)

        const { zone, cost } = await shippingZoneService.calculateShipping(
          storeId,
          shippingAddress,
          { totalWeight: weight, subtotal }
        )

        setMatchedZone(zone)
        setShippingCost(cost)
      } catch (error) {
        logger.error('Failed to calculate shipping:', error)
        // If zones failed to load, allow checkout anyway
        setZonesLoadFailed(true)
        setMatchedZone(null)
        setShippingCost(0)
      }
    }

    calculateShipping().catch((error) => logger.error(error))
  }, [includeShipping, sdkReady, storeId, shippingAddress, cartItems])

  const subtotal = useMemo(() => {
    return cartItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
  }, [cartItems])

  const total = useMemo(() => {
    return subtotal + shippingCost
  }, [subtotal, shippingCost])

  const currency = cartItems[0]?.currency || 'USD'

  const handleDetailsSubmit = () => {
    if (!includeShipping) {
      setStep('policies')
      return
    }

    // If using a saved address, validate shipping then go to policies
    if (selectedSavedAddressId) {
      handleShippingValidation()
      return
    }

    // If user has encryption key and entered a new address, show save prompt
    if (userHasEncryptionKey && userEncryptionPubKey) {
      setShowSavePrompt(true)
    } else {
      handleShippingValidation()
    }
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
      handleShippingValidation()
    } catch (error) {
      logger.error('Failed to save address:', error)
      // Continue anyway
      setShowSavePrompt(false)
      handleShippingValidation()
    } finally {
      setIsSavingAddress(false)
    }
  }

  const handleSkipSave = () => {
    setShowSavePrompt(false)
    handleShippingValidation()
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
      logger.error('Failed to add address:', err)
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
      logger.error('Failed to update address:', err)
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
      logger.error('Failed to delete address:', err)
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
      logger.error('Failed to set default address:', err)
      setError('Failed to set default address. Please try again.')
    }
  }

  const handleShippingValidation = () => {
    // Allow checkout if: zone matched, zones failed to load, or store has no zones
    if (!matchedZone && !zonesLoadFailed && !hasNoZones) {
      setError('We cannot ship to this address. Please check your shipping address.')
      return
    }
    setError(null)
    setStep('policies')
  }

  const promptForEncryptionKeyThenContinue = useCallback(() => {
    openEncryptionKeyModal('generic', () => {
      validateCheckoutReadiness(store)
        .then((readiness) => {
          if (readiness.isReady) {
            setError(null)
            setStep('payment')
            return
          }
          setError(readiness.blockerMessage)
        })
        .catch((err) => {
          logger.error('Failed to revalidate checkout readiness:', err)
          setError(err instanceof Error ? err.message : 'Failed to verify checkout readiness.')
        })
    })
  }, [openEncryptionKeyModal, validateCheckoutReadiness, store])

  const handlePoliciesSubmit = async () => {
    setError(null)
    const readiness = await validateCheckoutReadiness(store)
    if (readiness.isReady) {
      setStep('payment')
      return
    }

    if (readiness.blocker === 'missing-buyer-key') {
      setError(readiness.blockerMessage)
      promptForEncryptionKeyThenContinue()
      return
    }

    if (readiness.blockerMessage) {
      setError(readiness.blockerMessage)
    }
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

    setIsSubmitting(true)
    setError(null)

    try {
      const payload = storeOrderService.buildOrderPayload(
        cartItems,
        includeShipping ? shippingAddress : undefined,
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

      const readiness = await validateCheckoutReadiness(store)
      if (!readiness.isReady) {
        throw new Error(readiness.blockerMessage || 'Checkout is not ready. Please review payment prerequisites.')
      }

      const sellerPublicKey = readiness.sellerEncryptionPublicKey
      if (!sellerPublicKey) {
        throw new Error('Seller encryption key could not be loaded')
      }

      // Get buyer's encryption private key for deterministic ephemeral key derivation
      const buyerPrivateKey = readiness.buyerEncryptionPrivateKey
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
      logger.error('Failed to create order:', err)
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
            <Spinner size="md" />
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
                  switch (step) {
                    case 'details':
                      if (showSavePrompt) {
                        setShowSavePrompt(false)
                      } else {
                        router.back()
                      }
                      break
                    case 'policies': setStep('details'); break
                    case 'payment': setStep('policies'); break
                  }
                }}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <h1 className="text-xl font-bold">Checkout</h1>
              <button
                onClick={() => router.push('/cart')}
                className="ml-auto text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                Cancel
              </button>
            </div>

            {/* Progress Steps */}
            <div className="flex items-center px-4 pb-4">
              {(['details', 'policies', 'payment'] as const).map((s, i, steps) => {
                const currentIndex = steps.indexOf(step)
                const isComplete = currentIndex > i
                const isCurrent = step === s

                let stepClass = 'bg-gray-200 dark:bg-gray-800 text-gray-500'
                if (isCurrent) stepClass = 'bg-yappr-500 text-white'
                else if (isComplete) stepClass = 'bg-green-500 text-white'

                return (
                  <div key={s} className="flex items-center flex-1 last:flex-none">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0 ${stepClass}`}
                    >
                      {i + 1}
                    </div>
                    {i < 2 && (
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

          {/* Details Step */}
          {step === 'details' && !showSavePrompt && (
            <AddressForm
              address={shippingAddress}
              contact={buyerContact}
              onAddressChange={setShippingAddress}
              onContactChange={setBuyerContact}
              onSubmit={handleDetailsSubmit}
              savedAddresses={savedAddresses}
              selectedSavedAddressId={selectedSavedAddressId}
              onSavedAddressSelect={handleSavedAddressSelect}
              onManageSavedAddresses={() => setShowAddressModal(true)}
              includeShipping={includeShipping}
              onIncludeShippingChange={setIncludeShipping}
            />
          )}

          {/* Save Address Prompt */}
          {step === 'details' && showSavePrompt && (
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
          {step === 'payment' && !checkoutReadiness.isReady && (
            <div className="p-4 space-y-4">
              <div className="p-4 border border-yellow-200 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
                <p className="font-medium text-yellow-800 dark:text-yellow-200 mb-2">
                  Cannot proceed to payment yet
                </p>
                <p className="text-sm text-yellow-700 dark:text-yellow-300">
                  {checkoutReadiness.blockerMessage || 'Checkout is blocked due to missing prerequisites.'}
                </p>
              </div>
              {checkoutReadiness.blocker === 'missing-buyer-key' && (
                <Button onClick={promptForEncryptionKeyThenContinue} className="w-full">
                  Add Encryption Key
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => setStep('policies')}
                className="w-full"
              >
                Back to Policies
              </Button>
            </div>
          )}
          {step === 'payment' && checkoutReadiness.isReady && (
            <div>
              <PaymentSelector
                paymentUris={store?.paymentUris || []}
                selected={selectedPaymentUri}
                onSelect={setSelectedPaymentUri}
                txid={txid}
                onTxidChange={setTxid}
                orderTotal={total}
                orderCurrency={currency}
              />

              <div className="p-4 space-y-4">
                {/* Refund Address */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Refund Address (optional){selectedPaymentUri?.scheme && <span className="text-gray-500 font-normal"> - {selectedPaymentUri.scheme}</span>}
                  </label>
                  <input
                    type="text"
                    value={refundAddress}
                    onChange={(e) => setRefundAddress(e.target.value)}
                    placeholder={`Your ${selectedPaymentUri?.scheme || 'crypto'} address for refunds`}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 font-mono text-sm"
                  />
                </div>
              </div>

              <OrderReview
                store={store}
                items={cartItems}
                shippingAddress={includeShipping ? shippingAddress : undefined}
                shippingCost={shippingCost}
                subtotal={subtotal}
                total={total}
                currency={currency}
              />

              <div className="p-4 space-y-4">
                {/* Notes */}
                <div>
                  <label className="block text-sm font-medium mb-1">Order Notes (optional)</label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any special instructions for the seller"
                    rows={2}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
                  />
                </div>

                <Button
                  className="w-full"
                  onClick={handlePlaceOrder}
                  disabled={isSubmitting || !selectedPaymentUri}
                >
                  {isSubmitting ? 'Placing Order...' : 'Place Order'}
                </Button>

                <p className="text-xs text-center text-gray-500">
                  Your order details will be encrypted and sent securely to the seller.
                </p>
              </div>
            </div>
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
