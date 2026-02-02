'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon, BuildingStorefrontIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useSettingsStore } from '@/lib/store'
import { storeService } from '@/lib/services/store-service'
import { SocialLinksInput } from '@/components/profile/social-links-input'
import { PoliciesEditor } from '@/components/store/policies-editor'
import { parseStorePolicies, serializeStorePolicies, isPoliciesWithinLimit } from '@/lib/utils/policies'
import type { SocialLink, ParsedPaymentUri, StorePolicy } from '@/lib/types'

function CreateStorePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('id')
  const isEditMode = !!storeId
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [isLoading, setIsLoading] = useState(isEditMode)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [bannerUrl, setBannerUrl] = useState('')
  const [location, setLocation] = useState('')
  const [defaultCurrency, setDefaultCurrency] = useState('USD')
  const [policies, setPolicies] = useState<StorePolicy[]>([])
  const [status, setStatus] = useState<'active' | 'paused' | 'closed'>('active')

  // Contact methods as social links
  const [contactLinks, setContactLinks] = useState<SocialLink[]>([])

  // Payment URIs - preserve existing when editing (managed via Settings tab)
  const [existingPaymentUris, setExistingPaymentUris] = useState<ParsedPaymentUri[]>([])

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

        // Contact methods - already in SocialLink[] format
        setContactLinks(store.contactMethods || [])

        // Preserve all existing payment URIs (managed via Settings tab)
        if (store.paymentUris && store.paymentUris.length > 0) {
          setExistingPaymentUris(store.paymentUris)
        }
      } catch (err) {
        console.error('Failed to load store:', err)
        setError('Failed to load store data')
      } finally {
        setIsLoading(false)
      }
    }

    loadStore()
  }, [sdkReady, isEditMode, storeId, user?.identityId])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user?.identityId || !name.trim()) return

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
        contactMethods: contactLinks.length > 0 ? contactLinks : undefined
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
        // Payment methods are added later via the Settings tab
        await storeService.createStore(user.identityId, storeData)
        router.push('/store')
      }
    } catch (err) {
      console.error(`Failed to ${isEditMode ? 'update' : 'create'} store:`, err)
      setError(err instanceof Error ? err.message : `Failed to ${isEditMode ? 'update' : 'create'} store`)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center gap-4 p-4">
              <button
                onClick={() => router.back()}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <h1 className="text-xl font-bold">{isEditMode ? 'Edit Store' : 'Create Store'}</h1>
            </div>
          </header>

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Spinner />
            </div>
          ) : (
          <form onSubmit={handleSubmit} className="p-4 space-y-6">
            {/* Store Icon */}
            <div className="flex justify-center">
              <div className="w-24 h-24 rounded-xl bg-gray-200 dark:bg-gray-800 flex items-center justify-center">
                {logoUrl ? (
                  <img src={logoUrl} alt="Store logo" className="w-full h-full object-cover rounded-xl" />
                ) : (
                  <BuildingStorefrontIcon className="h-12 w-12 text-gray-400" />
                )}
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm">
                {error}
              </div>
            )}

            {/* Basic Info */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Store Information</h2>

              <div>
                <label className="block text-sm font-medium mb-1">Store Name *</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your Store Name"
                  required
                  maxLength={100}
                  className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe your store and what you sell"
                  rows={3}
                  maxLength={500}
                  className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Logo URL</label>
                  <input
                    type="url"
                    value={logoUrl}
                    onChange={(e) => setLogoUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Banner URL</label>
                  <input
                    type="url"
                    value={bannerUrl}
                    onChange={(e) => setBannerUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Location</label>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="City, Country"
                    maxLength={100}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Default Currency</label>
                  <select
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
              <h2 className="text-lg font-semibold">Contact Methods</h2>
              <SocialLinksInput
                links={contactLinks}
                onChange={setContactLinks}
                maxLinks={10}
                label="Contact Options"
                description="How buyers can reach you"
              />
            </div>

            {/* Policies */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Store Policies</h2>
              <p className="text-sm text-gray-500">
                Define your store policies (e.g., returns, shipping, privacy). Buyers must agree to these before checkout.
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
                disabled={isSubmitting || !name.trim()}
                className="w-full"
              >
                {isSubmitting
                  ? (isEditMode ? 'Saving...' : 'Creating Store...')
                  : (isEditMode ? 'Save Changes' : 'Create Store')}
              </Button>
            </div>
          </form>
          )}
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}

export default withAuth(CreateStorePage)
