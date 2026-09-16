import type { BlogPost } from '@/lib/types'
import type { EmbedTheme } from './embed-types'

export function createEmbedSnippets(
  post: Pick<BlogPost, 'id' | 'ownerId'>,
  theme: EmbedTheme,
  appUrl: string,
  basePath: string,
): { iframeSnippet: string; scriptSnippet: string } {
  const deploymentUrl = `${appUrl.replace(/\/+$/, '')}${basePath.replace(/\/+$/, '')}`
  const iframeSnippet = `<iframe src="${deploymentUrl}/embed/?post=${post.id}&owner=${post.ownerId}&theme=${theme}" width="100%" height="600" style="border:none"></iframe>`
  const scriptSnippet = `<div data-yappr-post="${post.id}" data-yappr-owner="${post.ownerId}" data-yappr-theme="${theme}"></div>\n<script src="${deploymentUrl}/embed.js"></script>`
  return { iframeSnippet, scriptSnippet }
}
