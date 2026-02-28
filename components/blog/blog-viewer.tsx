'use client'

import { useMemo } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import { blogBlockNoteSchema } from './blocknote-schema'

interface BlogViewerProps {
  blocks: unknown[]
}

function BlogViewerContent({ blocks }: BlogViewerProps) {
  const editor = useCreateBlockNote({
    schema: blogBlockNoteSchema,
    initialContent: blocks as never,
  })

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900 p-2">
      <BlockNoteView
        editor={editor}
        editable={false}
        theme="dark"
      />
    </div>
  )
}

export function BlogViewer({ blocks }: BlogViewerProps) {
  const contentKey = useMemo(() => JSON.stringify(blocks), [blocks])

  return <BlogViewerContent key={contentKey} blocks={blocks} />
}
