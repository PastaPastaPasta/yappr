'use client'

import { LimitedInput, LimitedTextarea } from '@/components/ui/limited-text'

import { logger } from '@/lib/logger';
import { useState, useEffect, useId } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { storeService } from '@/lib/services/store-service'
import { SocialLinksInput } from '@/components/profile/social-links-input'
import { PoliciesEditor } from '@/components/store/policies-editor'
import { parseStorePolicies, serializeStorePolicies, isPoliciesWithinLimit } from '@/lib/utils/policies'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { ipfsToGatewayUrl } from '@/lib/utils/ipfs-gateway'
import { extractErrorMessage } from '@/lib/error-utils'
import { reportModerationRefusal } from '@/components/moderation/barred-writer-notice'
import { ModerationClosedNotice } from '@/components/moderation/moderation-closed-notice'
import { useModeratedTypeOpen } from '@/hooks/use-moderated-type-open'
import { storefrontIsV6 } from '@/lib/constants'
import { storeStatsService } from '@/lib/services/store-stats-service'
import { STORE_CATEGORY_MAX_LENGTH, isStoreImageUrl, normalizeStoreCategory, storefrontCreateFeeCredits } from '@/lib/storefront/storefront-contract'
import { formatCreditsAsDash } from '@/lib/services/dpns-service'
import type { SocialLink, ParsedPaymentUri, StorePolicy } from '@/lib/types'
import { fieldLimits } from '@/lib/field-limits'

const ONE_STORE_MESSAGE = 'You already have a store. Each account can have one store; manage it from Store > Manage.'

