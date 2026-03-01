'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { ProfileImageUpload } from '@/components/ui/profile-image-upload'
import { BLOG_POST_SIZE_LIMIT } from '@/lib/constants'
import { blogPostService } from '@/lib/services'
import type { BlogPost } from '@/lib/types'
import { BlogEditor } from './blog-editor'
import { EditorFooter, SectionDivider, SectionHeading, heroTitleClassName, heroSubtitleClassName } from './editor-primitives'
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
        <Input value={labels} onChange={(e) => setLabels(e.target.value)} maxLength={256} placeholder="tech, updates" className="h-9 text-sm" />
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
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isSaving || !title.trim()}>
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </EditorFooter>
    </div>
  )
}
