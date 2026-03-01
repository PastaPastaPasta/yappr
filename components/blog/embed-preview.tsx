'use client'

import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import type { BlogPost } from '@/lib/types'
import { EMBED_STYLES } from '@/lib/embed/embed-styles'
import { renderEmbedHtml } from '@/lib/embed/embed-renderer'
import type { EmbedTheme } from '@/lib/embed/embed-types'
import { APP_URL } from '@/lib/constants'

interface EmbedPreviewProps {
  post: BlogPost
  username: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function EmbedPreview({ post, username }: EmbedPreviewProps) {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<EmbedTheme>('light')
  const [copied, setCopied] = useState(false)

  const iframeSnippet = `<iframe src="${APP_URL}/embed/?post=${post.id}&owner=${post.ownerId}&theme=${theme}" width="100%" height="600" style="border:none"></iframe>`
  const scriptSnippet = `<div data-yappr-post="${post.id}" data-yappr-owner="${post.ownerId}" data-yappr-theme="${theme}"></div>\n<script src="${APP_URL}/embed.js"></script>`

  const html = useMemo(() => renderEmbedHtml(post.content), [post.content])

  const previewDoc = useMemo(() => {
    const createdLabel = post.createdAt.toLocaleDateString()

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${EMBED_STYLES}</style>
  </head>
  <body>
    <div class="yappr-embed" data-yappr-theme="${theme}">
      <article class="yappr-embed-article">
        <header class="yappr-embed-header">
          <h1 class="yappr-embed-title">${escapeHtml(post.title)}</h1>
          <p class="yappr-embed-meta">${escapeHtml(username)} • ${escapeHtml(createdLabel)}</p>
        </header>
        <div class="yappr-embed-content">${html}</div>
      </article>
    </div>
  </body>
</html>`
  }, [html, post.createdAt, post.title, theme, username])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`${iframeSnippet}\n\n${scriptSnippet}`)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="rounded-full border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
        >
          Embed
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[96vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-gray-700 bg-neutral-950 p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <Dialog.Title className="text-lg font-semibold">Embed this post</Dialog.Title>
              <Dialog.Description className="text-sm text-gray-400">
                Copy the code and paste it into any website.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="rounded-full p-1 text-gray-300 hover:bg-gray-800" aria-label="Close">
                <XMarkIcon className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              className={`rounded-full px-3 py-1 text-xs ${theme === 'light' ? 'bg-white text-black' : 'bg-gray-800 text-gray-200'}`}
              onClick={() => setTheme('light')}
            >
              Light
            </button>
            <button
              type="button"
              className={`rounded-full px-3 py-1 text-xs ${theme === 'dark' ? 'bg-white text-black' : 'bg-gray-800 text-gray-200'}`}
              onClick={() => setTheme('dark')}
            >
              Dark
            </button>
          </div>

          <div className="rounded-xl border border-gray-800 bg-black/30 p-2">
            <iframe
              title="Embed preview"
              srcDoc={previewDoc}
              className="h-[380px] w-full rounded-lg border border-gray-800 bg-white"
            />
          </div>

          <div className="mt-4 space-y-3">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-300">IFrame</p>
              <pre className="overflow-x-auto rounded-lg border border-gray-800 bg-black/50 p-3 text-xs text-gray-300">
                {iframeSnippet}
              </pre>
            </div>

            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-300">Script</p>
              <pre className="overflow-x-auto rounded-lg border border-gray-800 bg-black/50 p-3 text-xs text-gray-300">
                {scriptSnippet}
              </pre>
            </div>

            <Button type="button" variant="outline" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy embed code'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
