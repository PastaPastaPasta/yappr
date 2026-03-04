'use client'

import { logger } from '@/lib/logger';
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import {
  XMarkIcon,
  PencilIcon,
  TrashIcon,
  PlusIcon,
  CheckIcon,
  StarIcon
} from '@heroicons/react/24/outline'
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useSettingsStore } from '@/lib/store'
import toast from 'react-hot-toast'
import type { SavedAddress, ShippingAddress, BuyerContact } from '@/lib/types'

interface SavedAddressModalProps {
  isOpen: boolean
  onClose: () => void
  addresses: SavedAddress[]
  onAdd: (address: ShippingAddress, contact: BuyerContact, label: string) => Promise<void>
  onUpdate: (id: string, updates: Partial<Pick<SavedAddress, 'label' | 'address' | 'contact' | 'isDefault'>>) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onSetDefault: (id: string) => Promise<void>
}

type ModalMode = 'list' | 'add' | 'edit'

export function SavedAddressModal({
  isOpen,
  onClose,
  addresses,
  onAdd,
  onUpdate,
  onDelete,
  onSetDefault
}: SavedAddressModalProps) {
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [mode, setMode] = useState<ModalMode>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // Form state
  const [label, setLabel] = useState('')
  const [name, setName] = useState('')
  const [street, setStreet] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [country, setCountry] = useState('US')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')

  const resetForm = () => {
    setLabel('')
    setName('')
    setStreet('')
    setCity('')
    setState('')
    setPostalCode('')
    setCountry('US')
    setEmail('')
    setPhone('')
  }

  const loadAddress = (address: SavedAddress) => {
    setLabel(address.label)
    setName(address.address.name)
    setStreet(address.address.street)
    setCity(address.address.city)
    setState(address.address.state || '')
    setPostalCode(address.address.postalCode)
    setCountry(address.address.country)
    setEmail(address.contact.email || '')
    setPhone(address.contact.phone || '')
  }

  const handleClose = () => {
    setMode('list')
    setEditingId(null)
    resetForm()
    onClose()
  }

  const handleAdd = () => {
    resetForm()
    setMode('add')
  }

  const handleEdit = (address: SavedAddress) => {
    loadAddress(address)
    setEditingId(address.id)
    setMode('edit')
  }

  const handleBack = () => {
    setMode('list')
    setEditingId(null)
    resetForm()
  }

  const handleSubmit = async () => {
    if (!name || !street || !city || !postalCode || !country || !label) {
      toast.error('Please fill in all required fields')
      return
    }

    setIsSubmitting(true)
    try {
      const addressData: ShippingAddress = {
        name,
        street,
        city,
        state: state || undefined,
        postalCode,
        country
      }

      const contactData: BuyerContact = {
        email: email || undefined,
        phone: phone || undefined
      }

      if (mode === 'add') {
        await onAdd(addressData, contactData, label)
        toast.success('Address saved!')
      } else if (mode === 'edit' && editingId) {
        await onUpdate(editingId, {
          label,
          address: addressData,
          contact: contactData
        })
        toast.success('Address updated!')
      }

      handleBack()
    } catch (error) {
      logger.error('Failed to save address:', error)
      toast.error('Failed to save address')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirmId) return

    setIsSubmitting(true)
    try {
      await onDelete(deleteConfirmId)
      toast.success('Address deleted')
      setDeleteConfirmId(null)
    } catch (error) {
      logger.error('Failed to delete address:', error)
      toast.error('Failed to delete address')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSetDefault = async (id: string) => {
    try {
      await onSetDefault(id)
      toast.success('Default address updated')
    } catch (error) {
      logger.error('Failed to set default:', error)
      toast.error('Failed to update default address')
    }
  }

  const formatAddressPreview = (address: SavedAddress) => {
    const parts = [
      address.address.street,
      address.address.city,
      address.address.state,
      address.address.postalCode
    ].filter(Boolean)
    return parts.join(', ')
  }

  const renderList = () => (
    <>
      <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
        {addresses.length === 0 ? (
          <p className="text-center text-gray-500 py-8">
            No saved addresses yet
          </p>
        ) : (
          addresses.map((address) => (
            <div
              key={address.id}
              className="p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{address.label}</span>
                    {address.isDefault && (
                      <span className="text-xs px-1.5 py-0.5 bg-yappr-100 dark:bg-yappr-900/30 text-yappr-700 dark:text-yappr-300 rounded">
                        Default
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                    {address.address.name}
                  </p>
                  <p className="text-sm text-gray-500 truncate">
                    {formatAddressPreview(address)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    onClick={() => handleSetDefault(address.id)}
                    title={address.isDefault ? 'Default address' : 'Set as default'}
                    className={address.isDefault ? 'text-yellow-500' : ''}
                  >
                    {address.isDefault ? (
                      <StarIconSolid className="h-4 w-4" />
                    ) : (
                      <StarIcon className="h-4 w-4" />
                    )}
                  </IconButton>
                  <IconButton onClick={() => handleEdit(address)} title="Edit">
                    <PencilIcon className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    onClick={() => setDeleteConfirmId(address.id)}
                    title="Delete"
                    className="text-red-500 hover:text-red-600"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
        <Button variant="ghost" onClick={handleClose}>
          Close
        </Button>
        <Button onClick={handleAdd}>
          <PlusIcon className="h-4 w-4 mr-1.5" />
          Add Address
        </Button>
      </div>
    </>
  )

  const renderForm = () => (
    <>
      <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
        <div>
          <label className="block text-sm font-medium mb-1">Label *</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g., Home, Work"
            className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
          />
        </div>

        <div className="border-t border-gray-200 dark:border-gray-800 pt-4">
          <h4 className="font-medium mb-3">Shipping Address</h4>

          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Full Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Street Address *</label>
              <input
                type="text"
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">City *</label>
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">State/Province</label>
                <input
                  type="text"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Postal Code *</label>
                <input
                  type="text"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Country *</label>
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                >
                  <option value="US">United States</option>
                  <option value="CA">Canada</option>
                  <option value="GB">United Kingdom</option>
                  <option value="AU">Australia</option>
                  <option value="DE">Germany</option>
                  <option value="FR">France</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-gray-800 pt-4">
          <h4 className="font-medium mb-3">Contact Information</h4>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
        <Button variant="ghost" onClick={handleBack} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? (
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Saving...
            </span>
          ) : (
            <>
              <CheckIcon className="h-4 w-4 mr-1.5" />
              {mode === 'add' ? 'Save Address' : 'Update Address'}
            </>
          )}
        </Button>
      </div>
    </>
  )

  return (
    <>
      <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
        <AnimatePresence>
          {isOpen && (
            <Dialog.Portal forceMount>
              <Dialog.Overlay asChild>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className={`fixed inset-0 bg-black/60 z-50 flex items-center justify-center px-4 ${
                    potatoMode ? '' : 'backdrop-blur-sm'
                  }`}
                >
                  <Dialog.Content asChild>
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95, y: 20 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: 20 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      className="w-full max-w-md bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl overflow-hidden"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* Header */}
                      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                        <Dialog.Title className="font-semibold text-gray-900 dark:text-gray-100">
                          {mode === 'list' && 'Saved Addresses'}
                          {mode === 'add' && 'Add New Address'}
                          {mode === 'edit' && 'Edit Address'}
                        </Dialog.Title>
                        <IconButton onClick={handleClose}>
                          <XMarkIcon className="h-5 w-5" />
                        </IconButton>
                      </div>

                      {mode === 'list' && renderList()}
                      {(mode === 'add' || mode === 'edit') && renderForm()}
                    </motion.div>
                  </Dialog.Content>
                </motion.div>
              </Dialog.Overlay>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
        onConfirm={handleDelete}
        title="Delete Address"
        message="Are you sure you want to delete this saved address? This action cannot be undone."
        confirmText="Delete"
        variant="danger"
        isLoading={isSubmitting}
      />
    </>
  )
}
