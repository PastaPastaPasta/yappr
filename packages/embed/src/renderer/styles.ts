export const EMBED_STYLE_ID = 'yappr-embed-style';

export function getEmbedStyles(): string {
  return `
.yappr-embed {
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--yappr-bg);
  color: var(--yappr-text);
  border: 1px solid var(--yappr-border);
  border-radius: 14px;
  overflow: hidden;
  max-width: 100%;
  line-height: 1.6;
}
.yappr-embed * {
  box-sizing: border-box;
}
.yappr-embed__state {
  padding: 16px;
  color: var(--yappr-muted);
  font-size: 14px;
}
.yappr-embed__error {
  color: #b42318;
}
.yappr-embed__cover {
  width: 100%;
  max-height: 360px;
  object-fit: cover;
  display: block;
}
.yappr-embed__body {
  padding: 18px;
}
.yappr-embed__title {
  margin: 0;
  font-size: 1.4rem;
  line-height: 1.25;
}
.yappr-embed__subtitle {
  margin: 8px 0 0;
  color: var(--yappr-muted);
  font-size: 0.96rem;
}
.yappr-embed__meta {
  margin-top: 10px;
  color: var(--yappr-muted);
  font-size: 0.83rem;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.yappr-embed__content {
  margin-top: 16px;
  overflow-wrap: break-word;
}
.yappr-embed__content p,
.yappr-embed__content h1,
.yappr-embed__content h2,
.yappr-embed__content h3,
.yappr-embed__content ul,
.yappr-embed__content ol,
.yappr-embed__content pre,
.yappr-embed__content table,
.yappr-embed__content figure {
  margin: 0 0 14px;
}
.yappr-embed__content img {
  max-width: 100%;
  border-radius: 10px;
}
.yappr-embed__content a {
  color: var(--yappr-link);
}
.yappr-embed__content pre,
.yappr-embed__content code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.yappr-embed__content pre {
  background: var(--yappr-code-bg);
  border-radius: 10px;
  padding: 12px;
  overflow: auto;
}
.yappr-embed__content code {
  background: var(--yappr-code-bg);
  border-radius: 4px;
  padding: 0 4px;
}
.yappr-embed__content table {
  border-collapse: collapse;
  width: 100%;
}
.yappr-embed__content td,
.yappr-embed__content th {
  border: 1px solid var(--yappr-border);
  padding: 8px;
}
.yappr-block-callout {
  border-left: 4px solid;
  border-radius: 10px;
  padding: 10px 12px;
}
.yappr-callout-info { background: #ecfeff; border-color: #06b6d4; }
.yappr-callout-warning { background: #fffbeb; border-color: #f59e0b; }
.yappr-callout-tip { background: #f0fdf4; border-color: #16a34a; }
.yappr-callout-note { background: #f5f3ff; border-color: #8b5cf6; }
.yappr-block-background-section {
  background: linear-gradient(145deg, rgba(15,95,215,0.09), rgba(143,197,253,0.09));
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 14px;
}
.yappr-block-divider {
  border: none;
  border-top: 1px solid var(--yappr-border);
  margin: 18px 0;
}
.yappr-block-divider[data-variant="dashed"] { border-top-style: dashed; }
.yappr-block-divider[data-variant="dots"] { border-top-style: dotted; }
.yappr-block-divider[data-variant="fade"] {
  border-top: none;
  height: 1px;
  background: linear-gradient(to right, transparent, var(--yappr-border), transparent);
}
.yappr-embed__footer {
  border-top: 1px solid var(--yappr-border);
  background: var(--yappr-surface);
  padding: 12px 18px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 0.86rem;
}
.yappr-embed__footer a {
  color: var(--yappr-link);
  text-decoration: none;
}
@media (max-width: 640px) {
  .yappr-embed__body {
    padding: 14px;
  }
  .yappr-embed__footer {
    padding: 10px 14px;
  }
}
`.trim();
}

export function ensureStylesMounted(): void {
  if (typeof document === 'undefined') {
    return;
  }

  if (document.getElementById(EMBED_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = EMBED_STYLE_ID;
  style.textContent = getEmbedStyles();
  document.head.appendChild(style);
}
