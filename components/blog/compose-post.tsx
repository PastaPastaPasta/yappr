'use client'

import { useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { BLOG_POST_SIZE_LIMIT } from '@/lib/constants'
import { blogPostService } from '@/lib/services'
import { getCompressedSize } from '@/lib/utils/compression'
import { labelsToCsv, parseLabels } from '@/lib/blog/content-utils'
import type { Blog, BlogPost } from '@/lib/types'
import { BlogEditor } from './blog-editor'
import { useAuth } from '@/contexts/auth-context'
import toast from 'react-hot-toast'

interface ComposePostProps {
  blog: Blog
  onPublished?: (post: BlogPost) => void
}

interface DraftData {
  title: string
  subtitle: string
  coverImage: string
  labels: string
  commentsEnabled: boolean
  blocks: unknown[]
}

export function ComposePost({ blog, onPublished }: ComposePostProps) {
  const { user } = useAuth()
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [coverImage, setCoverImage] = useState('')
  const [labels, setLabels] = useState('')
  const [customLabel, setCustomLabel] = useState('')
  const [commentsEnabled, setCommentsEnabled] = useState(Boolean(blog.commentsEnabledDefault ?? true))
  const [blocks, setBlocks] = useState<unknown[]>([])
  const [isPublishing, setIsPublishing] = useState(false)
  const [compressedBytes, setCompressedBytes] = useState(0)

  const availableLabels = useMemo(() => parseLabels(blog.labels), [blog.labels])
  const selectedLabels = useMemo(() => parseLabels(labels), [labels])

  const draftKey = useMemo(() => {
    if (!user?.identityId) return ''
    return `yappr:blog-draft:${user.identityId}:${blog.id}:new`
  }, [blog.id, user?.identityId])

  useEffect(() => {
    if (!draftKey) return

    const raw = localStorage.getItem(draftKey)
    if (!raw) return

    try {
      const parsed = JSON.parse(raw) as DraftData
      setTitle(parsed.title || '')
      setSubtitle(parsed.subtitle || '')
      setCoverImage(parsed.coverImage || '')
      setLabels(parsed.labels || '')
      setCommentsEnabled(parsed.commentsEnabled)
      setBlocks(Array.isArray(parsed.blocks) ? parsed.blocks : [])
    } catch {
      // Ignore invalid drafts
    }
  }, [draftKey])

  useEffect(() => {
    if (!draftKey) return

    const timeout = setTimeout(() => {
      const draft: DraftData = {
        title,
        subtitle,
        coverImage,
        labels,
        commentsEnabled,
        blocks,
      }
      try {
        localStorage.setItem(draftKey, JSON.stringify(draft))
      } catch {
        // Local storage can fail in private mode or when quota is exceeded.
      }
    }, 700)

    return () => clearTimeout(timeout)
  }, [blocks, commentsEnabled, coverImage, draftKey, labels, subtitle, title])

  const saveDraft = () => {
    if (!draftKey) return
    const draft: DraftData = { title, subtitle, coverImage, labels, commentsEnabled, blocks }
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft))
      toast.success('Draft saved locally')
    } catch {
      toast.error('Failed to save draft')
    }
  }

  const toggleLabel = (label: string) => {
    if (selectedLabels.includes(label)) {
      setLabels(labelsToCsv(selectedLabels.filter((item) => item !== label)))
      return
    }
    setLabels(labelsToCsv([...selectedLabels, label]))
  }

  const addCustomLabel = () => {
    const trimmed = customLabel.trim()
    if (!trimmed) return
    setLabels(labelsToCsv([...selectedLabels, trimmed]))
    setCustomLabel('')
  }

  const handlePublish = async () => {
    if (!user?.identityId) return
    if (!title.trim()) {
      toast.error('Title is required')
      return
    }
    const estimatedBytes = (() => {
      try {
        return getCompressedSize(blocks)
      } catch {
        return BLOG_POST_SIZE_LIMIT + 1
      }
    })()

    if (estimatedBytes > BLOG_POST_SIZE_LIMIT) {
      toast.error('Post is too large after compression')
      return
    }

    setIsPublishing(true)
    try {
      const created = await blogPostService.createPost(user.identityId, {
        blogId: blog.id,
        title: title.trim(),
        subtitle: subtitle.trim() || undefined,
        content: blocks,
        coverImage: coverImage || undefined,
        labels: labels || undefined,
        commentsEnabled,
      })

      if (draftKey) {
        localStorage.removeItem(draftKey)
      }
      toast.success('Post published')
      onPublished?.(created)
      setTitle('')
      setSubtitle('')
      setCoverImage('')
      setLabels('')
      setCustomLabel('')
      setBlocks([])
      setCommentsEnabled(Boolean(blog.commentsEnabledDefault ?? true))
    } catch {
      toast.error('Failed to publish post')
    } finally {
      setIsPublishing(false)
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-gray-800 bg-neutral-950 p-4">
      <h2 className="text-lg font-semibold">Compose Post</h2>

      <div>
        <label className="mb-1 block text-sm text-gray-300">Title</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={128} required />
      </div>

      <div>
        <label className="mb-1 block text-sm text-gray-300">Subtitle</label>
        <Textarea value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={256} rows={2} />
      </div>

      <ProfileImageUpload
        aspectRatio="banner"
        label="Cover image"
        currentUrl={coverImage || undefined}
        onUpload={setCoverImage}
        onClear={() => setCoverImage('')}
      />

      <div className="space-y-2">
        <label className="mb-1 block text-sm text-gray-300">Labels</label>

        {availableLabels.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {availableLabels.map((label) => {
              const selected = selectedLabels.includes(label)
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleLabel(label)}
                  aria-pressed={selected}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    selected
                      ? 'border-cyan-400/40 bg-cyan-400/20 text-cyan-100'
                      : 'border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}

        <div className="flex gap-2">
          <Input
            value={customLabel}
            onChange={(e) => setCustomLabel(e.target.value)}
            maxLength={40}
            placeholder="Custom label"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addCustomLabel()
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addCustomLabel} disabled={!customLabel.trim()}>
            Add
          </Button>
        </div>

        {selectedLabels.length > 0 && (
          <p className="text-xs text-gray-500">Selected: {selectedLabels.join(', ')}</p>
        )}
      </div>

      <div className="flex items-center justify-between rounded-lg border border-gray-800 p-3">
        <div>
          <p className="text-sm font-medium">Comments enabled</p>
          <p className="text-xs text-gray-500">Toggle comments for this post.</p>
        </div>
        <Switch checked={commentsEnabled} onCheckedChange={setCommentsEnabled} />
      </div>

      <BlogEditor initialBlocks={blocks} onChange={setBlocks} onBytesChange={setCompressedBytes} />

      <p className="text-xs text-gray-500">{compressedBytes} / {BLOG_POST_SIZE_LIMIT} bytes used</p>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={saveDraft}>Save Draft</Button>
        <Button onClick={handlePublish} disabled={isPublishing || !title.trim()}>
          {isPublishing ? 'Publishing...' : 'Publish'}
        </Button>
      </div>
    </div>
  )
}
