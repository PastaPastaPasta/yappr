'use client'

import { useState, useEffect, useCallback } from 'react'
import { MapPinIcon, LockClosedIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { SavedAddressModal } from '@/components/checkout/saved-address-modal'
import { savedAddressService } from '@/lib/services/saved-address-service'
import { hasEncryptionKey, getEncryptionKeyBytes } from '@/lib/secure-storage'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import type { SavedAddress, ShippingAddress, BuyerContact } from '@/lib/types'

export function SavedAddressesSettings() {
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()

  const [addresses, setAddresses] = useState<SavedAddress[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [userHasEncryptionKey, setUserHasEncryptionKey] = useState(false)
  const [userEncryptionPubKey, setUserEncryptionPubKey] = useState<Uint8Array | null>(null)

  const loadAddresses = useCallback(async () => {
    if (!sdkReady || !user?.identityId) return

    try {
      setIsLoading(true)

      // Check if user has encryption key
      const hasKey = hasEncryptionKey(user.identityId)
      setUserHasEncryptionKey(hasKey)

      if (!hasKey) {
        setAddresses([])
        return
      }

      // Get user's encryption public key
      const pubKey = await savedAddressService.getUserEncryptionPublicKey(user.identityId)
      if (pubKey) {
        setUserEncryptionPubKey(pubKey)
      }

      // Get user's encryption private key
      const privKey = getEncryptionKeyBytes(user.identityId)
      if (!privKey) {
        setAddresses([])
        return
      }

      // Load and decrypt saved addresses
      const loadedAddresses = await savedAddressService.getDecryptedAddresses(user.identityId, privKey)
      setAddresses(loadedAddresses)
    } catch (error) {
      console.error('Failed to load saved addresses:', error)
      setAddresses([])
    } finally {
      setIsLoading(false)
    }
  }, [sdkReady, user?.identityId])

  useEffect(() => {
    loadAddresses().catch(console.error)
  }, [loadAddresses])

  const handleAdd = async (address: ShippingAddress, contact: BuyerContact, label: string) => {
    if (!user?.identityId || !userEncryptionPubKey) return

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

    setAddresses((prev) => [...prev, newAddress])
  }

  const handleUpdate = async (
    id: string,
    updates: Partial<Pick<SavedAddress, 'label' | 'address' | 'contact' | 'isDefault'>>
  ) => {
    if (!user?.identityId || !userEncryptionPubKey) return

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
      setAddresses((prev) =>
        prev.map((a) => (a.id === id ? updated : updates.isDefault ? { ...a, isDefault: false } : a))
      )
    }
  }

  const handleDelete = async (id: string) => {
    if (!user?.identityId || !userEncryptionPubKey) return

    const privKey = getEncryptionKeyBytes(user.identityId)
    if (!privKey) throw new Error('Encryption key not found')

    await savedAddressService.removeAddress(user.identityId, id, userEncryptionPubKey, privKey)
    setAddresses((prev) => prev.filter((a) => a.id !== id))
  }

  const handleSetDefault = async (id: string) => {
    if (!user?.identityId || !userEncryptionPubKey) return

    const privKey = getEncryptionKeyBytes(user.identityId)
    if (!privKey) throw new Error('Encryption key not found')

    await savedAddressService.setDefault(user.identityId, id, userEncryptionPubKey, privKey)
    setAddresses((prev) => prev.map((a) => ({ ...a, isDefault: a.id === id })))
  }

  if (isLoading) {
    return (
      <div>
        <h3 className="font-semibold mb-4">Saved Shipping Addresses</h3>
        <div className="flex items-center justify-center py-6">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-yappr-500" />
        </div>
      </div>
    )
  }

  if (!userHasEncryptionKey) {
    return (
      <div>
        <h3 className="font-semibold mb-4">Saved Shipping Addresses</h3>
        <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <LockClosedIcon className="h-5 w-5 text-gray-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                To save shipping addresses securely, you need to set up an encryption key.
                Your addresses will be encrypted so only you can access them.
              </p>
              <p className="text-sm text-gray-500 mt-2">
                You can add an encryption key in the Privacy &amp; Security section above.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h3 className="font-semibold mb-4">Saved Shipping Addresses</h3>
      <div className="space-y-3">
        {addresses.length === 0 ? (
          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <MapPinIcon className="h-5 w-5 text-gray-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  No saved addresses yet. Save an address during checkout for faster ordering.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4">
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
              {addresses.length} saved {addresses.length === 1 ? 'address' : 'addresses'}
            </p>
            <ul className="space-y-2">
              {addresses.map((address) => (
                <li
                  key={address.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="font-medium">{address.label}</span>
                  {address.isDefault && (
                    <span className="text-xs px-1.5 py-0.5 bg-yappr-100 dark:bg-yappr-900/30 text-yappr-700 dark:text-yappr-300 rounded">
                      Default
                    </span>
                  )}
                  <span className="text-gray-500 truncate">
                    - {address.address.city}, {address.address.country}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => setShowModal(true)}
        >
          <MapPinIcon className="h-4 w-4 mr-2" />
          Manage Saved Addresses
        </Button>
      </div>

      <SavedAddressModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        addresses={addresses}
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        onSetDefault={handleSetDefault}
      />
    </div>
  )
}
