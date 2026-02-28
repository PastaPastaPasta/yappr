import type { InlineContent } from '../types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url) || /^tel:/i.test(url)) {
    return url;
  }
  return '#';
}

function applyStyles(base: string, entry: InlineContent): string {
  const styles = entry.styles;
  if (!styles) {
    return base;
  }

  let html = base;

  if (styles.code) html = `<code>${html}</code>`;
  if (styles.bold) html = `<strong>${html}</strong>`;
  if (styles.italic) html = `<em>${html}</em>`;
  if (styles.underline) html = `<u>${html}</u>`;
  if (styles.strike) html = `<s>${html}</s>`;

  const css: string[] = [];
  if (styles.textColor) css.push(`color:${escapeHtml(styles.textColor)}`);
  if (styles.backgroundColor) css.push(`background:${escapeHtml(styles.backgroundColor)}`);
  if (css.length > 0) {
    html = `<span style="${css.join(';')}">${html}</span>`;
  }

  return html;
}

export function renderInline(content?: InlineContent[] | string): string {
  if (!content) {
    return '';
  }

  if (typeof content === 'string') {
    return escapeHtml(content);
  }

  return content
    .map((entry) => {
      const textValue = entry.text ?? '';
      const nested = entry.content ? renderInline(entry.content) : '';
      const base = escapeHtml(textValue) + nested;
      const styled = applyStyles(base, entry);

      if (entry.type === 'link' && entry.href) {
        const href = sanitizeUrl(entry.href);
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${styled}</a>`;
      }

      return styled;
    })
    .join('');
}
