'use client'

import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultProps,
  filterSuggestionItems,
  insertOrUpdateBlock,
  type BlockSchema,
  type InlineContentSchema,
  type StyleSchema,
} from '@blocknote/core'
import {
  createReactBlockSpec,
  getDefaultReactSlashMenuItems,
  type DefaultReactSuggestionItem,
} from '@blocknote/react'
import {
  ArrowsUpDownIcon,
  CodeBracketIcon,
  ExclamationTriangleIcon,
  FilmIcon,
  HashtagIcon,
  InformationCircleIcon,
  ListBulletIcon,
  MinusIcon,
  SparklesIcon,
  SwatchIcon,
  TableCellsIcon,
  ViewColumnsIcon,
} from '@heroicons/react/24/outline'

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

function getHeadingLinks(documentBlocks: unknown[]): Array<{ id: string; text: string }> {
  let index = 0

  return documentBlocks
    .filter((block) => {
      if (!block || typeof block !== 'object') return false
      return (block as { type?: string }).type === 'heading'
    })
    .map((block) => {
      const heading = block as { content?: unknown }
      const text = extractInlineText(heading.content).trim()
      const id = `toc-heading-${index}`
      index += 1
      return { id, text }
    })
    .filter((heading) => Boolean(heading.text))
}

function getFootnoteEntries(documentBlocks: unknown[]): Array<{ id: string; noteId: string; text: string }> {
  return documentBlocks
    .filter((block) => block && typeof block === 'object' && (block as { type?: string }).type === 'footnote')
    .map((block) => {
      const footnoteBlock = block as { id?: string; props?: Record<string, unknown>; content?: unknown }
      return {
        id: footnoteBlock.id || '',
        noteId: String(footnoteBlock.props?.noteId || '').trim(),
        text: extractInlineText(footnoteBlock.content).trim(),
      }
    })
    .filter((entry) => Boolean(entry.text))
}

function updateBlockProps(editor: unknown, block: unknown, props: Record<string, unknown>) {
  const anyEditor = editor as { updateBlock?: (target: unknown, update: Record<string, unknown>) => void }
  const anyBlock = block as { props?: Record<string, unknown> }
  anyEditor.updateBlock?.(anyBlock, {
    props: {
      ...(anyBlock.props || {}),
      ...props,
    },
  })
}

function isTrustedHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function parseYouTubeEmbedUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase()
    let videoId = ''

    if (isTrustedHost(host, 'youtu.be')) {
      videoId = url.pathname.replace('/', '').trim()
    } else if (isTrustedHost(host, 'youtube.com')) {
      if (url.pathname.startsWith('/watch')) {
        videoId = url.searchParams.get('v') || ''
      } else if (url.pathname.startsWith('/embed/')) {
        videoId = url.pathname.split('/embed/')[1] || ''
      } else if (url.pathname.startsWith('/shorts/')) {
        videoId = url.pathname.split('/shorts/')[1] || ''
      }
    }

    if (!videoId) return null
    return `https://www.youtube-nocookie.com/embed/${videoId}`
  } catch {
    return null
  }
}

function parseOdyseeEmbedUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase()
    if (!isTrustedHost(host, 'odysee.com') && !isTrustedHost(host, 'lbry.tv')) {
      return null
    }

    const cleanPath = url.pathname.replace(/^\/+/, '')
    if (!cleanPath) return null
    return `https://odysee.com/$/embed/${cleanPath}`
  } catch {
    return null
  }
}

function toVideoEmbedUrl(url: string): string | null {
  return parseYouTubeEmbedUrl(url) || parseOdyseeEmbedUrl(url)
}

const backgroundSectionBlock = createReactBlockSpec(
  {
    type: 'backgroundSection',
    propSchema: {
      ...defaultProps,
      background: { default: 'linear-gradient(135deg, #0f172a, #1e293b)' },
      padding: { default: '24px', values: ['16px', '24px', '32px'] as const },
    },
    content: 'inline',
  },
  {
    render: ({ block, contentRef }) => {
      const background = block.props.background || 'rgba(15, 23, 42, 0.55)'

      return (
        <div
          className="rounded-xl border border-white/10"
          style={{
            background,
            padding: block.props.padding,
          }}
        >
          <div ref={contentRef} className="min-h-[28px] text-sm text-white/90" />
        </div>
      )
    },
  }
)

