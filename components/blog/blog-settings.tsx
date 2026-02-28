'use client'

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { blogService } from '@/lib/services'
import type { Blog } from '@/lib/types'
import toast from 'react-hot-toast'
import { ThemeEditor } from './theme-editor'

interface BlogSettingsProps {
  blog: Blog
  ownerId: string
  onUpdated?: (blog: Blog) => void
}

export function BlogSettings({ blog, ownerId, onUpdated }: BlogSettingsProps) {
  const [name, setName] = useState(blog.name)
  const [description, setDescription] = useState(blog.description || '')
  const [avatar, setAvatar] = useState(blog.avatar || '')
  const [headerImage, setHeaderImage] = useState(blog.headerImage || '')
  const [commentsEnabledDefault, setCommentsEnabledDefault] = useState(Boolean(blog.commentsEnabledDefault))
  const [labels, setLabels] = useState(blog.labels || '')
  const [isSaving, setIsSaving] = useState(false)
  const [isSavingTheme, setIsSavingTheme] = useState(false)

  const parsedLabels = useMemo(
    () => labels.split(',').map((item) => item.trim()).filter(Boolean),
    [labels]
  )

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

  const handleThemeSave = async (themeConfig: string) => {
    setIsSavingTheme(true)
    try {
      const updated = await blogService.updateBlog(blog.id, ownerId, {
        themeConfig,
      })
      toast.success('Theme updated')
      onUpdated?.(updated)
    } catch {
      toast.error('Failed to update theme')
    } finally {
      setIsSavingTheme(false)
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

      <div>
        <label className="mb-1 block text-sm text-gray-300">Labels</label>
        <Input
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
          maxLength={1024}
          placeholder="tech, web3, tutorial"
        />
        <p className="mt-1 text-xs text-gray-500">Comma-separated taxonomy for post labels.</p>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-gray-800 p-3">
        <div>
          <p className="text-sm font-medium">Comments enabled by default</p>
          <p className="text-xs text-gray-500">Applied when creating new posts.</p>
        </div>
        <Switch checked={commentsEnabledDefault} onCheckedChange={setCommentsEnabledDefault} />
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving || !name.trim()}>{isSaving ? 'Saving...' : 'Save settings'}</Button>
      </div>

      <div className={isSavingTheme ? 'opacity-75 pointer-events-none' : ''}>
        <ThemeEditor
          key={`${blog.id}:${blog.themeConfig || 'default'}`}
          initialThemeConfig={blog.themeConfig}
          blogName={name || blog.name}
          blogDescription={description || blog.description}
          onSave={handleThemeSave}
        />
      </div>
    </div>
  )
}
