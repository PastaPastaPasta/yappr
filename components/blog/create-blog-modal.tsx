'use client'

import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { useAuth } from '@/contexts/auth-context'
import { blogService } from '@/lib/services'
import type { Blog } from '@/lib/types'
import toast from 'react-hot-toast'

interface CreateBlogModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (blog: Blog) => void
}

export function CreateBlogModal({ open, onOpenChange, onCreated }: CreateBlogModalProps) {
  const { user } = useAuth()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState('')
  const [headerImage, setHeaderImage] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const handleSubmit = async () => {
    if (!user?.identityId || !name.trim()) return

    setIsSaving(true)
    try {
      const blog = await blogService.createBlog(user.identityId, {
        name: name.trim(),
        description: description.trim() || undefined,
        avatar: avatar || undefined,
        headerImage: headerImage || undefined,
      })

      toast.success('Blog created')
      onCreated?.(blog)
      onOpenChange(false)
      setName('')
      setDescription('')
      setAvatar('')
      setHeaderImage('')
    } catch (error) {
      toast.error('Failed to create blog')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-gray-800 bg-neutral-950 p-5">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold">Create Blog</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close dialog" className="rounded-full p-1 hover:bg-gray-800">
                <XMarkIcon className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-gray-300">Blog name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="My Blog" />
            </div>

            <div>
              <label className="mb-1 block text-sm text-gray-300">Description</label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={256} rows={3} placeholder="What this blog is about" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <ProfileImageUpload
                aspectRatio="square"
                label="Avatar"
                currentUrl={avatar || undefined}
                onUpload={setAvatar}
                onClear={() => setAvatar('')}
              />
              <ProfileImageUpload
                aspectRatio="banner"
                label="Header image"
                currentUrl={headerImage || undefined}
                onUpload={setHeaderImage}
                onClear={() => setHeaderImage('')}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={isSaving || !name.trim()}>
                {isSaving ? 'Creating...' : 'Create Blog'}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
