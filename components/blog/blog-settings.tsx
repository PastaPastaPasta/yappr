'use client'

import { fieldLimits } from '@/lib/field-limits'
import { LimitedInput, LimitedTextarea } from '@/components/ui/limited-text'

import { useState } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { blogIsV9 } from '@/lib/constants'
import { Switch } from '@/components/ui/switch'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { blogService } from '@/lib/services'
import { BlogFieldError, LABEL_LIMITS, blogCommentsDefault, labelProblem } from '@/lib/blog/content-utils'
import { ListLimitError } from '@/lib/typed-array-codecs'
import type { Blog } from '@/lib/types'
import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'
import { reportModerationRefusal } from '@/components/moderation/barred-writer-notice'

interface BlogSettingsProps {
  blog: Blog
  ownerId: string
  onUpdated?: (blog: Blog) => void
  onDeleted: () => void
}

export function BlogSettings({ blog, ownerId, onUpdated, onDeleted }: BlogSettingsProps) {
  const [name, setName] = useState(blog.name)
  const [description, setDescription] = useState(blog.description || '')
  const [avatar, setAvatar] = useState(blog.avatar || '')
  const [headerImage, setHeaderImage] = useState(blog.headerImage || '')
  const [commentsEnabledDefault, setCommentsEnabledDefault] = useState(blogCommentsDefault(blog))
  const [labels, setLabels] = useState<string[]>(blog.labels ?? [])
  const [newLabel, setNewLabel] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isSavingLabels, setIsSavingLabels] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      if (!await blogService.deleteBlog(blog.id, ownerId)) throw new Error('Delete refused')
      toast.success('Blog deleted')
      onDeleted()
    } catch (err) {
      if (!reportModerationRefusal(err, ownerId, 'blog')) toast.error('Failed to delete blog. Please try again.')
    } finally {
      setIsDeleting(false)
    }
  }


  const handleSave = async () => {
    setIsSaving(true)
    try {
      const updated = await blogService.updateBlog(blog.id, ownerId, {
        name: name.trim(),
        description: description.trim() || undefined,
        avatar: avatar || undefined,
        headerImage: headerImage || undefined,
        labels: labels.length > 0 ? labels : undefined,
        commentsEnabledDefault,
      })

      toast.success('Blog updated')
      onUpdated?.(updated)
    } catch (err) {
      if (!reportModerationRefusal(err, ownerId, 'blog')) toast.error(err instanceof ListLimitError || err instanceof BlogFieldError ? err.message : 'Failed to update blog')
    } finally {
      setIsSaving(false)
    }
  }

  const persistLabels = async (nextLabels: string[]) => {
    setIsSavingLabels(true)
    const previous = labels
    setLabels(nextLabels)

    try {
      const updated = await blogService.updateBlog(blog.id, ownerId, {
        labels: nextLabels.length > 0 ? nextLabels : undefined,
      })
      onUpdated?.(updated)
      toast.success('Labels updated')
    } catch (err) {
      setLabels(previous)
      logger.error('Failed to add label:', err)
      if (!reportModerationRefusal(err, ownerId, 'blog')) toast.error(err instanceof ListLimitError ? err.message : 'Failed to update labels')
    } finally {
      setIsSavingLabels(false)
    }
  }

  const addLabel = async () => {
    const trimmed = newLabel.trim()
    if (!trimmed) return
    if (labels.includes(trimmed)) {
      setNewLabel('')
      return
    }
    if (labels.length >= LABEL_LIMITS.blog) {
      toast.error(`A blog can have at most ${LABEL_LIMITS.blog} labels. Remove one first.`)
      return
    }
    const problem = labelProblem(trimmed)
    if (problem) {
      toast.error(problem)
      return
    }

    await persistLabels([...labels, trimmed])
    setNewLabel('')
  }

  const removeLabel = async (label: string) => {
    await persistLabels(labels.filter((item) => item !== label))
  }

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-950 p-4">
      <h2 className="text-lg font-semibold">Blog Settings</h2>

      <div>
        <label className="mb-1 block text-sm text-gray-700 dark:text-gray-300">Blog name</label>
        <LimitedInput contract="blog" document="blog" field="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div>
        <label className="mb-1 block text-sm text-gray-700 dark:text-gray-300">Description</label>
        <LimitedTextarea contract="blog" document="blog" field="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ProfileImageUpload urlLimits={fieldLimits('blog', 'blog', 'avatar')}
          aspectRatio="square"
          label="Avatar"
          currentUrl={avatar || undefined}
          onUpload={setAvatar}
          onClear={() => setAvatar('')}
        />
        <ProfileImageUpload urlLimits={fieldLimits('blog', 'blog', 'headerImage')}
          aspectRatio="banner"
          label="Header image"
          currentUrl={headerImage || undefined}
          onUpload={setHeaderImage}
          onClear={() => setHeaderImage('')}
        />
      </div>

      <section className="space-y-3 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
        <div>
          <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">Label Management</h3>
          <p className="text-xs text-gray-500">Organize your posts with labels.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {labels.length === 0 ? (
            <p className="text-xs text-gray-500">No labels yet.</p>
          ) : (
            labels.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => removeLabel(label)}
                aria-label={`Remove label: ${label}`}
                disabled={isSavingLabels}
                className="inline-flex items-center gap-1 rounded-full border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 px-2.5 py-1 text-xs text-gray-800 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                {label}
                <XMarkIcon className="h-3 w-3" />
              </button>
            ))
          )}
        </div>

        <div className="flex gap-2">
          <LimitedInput contract="blog" document="blog" field="labels[]"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Add new label"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addLabel().catch((err) => logger.error('Failed to add label:', err))
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => addLabel().catch((err) => logger.error('Failed to add label:', err))}
            disabled={isSavingLabels || !newLabel.trim()}
          >
            Add
          </Button>
        </div>
      </section>

      <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-800 p-3">
        <div>
          <p className="text-sm font-medium">Comments enabled by default</p>
          <p className="text-xs text-gray-500">Applied when creating new posts.</p>
        </div>
        <Switch checked={commentsEnabledDefault} onCheckedChange={setCommentsEnabledDefault} />
      </div>

      {blogIsV9() && (
        <div className="border-t border-gray-200 pt-4 dark:border-gray-800">
          <Button variant="destructive" onClick={() => setConfirmDelete(true)} disabled={isSaving || isSavingLabels}>
            Delete blog
          </Button>
          <ConfirmDialog
            isOpen={confirmDelete}
            onClose={() => { if (!isDeleting) setConfirmDelete(false) }}
            onConfirm={handleDelete}
            title="Delete blog"
            message={`Delete “${blog.name}”? Its posts will stop showing on the blog page and in discovery. The posts stay stored. This cannot be undone.`}
            confirmText="Delete blog"
            variant="danger"
            isLoading={isDeleting}
          />
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving || !name.trim()}>{isSaving ? 'Saving...' : 'Save settings'}</Button>
      </div>
    </div>
  )
}
