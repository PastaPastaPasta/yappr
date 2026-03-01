'use client'

import { useMemo, useState } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { blogPostService, blogService } from '@/lib/services'
import { downloadTextFile, labelsToCsv, parseLabels } from '@/lib/blog/content-utils'
import { generateBlogSitemap } from '@/lib/blog/sitemap-utils'
import type { Blog } from '@/lib/types'
import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'

interface BlogSettingsProps {
  blog: Blog
  ownerId: string
  username?: string
  onUpdated?: (blog: Blog) => void
}

export function BlogSettings({ blog, ownerId, username, onUpdated }: BlogSettingsProps) {
  const [name, setName] = useState(blog.name)
  const [description, setDescription] = useState(blog.description || '')
  const [avatar, setAvatar] = useState(blog.avatar || '')
  const [headerImage, setHeaderImage] = useState(blog.headerImage || '')
  const [commentsEnabledDefault, setCommentsEnabledDefault] = useState(Boolean(blog.commentsEnabledDefault))
  const [labels, setLabels] = useState(blog.labels || '')
  const [newLabel, setNewLabel] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isSavingLabels, setIsSavingLabels] = useState(false)
  const [isDownloadingSitemap, setIsDownloadingSitemap] = useState(false)

  const parsedLabels = useMemo(() => parseLabels(labels), [labels])

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const updated = await blogService.updateBlog(blog.id, ownerId, {
        name: name.trim(),
        description: description.trim() || undefined,
        avatar: avatar || undefined,
        headerImage: headerImage || undefined,
        labels: parsedLabels.join(',') || undefined,
        commentsEnabledDefault,
      })

      toast.success('Blog updated')
      onUpdated?.(updated)
    } catch {
      toast.error('Failed to update blog')
    } finally {
      setIsSaving(false)
    }
  }

  const persistLabels = async (nextLabels: string[]) => {
    setIsSavingLabels(true)
    const csv = labelsToCsv(nextLabels)
    setLabels(csv)

    try {
      const updated = await blogService.updateBlog(blog.id, ownerId, {
        labels: csv || undefined,
      })
      onUpdated?.(updated)
      toast.success('Labels updated')
    } catch (err) {
      logger.error('Failed to add label:', err)
      toast.error('Failed to update labels')
    } finally {
      setIsSavingLabels(false)
    }
  }

  const addLabel = async () => {
    const trimmed = newLabel.trim()
    if (!trimmed) return
    if (parsedLabels.includes(trimmed)) {
      setNewLabel('')
      return
    }

    await persistLabels([...parsedLabels, trimmed])
    setNewLabel('')
  }

  const removeLabel = async (label: string) => {
    await persistLabels(parsedLabels.filter((item) => item !== label))
  }

  const handleDownloadSitemap = async () => {
    setIsDownloadingSitemap(true)
    try {
      const posts = await blogPostService.getPostsByBlog(blog.id, { limit: 100 })
      const baseUrl = window.location.origin
      const fallbackUsername = new URLSearchParams(window.location.search).get('user') || 'blog'
      const xml = generateBlogSitemap(posts, blog, username || fallbackUsername, baseUrl)
      downloadTextFile(`${blog.name.toLowerCase().replace(/\s+/g, '-')}-sitemap.xml`, xml, 'application/xml')
      toast.success('Sitemap generated')
    } catch {
      toast.error('Failed to generate sitemap')
    } finally {
      setIsDownloadingSitemap(false)
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-gray-800 bg-neutral-950 p-4">
      <h2 className="text-lg font-semibold">Blog Settings</h2>

      <div>
        <label className="mb-1 block text-sm text-gray-300">Blog name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </div>

      <div>
        <label className="mb-1 block text-sm text-gray-300">Description</label>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={256} />
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

      <section className="space-y-3 rounded-lg border border-gray-800 p-3">
        <div>
          <h3 className="text-sm font-medium text-gray-200">Label Management</h3>
          <p className="text-xs text-gray-500">Manage blog taxonomy labels used for post filtering and selection.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {parsedLabels.length === 0 ? (
            <p className="text-xs text-gray-500">No labels yet.</p>
          ) : (
            parsedLabels.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => removeLabel(label)}
                aria-label={`Remove label: ${label}`}
                disabled={isSavingLabels}
                className="inline-flex items-center gap-1 rounded-full border border-gray-700 bg-gray-900 px-2.5 py-1 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50"
              >
                {label}
                <XMarkIcon className="h-3 w-3" />
              </button>
            ))
          )}
        </div>

        <div className="flex gap-2">
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            maxLength={40}
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

      <div className="flex items-center justify-between rounded-lg border border-gray-800 p-3">
        <div>
          <p className="text-sm font-medium">Comments enabled by default</p>
          <p className="text-xs text-gray-500">Applied when creating new posts.</p>
        </div>
        <Switch checked={commentsEnabledDefault} onCheckedChange={setCommentsEnabledDefault} />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={handleDownloadSitemap} disabled={isDownloadingSitemap}>
          {isDownloadingSitemap ? 'Generating sitemap...' : 'Download Sitemap'}
        </Button>
        <Button onClick={handleSave} disabled={isSaving || !name.trim()}>{isSaving ? 'Saving...' : 'Save settings'}</Button>
      </div>
    </div>
  )
}
