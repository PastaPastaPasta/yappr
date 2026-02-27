'use client'

import { useRef, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { TrashIcon, PhotoIcon } from '@heroicons/react/24/outline'
import type { ThreadPost } from '@/lib/store'
import { MarkdownContent } from '@/components/ui/markdown-content'
import { FormatButton, CharacterCounter } from './compose-sub-components'
import { MentionAutocomplete } from './mention-autocomplete'
import { EmojiPicker } from './emoji-picker'

const CHARACTER_LIMIT = 500

interface ThreadPostEditorProps {
  post: ThreadPost
  index: number
  isActive: boolean
  isOnly: boolean
  showPreview: boolean
  onActivate: () => void
  onRemove: () => void
  onContentChange: (content: string) => void
  textareaRef?: React.RefObject<HTMLTextAreaElement>
  extraCharacters?: number
  /** Image attachment controls - only shown on the first unposted post */
  onImageClick?: () => void
  canAttachImage?: boolean
  imageTitle?: string
  fileInputRef?: React.RefObject<HTMLInputElement>
  onFileSelect?: (e: React.ChangeEvent<HTMLInputElement>) => void
}

export function ThreadPostEditor({
  post,
  index,
  isActive,
  isOnly,
  showPreview,
  onActivate,
  onRemove,
  onContentChange,
  textareaRef,
  extraCharacters = 0,
  onImageClick,
  canAttachImage,
  imageTitle,
  fileInputRef,
  onFileSelect,
}: ThreadPostEditorProps) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const ref = textareaRef || localRef

  useEffect(() => {
    if (isActive && ref.current) {
      ref.current.focus()
    }
  }, [isActive, ref])

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const textarea = ref.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.max(80, textarea.scrollHeight)}px`
    }
  }, [ref])

  useEffect(() => {
    adjustHeight()
  }, [post.content, adjustHeight])

  const handleInsertEmoji = (emoji: string) => {
    const textarea = ref.current
    if (!textarea) return

    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const content = post.content

    const newContent = content.substring(0, start) + emoji + content.substring(end)
    const newCursorPos = start + emoji.length

    onContentChange(newContent)

    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(newCursorPos, newCursorPos)
    })
  }

  const handleInsertFormat = (prefix: string, suffix: string = prefix) => {
    const textarea = ref.current
    if (!textarea) return

    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const content = post.content
    const selectedText = content.substring(start, end)

    // Check if we should toggle OFF the formatting
    let shouldRemove = false
    let removeStart = start
    let removeEnd = end

    if (selectedText) {
      // Case 1: Selected text is already wrapped with the formatting
      if (selectedText.startsWith(prefix) && selectedText.endsWith(suffix)) {
        shouldRemove = true
        removeStart = start
        removeEnd = end
      }
      // Case 2: Selection is inside formatted text
      else if (
        start >= prefix.length &&
        content.substring(start - prefix.length, start) === prefix &&
        content.substring(end, end + suffix.length) === suffix
      ) {
        shouldRemove = true
        removeStart = start - prefix.length
        removeEnd = end + suffix.length
      }
    } else {
      // No selection - check if cursor is inside formatted text
      const beforeCursor = content.substring(0, start)
      const afterCursor = content.substring(start)

      const prefixIndex = beforeCursor.lastIndexOf(prefix)
      if (prefixIndex !== -1) {
        const suffixIndex = afterCursor.indexOf(suffix)
        if (suffixIndex !== -1) {
          const textBetweenPrefixAndCursor = beforeCursor.substring(prefixIndex + prefix.length)
          const textBetweenCursorAndSuffix = afterCursor.substring(0, suffixIndex)

          if (!textBetweenPrefixAndCursor.includes(suffix) && !textBetweenCursorAndSuffix.includes(prefix)) {
            shouldRemove = true
            removeStart = prefixIndex
            removeEnd = start + suffixIndex + suffix.length
          }
        }
      }
    }

    let newContent: string
    let newCursorPos: number

    if (shouldRemove) {
      // Remove the formatting
      const innerText = content.substring(removeStart + prefix.length, removeEnd - suffix.length)
      newContent = content.substring(0, removeStart) + innerText + content.substring(removeEnd)
      newCursorPos = removeStart + innerText.length
    } else {
      // Add the formatting
      const insertText = prefix + selectedText + suffix
      newContent = content.substring(0, start) + insertText + content.substring(end)
      newCursorPos = selectedText
        ? start + insertText.length
        : start + prefix.length
    }

    // Update content via React state
    onContentChange(newContent)

    // Restore focus and cursor position after React re-renders
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(newCursorPos, newCursorPos)
    })
  }

  const isPosted = !!post.postedPostId
  const effectiveLength = post.content.length + extraCharacters

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, height: 0 }}
      transition={{ duration: 0.2 }}
      className={`relative ${index > 0 ? 'mt-0' : ''}`}
    >
      {/* Thread connector line */}
      {index > 0 && (
        <div className={`absolute left-5 -top-3 w-0.5 h-3 bg-gradient-to-b ${
          isPosted
            ? 'from-green-300 to-green-400 dark:from-green-700 dark:to-green-600'
            : 'from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-600'
        }`} />
      )}

      <div
        onClick={isPosted ? undefined : onActivate}
        className={`relative rounded-xl border-2 transition-all ${
          isPosted
            ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/30 cursor-default'
            : isActive
            ? 'border-yappr-500 bg-white dark:bg-neutral-900 shadow-sm cursor-pointer'
            : 'border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950 hover:border-gray-300 dark:hover:border-gray-700 cursor-pointer'
        }`}
      >
        {/* Post number/status indicator - only show for threads (multiple posts) or posted status */}
        {(!isOnly || isPosted) && (
          <div className={`absolute -left-2 top-3 flex items-center justify-center w-6 h-6 rounded-full text-white text-xs font-semibold shadow-sm ${
            isPosted ? 'bg-green-500' : 'bg-yappr-500'
          }`}>
            {isPosted ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              index + 1
            )}
          </div>
        )}

        <div className="p-4 pl-8 pr-5">
          {/* Posted status badge */}
          {isPosted && (
            <div className="flex items-center gap-2 mb-2 text-xs text-green-600 dark:text-green-400 font-medium">
              <span>Posted</span>
            </div>
          )}

          {/* Formatting toolbar - only show when active and not posted */}
          {isActive && !showPreview && !isPosted && (
            <div className="flex items-center gap-1 mb-3 pb-2 border-b border-gray-100 dark:border-gray-800">
              <FormatButton
                onClick={() => handleInsertFormat('**')}
                title="Bold (Ctrl+B)"
              >
                <span className="font-bold text-sm">B</span>
              </FormatButton>
              <FormatButton
                onClick={() => handleInsertFormat('*')}
                title="Italic (Ctrl+I)"
              >
                <span className="italic text-sm">I</span>
              </FormatButton>
              <FormatButton
                onClick={() => handleInsertFormat('`')}
                title="Code"
              >
                <span className="font-mono text-xs">&lt;/&gt;</span>
              </FormatButton>
              <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />
              <FormatButton
                onClick={() => handleInsertFormat('@', '')}
                title="Mention someone"
              >
                <span className="text-sm">@</span>
              </FormatButton>
              <FormatButton
                onClick={() => handleInsertFormat('#', '')}
                title="Add hashtag"
              >
                <span className="text-sm">#</span>
              </FormatButton>
              <EmojiPicker onEmojiSelect={handleInsertEmoji} />

              {/* Image attachment button */}
              {onImageClick && (
                <>
                  <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />
                  <FormatButton
                    onClick={onImageClick}
                    title={imageTitle || 'Attach image'}
                    disabled={!canAttachImage}
                  >
                    <PhotoIcon className="w-4 h-4" />
                  </FormatButton>
                  {fileInputRef && onFileSelect && (
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={onFileSelect}
                      className="hidden"
                    />
                  )}
                </>
              )}

              {/* Remove button for thread posts */}
              {!isOnly && (
                <>
                  <div className="flex-1" />
                  <FormatButton onClick={onRemove} title="Remove this post">
                    <TrashIcon className="w-4 h-4 text-red-500" />
                  </FormatButton>
                </>
              )}
            </div>
          )}

          {/* Content area */}
          {showPreview || isPosted ? (
            <div className={`min-h-[60px] whitespace-pre-wrap break-words ${
              isPosted
                ? 'text-gray-600 dark:text-gray-400'
                : 'text-gray-900 dark:text-gray-100'
            }`}>
              {post.content ? (
                <MarkdownContent content={post.content} />
              ) : (
                <span className="text-gray-400 dark:text-gray-600 italic">
                  Nothing to preview
                </span>
              )}
            </div>
          ) : (
            <div className="relative">
              <textarea
                ref={ref}
                value={post.content}
                onChange={(e) => onContentChange(e.target.value)}
                onFocus={onActivate}
                onKeyDown={(e) => {
                  // Formatting shortcuts
                  if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                    e.preventDefault()
                    handleInsertFormat('**')
                  } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
                    e.preventDefault()
                    handleInsertFormat('*')
                  }
                }}
                placeholder={
                  index === 0
                    ? "What's on your mind?"
                    : 'Continue your thread...'
                }
                className={`w-full text-base resize-none outline-none bg-transparent placeholder:text-gray-400 dark:placeholder:text-gray-600 ${isActive ? 'min-h-[80px]' : 'min-h-[24px]'}`}
                style={{ height: 'auto' }}
              />
              <MentionAutocomplete
                textareaRef={ref}
                content={post.content}
                onSelect={(username, start, end) => {
                  // Replace @partial with @username (keep the @, add space after)
                  const newContent =
                    post.content.substring(0, start) +
                    '@' + username + ' ' +
                    post.content.substring(end)
                  onContentChange(newContent)

                  // Restore focus and position cursor after the mention
                  requestAnimationFrame(() => {
                    const textarea = ref.current
                    if (textarea) {
                      textarea.focus()
                      const newPos = start + 1 + username.length + 1 // @username + space
                      textarea.setSelectionRange(newPos, newPos)
                    }
                  })
                }}
              />
            </div>
          )}

          {/* Footer with formatting hints and character count - only show when active and not posted */}
          {isActive && !isPosted && (
            <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-100 dark:border-gray-800">
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">**bold**</code>
                <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">*italic*</code>
                <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">`code`</code>
              </div>
              <div className="flex items-center gap-2">
                {extraCharacters > 0 && (
                  <span className="text-xs text-gray-400 tabular-nums">
                    Image URL +{extraCharacters} chars
                  </span>
                )}
                <CharacterCounter current={effectiveLength} limit={CHARACTER_LIMIT} />
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}

export { CHARACTER_LIMIT }
