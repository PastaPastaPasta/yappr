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
    <div className="space-y-4 rounded-xl border border-gray-800 bg-neutral-950 p-4">
      <h2 className="text-lg font-semibold">Edit Post</h2>

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

      <div>
        <label className="mb-1 block text-sm text-gray-300">Labels</label>
        <Input value={labels} onChange={(e) => setLabels(e.target.value)} maxLength={256} placeholder="tech, updates" />
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

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving || !title.trim()}>
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </div>
  )
}
