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
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Content</p>
        <div className="flex items-center gap-3">
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
            className="inline-flex items-center gap-1.5 rounded-full bg-gray-800/60 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-300 disabled:opacity-50"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            <PhotoIcon className="h-3.5 w-3.5" />
            {isUploading ? `${progress}%` : 'Image'}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      <div className="rounded-xl border border-gray-800/60 bg-gray-900/40 p-3">
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
