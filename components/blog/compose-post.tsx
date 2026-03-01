'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { XMarkIcon, Cog6ToothIcon, PhotoIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { isIpfsProtocol } from '@/lib/utils/ipfs-gateway'
import { BLOG_POST_SIZE_LIMIT } from '@/lib/constants'
import { blogPostService } from '@/lib/services'
import { getCompressedSize } from '@/lib/utils/compression'
import { labelsToCsv, parseLabels } from '@/lib/blog/content-utils'
import { useImageUpload } from '@/hooks/use-image-upload'
import type { Blog, BlogPost } from '@/lib/types'
import { BlogEditor } from './blog-editor'
import { useAuth } from '@/contexts/auth-context'
import { logger } from '@/lib/logger'
import toast from 'react-hot-toast'

interface ComposePostProps {
  blog: Blog
  onBack?: () => void
  onPublished?: (post: BlogPost) => void
  editPost?: BlogPost
  ownerId?: string
}

interface DraftData {
  title: string
  subtitle: string
  coverImage: string
  labels: string
  commentsEnabled: boolean
  blocks: unknown[]
}

export function ComposePost({ blog, onBack, onPublished, editPost, ownerId }: ComposePostProps) {
  const isEditing = Boolean(editPost)
  const { user } = useAuth()
  const [title, setTitle] = useState(editPost?.title ?? '')
  const [subtitle, setSubtitle] = useState(editPost?.subtitle ?? '')
  const [coverImage, setCoverImage] = useState(editPost?.coverImage ?? '')
  const [labels, setLabels] = useState(editPost?.labels ?? '')
  const [customLabel, setCustomLabel] = useState('')
  const [commentsEnabled, setCommentsEnabled] = useState(
    editPost ? Boolean(editPost.commentsEnabled ?? true) : Boolean(blog.commentsEnabledDefault ?? true)
  )
  const [blocks, setBlocks] = useState<unknown[]>(
    editPost && Array.isArray(editPost.content) ? editPost.content : []
  )
  const [isPublishing, setIsPublishing] = useState(false)
  const [compressedBytes, setCompressedBytes] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)

  const labelInputRef = useRef<HTMLInputElement>(null)
  const coverFileRef = useRef<HTMLInputElement>(null)
  const { upload: uploadImage, isUploading: isUploadingCover, progress: uploadProgress, isProviderConnected, checkProvider } = useImageUpload()

  useEffect(() => {
    checkProvider().catch(() => {})
  }, [checkProvider])

  const handleCoverFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file')
      if (coverFileRef.current) coverFileRef.current.value = ''
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be smaller than 5MB')
      if (coverFileRef.current) coverFileRef.current.value = ''
      return
    }

    try {
      const result = await uploadImage(file)
      setCoverImage(`ipfs://${result.cid}`)
    } catch {
      toast.error('Failed to upload cover image')
    }
    if (coverFileRef.current) coverFileRef.current.value = ''
  }, [uploadImage])

  const handleCoverClick = useCallback(() => {
    if (!isProviderConnected) {
      toast.error('Connect a storage provider in Settings to upload images')
      return
    }
    coverFileRef.current?.click()
  }, [isProviderConnected])

  const handleAddLabel = () => {
    setShowSettings(true)
    setTimeout(() => labelInputRef.current?.focus(), 100)
  }

  const availableLabels = useMemo(() => parseLabels(blog.labels), [blog.labels])
  const selectedLabels = useMemo(() => parseLabels(labels), [labels])

  const draftKey = useMemo(() => {
    if (!user?.identityId) return ''
    return `yappr:blog-draft:${user.identityId}:${blog.id}:new`
  }, [blog.id, user?.identityId])

  useEffect(() => {
    if (!draftKey || isEditing) return

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
  }, [draftKey, isEditing])

  useEffect(() => {
    if (!draftKey || isEditing) return

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
  }, [blocks, commentsEnabled, coverImage, draftKey, isEditing, labels, subtitle, title])

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

  const handleSubmit = async () => {
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
      if (isEditing && editPost && ownerId) {
        const updated = await blogPostService.updatePost(editPost.id, ownerId, {
          title: title.trim(),
          subtitle: subtitle.trim() || undefined,
          coverImage: coverImage || undefined,
          labels: labels || undefined,
          commentsEnabled,
          content: blocks,
        })
        toast.success('Post updated')
        onPublished?.(updated)
      } else {
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
      }
    } catch {
      toast.error(isEditing ? 'Failed to update post' : 'Failed to publish post')
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
          {draftSaved && !isEditing && (
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
            onClick={handleSubmit}
            disabled={isPublishing || !title.trim()}
          >
            {isPublishing
              ? (isEditing ? 'Saving...' : 'Publishing...')
              : (isEditing ? 'Save Changes' : 'Publish')}
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
                  ref={labelInputRef}
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

      {/* Hidden file input for cover image */}
      <input
        ref={coverFileRef}
        type="file"
        accept="image/*"
        onChange={handleCoverFileSelect}
        className="hidden"
      />

      {/* Writing canvas */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[640px] px-4 py-8">
          {/* Cover image banner */}
          {coverImage && (
            <div className="relative mb-6 aspect-[3/1] overflow-hidden rounded-lg">
              {isIpfsProtocol(coverImage) ? (
                <IpfsImage src={coverImage} alt="Cover" className="h-full w-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={coverImage} alt="Cover" className="h-full w-full object-cover" />
              )}
              <button
                type="button"
                onClick={() => setCoverImage('')}
                className="absolute right-2 top-2 rounded-full bg-black/50 p-1.5 transition-colors hover:bg-black/70"
                title="Remove cover image"
              >
                <XMarkIcon className="h-4 w-4 text-white" />
              </button>
            </div>
          )}

          {/* Title + cover image button */}
          <div className="flex items-start gap-2">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={128}
              placeholder="Title"
              className="min-w-0 flex-1 bg-transparent text-[32px] font-bold leading-tight text-white placeholder:text-gray-700 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCoverClick}
              disabled={isUploadingCover}
              className="mt-2 shrink-0 rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-800/60 hover:text-gray-400 disabled:opacity-50"
              title={coverImage ? 'Change cover image' : 'Add cover image'}
            >
              {isUploadingCover ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <PhotoIcon className="h-5 w-5" />
              )}
            </button>
          </div>

          {/* Upload progress */}
          {isUploadingCover && (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-gray-800/40">
              <div
                className="h-full bg-yappr-500 transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}

          {/* Subtitle */}
          <input
            type="text"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            maxLength={256}
            placeholder="Add a subtitle..."
            className="mt-3 w-full bg-transparent text-lg text-gray-400 placeholder:text-gray-700 focus:outline-none"
          />

          {/* Inline labels — always visible */}
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
              onClick={handleAddLabel}
              className="rounded-full bg-gray-800/30 px-2 py-0.5 text-xs text-gray-600 transition-colors hover:bg-gray-800/50 hover:text-gray-400"
            >
              +
            </button>
          </div>

          {/* Editor — the writing space */}
          <div className="compose-canvas mt-6">
            <BlogEditor initialBlocks={blocks} onChange={setBlocks} onBytesChange={setCompressedBytes} />
          </div>
        </div>
      </div>
    </div>
  )
}
