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
  ExclamationTriangleIcon,
  InformationCircleIcon,
  MinusIcon,
  SparklesIcon,
  SwatchIcon,
} from '@heroicons/react/24/outline'

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

export const blogBlockNoteSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    backgroundSection: backgroundSectionBlock,
    callout: calloutBlock,
    divider: dividerBlock,
    spacer: spacerBlock,
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
