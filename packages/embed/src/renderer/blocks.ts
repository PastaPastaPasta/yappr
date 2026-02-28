import type { BlockNoteBlock, RenderResult } from '../types';
import { renderInline } from './inline';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderChildren(children?: BlockNoteBlock[]): string {
  if (!children || children.length === 0) {
    return '';
  }
  return renderBlocks(children).html;
}

function renderList(blocks: BlockNoteBlock[], index: number, type: 'bulletListItem' | 'numberedListItem'): { html: string; nextIndex: number } {
  const tag = type === 'bulletListItem' ? 'ul' : 'ol';
  let current = index;
  let items = '';

  while (current < blocks.length && blocks[current].type === type) {
    const block = blocks[current];
    const content = renderInline(block.content);
    const nestedChildren = renderChildren(block.children);
    items += `<li>${content}${nestedChildren}</li>`;
    current += 1;
  }

  return {
    html: `<${tag}>${items}</${tag}>`,
    nextIndex: current
  };
}

function renderTable(block: BlockNoteBlock): string {
  const rows = (block.children ?? [])
    .map((row) => {
      const cells = (row.children ?? [])
        .map((cell) => `<td>${renderInline(cell.content)}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<table><tbody>${rows}</tbody></table>`;
}

function renderBlock(block: BlockNoteBlock): string {
  const props = block.props ?? {};

  switch (block.type) {
    case 'paragraph':
      return `<p>${renderInline(block.content)}</p>`;
    case 'heading': {
      const levelRaw = typeof props.level === 'number' ? props.level : Number(props.level ?? 1);
      const level = Math.max(1, Math.min(3, levelRaw || 1));
      return `<h${level}>${renderInline(block.content)}</h${level}>`;
    }
    case 'image': {
      const src = typeof props.url === 'string' ? props.url : typeof props.src === 'string' ? props.src : '';
      const caption = typeof props.caption === 'string' ? props.caption : '';
      if (!src) {
        return '';
      }
      return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(caption)}" loading="lazy" /><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
    }
    case 'table':
      return renderTable(block);
    case 'codeBlock': {
      const code = typeof block.content === 'string' ? block.content : renderInline(block.content);
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
    case 'backgroundSection': {
      const content = renderInline(block.content);
      const children = renderChildren(block.children);
      return `<div class="yappr-block-background-section">${content}${children}</div>`;
    }
    case 'callout': {
      const variant = typeof props.variant === 'string' ? props.variant : 'info';
      const safeVariant = ['info', 'warning', 'tip', 'note'].includes(variant) ? variant : 'info';
      return `<div class="yappr-block-callout yappr-callout-${safeVariant}">${renderInline(block.content)}${renderChildren(block.children)}</div>`;
    }
    case 'divider': {
      const variant = typeof props.variant === 'string' ? props.variant : 'solid';
      const safeVariant = ['solid', 'dashed', 'dots', 'fade'].includes(variant) ? variant : 'solid';
      return `<hr class="yappr-block-divider" data-variant="${safeVariant}" />`;
    }
    case 'spacer': {
      const size = typeof props.size === 'string' ? props.size : 'medium';
      const px = size === 'small' ? 12 : size === 'large' ? 40 : 24;
      return `<div style="height:${px}px"></div>`;
    }
    default:
      return `<p>${renderInline(block.content)}</p>`;
  }
}

export function renderBlocks(blocks: BlockNoteBlock[]): RenderResult {
  let html = '';
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];

    if (block.type === 'bulletListItem' || block.type === 'numberedListItem') {
      const result = renderList(blocks, index, block.type);
      html += result.html;
      index = result.nextIndex;
      continue;
    }

    html += renderBlock(block);
    index += 1;
  }

  return { html, blocks };
}
