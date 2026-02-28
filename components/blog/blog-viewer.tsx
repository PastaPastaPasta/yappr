'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import 'highlight.js/styles/github-dark.css'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import { blogBlockNoteSchema } from './blocknote-schema'

// Register only the languages we support to keep bundle small
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('go', go)

interface BlogViewerProps {
  blocks: unknown[]
}

function extractInlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const maybeText = (item as { text?: unknown }).text
        return typeof maybeText === 'string' ? maybeText : ''
      }
      return ''
    })
    .join('')
}

function collectFootnotes(blocks: unknown[]): Array<{ key: string; text: string; noteId?: string }> {
  return blocks
    .filter((block) => block && typeof block === 'object' && (block as { type?: string }).type === 'footnote')
    .map((block, index) => {
      const footnoteBlock = block as { id?: string; props?: Record<string, unknown>; content?: unknown }
      const text = extractInlineText(footnoteBlock.content).trim()
      return {
        key: footnoteBlock.id || `footnote-${index}`,
        noteId: String(footnoteBlock.props?.noteId || '').trim() || undefined,
        text,
      }
    })
    .filter((entry) => Boolean(entry.text))
}

function BlogViewerContent({ blocks }: BlogViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editor = useCreateBlockNote({
    schema: blogBlockNoteSchema,
    initialContent: blocks as never,
  })

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6')
    headings.forEach((heading, index) => {
      heading.id = `toc-heading-${index}`
    })

    const codeNodes = root.querySelectorAll('pre code')
    codeNodes.forEach((codeNode) => {
      hljs.highlightElement(codeNode as HTMLElement)
    })
  }, [blocks])

  const footnotes = useMemo(() => collectFootnotes(blocks), [blocks])

  return (
    <div ref={containerRef} className="rounded-xl border border-gray-700 bg-gray-900 p-2">
      <BlockNoteView
        editor={editor}
        editable={false}
        theme="dark"
      />
      {footnotes.length > 0 && (
        <section className="mt-4 border-t border-white/10 pt-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">Footnotes</h3>
          <ol className="mt-2 list-decimal space-y-2 pl-6 text-sm text-gray-200">
            {footnotes.map((footnote, index) => (
              <li key={footnote.key} id={`footnote-item-${index + 1}`}>
                {footnote.text}
                {footnote.noteId && <span className="ml-2 text-xs text-gray-400">({footnote.noteId})</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

export function BlogViewer({ blocks }: BlogViewerProps) {
  const contentKey = useMemo(() => JSON.stringify(blocks), [blocks])

  return <BlogViewerContent key={contentKey} blocks={blocks} />
}
