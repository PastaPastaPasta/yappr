'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { dpnsService } from '@/lib/services/dpns-service'
import toast from 'react-hot-toast'
import { CheckCircle2, XCircle, Loader2, RefreshCw, X, Edit2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useKeyBackupModal } from '@/hooks/use-key-backup-modal'
import { encryptedKeyService } from '@/lib/services/encrypted-key-service'

interface UsernameModalProps {
  isOpen: boolean
  onClose: () => void
  customIdentityId?: string
}

export function UsernameModal({ isOpen, onClose, customIdentityId: initialIdentityId }: UsernameModalProps) {
  const router = useRouter()
  const { user, updateDPNSUsername } = useAuth()
  const { isReady: isSdkReady, error: sdkError } = useSdk()
  const [username, setUsername] = useState('')
  const [isChecking, setIsChecking] = useState(false)
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCheckingExisting, setIsCheckingExisting] = useState(false)
  const [isEditingIdentity, setIsEditingIdentity] = useState(false)
  const [customIdentityId, setCustomIdentityId] = useState(initialIdentityId || '')
  
  // Debug SDK state
  useEffect(() => {
    console.log('UsernameModal: SDK ready state:', isSdkReady, 'SDK error:', sdkError)
  }, [isSdkReady, sdkError])

  const currentIdentityId = customIdentityId || initialIdentityId || user?.identityId || ''

  // Check username availability with debounce
  useEffect(() => {
    if (!username) {
      setIsAvailable(null)
      setValidationError(null)
      return
    }

    // Do basic validation first (without WASM)
    if (username.length < 3) {
      setValidationError('Username must be at least 3 characters long')
      setIsAvailable(false)
      return
    }
    
    if (username.length > 20) {
      setValidationError('Username must be 20 characters or less')
      setIsAvailable(false)
      return
    }
    
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      setValidationError('Username can only contain letters, numbers, and underscores')
      setIsAvailable(false)
      return
    }
    
    if (username.startsWith('_') || username.endsWith('_')) {
      setValidationError('Username cannot start or end with underscore')
      setIsAvailable(false)
      return
    }
    
    if (username.includes('__')) {
      setValidationError('Username cannot contain consecutive underscores')
      setIsAvailable(false)
      return
    }
    
    setValidationError(null)
    
    // Debounce availability check
    const timeoutId = setTimeout(async () => {
      if (!isSdkReady) {
        setValidationError(sdkError ? `Service error: ${sdkError}` : 'Service is initializing...')
        setIsAvailable(false)
        return
      }
      
      setIsChecking(true)
      try {
        const available = await dpnsService.isUsernameAvailable(username)
        setIsAvailable(available)
      } catch (error) {
        console.error('Failed to check username availability:', error)
        toast.error('Failed to check username availability')
      } finally {
        setIsChecking(false)
      }
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [username, isSdkReady, sdkError])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!username || !isAvailable || validationError || !currentIdentityId) {
      return
    }
    
    if (!isSdkReady) {
      toast.error('Service is initializing. Please try again in a moment.')
      return
    }
    
    setIsSubmitting(true)
    
    try {
      // Get the private key from secure storage
      const { getPrivateKey } = await import('@/lib/secure-storage')
      const privateKey = getPrivateKey(currentIdentityId)
      if (!privateKey) {
        throw new Error('Authentication required. Please log in again.')
      }
      
      // Get the identity to find a suitable key
      const { identityService } = await import('@/lib/services/identity-service')
      const identity = await identityService.getIdentity(currentIdentityId)
      
      if (!identity) {
        throw new Error('Identity not found')
      }
      
      // Find a suitable key (CRITICAL or HIGH security level)
      // Security levels: MASTER=0, CRITICAL=1, HIGH=2, MEDIUM=3
      console.log('Identity publicKeys:', JSON.stringify(identity.publicKeys, null, 2))
      
      const suitableKey = identity.publicKeys.find((key: any) => {
        // Check if key has the expected structure
        const keySecurityLevel = key.securityLevel
        const keyDisabledAt = key.disabledAt
        
        console.log(`Key ${key.id}: securityLevel=${keySecurityLevel}, disabledAt=${keyDisabledAt}`)
        
        // Only accept CRITICAL (1) or HIGH (2) security levels
        return !keyDisabledAt && (keySecurityLevel === 1 || keySecurityLevel === 2)
      })
      
      if (!suitableKey) {
        // Log available keys for debugging
        console.log('Available keys:', identity.publicKeys.map((k: any) => ({
          id: k.id,
          securityLevel: k.securityLevel,
          disabledAt: k.disabledAt,
          type: k.type,
          purpose: k.purpose
        })))
        throw new Error('No suitable keys found. DPNS requires CRITICAL (security level 1) or HIGH (security level 2) key.')
      }
      
      const keySecurityLevel = suitableKey.security_level ?? suitableKey.securityLevel
      console.log(`Using key ${suitableKey.id} with security level ${keySecurityLevel === 1 ? 'CRITICAL' : 'HIGH'} (${keySecurityLevel})`)
      
      // Register the username
      await dpnsService.registerUsername(username, currentIdentityId, suitableKey.id, privateKey)
      
      toast.success('DPNS username registered successfully!')

      // Update user in auth context if it's the current user
      if (currentIdentityId === user?.identityId) {
        updateDPNSUsername(username)
      }

      onClose()

      // Prompt for key backup if the feature is configured
      if (encryptedKeyService.isConfigured()) {
        // Check if they already have a backup
        const hasBackup = await encryptedKeyService.hasBackup(currentIdentityId)
        if (!hasBackup && privateKey) {
          // Open the key backup modal
          useKeyBackupModal.getState().open(currentIdentityId, username, privateKey)
          return // Don't redirect yet - let the backup modal handle it
        }
      }

      // Redirect to profile creation
      router.push('/profile/create')
    } catch (error: any) {
      console.error('Failed to register username:', error)
      const errorMessage = error.message || 'Failed to register username'
      
      // Provide more specific error messages
      if (errorMessage.includes('already taken')) {
        toast.error('This username is already taken. Please choose another.')
      } else if (errorMessage.includes('Invalid username')) {
        toast.error('Invalid username format. Please check the requirements.')
      } else if (errorMessage.includes('SDK')) {
        toast.error('Service initialization failed. Please try again.')
      } else {
        toast.error(errorMessage)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const getStatusIcon = () => {
    if (isChecking) {
      return <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
    }
    
    if (validationError) {
      return <XCircle className="w-5 h-5 text-red-500" />
    }
    
    if (isAvailable === true) {
      return <CheckCircle2 className="w-5 h-5 text-green-500" />
    }
    
    if (isAvailable === false) {
      return <XCircle className="w-5 h-5 text-red-500" />
    }
    
    return null
  }

  const getStatusMessage = () => {
    if (validationError) {
      return <p className="text-sm text-red-600 mt-1">{validationError}</p>
    }
    
    if (isChecking) {
      return <p className="text-sm text-gray-500 mt-1">Checking availability...</p>
    }
    
    if (isAvailable === true) {
      return <p className="text-sm text-green-600 mt-1">Username is available!</p>
    }
    
    if (isAvailable === false) {
      return <p className="text-sm text-red-600 mt-1">Username is already taken</p>
    }
    
    return null
  }

  const handleCheckExistingUsername = async () => {
    if (!currentIdentityId) return
    
    if (!isSdkReady) {
      toast.error('Service is initializing. Please try again in a moment.')
      return
    }
    
    setIsCheckingExisting(true)
    try {
      // Clear any cached DPNS data first
      dpnsService.clearCache(undefined, currentIdentityId)
      
      // Try to resolve the username
      const existingUsername = await dpnsService.resolveUsername(currentIdentityId)
      
      if (existingUsername) {
        toast.success(`Found username: ${existingUsername}!`)
        
        // Update the auth context with the username if it's the current user
        if (currentIdentityId === user?.identityId) {
          updateDPNSUsername(existingUsername)
        }
        
        onClose()
        
        // Redirect to home or profile creation (check new unified profile first, then old)
        const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
        const { profileService } = await import('@/lib/services/profile-service')
        let profile = await unifiedProfileService.getProfile(currentIdentityId, existingUsername)
        if (!profile) {
          profile = await profileService.getProfile(currentIdentityId, existingUsername)
        }

        if (profile) {
          router.push('/')
        } else {
          router.push('/profile/create')
        }
      } else {
        toast.error('No username found. Please register one above.')
      }
    } catch (error) {
      console.error('Failed to check for existing username:', error)
      toast.error('Failed to check for existing username')
    } finally {
      setIsCheckingExisting(false)
    }
  }

  const handleIdentityChange = () => {
    if (isEditingIdentity) {
      // Save the custom identity
      if (customIdentityId && customIdentityId !== user?.identityId) {
        // Validate it's a valid base58 string
        try {
          // Basic validation - check length and characters
          if (!/^[1-9A-HJ-NP-Za-km-z]{42,44}$/.test(customIdentityId)) {
            toast.error('Invalid identity ID format')
            return
          }
        } catch (error) {
          toast.error('Invalid identity ID')
          return
        }
      }
      setIsEditingIdentity(false)
    } else {
      setCustomIdentityId(currentIdentityId)
      setIsEditingIdentity(true)
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
          />
          
          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 flex items-center justify-center z-50 px-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-8 max-w-md w-full relative">
              {/* Close button */}
              <button
                onClick={onClose}
                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
              
              <h1 className="text-3xl font-bold text-center mb-2">Choose Your Username</h1>
              <p className="text-gray-600 dark:text-gray-400 text-center mb-6">
                Select a unique username for your Dash Platform identity
              </p>
              
              {/* Identity ID Display */}
              <div className="mb-6 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg">
                <label className="text-xs text-gray-500 uppercase tracking-wide">Identity ID</label>
                <div className="flex items-center gap-2 mt-1">
                  {isEditingIdentity ? (
                    <Input
                      type="text"
                      value={customIdentityId}
                      onChange={(e) => setCustomIdentityId(e.target.value)}
                      placeholder="Enter identity ID"
                      className="flex-1 font-mono text-sm"
                      autoFocus
                    />
                  ) : (
                    <span className="flex-1 font-mono text-sm break-all">
                      {currentIdentityId}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleIdentityChange}
                    className="shrink-0"
                  >
                    {isEditingIdentity ? (
                      'Save'
                    ) : (
                      <Edit2 className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              </div>
              
              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    DPNS Username
                  </label>
                  <div className="relative">
                    <Input
                      id="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value.toLowerCase())}
                      placeholder="johndoe"
                      className="pr-10"
                      autoComplete="off"
                      maxLength={20}
                    />
                    <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                      {getStatusIcon()}
                    </div>
                  </div>
                  {getStatusMessage()}
                  
                  <div className="mt-4 space-y-2 text-xs text-gray-500">
                    <p>Username requirements:</p>
                    <ul className="list-disc list-inside space-y-1 ml-2">
                      <li>3-20 characters long</li>
                      <li>Letters, numbers, and underscores only</li>
                      <li>Cannot start or end with underscore</li>
                      <li>No consecutive underscores</li>
                    </ul>
                  </div>
                </div>
                
                <Button 
                  type="submit" 
                  className="w-full" 
                  disabled={!username || !isAvailable || !!validationError || isChecking || isSubmitting || !currentIdentityId}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Registering Username...
                    </>
                  ) : (
                    'Register Username'
                  )}
                </Button>
              </form>
              
              <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                <p className="text-sm text-gray-600 dark:text-gray-400 text-center mb-3">
                  Already registered your username elsewhere?
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={handleCheckExistingUsername}
                  disabled={isCheckingExisting || !currentIdentityId}
                >
                  {isCheckingExisting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Checking for existing username...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      I just registered my username
                    </>
                  )}
                </Button>
                
                <button
                  type="button"
                  onClick={() => {
                    // Mark that user chose to skip DPNS registration
                    sessionStorage.setItem('yappr_skip_dpns', 'true')
                    onClose()
                    router.push('/profile/create')
                  }}
                  className="w-full mt-3 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                >
                  Skip for now
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}