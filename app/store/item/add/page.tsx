'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useId, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftIcon,
  XMarkIcon,
  PlusIcon,
  TruckIcon,
  CloudArrowDownIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { ipfsToGatewayUrl } from '@/lib/utils/ipfs-gateway'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { storeItemService } from '@/lib/services/store-item-service'
import { storeService } from '@/lib/services/store-service'
import { getCurrencyStep, fromSmallestUnit, getCurrencyDecimals } from '@/lib/utils/format'
import { itemDeliverableService, KitWriteUncertainError } from '@/lib/services/item-deliverable-service'
import { DigitalKitEditor } from '@/components/digital'
import { storefrontSupportsDigital, storefrontVariantsAreTyped } from '@/lib/constants'
import { encodeKit, kitDeliveryFitError } from '@/lib/services/digital-delivery-plan'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import type { ItemVariants, ItemFulfillment, ItemDeliverable, ItemDeliverablePayload } from '@/lib/types'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { LIST_LIMITS, ListLimitError } from '@/lib/typed-array-codecs'
import { itemImageLimit, storefrontCreateFeeCredits } from '@/lib/storefront/storefront-contract'
import { clampImages, emptyVariants, variantProblems } from '@/lib/storefront/variant-codec'
import { convertPrices, defaultCombinationPrice, parsePriceInput, shiftImagesAfterRemoval, tidyNames } from '@/lib/storefront/variant-editor-model'
import { VariantEditor } from '@/components/store/variant-editor'
import { formatCreditsAsDash } from '@/lib/services/dpns-service'

const IMAGE_URL_PATTERN = LIST_LIMITS.storeImageUrls.pattern
const EMPTY_KIT: ItemDeliverablePayload = { v: 1, assets: [], deliverWhen: 'payment_confirmed' }
const kitHasContent = (kit: ItemDeliverablePayload) =>
  kit.assets.length > 0 || kit.licenseKeys !== undefined || Boolean(kit.instructions)
/** Whether two reads are the same kit document at the same revision (or both found none). */
const sameKitRevision = (a: ItemDeliverable | null, b: ItemDeliverable | null) =>
  a === null || b === null ? a === b : a.id === b.id && a.$revision === b.$revision

/**
 * The digital kit's state on this device: `ready` (editable), `locked` (one
 * exists but this device has no key), `unreadable` (it does not decrypt with
 * the key here, e.g. one written before a key change), `loading`, or `error`
 * (the read failed). A locked or unreadable kit is never overwritten by a
 * product save; only an explicit "replace" makes it editable (and empty).
 */
type KitState = 'ready' | 'loading' | 'locked' | 'unreadable' | 'error'

