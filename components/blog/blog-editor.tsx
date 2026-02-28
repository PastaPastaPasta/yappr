'use client'

import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import { PhotoIcon } from '@heroicons/react/24/outline'
import { BLOG_POST_SIZE_LIMIT } from '@/lib/constants'
import { getCompressedSize } from '@/lib/utils/compression'
import { useImageUpload } from '@/hooks/use-image-upload'

interface BlogEditorProps {
  initialBlocks?: unknown[]
  onChange: (blocks: unknown[]) => void
}

export function BlogEditor({ initialBlocks, onChange }: BlogEditorProps) {
  const editor = useCreateBlockNote({
    // Cast needed: BlockNote's internal types for initialContent are overly strict
    initialContent: (initialBlocks || undefined) as never,
  })

  const { upload, isUploading, progress, error, clearError } = useImageUpload()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [bytesUsed, setBytesUsed] = useState(0)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  const publishChange = useCallback(() => {
    const blocks = editor.document as unknown[]
    onChange(blocks)

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    debounceRef.current = setTimeout(() => {
      setBytesUsed(getCompressedSize(blocks))
    }, 500)
  }, [editor, onChange])

  const handleImageUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    clearError()

    try {
      const result = await upload(file)
      const ipfsUrl = `ipfs://${result.cid}`
      const cursor = editor.getTextCursorPosition()

      editor.insertBlocks(
        [
          {
            type: 'image',
            props: {
              url: ipfsUrl,
              caption: '',
              name: file.name,
            },
          } as never,
        ],
        cursor.block,
        'after'
      )
      publishChange()
    } catch {
      // Error is already captured by useImageUpload hook and displayed via error state
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }, [clearError, editor, publishChange, upload])

  useEffect(() => {
    setBytesUsed(getCompressedSize(editor.document as unknown[]))

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [editor])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-900/60 p-3">
        <div>
          <p className="text-sm font-medium text-gray-100">Editor</p>
          <p className="text-xs text-gray-400">{bytesUsed} / {BLOG_POST_SIZE_LIMIT} bytes used</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleImageUpload}
            disabled={isUploading}
          />
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-gray-600 px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-800 disabled:opacity-60"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            <PhotoIcon className="h-4 w-4" />
            {isUploading ? `Uploading ${progress}%` : 'Insert IPFS image'}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      <div className="rounded-xl border border-gray-700 bg-gray-900 p-2">
        <BlockNoteView
          editor={editor}
          theme="dark"
          onChange={publishChange}
          slashMenu={true}
          formattingToolbar={true}
        />
      </div>
    </div>
  )
}
