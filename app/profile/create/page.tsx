'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { isIpfsProtocol, ipfsToGatewayUrl } from '@/lib/utils/ipfs-gateway'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { getPrivateKey, storePrivateKey } from '@/lib/secure-storage'
import toast from 'react-hot-toast'
import { SparklesIcon, PhotoIcon } from '@heroicons/react/24/outline'
import { Spinner } from '@/components/ui/spinner'
import Image from 'next/image'
import type { SocialLink } from '@/lib/types'
import { PaymentUriInput } from '@/components/profile/payment-uri-input'
import { SocialLinksInput } from '@/components/profile/social-links-input'
import { extractErrorMessage, isTimeoutError } from '@/lib/error-utils'
import {
  unifiedProfileService,
  DICEBEAR_STYLES,
  DICEBEAR_STYLE_LABELS,
  DEFAULT_AVATAR_STYLE,
  type DiceBearStyle,
} from '@/lib/services/unified-profile-service'

type AvatarSource = 'generated' | 'custom'

function CreateProfilePage() {
  const router = useRouter()
  const { user, logout } = useAuth()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showPrivateKeyInput, setShowPrivateKeyInput] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [isCheckingProfile, setIsCheckingProfile] = useState(true)

  // Avatar state
  const [avatarSource, setAvatarSource] = useState<AvatarSource>('generated')
  const [avatarStyle, setAvatarStyle] = useState<DiceBearStyle>(DEFAULT_AVATAR_STYLE)
  const [avatarSeed, setAvatarSeed] = useState<string>('')
  const [customAvatarUrl, setCustomAvatarUrl] = useState<string | null>(null)

  // Banner state
  const [bannerUrl, setBannerUrl] = useState<string | null>(null)

  const [formData, setFormData] = useState({
    displayName: '',
    bio: '',
    location: '',
    website: '',
    pronouns: '',
    nsfw: false,
  })

  // Payment URIs (array of strings)
  const [paymentUris, setPaymentUris] = useState<string[]>([])

  // Social links (array of {platform, handle})
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([])

  // Check for existing profile on mount
  useEffect(() => {
    const checkExistingProfile = async () => {
      if (!user) return

      try {
        const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
        const existingProfile = await unifiedProfileService.getProfile(user.identityId)

        if (existingProfile) {
          toast.success('You already have a profile!')
          router.push(`/user?id=${user.identityId}`)
          return
        }

        // New profile - default seed to user ID
        setAvatarSeed(user.identityId)
      } catch (error) {
        logger.error('Error checking profile status:', error)
      } finally {
        setIsCheckingProfile(false)
      }
    }

    checkExistingProfile().catch(err => logger.error('Failed to check profile:', err))
  }, [user, router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!formData.displayName.trim()) {
      toast.error('Display name is required')
      return
    }

    // Check if private key is in secure storage
    const storedPrivateKey = user ? getPrivateKey(user.identityId) : null
    if (!storedPrivateKey && !privateKey) {
      setShowPrivateKeyInput(true)
      toast.error('Please enter your private key to continue')
      return
    }

    // If private key was entered, store it in secure storage
    if (privateKey && !storedPrivateKey && user) {
      storePrivateKey(user.identityId, privateKey)
    }

    setIsSubmitting(true)

    try {
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

      if (!user) {
        throw new Error('User not authenticated')
      }

      logger.info('Creating profile with data:', formData)

      // Build avatar data - either custom URL or generated DiceBear settings
      let avatarData: string | undefined
      if (avatarSource === 'custom' && customAvatarUrl) {
        // Store custom image URL directly
        avatarData = customAvatarUrl
      } else if (avatarSeed) {
        // Store DiceBear settings as JSON
        avatarData = unifiedProfileService.encodeAvatarData(avatarSeed, avatarStyle)
      }

      // Create the profile on the new unified profile contract
      await unifiedProfileService.createProfile(user.identityId, {
        displayName: formData.displayName,
        bio: formData.bio || undefined,
        location: formData.location || undefined,
        website: formData.website || undefined,
        pronouns: formData.pronouns || undefined,
        nsfw: formData.nsfw || undefined,
        avatar: avatarData,
        bannerUri: bannerUrl || undefined,
        paymentUris: paymentUris.length > 0 ? paymentUris : undefined,
        socialLinks: socialLinks.length > 0 ? socialLinks : undefined,
      })

      toast.success('Profile created successfully!')

      // Redirect to feed
      router.push('/feed')
    } catch (error: unknown) {
      logger.error('Failed to create profile:', error)

      const errorMessage = extractErrorMessage(error)

      // Check if it's a duplicate profile error
      if (errorMessage.includes('duplicate unique properties') ||
          errorMessage.includes('already exists')) {
        toast.error('You already have a profile! Redirecting...')
        setTimeout(() => {
          router.push(`/user?id=${user?.identityId}`)
        }, 2000)
        return
      }

      // Check if it's a timeout error - the profile might have been created successfully
      if (isTimeoutError(error) && user) {
        toast.loading('Request timed out. Checking if profile was created...', { duration: 3000 })

        // Wait a moment for the network to propagate, then check if profile exists
        await new Promise(resolve => setTimeout(resolve, 2000))

        try {
          const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
          const { cacheManager } = await import('@/lib/cache-manager')

          // Clear cache to ensure we get fresh data from the network
          cacheManager.invalidateByTag(`user:${user.identityId}`)

          const profile = await unifiedProfileService.getProfile(user.identityId)

          if (profile) {
            // Profile was actually created despite the timeout
            toast.dismiss()
            toast.success('Profile created successfully!')
            router.push('/feed')
            return
          }
        } catch (checkError) {
          logger.error('Error checking for profile:', checkError)
        }

        // Profile doesn't exist - show helpful timeout error
        toast.dismiss()
        toast.error('Request timed out. Please try again.')
      } else {
        toast.error('Failed to create profile. Please try again.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  // Show loading state while checking for existing profile
  if (isCheckingProfile) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-neutral-900 flex items-center justify-center">
        <div className="text-center">
          <Spinner size="lg" className="mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-400">Checking profile status...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-neutral-900 flex items-center justify-center px-4 py-8">
      <div className="max-w-lg w-full">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-8">
          {/* Header with logout button */}
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-3xl font-bold">Create Your Profile</h1>
            <button
              onClick={logout}
              className="text-sm text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            >
              Logout
            </button>
          </div>

          <p className="text-gray-600 dark:text-gray-400 text-center mb-8">
            Set up your Yappr profile to start connecting
          </p>

          {/* Display username if available */}
          {(user?.dpnsUsername || sessionStorage.getItem('yappr_dpns_username')) && (
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4 mb-6">
              <p className="text-sm text-purple-700 dark:text-purple-300">
                <span className="font-semibold">Username:</span> @{user?.dpnsUsername || sessionStorage.getItem('yappr_dpns_username')}
              </p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Private key input if needed */}
            {showPrivateKeyInput && (
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-3">
                  Your private key is needed to create your profile. It will only be stored in this session.
                </p>
                <Input
                  type="password"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="Enter your private key (WIF format)"
                  className="w-full mb-2"
                />
                <p className="text-xs text-yellow-700 dark:text-yellow-300">
                  Default test key: XJ1CkT9xEz4Q471Rs8efttjo7kx7MfAz46Pn9GQWQJFK1oKkW84K
                </p>
              </div>
            )}

            {/* Avatar Section */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Avatar</h3>

              {/* Avatar Source Tabs */}
              <div className="flex border-b border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => setAvatarSource('generated')}
                  className={`flex-1 py-2 px-4 text-sm font-medium transition-colors relative ${
                    avatarSource === 'generated'
                      ? 'text-yappr-600 dark:text-yappr-400'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  <span className="flex items-center justify-center gap-2">
                    <SparklesIcon className="h-4 w-4" />
                    Generated
                  </span>
                  {avatarSource === 'generated' && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yappr-500" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setAvatarSource('custom')}
                  className={`flex-1 py-2 px-4 text-sm font-medium transition-colors relative ${
                    avatarSource === 'custom'
                      ? 'text-yappr-600 dark:text-yappr-400'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  <span className="flex items-center justify-center gap-2">
                    <PhotoIcon className="h-4 w-4" />
                    Custom Image
                  </span>
                  {avatarSource === 'custom' && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yappr-500" />
                  )}
                </button>
              </div>

              {avatarSource === 'generated' ? (
                <div className="flex items-start gap-6">
                  {/* Avatar Preview */}
                  <div className="flex-shrink-0">
                    <div className="w-24 h-24 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700">
                      {avatarSeed && (
                        <Image
                          src={unifiedProfileService.getAvatarUrlFromConfig({ style: avatarStyle, seed: avatarSeed })}
                          alt="Avatar preview"
                          width={96}
                          height={96}
                          className="w-full h-full object-cover"
                          unoptimized
                        />
                      )}
                    </div>
                  </div>

                  {/* Avatar Controls */}
                  <div className="flex-1 space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Style
                      </label>
                      <select
                        value={avatarStyle}
                        onChange={(e) => setAvatarStyle(e.target.value as DiceBearStyle)}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                      >
                        {DICEBEAR_STYLES.map((style) => (
                          <option key={style} value={style}>
                            {DICEBEAR_STYLE_LABELS[style]}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="button"
                      onClick={() => setAvatarSeed(unifiedProfileService.generateRandomSeed())}
                      className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-yappr-600 hover:text-yappr-700 dark:text-yappr-400 dark:hover:text-yappr-300 hover:bg-yappr-50 dark:hover:bg-yappr-900/20 rounded-lg transition-colors"
                    >
                      <SparklesIcon className="h-4 w-4" />
                      Randomize
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <ProfileImageUpload
                    currentUrl={customAvatarUrl || undefined}
                    onUpload={(url) => setCustomAvatarUrl(url)}
                    onClear={() => setCustomAvatarUrl(null)}
                    aspectRatio="square"
                    maxSizeMB={2}
                    label=""
                    placeholder="Click to upload your avatar"
                  />
                  <p className="text-xs text-gray-500 text-center">
                    Upload a custom image for your avatar. Recommended: square image, at least 200x200px.
                  </p>
                </div>
              )}
            </div>

            {/* Banner Section */}
            <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Banner (Optional)</h3>

              {/* Banner Preview */}
              {bannerUrl && (
                <div className="relative aspect-[3/1] rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={isIpfsProtocol(bannerUrl) ? ipfsToGatewayUrl(bannerUrl) : bannerUrl}
                    alt="Banner preview"
                    className="w-full h-full object-cover"
                  />
                </div>
              )}

              <ProfileImageUpload
                currentUrl={bannerUrl || undefined}
                onUpload={(url) => setBannerUrl(url)}
                onClear={() => setBannerUrl(null)}
                aspectRatio="banner"
                maxSizeMB={5}
                label=""
                placeholder="Click to upload banner image"
              />
              <p className="text-xs text-gray-500">
                Recommended: 1500x500 pixels (3:1 aspect ratio). Max 5MB.
              </p>
            </div>

            {/* Basic Info Section */}
            <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Basic Info</h3>

              <div>
                <label htmlFor="displayName" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Display Name *
                </label>
                <Input
                  id="displayName"
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  placeholder="John Doe"
                  required
                  maxLength={50}
                />
              </div>

              <div>
                <label htmlFor="pronouns" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Pronouns
                </label>
                <Input
                  id="pronouns"
                  type="text"
                  value={formData.pronouns}
                  onChange={(e) => setFormData({ ...formData, pronouns: e.target.value })}
                  placeholder="e.g. she/her"
                  maxLength={20}
                />
              </div>

              <div>
                <label htmlFor="bio" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Bio
                </label>
                <Textarea
                  id="bio"
                  value={formData.bio}
                  onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                  placeholder="Tell us about yourself..."
                  rows={3}
                  maxLength={160}
                />
                <p className="text-xs text-gray-500 mt-1">
                  {formData.bio.length}/160 characters
                </p>
              </div>

              <div>
                <label htmlFor="location" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Location
                </label>
                <Input
                  id="location"
                  type="text"
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  placeholder="San Francisco, CA"
                  maxLength={50}
                />
              </div>

              <div>
                <label htmlFor="website" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Website
                </label>
                <Input
                  id="website"
                  type="url"
                  value={formData.website}
                  onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                  placeholder="https://example.com"
                  maxLength={200}
                />
              </div>
            </div>

            {/* Payment Addresses Section */}
            <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
              <PaymentUriInput
                uris={paymentUris}
                onChange={setPaymentUris}
                disabled={isSubmitting}
              />
            </div>

            {/* Social Links Section */}
            <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
              <SocialLinksInput
                links={socialLinks}
                onChange={setSocialLinks}
                disabled={isSubmitting}
              />
            </div>

            {/* Content Settings */}
            <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Content Settings</h3>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.nsfw}
                  onChange={(e) => setFormData({ ...formData, nsfw: e.target.checked })}
                  className="w-4 h-4 text-yappr-500 rounded focus:ring-yappr-500"
                />
                <div>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">NSFW Content</span>
                  <p className="text-xs text-gray-500">Mark your profile as containing adult content</p>
                </div>
              </label>
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting || !formData.displayName.trim()}
            >
              {isSubmitting ? 'Creating Profile...' : 'Create Profile'}
            </Button>
          </form>

          <div className="mt-6 text-center space-y-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Identity: {user?.identityId.slice(0, 8)}...
            </p>
            {(!user || !getPrivateKey(user.identityId)) && (
              <button
                type="button"
                onClick={() => setShowPrivateKeyInput(!showPrivateKeyInput)}
                className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
              >
                {showPrivateKeyInput ? 'Hide' : 'Need to enter'} private key?
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default withAuth(CreateProfilePage, { allowWithoutDPNS: true })
