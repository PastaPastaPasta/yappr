'use client'

import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { SuggestionMenuController } from '@blocknote/react'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import { PhotoIcon } from '@heroicons/react/24/outline'
import { BLOG_POST_SIZE_LIMIT } from '@/lib/constants'
import { getCompressedSize } from '@/lib/utils/compression'
import { useImageUpload } from '@/hooks/use-image-upload'
import { blogBlockNoteSchema, getBlogSlashMenuItems } from './blocknote-schema'

interface BlogEditorProps {
  initialBlocks?: unknown[]
  onChange: (blocks: unknown[]) => void
  onBytesChange?: (bytes: number) => void
}

export function BlogEditor({ initialBlocks, onChange, onBytesChange }: BlogEditorProps) {
  const editor = useCreateBlockNote({
    schema: blogBlockNoteSchema,
    initialContent: (initialBlocks?.length ? initialBlocks : undefined) as never,
  })

  const { upload, isUploading, progress, error, clearError } = useImageUpload()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [bytesUsed, setBytesUsed] = useState(0)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  const reportBytes = useCallback((nextBytes: number) => {
    setBytesUsed(nextBytes)
    onBytesChange?.(nextBytes)
  }, [onBytesChange])

  const publishChange = useCallback(() => {
    const blocks = editor.document as unknown[]
    onChange(blocks)

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    debounceRef.current = setTimeout(() => {
      reportBytes(getCompressedSize(blocks))
    }, 500)
  }, [editor, onChange, reportBytes])

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
      // Error state is already set by useImageUpload hook and displayed in the UI.
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }, [clearError, editor, publishChange, upload])

  useEffect(() => {
    reportBytes(getCompressedSize(editor.document as unknown[]))

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [editor, reportBytes])

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
          slashMenu={false}
          formattingToolbar={true}
        >
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) => getBlogSlashMenuItems(editor, query)}
          />
        </BlockNoteView>
      </div>
    </div>
  )
}
