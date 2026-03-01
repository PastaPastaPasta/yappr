'use client'

import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { SuggestionMenuController } from '@blocknote/react'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { PhotoIcon, LinkIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { getCompressedSize } from '@/lib/utils/compression'
import { validateHttpUrl } from '@/lib/utils'
import { useImageUpload } from '@/hooks/use-image-upload'
import { useFileDrop } from '@/hooks/use-file-drop'
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
  const [imageUrlInput, setImageUrlInput] = useState('')
  const [showImageUrlInput, setShowImageUrlInput] = useState(false)
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

  const insertImageBlock = useCallback((url: string, name = '') => {
    const cursor = editor.getTextCursorPosition()
    editor.insertBlocks(
      [
        {
          type: 'image',
          props: { url, caption: '', name },
        } as never,
      ],
      cursor.block,
      'after'
    )
    publishChange()
  }, [editor, publishChange])

  const insertImageFile = useCallback(async (file: File) => {
    clearError()

    try {
      const result = await upload(file)
      insertImageBlock(`ipfs://${result.cid}`, file.name)
    } catch {
      // Error state is already set by useImageUpload hook and displayed in the UI.
    }
  }, [clearError, insertImageBlock, upload])

  const handleImageUrlSubmit = useCallback(() => {
    const validated = validateHttpUrl(imageUrlInput)
    if (!validated) {
      toast.error('Please enter a valid http or https URL')
      return
    }
    insertImageBlock(validated)
    setImageUrlInput('')
    setShowImageUrlInput(false)
  }, [imageUrlInput, insertImageBlock])

  const handleImageUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    await insertImageFile(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [insertImageFile])

  const { isDragging, dropZoneProps } = useFileDrop({
    disabled: isUploading,
    accept: 'image/',
    onDrop: insertImageFile,
  })

  useEffect(() => {
    reportBytes(getCompressedSize(editor.document as unknown[]))

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [editor, reportBytes])

  return (
    <div
      {...dropZoneProps}
      className={`relative rounded-lg transition-colors ${
        isDragging ? 'ring-2 ring-yappr-500/60 bg-yappr-500/5' : ''
      }`}
    >
      {/* Hidden file input for IPFS image uploads */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageUpload}
        disabled={isUploading}
      />

      {(error || isUploading) && (
        <div className="mb-2 text-xs">
          {error && (
            <p className="text-amber-400">
              {error.includes('provider') ? (
                <>No storage provider connected. <Link href="/settings" className="underline hover:text-amber-300">Connect in Settings</Link></>
              ) : error}
            </p>
          )}
          {isUploading && <p className="text-gray-500">Uploading image... {progress}%</p>}
        </div>
      )}

      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/40">
          <p className="text-sm font-medium text-yappr-400">Drop image to insert</p>
        </div>
      )}

      <BlockNoteView
        editor={editor}
        theme="dark"
        onChange={publishChange}
        slashMenu={false}
        formattingToolbar
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) => getBlogSlashMenuItems(editor, query)}
        />
      </BlockNoteView>

      {/* Image actions */}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          aria-label="Upload image"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="inline-flex items-center gap-1.5 rounded-full bg-gray-800/40 px-3 py-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-800/70 hover:text-gray-300 disabled:opacity-50"
        >
          <PhotoIcon className="h-3.5 w-3.5" />
          {isUploading ? `${progress}%` : 'Add image'}
        </button>
        {!showImageUrlInput && (
          <button
            type="button"
            onClick={() => setShowImageUrlInput(true)}
            className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-400"
          >
            <LinkIcon className="h-3 w-3" />
            Paste URL
          </button>
        )}
      </div>
      {showImageUrlInput && (
        <div className="mt-2 flex gap-1.5">
          <input
            type="url"
            value={imageUrlInput}
            onChange={(e) => setImageUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleImageUrlSubmit() } }}
            placeholder="https://example.com/image.jpg"
            className="h-7 flex-1 rounded border border-gray-700 bg-gray-900/60 px-2 text-xs text-gray-300 placeholder:text-gray-600 focus:border-yappr-500 focus:outline-none"
            autoFocus
          />
          <button
            type="button"
            onClick={handleImageUrlSubmit}
            className="shrink-0 rounded bg-gray-800 px-2 text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-300"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => { setShowImageUrlInput(false); setImageUrlInput('') }}
            className="shrink-0 rounded px-1 text-xs text-gray-500 hover:text-gray-300"
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
