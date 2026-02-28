'use client'

import { useEffect, useMemo, useState } from 'react'
import { XMarkIcon, Cog6ToothIcon } from '@heroicons/react/24/outline'
import { Input } from '@/components/ui/input'
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
import { logger } from '@/lib/logger'
import toast from 'react-hot-toast'

interface ComposePostProps {
  blog: Blog
  onBack?: () => void
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

export function ComposePost({ blog, onBack, onPublished }: ComposePostProps) {
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
  const [showSettings, setShowSettings] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)

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

    setDraftSaved(false)
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
        setDraftSaved(true)
      } catch (err) {
        logger.warn('Auto-save draft failed:', err)
      }
    }, 700)

    return () => clearTimeout(timeout)
  }, [blocks, commentsEnabled, coverImage, draftKey, labels, subtitle, title])

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
    if (selectedLabels.includes(trimmed)) {
      setCustomLabel('')
      return
    }
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
    <div className="flex min-h-0 flex-col">
      {/* Compose top bar */}
      <div className="flex items-center justify-between border-b border-gray-800/40 px-4 py-2.5">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-sm text-gray-500 transition-colors hover:text-gray-300"
            >
              &larr;
            </button>
          )}
          {draftSaved && (
            <span className="flex items-center gap-1.5 text-xs text-gray-600">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500/70" />
              Saved
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((prev) => !prev)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-800/60 hover:text-gray-300"
          >
            <Cog6ToothIcon className="h-3.5 w-3.5" />
            Settings
          </button>
          <Button
            size="sm"
            onClick={handlePublish}
            disabled={isPublishing || !title.trim()}
          >
            {isPublishing ? 'Publishing...' : 'Publish'}
          </Button>
        </div>
      </div>

      {/* Settings panel — collapsible */}
      {showSettings && (
        <div className="border-b border-gray-800/40 bg-gray-900/20 px-4 py-4">
          <div className="mx-auto max-w-[640px] space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-300">Post settings</p>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="rounded p-1 text-gray-500 transition-colors hover:text-gray-300"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>

            <ProfileImageUpload
              aspectRatio="banner"
              label="Cover image"
              currentUrl={coverImage || undefined}
              onUpload={setCoverImage}
              onClear={() => setCoverImage('')}
            />

            {/* Labels */}
            <div>
              <p className="mb-2 text-xs text-gray-500">Labels</p>
              {(availableLabels.length > 0 || selectedLabels.length > 0) && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {availableLabels.map((label) => {
                    const selected = selectedLabels.includes(label)
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => toggleLabel(label)}
                        aria-pressed={selected}
                        className={`rounded-full px-2.5 py-0.5 text-xs transition-all ${
                          selected
                            ? 'bg-yappr-500/20 text-yappr-300 ring-1 ring-yappr-500/40'
                            : 'bg-gray-800/60 text-gray-400 hover:bg-gray-800 hover:text-gray-300'
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
                  placeholder="Add a label..."
                  className="h-8 text-xs"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addCustomLabel()
                    }
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={addCustomLabel} disabled={!customLabel.trim()}>
                  Add
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Switch checked={commentsEnabled} onCheckedChange={setCommentsEnabled} />
                <span className="text-xs text-gray-400">Allow comments</span>
              </div>
              <span className="text-xs tabular-nums text-gray-600">
                {compressedBytes.toLocaleString()} / {BLOG_POST_SIZE_LIMIT.toLocaleString()} bytes
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Writing canvas */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[640px] px-4 py-8">
          {/* Title */}
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={128}
            placeholder="Title"
            className="w-full bg-transparent text-[32px] font-bold leading-tight text-white placeholder:text-gray-700 focus:outline-none"
          />

          {/* Subtitle */}
          <input
            type="text"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            maxLength={256}
            placeholder="Add a subtitle..."
            className="mt-3 w-full bg-transparent text-lg text-gray-400 placeholder:text-gray-700 focus:outline-none"
          />

          {/* Inline labels */}
          {selectedLabels.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              {selectedLabels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1 rounded-full bg-gray-800/50 px-2.5 py-0.5 text-xs text-gray-400"
                >
                  {label}
                  <button
                    type="button"
                    onClick={() => toggleLabel(label)}
                    className="text-gray-600 hover:text-gray-300"
                  >
                    <XMarkIcon className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                aria-label="Add labels"
                onClick={() => setShowSettings(true)}
                className="rounded-full bg-gray-800/30 px-2 py-0.5 text-xs text-gray-600 transition-colors hover:text-gray-400"
              >
                +
              </button>
            </div>
          )}

          {/* Editor — the writing space */}
          <div className="compose-canvas mt-6">
            <BlogEditor initialBlocks={blocks} onChange={setBlocks} onBytesChange={setCompressedBytes} />
          </div>
        </div>
      </div>
    </div>
  )
}
