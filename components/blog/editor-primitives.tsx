import type { ReactNode } from 'react'
import { Switch } from '@/components/ui/switch'
import { BLOG_POST_SIZE_LIMIT } from '@/lib/constants'

/** Gradient horizontal rule used between editor sections. */
export function SectionDivider() {
  return <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent" />
}

/** Uppercase section heading used in the compose/edit forms. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-500">
      {children}
    </p>
  )
}

/** Borderless title input className for the editorial hero style. */
export const heroTitleClassName =
  '!h-auto border-0 bg-transparent px-0 text-2xl font-bold text-white placeholder:text-gray-600 focus:ring-0'

/** Borderless subtitle textarea className for the editorial hero style. */
export const heroSubtitleClassName =
  'mt-2 resize-none border-0 bg-transparent px-0 text-base text-gray-300 placeholder:text-gray-600 focus:ring-0'

interface EditorFooterProps {
  commentsEnabled: boolean
  onCommentsChange: (value: boolean) => void
  compressedBytes: number
  children: ReactNode
}

/** Settings & actions footer used at the bottom of compose/edit forms. */
export function EditorFooter({ commentsEnabled, onCommentsChange, compressedBytes, children }: EditorFooterProps) {
  return (
    <div className="space-y-4 rounded-xl border border-gray-800/60 bg-gray-900/30 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Switch checked={commentsEnabled} onCheckedChange={onCommentsChange} />
          <span className="text-sm text-gray-400">Comments</span>
        </div>
        <p className="text-xs tabular-nums text-gray-600">
          {compressedBytes.toLocaleString()} / {BLOG_POST_SIZE_LIMIT.toLocaleString()} bytes
        </p>
      </div>
      {children}
    </div>
  )
}