const calloutBlock = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: {
      ...defaultProps,
      variant: { default: 'info', values: ['info', 'warning', 'tip', 'note'] as const },
      title: { default: '' },
    },
    content: 'inline',
  },
  {
    render: ({ block, contentRef }) => {
      const variant = block.props.variant
      const variantClassMap: Record<string, string> = {
        info: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-100',
        warning: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
        tip: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100',
        note: 'border-violet-500/40 bg-violet-500/10 text-violet-100',
      }
      const labelMap: Record<string, string> = {
        info: 'Info',
        warning: 'Warning',
        tip: 'Tip',
        note: 'Note',
      }

      const iconMap: Record<string, JSX.Element> = {
        info: <InformationCircleIcon className="h-4 w-4" />,
        warning: <ExclamationTriangleIcon className="h-4 w-4" />,
        tip: <SparklesIcon className="h-4 w-4" />,
        note: <MinusIcon className="h-4 w-4" />,
      }

      return (
        <div className={`rounded-xl border p-3 ${variantClassMap[variant] || variantClassMap.info}`}>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
            {iconMap[variant] || iconMap.info}
            <span>{block.props.title || labelMap[variant] || 'Info'}</span>
          </div>
          <div ref={contentRef} className="min-h-[24px] text-sm leading-relaxed" />
        </div>
      )
    },
  }
)

const dividerBlock = createReactBlockSpec(
  {
    type: 'divider',
    propSchema: {
      ...defaultProps,
      variant: { default: 'solid', values: ['solid', 'dashed', 'dots', 'fade'] as const },
    },
    content: 'none',
  },
  {
    render: ({ block }) => {
      const variant = block.props.variant
      const styleMap: Record<string, string> = {
        solid: 'border-t border-solid border-gray-500/50',
        dashed: 'border-t border-dashed border-gray-500/60',
        dots: 'border-t border-dotted border-gray-500/70',
        fade: 'h-px bg-gradient-to-r from-transparent via-gray-400/60 to-transparent',
      }

      return (
        <div className="py-3">
          <div className={styleMap[variant] || styleMap.solid} />
        </div>
      )
    },
  }
)

const spacerBlock = createReactBlockSpec(
  {
    type: 'spacer',
    propSchema: {
      ...defaultProps,
      size: { default: 'medium', values: ['small', 'medium', 'large'] as const },
    },
    content: 'none',
  },
  {
    render: ({ block }) => {
      const heightMap: Record<string, number> = {
        small: 16,
        medium: 36,
        large: 72,
      }
      const height = heightMap[block.props.size] || heightMap.medium

      return <div aria-label={`Spacer (${block.props.size})`} style={{ height }} />
    },
  }
)

