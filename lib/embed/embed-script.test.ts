import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const script = readFileSync(resolve(__dirname, '../../public/embed.js'), 'utf8')

function embeddedUrl(scriptUrl: string | null, loading = false): string {
  const attributes: Record<string, string> = { 'data-yappr-post': 'postId', 'data-yappr-owner': 'ownerId', 'data-yappr-theme': 'dark' }
  let url = ''
  let onReady: (() => void) | undefined
  const document = {
    currentScript: scriptUrl ? { src: scriptUrl } : null,
    readyState: loading ? 'loading' : 'complete',
    querySelectorAll: () => [{
      getAttribute: (name: string) => attributes[name],
      setAttribute: () => {},
      appendChild: (iframe: { src: string }) => { url = iframe.src },
    }],
    createElement: () => ({ style: {}, setAttribute: () => {} }),
    addEventListener: (_name: string, callback: () => void) => { onReady = callback },
  }
  runInNewContext(script, { document, URL, encodeURIComponent })
  document.currentScript = null
  onReady?.()
  return url
}

describe('published embed loader', () => {
  it.each(['', '/devnet', '/testing', '/nested/deployment'])(
    'loads the iframe beside the script for deployment %j', (basePath) => {
      expect(embeddedUrl(`https://yap.pr${basePath}/embed.js`)).toBe(
        `https://yap.pr${basePath}/embed/?post=postId&owner=ownerId&theme=dark`
      )
    }
  )

  it('retains the script deployment until DOMContentLoaded and ignores cache query parameters', () => {
    expect(embeddedUrl('https://yap.pr/devnet/embed.js?v=2', true)).toBe(
      'https://yap.pr/devnet/embed/?post=postId&owner=ownerId&theme=dark'
    )
  })

  it('retains the canonical fallback when there is no external script URL', () => {
    expect(embeddedUrl(null)).toBe('https://yap.pr/embed/?post=postId&owner=ownerId&theme=dark')
  })
})
