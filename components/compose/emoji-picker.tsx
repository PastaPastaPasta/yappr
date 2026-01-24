'use client'

import { useRef, useState, useCallback, useEffect } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { FaceSmileIcon } from '@heroicons/react/24/outline'
import data from '@emoji-mart/data'
import Picker from '@emoji-mart/react'
import { useTheme } from 'next-themes'

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void
  disabled?: boolean
}

interface EmojiData {
  native: string
  id: string
  name: string
  unified: string
}

export function EmojiPicker({ onEmojiSelect, disabled = false }: EmojiPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const { resolvedTheme } = useTheme()
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleEmojiSelect = useCallback((emoji: EmojiData) => {
    onEmojiSelect(emoji.native)
    setIsOpen(false)
  }, [onEmojiSelect])

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
        buttonRef.current?.focus()
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger asChild>
        <button
          ref={buttonRef}
          type="button"
          disabled={disabled}
          title="Add emoji"
          className="p-1.5 rounded-md text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <FaceSmileIcon className="w-4 h-4" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          className="z-[100] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          onOpenAutoFocus={(e) => {
            // Prevent auto-focus stealing from the textarea
            e.preventDefault()
          }}
        >
          <div className="rounded-xl shadow-xl overflow-hidden border border-gray-200 dark:border-gray-700">
            <Picker
              data={data}
              onEmojiSelect={handleEmojiSelect}
              theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
              previewPosition="none"
              skinTonePosition="search"
              maxFrequentRows={2}
              perLine={8}
              emojiSize={24}
              emojiButtonSize={32}
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
