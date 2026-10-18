import type { Blog, BlogPost } from '@/lib/types'
export const managedBlog: Blog = { id: 'blog', ownerId: 'owner', name: 'Retained blog', createdAt: new Date(1700000000000) }
const post: BlogPost = { id: 'post', ownerId: 'owner', blogId: 'blog', title: 'Retained article', slug: 'retained', content: [], createdAt: new Date(1700000000000), publishedAt: 1700000000000 }
const scenario = new URLSearchParams(window.location.search).get('scenario')
const paged = scenario === 'paged' || scenario === 'slow-paged'
let releasePage: (() => void) | undefined
export function releaseManagementPage() { releasePage?.() }
let blogDeleted = false
let postDeleted = false
export const blogService = {
  async deleteBlog() { blogDeleted = true; return true },
}
export const blogPostService = {
  async getOwnerPostsPage(_ownerId: string, options?: { startAfter?: string }) {
    if (scenario === 'slow-paged' && options?.startAfter) {
      await new Promise<void>((resolve) => { releasePage = resolve })
      return { posts: [{ ...post, id: 'next', title: 'Next article' }] }
    }
    if (postDeleted && options?.startAfter === post.id) throw new Error('Cursor left the live index')
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
export function managementSnapshot() { return { blogDeleted, postDeleted } }
export function ProfileImageUpload() { return null }
export function reportModerationRefusal() { return false }