function CreateStorePage() {
  const formId = useId()
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('id')
  const isEditMode = !!storeId
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const [isLoading, setIsLoading] = useState(isEditMode)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Testnet registers the storefront `notYetUsable`: stores open with its first seated team (41200 before).
  const storesOpen = useModeratedTypeOpen('store', true, 'storefront')

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [bannerUrl, setBannerUrl] = useState('')
  const [location, setLocation] = useState('')
  const [defaultCurrency, setDefaultCurrency] = useState('USD')
  const [policies, setPolicies] = useState<StorePolicy[]>([])
  const [status, setStatus] = useState<'active' | 'paused' | 'closed'>('active')
  // v6: every store files under one category slug; what is typed is normalised to it.
  const needsCategory = storefrontIsV6()
  const [category, setCategory] = useState('')
  const [suggestedCategories, setSuggestedCategories] = useState<string[]>([])
  const categorySlug = normalizeStoreCategory(category)
  // v6 charges an action fee on the create (null before v6).
  const createFeeCredits = storefrontCreateFeeCredits('store')

  // Contact methods as social links
  const [contactLinks, setContactLinks] = useState<SocialLink[]>([])

  // Payment URIs - preserve existing when editing (managed via Settings tab)
  const [existingPaymentUris, setExistingPaymentUris] = useState<ParsedPaymentUri[]>([])

  // Offer the categories other stores already use, so similar stores share one.
  useEffect(() => {
    if (!sdkReady || !needsCategory) return
    let active = true
    storeStatsService.topStoreCategories(20)
      .then((ranked) => { if (active) setSuggestedCategories(ranked.map((entry) => entry.id)) })
      .catch((err) => logger.warn('Failed to load store categories:', err))
    return () => { active = false }
  }, [sdkReady, needsCategory])

  // Load existing store data in edit mode
  useEffect(() => {
    if (!sdkReady || !isEditMode || !storeId) return

    const loadStore = async () => {
      try {
        setIsLoading(true)
        const store = await storeService.getById(storeId)
        if (!store) {
          setError('Store not found')
          return
        }

        // Verify ownership before populating form
        if (store.ownerId !== user?.identityId) {
          setError('Unauthorized to edit this store')
          setIsLoading(false)
          return
        }

        // Populate form fields
        setName(store.name || '')
        setDescription(store.description || '')
        setLogoUrl(store.logoUrl || '')
        setBannerUrl(store.bannerUrl || '')
        setLocation(store.location || '')
        setDefaultCurrency(store.defaultCurrency || 'USD')
        setPolicies(parseStorePolicies(store.policies))
        setStatus(store.status || 'active')
        setCategory(store.category || '')

        // Contact methods - already in SocialLink[] format
        setContactLinks(store.contactMethods || [])

        // Preserve all existing payment URIs (managed via Settings tab)
        if (store.paymentUris && store.paymentUris.length > 0) {
          setExistingPaymentUris(store.paymentUris)
        }
      } catch (err) {
        logger.error('Failed to load store:', err)
        setError('Failed to load store data')
      } finally {
        setIsLoading(false)
      }
    }

    loadStore().catch((err) => logger.error('Failed to load store:', err))
  }, [sdkReady, isEditMode, storeId, user?.identityId])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user?.identityId || !name.trim()) return

    if (needsCategory && !categorySlug) {
      setError('Choose a category for your store, such as "books" or "vintage clothing".')
      return
    }
    if ([logoUrl, bannerUrl].some((url) => url.trim() && !isStoreImageUrl(url.trim()))) {
      setError('Logo and banner URLs must start with https:// or ipfs://')
      return
    }

    // Validate policies length
    if (!isPoliciesWithinLimit(policies)) {
      setError('Store policies exceed the maximum character limit.')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      // Serialize policies to JSON string
      const serializedPolicies = serializeStorePolicies(policies)

      const storeData = {
        name: name.trim(),
        status, // Required field - preserves existing status when editing
        description: description.trim() || undefined,
        logoUrl: logoUrl.trim() || undefined,
        bannerUrl: bannerUrl.trim() || undefined,
        location: location.trim() || undefined,
        defaultCurrency,
        policies: serializedPolicies || undefined,
        contactMethods: contactLinks.length > 0 ? contactLinks : undefined,
        // Only v6 has the property (and requires it); earlier cuts never fill it.
        category: categorySlug || undefined
      }

      if (isEditMode && storeId) {
        // Preserve existing payment URIs when updating
        const updateData = {
          ...storeData,
          paymentUris: existingPaymentUris.length > 0 ? existingPaymentUris : undefined
        }
        await storeService.updateStore(storeId, user.identityId, updateData)
        router.push('/store/manage')
      } else {
        // The contract allows one store per identity; say so instead of letting consensus refuse it.
        if (await storeService.hasStore(user.identityId)) {
          setError(ONE_STORE_MESSAGE)
          return
        }
        // Payment methods are added later via the Settings tab
        await storeService.createStore(user.identityId, storeData)
        router.push('/store')
      }
    } catch (err) {
      logger.error(`Failed to ${isEditMode ? 'update' : 'create'} store:`, err)
      if (reportModerationRefusal(err, user.identityId, 'storefront')) {
        setError(null)
      } else if (!isEditMode && /duplicate unique properties/i.test(extractErrorMessage(err))) {
        setError(ONE_STORE_MESSAGE)
      } else {
        setError(err instanceof Error ? err.message : `Failed to ${isEditMode ? 'update' : 'create'} store`)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <PageShell>
          <PageHeader>
            <div className="flex items-center gap-4 p-4">
              <button
                aria-label="Back"
                onClick={() => router.back()}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <h1 className="text-xl font-bold">{isEditMode ? 'Edit Store' : 'Create Store'}</h1>
            </div>
          </PageHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Spinner />
            </div>
          ) : (
          <form onSubmit={handleSubmit} className="p-4 space-y-6">
            {!storesOpen && <ModerationClosedNotice product="storefront" />}
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm">
                {error}
              </div>
            )}

            {/* Basic Info */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Store details</h2>

              <div>
                <label htmlFor={`${formId}-name`} className="block text-sm font-medium mb-1">Store name *</label>
                <LimitedInput contract="storefront" document="store" field="name"
                  type="text"
                  id={`${formId}-name`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your store name"
                  required
                  className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
              </div>

              <div>
                <label htmlFor={`${formId}-description`} className="block text-sm font-medium mb-1">Description</label>
                <LimitedTextarea contract="storefront" document="store" field="description"
                  id={`${formId}-description`}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe your store and what you sell"
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
                />
              </div>

              {needsCategory && (
                <div>
                  <label htmlFor={`${formId}-category`} className="block text-sm font-medium mb-1">Category *</label>
                  <LimitedInput limits={{ maxLength: STORE_CATEGORY_MAX_LENGTH * 2 }}
                    type="text"
                    id={`${formId}-category`}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. vintage clothing"
                    required
                    list={`${formId}-categories`}
                    aria-describedby={`${formId}-category-hint`}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                  <datalist id={`${formId}-categories`}>
                    {suggestedCategories.map((slug) => <option key={slug} value={slug} />)}
                  </datalist>
                  <p id={`${formId}-category-hint`} className="mt-1 text-xs text-gray-500">
                    {categorySlug
                      ? <>Listed under <span className="font-mono">{categorySlug}</span>. Stores with the same category are browsed together.</>
                      : `Lowercase words and digits, up to ${STORE_CATEGORY_MAX_LENGTH} characters.`}
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="w-28 shrink-0">
                  <ProfileImageUpload
                    currentUrl={logoUrl || undefined}
                    onUpload={(url) => setLogoUrl(ipfsToGatewayUrl(url))}
                    onClear={() => setLogoUrl('')}
                    aspectRatio="square"
                    label="Logo"
                    placeholder="Add logo"
                    urlLimits={fieldLimits('storefront', 'store', 'logoUrl')}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <ProfileImageUpload
                    currentUrl={bannerUrl || undefined}
                    onUpload={(url) => setBannerUrl(ipfsToGatewayUrl(url))}
                    onClear={() => setBannerUrl('')}
                    aspectRatio="banner"
                    label="Banner"
                    placeholder="Add banner"
                    urlLimits={fieldLimits('storefront', 'store', 'bannerUrl')}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor={`${formId}-location`} className="block text-sm font-medium mb-1">Location</label>
                  <LimitedInput contract="storefront" document="store" field="location"
                    type="text"
                    id={`${formId}-location`}
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="City, Country"
                    className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                </div>
                <div>
                  <label htmlFor={`${formId}-currency`} className="block text-sm font-medium mb-1">Currency</label>
                  <select
                    id={`${formId}-currency`}
                    value={defaultCurrency}
                    onChange={(e) => setDefaultCurrency(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  >
                    <option value="USD">USD - US Dollar</option>
                    <option value="EUR">EUR - Euro</option>
                    <option value="GBP">GBP - British Pound</option>
                    <option value="CAD">CAD - Canadian Dollar</option>
                    <option value="DASH">DASH - Dash</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Contact Methods */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Contact</h2>
              <SocialLinksInput
                links={contactLinks}
                onChange={setContactLinks}
                maxLinks={10}
                label="How buyers can reach you"
                description="Email, Signal, Telegram or any other handle."
              />
            </div>

            {/* Policies */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Policies</h2>
              <p className="text-sm text-gray-500">
                Returns, shipping and other terms buyers agree to at checkout.
              </p>

              <PoliciesEditor
                policies={policies}
                onChange={setPolicies}
              />
            </div>

            {/* Submit */}
            <div className="pt-4">
              <Button
                type="submit"
                disabled={isSubmitting || !name.trim() || !storesOpen}
                className="w-full"
              >
                {isSubmitting
                  ? (isEditMode ? 'Saving...' : 'Creating Store...')
                  : (isEditMode ? 'Save Changes' : 'Create Store')}
              </Button>
              {!isEditMode && createFeeCredits !== null && (
                <p className="mt-2 text-center text-xs text-gray-500">
                  Opening a store costs about {formatCreditsAsDash(createFeeCredits)} DASH.
                </p>
              )}
            </div>
          </form>
          )}
    </PageShell>
  )
}

export default withAuth(CreateStorePage)