const tableOfContentsBlock = createReactBlockSpec(
  {
    type: 'tableOfContents',
    propSchema: {
      ...defaultProps,
    },
    content: 'none',
  },
  {
    render: ({ editor }) => {
      if ((editor as { isEditable?: boolean }).isEditable) {
        return (
          <div className="rounded-lg border border-dashed border-gray-600 bg-gray-900/40 p-3 text-sm text-gray-300">
            Table of Contents (auto-generated on view)
          </div>
        )
      }

      const headings = getHeadingLinks((editor as { document?: unknown[] }).document || [])

      if (headings.length === 0) {
        return (
          <div className="rounded-lg border border-dashed border-gray-700 bg-gray-900/30 p-3 text-sm text-gray-400">
            No headings found.
          </div>
        )
      }

      return (
        <nav aria-label="Table of contents" className="rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Table of contents</p>
          <ul className="space-y-1">
            {headings.map((heading, index) => (
              <li key={heading.id}>
                <a href={`#${heading.id}`} className="text-sm text-cyan-300 hover:underline">
                  {index + 1}. {heading.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )
    },
  }
)

const codeBlock = createReactBlockSpec(
  {
    type: 'codeBlock',
    propSchema: {
      ...defaultProps,
      language: {
        default: 'javascript',
        values: ['javascript', 'typescript', 'python', 'rust', 'bash', 'json', 'html', 'css', 'go', 'solidity'] as const,
      },
      code: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      const editable = Boolean((editor as { isEditable?: boolean }).isEditable)

      return (
        <div className="space-y-2 rounded-lg border border-gray-700 bg-gray-950 p-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium uppercase tracking-wider text-gray-400">Language</label>
            <select
              value={block.props.language || 'javascript'}
              disabled={!editable}
              className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200 disabled:opacity-70"
              onChange={(event) => updateBlockProps(editor, block, { language: event.target.value })}
            >
              {['javascript', 'typescript', 'python', 'rust', 'bash', 'json', 'html', 'css', 'go', 'solidity'].map((language) => (
                <option key={language} value={language}>{language}</option>
              ))}
            </select>
          </div>

          {editable ? (
            <textarea
              value={String(block.props.code || '')}
              onChange={(event) => updateBlockProps(editor, block, { code: event.target.value })}
              placeholder="Paste or type code..."
              className="h-44 w-full resize-y rounded-md border border-gray-700 bg-gray-900 p-2 font-mono text-xs text-gray-100"
            />
          ) : (
            <pre className="overflow-x-auto rounded-md bg-black/40 p-3">
              <code className={`language-${block.props.language || 'javascript'}`}>{String(block.props.code || '')}</code>
            </pre>
          )}
        </div>
      )
    },
  }
)

const videoEmbedBlock = createReactBlockSpec(
  {
    type: 'videoEmbed',
    propSchema: {
      ...defaultProps,
      url: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      const editable = Boolean((editor as { isEditable?: boolean }).isEditable)
      const url = String(block.props.url || '')
      const embedUrl = toVideoEmbedUrl(url)

      return (
        <div className="space-y-2 rounded-lg border border-gray-700 bg-black/20 p-3">
          {editable && (
            <input
              type="url"
              value={url}
              onChange={(event) => updateBlockProps(editor, block, { url: event.target.value })}
              placeholder="YouTube or Odysee URL"
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
            />
          )}
          {embedUrl ? (
            <div className="relative w-full overflow-hidden rounded-lg border border-white/10 pt-[56.25%]">
              <iframe
                src={embedUrl}
                title="Embedded video"
                className="absolute inset-0 h-full w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            </div>
          ) : (
            <p className="text-sm text-gray-400">Add a supported video URL to preview embed.</p>
          )}
        </div>
      )
    },
  }
)

function parseTableData(rawData: unknown, rows: number, cols: number): string[][] {
  try {
    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : null
    if (!Array.isArray(parsed)) throw new Error('Invalid table data')
    return Array.from({ length: rows }, (_, rowIndex) =>
      Array.from({ length: cols }, (_, colIndex) => {
        const row = parsed[rowIndex]
        if (!Array.isArray(row)) return ''
        const cell = row[colIndex]
        return typeof cell === 'string' ? cell : ''
      })
    )
  } catch {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''))
  }
}

const simpleTableBlock = createReactBlockSpec(
  {
    type: 'simpleTable',
    propSchema: {
      ...defaultProps,
      rows: { default: 3 },
      cols: { default: 3 },
      data: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      const editable = Boolean((editor as { isEditable?: boolean }).isEditable)
      const rows = Math.min(12, Math.max(1, Number(block.props.rows || 3)))
      const cols = Math.min(8, Math.max(1, Number(block.props.cols || 3)))
      const tableData = parseTableData(block.props.data, rows, cols)

      const updateCell = (rowIndex: number, colIndex: number, value: string) => {
        const nextData = tableData.map((row) => [...row])
        nextData[rowIndex][colIndex] = value
        updateBlockProps(editor, block, {
          rows,
          cols,
          data: JSON.stringify(nextData),
        })
      }

      return (
        <div className="overflow-x-auto rounded-lg border border-gray-700">
          <table className="min-w-full border-collapse text-sm">
            <tbody>
              {tableData.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {row.map((cell, colIndex) => (
                    <td key={`cell-${rowIndex}-${colIndex}`} className="border border-gray-700 p-0 align-top">
                      {editable ? (
                        <input
                          type="text"
                          value={cell}
                          onChange={(event) => updateCell(rowIndex, colIndex, event.target.value)}
                          className="h-[36px] w-full min-w-[120px] bg-transparent p-2 text-sm text-gray-100 outline-none"
                        />
                      ) : (
                        <div className="min-h-[36px] min-w-[120px] bg-black/10 p-2 text-gray-100">{cell}</div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    },
  }
)

const columnLayoutBlock = createReactBlockSpec(
  {
    type: 'columnLayout',
    propSchema: {
      ...defaultProps,
      columns: { default: '2', values: ['2', '3'] as const },
    },
    content: 'inline',
  },
  {
    render: ({ block, contentRef, editor }) => {
      const columnCount = Number(block.props.columns || '2')
      const source = extractInlineText(block.content)
      const parts = source.split('|').map((part) => part.trim())
      const editable = Boolean((editor as { isEditable?: boolean }).isEditable)

      return (
        <div className="space-y-2 rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium uppercase tracking-wider text-gray-400">Columns</label>
            <select
              value={String(block.props.columns || '2')}
              disabled={!editable}
              className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200 disabled:opacity-70"
              onChange={(event) => updateBlockProps(editor, block, { columns: event.target.value })}
            >
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </div>
          <div className={`grid gap-2 ${columnCount === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
            {Array.from({ length: columnCount }).map((_, index) => (
              <div key={`col-${index}`} className="rounded-md border border-white/10 bg-black/20 p-2 text-sm text-gray-100">
                {parts[index] || <span className="text-gray-500">{`Column ${index + 1}`}</span>}
              </div>
            ))}
          </div>
          {editable && (
            <div>
              <p className="mb-1 text-xs text-gray-400">Edit source text (use | to separate columns)</p>
              <div
                ref={contentRef}
                className="min-h-[28px] rounded-md border border-dashed border-gray-700 bg-black/20 p-2 text-sm text-gray-100"
              />
            </div>
          )}
        </div>
      )
    },
  }
)

const footnoteBlock = createReactBlockSpec(
  {
    type: 'footnote',
    propSchema: {
      ...defaultProps,
      noteId: { default: '' },
    },
    content: 'inline',
  },
  {
    render: ({ block, contentRef, editor }) => {
      const editable = Boolean((editor as { isEditable?: boolean }).isEditable)
      const entries = getFootnoteEntries((editor as { document?: unknown[] }).document || [])
      const index = Math.max(1, entries.findIndex((entry) => entry.id === block.id) + 1)
      const text = extractInlineText(block.content).trim()

      if (!editable) {
        if (!text) return null
        return (
          <sup id={`footnote-ref-${index}`} className="mx-0.5 align-super text-xs">
            <a href={`#footnote-item-${index}`} className="text-cyan-300 hover:underline">
              [{index}]
            </a>
          </sup>
        )
      }

      return (
        <div className="flex items-start gap-2 rounded-md border border-white/10 bg-black/20 p-2">
          <sup className="pt-1 text-xs text-gray-300">[{index}]</sup>
          <div className="flex-1 space-y-1">
            <input
              type="text"
              value={String(block.props.noteId || '')}
              onChange={(event) => updateBlockProps(editor, block, { noteId: event.target.value })}
              placeholder="Footnote id (optional)"
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
            />
            <div ref={contentRef} className="min-h-[24px] rounded-md border border-dashed border-gray-700 p-2 text-sm text-gray-100" />
          </div>
        </div>
      )
    },
  }
)

export const blogBlockNoteSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    backgroundSection: backgroundSectionBlock,
    callout: calloutBlock,
    divider: dividerBlock,
    spacer: spacerBlock,
    tableOfContents: tableOfContentsBlock,
    codeBlock,
    videoEmbed: videoEmbedBlock,
    simpleTable: simpleTableBlock,
    columnLayout: columnLayoutBlock,
    footnote: footnoteBlock,
  },
})

export function getBlogSlashMenuItems<
  BSchema extends BlockSchema,
  I extends InlineContentSchema,
  S extends StyleSchema,
>(editor: BlockNoteEditor<BSchema, I, S>, query: string): DefaultReactSuggestionItem[] {
  const defaults = getDefaultReactSlashMenuItems(editor)

  const customItems: DefaultReactSuggestionItem[] = [
    {
      title: 'Table of contents',
      subtext: 'Auto-generated links to headings',
      aliases: ['toc', 'table', 'contents', 'outline'],
      group: 'Blog blocks',
      icon: <ListBulletIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, { type: 'tableOfContents' } as never)
      },
    },
    {
      title: 'Code block',
      subtext: 'Code with language and syntax highlighting',
      aliases: ['code', 'snippet', 'highlight'],
      group: 'Blog blocks',
      icon: <CodeBracketIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, {
          type: 'codeBlock',
          props: { language: 'javascript', code: '' },
        } as never)
      },
    },
    {
      title: 'Video embed',
      subtext: 'Embed YouTube or Odysee video',
      aliases: ['video', 'youtube', 'odysee', 'embed'],
      group: 'Blog blocks',
      icon: <FilmIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, {
          type: 'videoEmbed',
          props: { url: '' },
        } as never)
      },
    },
    {
      title: 'Simple table',
      subtext: 'Editable table block',
      aliases: ['table', 'grid', 'cells'],
      group: 'Blog blocks',
      icon: <TableCellsIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, {
          type: 'simpleTable',
          props: {
            rows: 3,
            cols: 3,
            data: JSON.stringify(Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ''))),
          },
        } as never)
      },
    },
    {
      title: 'Column layout',
      subtext: '2 or 3 equal-width columns',
      aliases: ['columns', 'layout', 'grid'],
      group: 'Blog blocks',
      icon: <ViewColumnsIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, {
          type: 'columnLayout',
          props: { columns: '2' },
          content: 'Column 1 | Column 2',
        } as never)
      },
    },
    {
      title: 'Footnote',
      subtext: 'Inline footnote reference',
      aliases: ['footnote', 'reference', 'note'],
      group: 'Blog blocks',
      icon: <HashtagIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, {
          type: 'footnote',
          props: { noteId: '' },
          content: 'Footnote text',
        } as never)
      },
    },
    {
      title: 'Background section',
      subtext: 'Wrap text in a highlighted section',
      aliases: ['background', 'section', 'panel'],
      group: 'Basic blocks',
      icon: <SwatchIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, {
          type: 'backgroundSection',
          content: 'Write highlighted content...',
        } as never)
      },
    },
    {
      title: 'Callout',
      subtext: 'Info, warning, tip, or note box',
      aliases: ['callout', 'info', 'warning', 'tip', 'note'],
      group: 'Basic blocks',
      icon: <InformationCircleIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, {
          type: 'callout',
          content: 'Write callout text...',
        } as never)
      },
    },
    {
      title: 'Divider',
      subtext: 'Horizontal separator line',
      aliases: ['divider', 'separator', 'hr'],
      group: 'Basic blocks',
      icon: <MinusIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, { type: 'divider' } as never)
      },
    },
    {
      title: 'Spacer',
      subtext: 'Adjustable vertical whitespace',
      aliases: ['spacer', 'space', 'gap'],
      group: 'Basic blocks',
      icon: <ArrowsUpDownIcon className="h-4 w-4" />,
      onItemClick: () => {
        insertOrUpdateBlock(editor as unknown as BlockNoteEditor, { type: 'spacer' } as never)
      },
    },
  ]

  return filterSuggestionItems([...defaults, ...customItems], query)
}
