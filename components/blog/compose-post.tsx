'use client'

import { useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { BLOG_POST_SIZE_LIMIT } from '@/lib/constants'
import { blogPostService } from '@/lib/services'
import { getCompressedSize } from '@/lib/utils/compression'
import { labelsToCsv, parseLabels } from '@/lib/blog/content-utils'
import type { Blog, BlogPost } from '@/lib/types'
import { BlogEditor } from './blog-editor'
import { EditorFooter, SectionDivider, SectionHeading, heroTitleClassName, heroSubtitleClassName } from './editor-primitives'
import { useAuth } from '@/contexts/auth-context'
import { logger } from '@/lib/logger'
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
      } catch (err) {
        // Local storage can fail in private mode or when quota is exceeded.
        logger.warn('Auto-save draft failed:', err)
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
    <div className="space-y-6">
      {/* Title & Subtitle */}
      <section>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={128}
          required
          placeholder="Post title"
          className={heroTitleClassName}
        />
        <Textarea
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          maxLength={256}
          rows={1}
          placeholder="Add a subtitle..."
          className={heroSubtitleClassName}
        />
      </section>

      <SectionDivider />

      {/* Cover image */}
      <section>
        <SectionHeading>Cover image</SectionHeading>
        <ProfileImageUpload
          aspectRatio="banner"
          label=""
          currentUrl={coverImage || undefined}
          onUpload={setCoverImage}
          onClear={() => setCoverImage('')}
        />
      </section>

      <SectionDivider />

      {/* Labels */}
      <section>
        <SectionHeading>Labels</SectionHeading>

        {(availableLabels.length > 0 || selectedLabels.length > 0) && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {availableLabels.map((label) => {
              const selected = selectedLabels.includes(label)
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleLabel(label)}
                  aria-pressed={selected}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
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
            className="h-9 text-sm"
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
      </section>

      <SectionDivider />

      {/* Editor */}
      <section>
        <BlogEditor initialBlocks={blocks} onChange={setBlocks} onBytesChange={setCompressedBytes} />
      </section>

      <EditorFooter
        commentsEnabled={commentsEnabled}
        onCommentsChange={setCommentsEnabled}
        compressedBytes={compressedBytes}
      >
        <div className="flex items-center justify-end gap-3">
          <Button variant="ghost" onClick={saveDraft} className="text-gray-400 hover:text-white">
            Save Draft
          </Button>
          <Button onClick={handlePublish} disabled={isPublishing || !title.trim()}>
            {isPublishing ? 'Publishing...' : 'Publish'}
          </Button>
        </div>
      </EditorFooter>
    </div>
  )
}
