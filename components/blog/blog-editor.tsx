'use client'

import { type ChangeEvent, useCallback, useEffect, useRef } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { SuggestionMenuController } from '@blocknote/react'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
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

  const { upload, isUploading, error, clearError } = useImageUpload()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  const reportBytes = useCallback((nextBytes: number) => {
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
    <div>
      {/* Hidden file input for image uploads */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageUpload}
        disabled={isUploading}
      />

      {error && (
        <p className="mb-2 text-sm text-red-400">{error}</p>
      )}

      {isUploading && (
        <p className="mb-2 text-xs text-gray-500">Uploading image...</p>
      )}

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
  )
}
