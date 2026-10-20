import type { Blog, BlogPost } from '@/lib/types'
export const managedBlog: Blog = { id: 'blog', ownerId: 'owner', name: 'Retained blog', createdAt: new Date(1700000000000) }
const post: BlogPost = { id: 'post', ownerId: 'owner', blogId: 'blog', title: 'Retained article', slug: 'retained', content: [], createdAt: new Date(1700000000000), publishedAt: 1700000000000 }
const scenario = new URLSearchParams(window.location.search).get('scenario')
const paged = scenario === 'paged' || scenario === 'slow-paged' || scenario === 'slow-refresh'
let releasePage: (() => void) | undefined
export function releaseManagementPage() { releasePage?.() }
let blogDeleted = false
let postDeleted = false
let firstReadFailed = false
export const blogService = {
  async deleteBlog() { blogDeleted = true; return true },
}
export const blogPostService = {
  async getOwnerPostsPage(_ownerId: string, options?: { startAfter?: string }) {
    if (scenario === 'capped') {
      // Six pages of live-blog posts, more than one read covers, before the retained post.
      const page = options?.startAfter ? Number(options.startAfter.slice('live-'.length)) + 1 : 0
      if (page < 6) return { posts: [{ ...post, id: `live-${page}`, blogId: 'live', title: `Live article ${page}` }], nextCursor: `live-${page}` }
      return { posts: [post] }
    }
    if (scenario === 'first-read-fails' && !firstReadFailed) {
      firstReadFailed = true
      throw new Error('DAPI timeout')
    }
    if (scenario === 'live-first' || scenario === 'all-live') {
      // The first page holds only posts from a live blog; the next one (if any) a retained post.
      if (!options?.startAfter) return { posts: [{ ...post, id: 'live', blogId: 'live', title: 'Live article' }], nextCursor: 'live' }
      return scenario === 'live-first' ? { posts: [post] } : { posts: [] }
    }
    if (scenario === 'slow-paged' && options?.startAfter) {
      await new Promise<void>((resolve) => { releasePage = resolve })
      return { posts: [{ ...post, id: 'next', title: 'Next article' }] }
    }
    if (postDeleted && options?.startAfter === post.id) throw new Error('Cursor left the live index')
    if (scenario === 'slow-refresh' && postDeleted) await new Promise<void>((resolve) => { releasePage = resolve })
    return postDeleted
      ? { posts: paged ? [{ ...post, id: 'next', title: 'Next article' }] : [] }
      : { posts: [post], nextCursor: paged ? post.id : undefined }
  },
  async deletePost(id: string, ownerId: string) {
    if (!blogDeleted || id !== post.id || ownerId !== post.ownerId) throw new Error('Wrong retraction sequence')
    postDeleted = true
    return true
  },
}
export const liveBlogIds = scenario === 'live-first' || scenario === 'all-live' || scenario === 'capped' ? new Set(['live']) : undefined
export function managementSnapshot() { return { blogDeleted, postDeleted } }
export function ProfileImageUpload() { return null }
export function reportModerationRefusal() { return false }
