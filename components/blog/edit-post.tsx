'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { BLOG_POST_SIZE_LIMIT } from '@/lib/constants'
import { blogPostService } from '@/lib/services'
import type { BlogPost } from '@/lib/types'
import { BlogEditor } from './blog-editor'
import { getCompressedSize } from '@/lib/utils/compression'
import toast from 'react-hot-toast'

interface EditPostProps {
  postId: string
  ownerId: string
  onSaved?: (post: BlogPost) => void
}

export function EditPost({ postId, ownerId, onSaved }: EditPostProps) {
  const [post, setPost] = useState<BlogPost | null>(null)
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [coverImage, setCoverImage] = useState('')
  const [labels, setLabels] = useState('')
  const [commentsEnabled, setCommentsEnabled] = useState(true)
  const [blocks, setBlocks] = useState<unknown[]>([])
  const [loading, setLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [compressedBytes, setCompressedBytes] = useState(0)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const loaded = await blogPostService.getPost(postId)
        if (!loaded) return
        setPost(loaded)
        setTitle(loaded.title)
        setSubtitle(loaded.subtitle || '')
        setCoverImage(loaded.coverImage || '')
        setLabels(loaded.labels || '')
        setCommentsEnabled(Boolean(loaded.commentsEnabled ?? true))
        setBlocks(Array.isArray(loaded.content) ? loaded.content : [])
      } finally {
        setLoading(false)
      }
    }

    load().catch(() => setLoading(false))
  }, [postId])

  const handleSave = async () => {
    if (!post) return
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

    setIsSaving(true)
    try {
      const updated = await blogPostService.updatePost(post.id, ownerId, {
        title: title.trim(),
        subtitle: subtitle.trim() || undefined,
        coverImage: coverImage || undefined,
        labels: labels || undefined,
        commentsEnabled,
        content: blocks,
      })
      setPost(updated)
      toast.success('Post updated')
      onSaved?.(updated)
    } catch {
      toast.error('Failed to update post')
    } finally {
      setIsSaving(false)
    }
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading post...</p>
  }

  if (!post) {
    return <p className="text-sm text-gray-500">Post not found</p>
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
          className="!h-auto border-0 bg-transparent px-0 text-2xl font-bold text-white placeholder:text-gray-600 focus:ring-0"
        />
        <Textarea
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          maxLength={256}
          rows={1}
          placeholder="Add a subtitle..."
          className="mt-2 resize-none border-0 bg-transparent px-0 text-base text-gray-300 placeholder:text-gray-600 focus:ring-0"
        />
      </section>

      <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent" />

      {/* Cover image */}
      <section>
        <p className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-500">Cover image</p>
        <ProfileImageUpload
          aspectRatio="banner"
          label=""
          currentUrl={coverImage || undefined}
          onUpload={setCoverImage}
          onClear={() => setCoverImage('')}
        />
      </section>

      <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent" />

      {/* Labels */}
      <section>
        <p className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-500">Labels</p>
        <Input value={labels} onChange={(e) => setLabels(e.target.value)} maxLength={256} placeholder="tech, updates" className="h-9 text-sm" />
      </section>

      <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent" />

      {/* Editor */}
      <section>
        <BlogEditor initialBlocks={blocks} onChange={setBlocks} onBytesChange={setCompressedBytes} />
      </section>

      {/* Settings & Actions */}
      <div className="space-y-4 rounded-xl border border-gray-800/60 bg-gray-900/30 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Switch checked={commentsEnabled} onCheckedChange={setCommentsEnabled} />
            <span className="text-sm text-gray-400">Comments</span>
          </div>
          <p className="text-xs tabular-nums text-gray-600">{compressedBytes.toLocaleString()} / {BLOG_POST_SIZE_LIMIT.toLocaleString()} bytes</p>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isSaving || !title.trim()}>
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
