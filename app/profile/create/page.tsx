'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { getPrivateKey, storePrivateKey } from '@/lib/secure-storage'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'

function CreateProfilePage() {
  const router = useRouter()
  const { user, logout } = useAuth()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showPrivateKeyInput, setShowPrivateKeyInput] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [isCheckingProfile, setIsCheckingProfile] = useState(true)
  
  const [formData, setFormData] = useState({
    displayName: '',
    bio: '',
    location: '',
    website: ''
  })

  // Check for existing profile on component mount
  useEffect(() => {
    const checkExistingProfile = async () => {
      if (!user) return
      
      try {
        const { profileService } = await import('@/lib/services/profile-service')
        const existingProfile = await profileService.getProfile(user.identityId)
        
        if (existingProfile) {
          toast.success('You already have a profile!')
          router.push('/profile')
        }
      } catch (error) {
        console.error('Error checking for existing profile:', error)
      } finally {
        setIsCheckingProfile(false)
      }
    }
    
    checkExistingProfile()
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
      // Create profile using the profile service
      const { profileService } = await import('@/lib/services/profile-service')
      
      if (!user) {
        throw new Error('User not authenticated')
      }
      
      console.log('Creating profile with data:', formData)
      
      // Create the profile
      await profileService.createProfile(
        user.identityId,
        formData.displayName,
        formData.bio,
        undefined // avatarData - will be implemented later
      )
      
      toast.success('Profile created successfully!')
      
      // Redirect to home
      router.push('/')
    } catch (error: any) {
      console.error('Failed to create profile:', error)
      
      // Check if it's a duplicate profile error
      if (error.message?.includes('duplicate unique properties') || 
          error.message?.includes('already exists')) {
        toast.error('You already have a profile! Redirecting...')
        setTimeout(() => {
          router.push('/profile')
        }, 2000)
      } else {
        toast.error(error instanceof Error ? error.message : 'Failed to create profile')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  // Show loading state while checking for existing profile
  if (isCheckingProfile) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-black flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-12 w-12 animate-spin text-yappr-500 mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-400">Checking for existing profile...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-black flex items-center justify-center px-4">
      <div className="max-w-md w-full">
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
              <label htmlFor="bio" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Bio
              </label>
              <Textarea
                id="bio"
                value={formData.bio}
                onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                placeholder="Tell us about yourself..."
                rows={4}
                maxLength={200}
              />
              <p className="text-xs text-gray-500 mt-1">
                {formData.bio.length}/200 characters
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
                maxLength={100}
              />
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