function AddItemPage() {
  const formId = useId()
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('storeId')
  const itemId = searchParams.get('itemId')
  const isEditMode = !!itemId
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()
  const supportsDigital = storefrontSupportsDigital()
  // v6 charges an action fee on each new listing (null before v6).
  const listingFeeCredits = storefrontCreateFeeCredits('storeItem')
  const imageLimit = itemImageLimit()
  // Per-combination weights exist from storefront v7 on.
  const variantsAreTyped = storefrontVariantsAreTyped()

  // Digital delivery (storefront v6)
  const [fulfillment, setFulfillment] = useState<ItemFulfillment>('shipped')
  const [kit, setKit] = useState<ItemDeliverablePayload>(EMPTY_KIT)
  const [existingDeliverable, setExistingDeliverable] = useState<ItemDeliverable | null>(null)
  const [kitState, setKitState] = useState<KitState>('ready')
  // Only a kit the seller changed is written: re-saving an untouched copy could
  // put back license keys a delivery elsewhere has taken since it was read.
  const [kitDirty, setKitDirty] = useState(false)
  // A file's key joins the kit only when its upload finishes: no saving before then.
  const [isKitUploading, setIsKitUploading] = useState(false)
  const updateKit = useCallback((update: (current: ItemDeliverablePayload) => ItemDeliverablePayload) => {
    setKit(update)
    setKitDirty(true)
  }, [])
  // A create whose kit failed to save keeps its form; the next submit edits this item.
  const [createdItemId, setCreatedItemId] = useState<string | null>(null)
  // A create that was broadcast but not seen on chain. Until a read finds it,
  // the form is neither an edit (it may not exist) nor free to create again
  // (it may still land): the next submit looks for this exact listing first.
  const [pendingItemId, setPendingItemId] = useState<string | null>(null)
  // A look for the pending listing came back empty: the seller may choose to create it again.
  const [pendingStillMissing, setPendingStillMissing] = useState(false)
  /** The item being edited: the URL's, or the one this form just created. */
  const editingItemId = itemId || createdItemId
  const isDigital = supportsDigital && fulfillment === 'digital'

  const [isLoading, setIsLoading] = useState(isEditMode || !!storeId)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [basePrice, setBasePrice] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [imageUrls, setImageUrls] = useState<string[]>([])
  const [newImageUrl, setNewImageUrl] = useState('')
  const [category, setCategory] = useState('')
  const [stockQuantity, setStockQuantity] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedStoreId, setLoadedStoreId] = useState<string | null>(null)

  // Variant state: the option types and the combinations offered (saved only while hasVariants is on).
  const [hasVariants, setHasVariants] = useState(false)
  // A v7 listing saved with options keeps them: its option-id counter lives in
  // the table, and a new table would give carts' and kits' old ids to other options.
  const [keepVariants, setKeepVariants] = useState(false)
  const [variants, setVariants] = useState<ItemVariants>(emptyVariants)

  // Resolve the store default before the new-product form becomes editable.
  useEffect(() => {
    if (!sdkReady || isEditMode || !storeId) return
    let cancelled = false

    const loadStoreCurrency = async () => {
      setIsLoading(true)
      setLoadedStoreId(null)
      setError(null)
      try {
        const store = await storeService.getById(storeId)
        if (cancelled) return
        if (!store) {
          setError('Store not found. Return to your store and try again.')
          return
        }
        setCurrency(store.defaultCurrency || 'USD')
        setLoadedStoreId(store.id)
      } catch (err) {
        if (cancelled) return
        logger.error('Failed to load store currency:', err)
        setError('Failed to load store currency. Reload this page to try again.')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadStoreCurrency()
    return () => { cancelled = true }
  }, [sdkReady, isEditMode, storeId])

  // Load existing item data in edit mode
  useEffect(() => {
    if (!sdkReady || !isEditMode || !itemId) return

    const loadItem = async () => {
      try {
        setIsLoading(true)
        const item = await storeItemService.getById(itemId)
        if (!item) {
          setError('Item not found')
          return
        }

        // Populate form fields
        const itemCurrency = item.currency || 'USD'
        const decimals = getCurrencyDecimals(itemCurrency)

        setTitle(item.title || '')
        setDescription(item.description || '')
        setCurrency(itemCurrency)
        setCategory(item.category || '')
        setImageUrls(item.imageUrls || [])
        setLoadedStoreId(item.storeId)
        setFulfillment(item.fulfillment === 'digital' ? 'digital' : 'shipped')

        // Convert price from smallest unit to display value
        if (item.basePrice !== undefined) {
          setBasePrice(fromSmallestUnit(item.basePrice, itemCurrency).toFixed(decimals))
        }
        if (item.stockQuantity !== undefined) {
          setStockQuantity(item.stockQuantity.toString())
        }

        // Load variants (the service hands back the same table on every storefront version)
        if (item.variants && item.variants.axes.length > 0) {
          setHasVariants(true)
          setVariants(item.variants)
          setKeepVariants(storefrontVariantsAreTyped())
        }
      } catch (err) {
        logger.error('Failed to load item:', err)
        setError('Failed to load item data')
      } finally {
        setIsLoading(false)
      }
    }

    loadItem().catch((err) => logger.error('Failed to load item:', err))
  }, [sdkReady, isEditMode, itemId])

  /** Read and decrypt the item's kit, or mark it locked when this device lacks the key. */
  const loadKit = useCallback(async (id: string, ownerId: string) => {
    setKitState('loading')
    try {
      const deliverable = await itemDeliverableService.getForItem(id)
      setExistingDeliverable(deliverable)
      if (!deliverable) {
        // No kit on chain: a draft read from one that is gone (deleted elsewhere)
        // must not become a new kit, or codes it held that were since sent
        // would be offered again. Start from empty.
        setKit(EMPTY_KIT)
        setKitDirty(false)
        setKitState('ready')
        return
      }
      const privateKey = getEncryptionKeyBytes(ownerId)
      if (!privateKey) {
        setKitState('locked')
        return
      }
      try {
        setKit(await itemDeliverableService.decryptKit(deliverable, privateKey))
      } catch (decryptError) {
        logger.warn('Delivery content does not decrypt with this key:', decryptError)
        setKitState('unreadable')
        return
      }
      setKitDirty(false)
      setKitState('ready')
    } catch (err) {
      logger.error('Failed to load delivery content:', err)
      setKitState('error')
    }
  }, [])

  useEffect(() => {
    if (!sdkReady || !supportsDigital || !itemId || !user?.identityId) return
    loadKit(itemId, user.identityId).catch((err) => logger.error(err))
  }, [sdkReady, supportsDigital, itemId, user?.identityId, loadKit])

  const handleAddImage = () => {
    const url = newImageUrl.trim()
    if (!url || imageUrls.length >= imageLimit) return
    // storefront v4 stores only http(s):// and ipfs:// image URLs (the contract's pattern).
    if (!IMAGE_URL_PATTERN.test(url)) {
      setError('Image URLs must start with https://, http:// or ipfs://')
      return
    }
    // A combination names an image by position, and the stored list keeps one of each URL.
    if (imageUrls.includes(url)) {
      setError('That image is already in this listing.')
      return
    }
    setError(null)
    setImageUrls([...imageUrls, url])
    setNewImageUrl('')
  }

  const handleRemoveImage = (index: number) => {
    const remaining = imageUrls.filter((_, i) => i !== index)
    setImageUrls(remaining)
    // Combinations name images by position: the removed one's fall back to the default, later ones move down.
    setVariants((current) => clampImages(shiftImagesAfterRemoval(current, index), remaining.length))
  }

  /** Prices are kept in the smallest unit, so a currency change re-expresses them to read the same. */
  const handleCurrencyChange = (next: string) => {
    setVariants((current) => convertPrices(current, currency, next))
    setCurrency(next)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user?.identityId || !title.trim()) return
    if (!editingItemId && (!storeId || loadedStoreId !== storeId)) return

    if (isKitUploading) {
      setError('Wait for the file upload to finish before saving.')
      return
    }
    if (isDigital && (kitState === 'loading' || kitState === 'error')) {
      setError('The delivery content has not loaded yet. Wait a moment or reload the page.')
      return
    }
    const willSaveKit = isDigital && kitState === 'ready' && kitDirty && (existingDeliverable !== null || kitHasContent(kit))
    // The kit is encrypted to the seller's own key, so writing one needs it here.
    const sellerPrivateKey = willSaveKit ? getEncryptionKeyBytes(user.identityId) : null
    if (willSaveKit) {
      if (!sellerPrivateKey) {
        openEncryptionKeyModal('sell_digital')
        setError('Add your encryption key to save the delivery content of a digital product.')
        return
      }
      // Refuse an oversized kit before the product is written, not after.
      try {
        encodeKit(kit)
      } catch (sizeError) {
        setError(sizeError instanceof Error ? sizeError.message : 'Delivery content is too large')
        return
      }
    }
    // A kit must fit one delivery for one unit, or no order could receive it.
    // A receipt's size depends on the kit alone (receipts carry a fixed-size
    // variant reference, not the variant names), so the listing can change
    // freely afterwards: only a kit write needs this check.
    if (willSaveKit) {
      const fitError = kitDeliveryFitError(kit)
      if (fitError) {
        setError(fitError)
        return
      }
    }

    // Include any pending image URL that wasn't explicitly added, if it is one
    // the contract accepts; a bad pending URL stops the save rather than vanishing.
    const pendingUrl = newImageUrl.trim()
    if (pendingUrl && !IMAGE_URL_PATTERN.test(pendingUrl)) {
      setError('Image URLs must start with https://, http:// or ipfs://')
      return
    }
    const allImageUrls = pendingUrl
      ? [...imageUrls, pendingUrl].slice(0, imageLimit)
      : imageUrls

    const priceInSmallestUnit = basePrice.trim() ? parsePriceInput(basePrice, currency) : undefined
    if (!hasVariants && basePrice.trim() && priceInSmallestUnit === undefined) {
      setError('Enter a valid price.')
      return
    }

    // With variants on, the table must be storable as it is; off, any stored table is removed.
    let savedVariants: ItemVariants | undefined
    if (hasVariants) {
      savedVariants = tidyNames(variants)
      const [problem] = variantProblems(savedVariants, { imageCount: allImageUrls.length, legacy: !variantsAreTyped })
      if (problem) {
        setError(problem)
        return
      }
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const itemData = {
        title: title.trim(),
        description: description.trim() || undefined,
        basePrice: hasVariants ? undefined : priceInSmallestUnit,
        currency: currency || undefined,
        imageUrls: allImageUrls.length > 0 ? allImageUrls : undefined,
        category: category.trim() || undefined,
        stockQuantity: hasVariants ? undefined : (stockQuantity ? parseInt(stockQuantity, 10) : undefined),
        // No status: an edit keeps a paused or sold-out product so, and a create defaults to active.
        // variants is always named, so unticking "has variants" removes the stored ones.
        variants: savedVariants,
        // Only named on v6, which is the first cut that has the property.
        ...(supportsDigital ? { fulfillment } : {})
      }

      // An EDIT must use the item's own store, never the URL's: v2 freezes
      // `storeItem.storeId`, so a stale or wrong `?storeId=` would turn a title
      // change into a 40128 rejection (and a 40127 if that store is not yours).
      // A create has no stored value to defer to, so the URL leads there.
      const effectiveStoreId = editingItemId ? (loadedStoreId || storeId) : (storeId || loadedStoreId)

      // An earlier create of this form that was not confirmed: find that exact
      // listing before anything else. Found, it is edited; not found, nothing
      // is written, since creating again could list the product twice.
      let targetItemId = editingItemId
      if (!targetItemId && pendingItemId) {
        if (!(await storeItemService.isOnChain(pendingItemId))) {
          setPendingStillMissing(true)
          setError('Your new product was sent but is still not confirmed. Wait a moment and save again. If it never appears in your store, you can create it again.')
          return
        }
        setCreatedItemId(pendingItemId)
        setPendingItemId(null)
        setPendingStillMissing(false)
        targetItemId = pendingItemId
      }

      /** Write the kit once the listing is saved; false (with the error shown) when it did not save. */
      const writeKit = async (itemId: string): Promise<boolean> => {
        if (!sellerPrivateKey) return false
        try {
          const saved = await itemDeliverableService.saveKit(user.identityId, itemId, kit, sellerPrivateKey, existingDeliverable)
          setExistingDeliverable(saved)
          setKitDirty(false)
          return true
        } catch (kitError) {
          logger.error('Failed to save delivery content:', kitError)
          // Re-read the chain. The draft stays tied to the kit it was edited
          // from: a revision it was not built from (this save landing late, or
          // another tab or device changing it, e.g. a delivery taking unique
          // codes) is never attached to it, or the next save would write the
          // stale pool over that revision and put sent codes back. Such a kit
          // is reloaded whole (content and revision together) for review.
          const outcome = 'The product was saved, but'
          const onChain = await itemDeliverableService.getForItem(itemId).catch(() => undefined)
          if (onChain !== undefined && !sameKitRevision(onChain, existingDeliverable)) {
            await loadKit(itemId, user.identityId)
            setError(`${outcome} its delivery content on chain is not the version this page started from (a save may have landed late, or it was changed elsewhere, for example by a delivery that used unique codes), so it was reloaded. Review it and save again.`)
          } else if (kitError instanceof KitWriteUncertainError) {
            // It may yet land. The next save writes from the same base, which
            // the chain refuses if this one landed meanwhile.
            setError(`${outcome} its delivery content was sent and is not confirmed yet. Wait a moment, then save again to make sure it is stored.`)
          } else {
            setError(`${outcome} its delivery content was not saved (${kitError instanceof Error ? kitError.message : 'unknown error'}). Save again to retry.`)
          }
          return false
        }
      }

      let savedItemId: string
      if (targetItemId && effectiveStoreId) {
        await storeItemService.updateItem(targetItemId, user.identityId, effectiveStoreId, itemData)
        savedItemId = targetItemId
      } else if (effectiveStoreId) {
        const created = await storeItemService.createItem(user.identityId, effectiveStoreId, itemData)
        setLoadedStoreId(effectiveStoreId)
        // Broadcast but not seen: the kit cannot reference it yet, and the form
        // must not turn into an edit of a listing that may never exist.
        const confirmed = (created as { __createConfirmed?: boolean }).__createConfirmed !== false
        if (!confirmed && !(await storeItemService.isOnChain(created.id))) {
          setPendingItemId(created.id)
          setPendingStillMissing(false)
          setError('Your new product was sent but is not confirmed yet. Wait a moment, then save again: that looks for this product first and never creates it twice.')
          return
        }
        savedItemId = created.id
        setCreatedItemId(created.id)
      } else {
        setError('Store ID is required')
        return
      }

      // A locked or unreadable kit, or an untouched one, is left as it is.
      if (willSaveKit && sellerPrivateKey && !(await writeKit(savedItemId))) return

      router.push('/store/manage')
    } catch (err) {
      logger.error(`Failed to ${editingItemId ? 'update' : 'create'} item:`, err)
      setError(err instanceof ListLimitError ? err.message : `Failed to ${editingItemId ? 'update' : 'create'} product. Please try again.`)
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!storeId && !isEditMode) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center items-center">
          <p className="text-gray-500">No store ID provided</p>
        </div>
        <RightSidebar />
      </div>
    )
  }

  return (
    <PageShell>
          <PageHeader>
            <div className="flex items-center gap-4 p-4">
              <button
                aria-label="Back"
                onClick={() => router.back()}
                className="p-2 -ml-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <h1 className="text-xl font-bold">{isEditMode ? 'Edit Product' : 'Add Product'}</h1>
            </div>
          </PageHeader>

          {isLoading || (!isEditMode && loadedStoreId !== storeId && !error) ? (
            <div className="flex items-center justify-center py-20">
              <Spinner />
            </div>
          ) : !isEditMode && loadedStoreId !== storeId ? (
            <p role="alert" className="p-4 text-red-500">{error}</p>
          ) : (
          <form onSubmit={handleSubmit} className="p-4 space-y-6">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg text-sm"
              >
                {error}
              </motion.div>
            )}
            {pendingItemId && pendingStillMissing && (
              <div className="p-3 border border-yellow-200 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg space-y-2">
                <p className="text-sm text-yellow-800 dark:text-yellow-200">
                  Creating it again is safe only if the first one never lands. If it does, your store lists this product twice, and you can mark the extra one deleted.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => {
                    setPendingItemId(null)
                    setPendingStillMissing(false)
                    setError(null)
                  }}
                >
                  Create it again on next save
                </Button>
              </div>
            )}

            {/* Title */}
            <div>
              <label htmlFor={`${formId}-title`} className="block text-sm font-medium mb-2">
                Product Title <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id={`${formId}-title`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter product title"
                className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                required
                maxLength={200}
              />
            </div>

            {/* Description */}
            <div>
              <label htmlFor={`${formId}-description`} className="block text-sm font-medium mb-2">Description</label>
              <textarea
                id={`${formId}-description`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe your product"
                rows={4}
                className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
                maxLength={2000}
              />
            </div>

            {/* Product type (storefront v6) */}
            {supportsDigital && (
              <fieldset>
                <legend className="block text-sm font-medium mb-2">Product type</legend>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { value: 'shipped', label: 'Physical', hint: 'Shipped to the buyer', Icon: TruckIcon },
                    { value: 'digital', label: 'Digital', hint: 'Files, links or keys delivered online', Icon: CloudArrowDownIcon },
                  ] as const).map(({ value, label, hint, Icon }) => (
                    <label
                      key={value}
                      className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${isKitUploading ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'} ${
                        fulfillment === value
                          ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-900/20'
                          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name={`${formId}-fulfillment`}
                        value={value}
                        checked={fulfillment === value}
                        onChange={() => setFulfillment(value)}
                        // Switching away unmounts the kit editor, which would drop an in-flight upload's key.
                        disabled={isKitUploading}
                        className="sr-only"
                      />
                      <Icon className="h-5 w-5 mt-0.5 text-yappr-500 flex-shrink-0" aria-hidden="true" />
                      <span>
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="block text-xs text-gray-500">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {/* Images */}
            <div>
              <p className="block text-sm font-medium mb-2">Product Images (max {imageLimit})</p>

              {imageUrls.length > 0 && (
                <div className="grid grid-cols-4 gap-2 mb-3">
                  {imageUrls.map((url, index) => (
                    <div key={index} className="relative aspect-square bg-gray-100 dark:bg-gray-900 rounded-lg overflow-hidden">
                      <IpfsImage src={url} alt={`Product ${index + 1}`} className="w-full h-full object-cover" />
                      {hasVariants && (
                        // Combinations pick an image by this number.
                        <span aria-hidden="true" className="absolute bottom-1 left-1 px-1.5 rounded bg-black/50 text-xs text-white">{index + 1}</span>
                      )}
                      <button
                        type="button"
                        aria-label={`Remove product image ${index + 1}`}
                        onClick={() => handleRemoveImage(index)}
                        className="absolute top-1 right-1 p-1 bg-black/50 rounded-full hover:bg-black/70 transition-colors"
                      >
                        <XMarkIcon className="h-4 w-4 text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {imageUrls.length < imageLimit && (
                <ProfileImageUpload
                  onUpload={(ipfsUrl) => {
                    const gatewayUrl = ipfsToGatewayUrl(ipfsUrl)
                    setImageUrls(prev => (prev.includes(gatewayUrl) ? prev : [...prev, gatewayUrl].slice(0, imageLimit)))
                  }}
                  aspectRatio="square"
                  label=""
                  placeholder="Upload product image"
                />
              )}

              {imageUrls.length < imageLimit && (
                <details className="text-sm mt-2">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-400">
                    Or paste a URL
                  </summary>
                  <div className="flex gap-2 mt-2">
                    <input
                      type="url"
                      aria-label="Product image URL"
                      value={newImageUrl}
                      onChange={(e) => setNewImageUrl(e.target.value)}
                      placeholder="Enter image URL"
                      className="flex-1 px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      aria-label="Add product image URL"
                      onClick={handleAddImage}
                      disabled={!newImageUrl}
                    >
                      <PlusIcon className="h-5 w-5" />
                    </Button>
                  </div>
                </details>
              )}
            </div>

            {/* Category */}
            <div>
              <label htmlFor={`${formId}-category`} className="block text-sm font-medium mb-2">Category</label>
              <input
                type="text"
                id={`${formId}-category`}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g., Electronics, Clothing"
                className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                maxLength={50}
              />
            </div>

            {/* Variants Toggle */}
            <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasVariants}
                  disabled={keepVariants}
                  onChange={(e) => {
                    // A fresh table starts empty; one edited before unticking comes back as it was.
                    if (e.target.checked && variants.axes.length === 0) setVariants(emptyVariants())
                    setHasVariants(e.target.checked)
                  }}
                  className="w-5 h-5 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
                />
                <span className="font-medium">This product has variants (e.g., size, color)</span>
              </label>
              {keepVariants && (
                <p className="mt-2 text-sm text-gray-500">A product keeps its options once it has been saved with them. To sell it without options, list it again as a new product.</p>
              )}
            </div>

            {hasVariants ? (
              <VariantEditor
                variants={variants}
                onChange={setVariants}
                currency={currency}
                defaultPrice={defaultCombinationPrice(basePrice, currency, variants)}
                imageUrls={imageUrls}
                showWeight={variantsAreTyped}
                keepTable={keepVariants}
                disabled={isSubmitting}
              />
            ) : (
              /* Simple Price & Stock */
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor={`${formId}-price`} className="block text-sm font-medium mb-2">Price ({currency})</label>
                    <input
                      type="number"
                      id={`${formId}-price`}
                      value={basePrice}
                      onChange={(e) => setBasePrice(e.target.value)}
                      placeholder="0.00"
                      step={getCurrencyStep(currency)}
                      min="0"
                      className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                    />
                  </div>
                  <div>
                    <label htmlFor={`${formId}-currency`} className="block text-sm font-medium mb-2">Currency</label>
                    <select
                      id={`${formId}-currency`}
                      value={currency}
                      onChange={(e) => handleCurrencyChange(e.target.value)}
                      className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                    >
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                      <option value="GBP">GBP</option>
                      <option value="CAD">CAD</option>
                      <option value="DASH">DASH</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor={`${formId}-stock`} className="block text-sm font-medium mb-2">Stock Quantity</label>
                  <input
                    type="number"
                    id={`${formId}-stock`}
                    value={stockQuantity}
                    onChange={(e) => setStockQuantity(e.target.value)}
                    placeholder="Unlimited"
                    min="0"
                    className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                </div>
              </>
            )}

            {/* Currency selector when variants enabled */}
            {hasVariants && (
              <div>
                <label htmlFor={`${formId}-currency`} className="block text-sm font-medium mb-2">Currency</label>
                <select
                  id={`${formId}-currency`}
                  value={currency}
                  onChange={(e) => handleCurrencyChange(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="CAD">CAD</option>
                  <option value="DASH">DASH</option>
                </select>
              </div>
            )}

            {/* Digital delivery content */}
            {isDigital && user?.identityId && (
              <section className="border-t border-gray-200 dark:border-gray-800 pt-6 space-y-3">
                <h2 className="font-medium flex items-center gap-2">
                  <CloudArrowDownIcon className="h-5 w-5 text-yappr-500" aria-hidden="true" />
                  Digital delivery
                </h2>
                {kitState === 'loading' && <Spinner size="sm" />}
                {kitState === 'error' && (
                  <p role="alert" className="text-sm text-red-600">Could not load this product&apos;s delivery content. Reload the page to try again.</p>
                )}
                {kitState === 'locked' && (
                  <div className="p-3 border border-yellow-200 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg space-y-2">
                    <p className="text-sm text-yellow-800 dark:text-yellow-200">
                      This product&apos;s delivery content is encrypted to your encryption key. Add it on this device to view or change it. Saving now leaves it unchanged.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => openEncryptionKeyModal('sell_digital', () => {
                        if (editingItemId) loadKit(editingItemId, user.identityId).catch((err) => logger.error(err))
                      })}
                    >
                      Add Encryption Key
                    </Button>
                  </div>
                )}
                {kitState === 'unreadable' && (
                  <div className="p-3 border border-yellow-200 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg space-y-2">
                    <p className="text-sm text-yellow-800 dark:text-yellow-200">
                      This product&apos;s delivery content does not decrypt with the encryption key on this device (it may have been saved under an earlier key). Saving the product leaves it unchanged. You can replace it with new content instead.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setKit(EMPTY_KIT)
                        setKitDirty(true)
                        setKitState('ready')
                      }}
                    >
                      Replace delivery content
                    </Button>
                  </div>
                )}
                {kitState === 'ready' && (
                  <DigitalKitEditor
                    // Remount on each saved or reloaded revision: the editor seeds local text from the kit.
                    key={existingDeliverable?.$revision ?? 'new'}
                    kit={kit}
                    onChange={updateKit}
                    onBusyChange={setIsKitUploading}
                    identityId={user.identityId}
                    // Assets can target options only where option ids are stored (v7).
                    variants={hasVariants && variantsAreTyped ? variants : undefined}
                    disabled={isSubmitting}
                  />
                )}
              </section>
            )}

            {/* Submit */}
            <div className="pt-4">
              <Button
                type="submit"
                disabled={isSubmitting || isKitUploading || !title.trim()}
                className="w-full"
              >
                {isSubmitting
                  ? (editingItemId || pendingItemId ? 'Saving...' : 'Creating...')
                  : (editingItemId || pendingItemId ? 'Save Changes' : 'Create Product')}
              </Button>
              {!editingItemId && !pendingItemId && listingFeeCredits !== null && (
                <p className="mt-2 text-center text-xs text-gray-500">
                  Listing a product pays a moderation fee of about {formatCreditsAsDash(listingFeeCredits)} DASH, plus the network fee.
                </p>
              )}
            </div>
          </form>
          )}
    </PageShell>
  )
}

export default withAuth(AddItemPage)
