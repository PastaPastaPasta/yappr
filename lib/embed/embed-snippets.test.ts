import { describe, expect, it } from 'vitest'
import { createEmbedSnippets } from './embed-snippets'

const post = { id: 'publishedPost', ownerId: 'blogOwner' }

describe('createEmbedSnippets', () => {
  it.each(['', '/devnet', '/testing', '/nested/deployment'])(
    'keeps both snippet URLs on deployment %j', (basePath) => {
      const { iframeSnippet, scriptSnippet } = createEmbedSnippets(post, 'light', 'https://yap.pr', basePath)
      expect(iframeSnippet).toContain(`src="https://yap.pr${basePath}/embed/?post=publishedPost&owner=blogOwner&theme=light"`)
      expect(scriptSnippet).toContain(`src="https://yap.pr${basePath}/embed.js"`)
      expect(scriptSnippet).toContain('data-yappr-post="publishedPost"')
      expect(scriptSnippet).toContain('data-yappr-owner="blogOwner"')
    }
  )

  it('preserves the selected theme and handles trailing slashes', () => {
    const { iframeSnippet, scriptSnippet } = createEmbedSnippets(post, 'dark', 'https://yap.pr/', '/devnet/')
    expect(iframeSnippet).toContain('https://yap.pr/devnet/embed/?post=publishedPost&owner=blogOwner&theme=dark')
    expect(scriptSnippet).toContain('data-yappr-theme="dark"')
    expect(scriptSnippet).toContain('src="https://yap.pr/devnet/embed.js"')
  })
})
