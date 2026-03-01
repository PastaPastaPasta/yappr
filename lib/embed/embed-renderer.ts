import type { EmbedBlock, EmbedRenderOptions } from './embed-types'
import { FORBIDDEN_CSS_PATTERN } from '@/lib/blog/theme-types'

const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function ensureString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isSafeCssValue(value: string): boolean {
  if (/[;{}]/.test(value)) return false
  return !FORBIDDEN_CSS_PATTERN.test(value)
}

function sanitizeUrl(value: string, options?: EmbedRenderOptions): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  if (trimmed.startsWith('ipfs://')) {
    const gateway = (options?.ipfsGateway || DEFAULT_IPFS_GATEWAY).replace(/\/+$/, '')
    const cidPath = trimmed.replace(/^ipfs:\/\//, '').replace(/^ipfs\//, '')
    return `${gateway}/${cidPath}`
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return ''
}

function applyTextStyles(text: string, styles: Record<string, unknown> | null): string {
  if (!styles) return text

  let html = text
  if (styles.code) html = `<code>${html}</code>`
  if (styles.bold) html = `<strong>${html}</strong>`
  if (styles.italic) html = `<em>${html}</em>`
  if (styles.underline) html = `<u>${html}</u>`
  if (styles.strikethrough) html = `<s>${html}</s>`
  return html
}

function renderInline(node: unknown, options?: EmbedRenderOptions): string {
  if (typeof node === 'string') {
    return escapeHtml(node)
  }

  if (Array.isArray(node)) {
    return node.map((item) => renderInline(item, options)).join('')
  }

  const record = toRecord(node)
  if (!record) return ''

  const type = ensureString(record.type)

  if (type === 'link') {
    const href = sanitizeUrl(ensureString(record.href) || ensureString(record.url), options)
    const text = renderInline(record.content ?? record.text ?? record.children ?? href, options)
    if (!href) return text
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text || escapeHtml(href)}</a>`
  }

  const rawText = ensureString(record.text)
  if (rawText) {
    const styled = applyTextStyles(escapeHtml(rawText), toRecord(record.styles))
    const href = sanitizeUrl(ensureString(record.href) || ensureString(record.url), options)
    if (!href) return styled
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${styled}</a>`
  }

  if (record.content || record.children) {
    return renderInline(record.content ?? record.children, options)
  }

  return ''
}

function inlineToText(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map((item) => inlineToText(item)).join('')

  const record = toRecord(node)
  if (!record) return ''

  if (typeof record.text === 'string') return record.text
  if (record.content || record.children) return inlineToText(record.content ?? record.children)

  return Object.values(record).map((value) => inlineToText(value)).join('')
}

function getHeadingLevel(block: EmbedBlock): number {
  const props = toRecord(block.props)
  const fromProps = Number(props?.level)
  const fromBlock = Number((block as Record<string, unknown>).level)
  const level = Number.isFinite(fromProps) ? fromProps : fromBlock
  if (!Number.isFinite(level) || level < 1 || level > 6) return 2
  return Math.floor(level)
}

function normalizeSpacerHeight(size: string): number {
  if (size === 'small') return 16
  if (size === 'large') return 72
  return 36
}

function renderList(blocks: EmbedBlock[], start: number, type: 'bulletListItem' | 'numberedListItem', options?: EmbedRenderOptions): { html: string; nextIndex: number } {
  const tag = type === 'bulletListItem' ? 'ul' : 'ol'
  const items: string[] = []
  let index = start

  while (index < blocks.length && blocks[index]?.type === type) {
    const block = blocks[index]
    const itemBody = renderInline(block.content, options) || '&nbsp;'
    const childHtml = Array.isArray(block.children) ? renderBlocks(block.children, options) : ''
    items.push(`<li>${itemBody}${childHtml}</li>`)
    index += 1
  }

  return {
    html: `<${tag}>${items.join('')}</${tag}>`,
    nextIndex: index,
  }
}

function renderBlock(block: EmbedBlock, options?: EmbedRenderOptions): string {
  const type = ensureString(block.type || 'paragraph')
  const props = toRecord(block.props)

  if (type === 'paragraph') {
    return `<p>${renderInline(block.content, options) || '&nbsp;'}</p>`
  }

  if (type === 'heading') {
    const level = getHeadingLevel(block)
    return `<h${level}>${renderInline(block.content, options) || '&nbsp;'}</h${level}>`
  }

  if (type === 'image') {
    const src = sanitizeUrl(ensureString(props?.url) || ensureString(props?.src), options)
    if (!src) return ''
    const caption = renderInline(props?.caption || block.content, options)
    const captionText = inlineToText(props?.caption || block.content)
    return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(captionText)}" loading="lazy" />${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`
  }

  if (type === 'codeBlock') {
    const code = escapeHtml(inlineToText(block.content))
    const language = ensureString(props?.language)
    const className = language ? ` class="language-${escapeHtml(language)}"` : ''
    return `<pre><code${className}>${code}</code></pre>`
  }

  if (type === 'quote' || type === 'blockquote') {
    const body = renderInline(block.content, options) || '&nbsp;'
    return `<blockquote>${body}</blockquote>`
  }

  if (type === 'callout') {
    const variant = ensureString(props?.variant) || 'info'
    const title = ensureString(props?.title) || variant
    const body = renderInline(block.content, options) || '&nbsp;'
    return `<section class="yappr-embed-callout" data-variant="${escapeHtml(variant)}"><p class="yappr-embed-callout-title">${escapeHtml(title)}</p><div>${body}</div></section>`
  }

  if (type === 'divider') {
    const variant = ensureString(props?.variant) || 'solid'
    return `<div class="yappr-embed-divider" data-variant="${escapeHtml(variant)}"><hr /></div>`
  }

  if (type === 'spacer') {
    const size = ensureString(props?.size) || 'medium'
    return `<div aria-hidden="true" style="height:${normalizeSpacerHeight(size)}px"></div>`
  }

  if (type === 'backgroundSection') {
    const background = ensureString(props?.background)
    const padding = ensureString(props?.padding) || '24px'
    const content = renderInline(block.content, options) || '&nbsp;'
    const styleParts = [`padding:${escapeHtml(isSafeCssValue(padding) ? padding : '24px')}`]
    if (background && isSafeCssValue(background)) {
      styleParts.push(`background:${escapeHtml(background)}`)
    }
    return `<section class="yappr-embed-background-section" style="${styleParts.join(';')}">${content}</section>`
  }

  const fallback = renderInline(block.content, options)
  if (fallback) return `<p>${fallback}</p>`
  return ''
}

export function renderBlocks(blocks: EmbedBlock[], options?: EmbedRenderOptions): string {
  const safeBlocks = Array.isArray(blocks) ? blocks : []
  const rendered: string[] = []
  let index = 0

  while (index < safeBlocks.length) {
    const block = safeBlocks[index]
    if (!block || typeof block !== 'object') {
      index += 1
      continue
    }

    if (block.type === 'bulletListItem' || block.type === 'numberedListItem') {
      const listResult = renderList(safeBlocks, index, block.type, options)
      rendered.push(listResult.html)
      index = listResult.nextIndex
      continue
    }

    rendered.push(renderBlock(block, options))
    index += 1
  }

  return rendered.filter(Boolean).join('')
}

export function renderEmbedHtml(blocks: unknown, options?: EmbedRenderOptions): string {
  if (!Array.isArray(blocks)) return ''
  return renderBlocks(blocks as EmbedBlock[], options)
}
