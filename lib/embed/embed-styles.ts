export const EMBED_STYLES = `
:root {
  color-scheme: light dark;
}

html,
body {
  margin: 0;
  padding: 0;
}

body {
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6;
}

.yappr-embed {
  --yappr-bg: #ffffff;
  --yappr-card: #f8fafc;
  --yappr-border: #e2e8f0;
  --yappr-text: #0f172a;
  --yappr-muted: #475569;
  --yappr-link: #0f766e;
  --yappr-code-bg: #e2e8f0;
  --yappr-code-text: #1e293b;
  --yappr-quote: #64748b;
  background: var(--yappr-bg);
  color: var(--yappr-text);
  padding: 16px;
}

.yappr-embed[data-yappr-theme='dark'] {
  --yappr-bg: #0b1220;
  --yappr-card: #111827;
  --yappr-border: #25314a;
  --yappr-text: #e5e7eb;
  --yappr-muted: #94a3b8;
  --yappr-link: #2dd4bf;
  --yappr-code-bg: #1f2937;
  --yappr-code-text: #dbeafe;
  --yappr-quote: #cbd5e1;
}

.yappr-embed-article {
  margin: 0 auto;
  max-width: 780px;
}

.yappr-embed-header {
  border-bottom: 1px solid var(--yappr-border);
  margin-bottom: 16px;
  padding-bottom: 12px;
}

.yappr-embed-title {
  font-size: 1.5rem;
  line-height: 1.25;
  margin: 0 0 6px;
}

.yappr-embed-meta {
  color: var(--yappr-muted);
  font-size: 0.875rem;
  margin: 0;
}

.yappr-embed-content p {
  margin: 0 0 0.9rem;
}

.yappr-embed-content h1,
.yappr-embed-content h2,
.yappr-embed-content h3,
.yappr-embed-content h4,
.yappr-embed-content h5,
.yappr-embed-content h6 {
  line-height: 1.3;
  margin: 1.15rem 0 0.5rem;
}

.yappr-embed-content ul,
.yappr-embed-content ol {
  margin: 0 0 0.9rem 1.4rem;
  padding: 0;
}

.yappr-embed-content li {
  margin: 0.25rem 0;
}

.yappr-embed-content img {
  border-radius: 10px;
  display: block;
  height: auto;
  margin: 0.5rem 0;
  max-width: 100%;
}

.yappr-embed-content figure {
  margin: 0 0 1rem;
}

.yappr-embed-content figcaption {
  color: var(--yappr-muted);
  font-size: 0.82rem;
}

.yappr-embed-content pre {
  background: var(--yappr-code-bg);
  border-radius: 10px;
  color: var(--yappr-code-text);
  margin: 0 0 1rem;
  overflow-x: auto;
  padding: 12px;
}

.yappr-embed-content code {
  background: var(--yappr-code-bg);
  border-radius: 4px;
  color: var(--yappr-code-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace;
  font-size: 0.9em;
  padding: 0.1em 0.35em;
}

.yappr-embed-content pre code {
  background: transparent;
  padding: 0;
}

.yappr-embed-content blockquote {
  border-left: 3px solid var(--yappr-border);
  color: var(--yappr-quote);
  margin: 0 0 1rem;
  padding: 0.25rem 0 0.25rem 0.9rem;
}

.yappr-embed-content a {
  color: var(--yappr-link);
  text-decoration: underline;
}

.yappr-embed-callout {
  border: 1px solid var(--yappr-border);
  border-radius: 10px;
  margin: 0 0 1rem;
  padding: 12px;
}

.yappr-embed-callout-title {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  margin: 0 0 6px;
  text-transform: uppercase;
}

.yappr-embed-callout[data-variant='info'] {
  background: color-mix(in srgb, #06b6d4 14%, var(--yappr-bg));
}

.yappr-embed-callout[data-variant='warning'] {
  background: color-mix(in srgb, #f59e0b 16%, var(--yappr-bg));
}

.yappr-embed-callout[data-variant='tip'] {
  background: color-mix(in srgb, #10b981 14%, var(--yappr-bg));
}

.yappr-embed-callout[data-variant='note'] {
  background: color-mix(in srgb, #8b5cf6 14%, var(--yappr-bg));
}

.yappr-embed-divider {
  margin: 1rem 0;
}

.yappr-embed-divider hr {
  border: 0;
  border-top: 1px solid var(--yappr-border);
}

.yappr-embed-divider[data-variant='dashed'] hr {
  border-top-style: dashed;
}

.yappr-embed-divider[data-variant='dots'] hr {
  border-top-style: dotted;
}

.yappr-embed-divider[data-variant='fade'] hr {
  border-top-color: transparent;
  background: linear-gradient(90deg, transparent, var(--yappr-border), transparent);
  height: 1px;
}

.yappr-embed-background-section {
  border: 1px solid var(--yappr-border);
  border-radius: 12px;
  margin: 0 0 1rem;
}

.yappr-embed-footer {
  border-top: 1px solid var(--yappr-border);
  color: var(--yappr-muted);
  font-size: 0.85rem;
  margin-top: 16px;
  padding-top: 10px;
}
`
