'use client'

import { useState, useCallback } from 'react'
import * as Popover from '@radix-ui/react-popover'
import Picker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import { useTheme } from 'next-themes'

interface EmojiData {
  native: string
  unified: string
  shortcodes: string
}

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void
  disabled?: boolean
}

export function EmojiPicker({ onEmojiSelect, disabled = false }: EmojiPickerProps) {
  const [open, setOpen] = useState(false)
  const { resolvedTheme } = useTheme()

  const handleEmojiSelect = useCallback(
    (emoji: EmojiData) => {
      onEmojiSelect(emoji.native)
      setOpen(false)
    },
    [onEmojiSelect]
  )

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          title="Add emoji"
          className="p-1.5 rounded-md text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="text-base leading-none">😀</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          className="z-[100] animate-in fade-in-0 zoom-in-95 rounded-lg shadow-lg"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div
            onWheel={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
          >
            <Picker
              data={data}
              onEmojiSelect={handleEmojiSelect}
              theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
              previewPosition="none"
              skinTonePosition="search"
              maxFrequentRows={2}
              perLine={8}
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
