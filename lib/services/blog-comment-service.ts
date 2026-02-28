import { BaseDocumentService, type QueryOptions } from './document-service'
import { YAPPR_BLOG_CONTRACT_ID } from '@/lib/constants'
import type { BlogComment } from '@/lib/types'
import { identifierToBase58, requireIdentifierBytes } from './sdk-helpers'

export interface BlogCommentQueryOptions {
  limit?: number
  startAfter?: string
}

class BlogCommentService extends BaseDocumentService<BlogComment> {
  constructor() {
    super('blogComment', YAPPR_BLOG_CONTRACT_ID)
  }

  protected transformDocument(doc: Record<string, unknown>): BlogComment {
    const data = (doc.data || doc) as Record<string, unknown>

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date((doc.$createdAt || doc.createdAt || Date.now()) as number),
      blogPostId: identifierToBase58(data.blogPostId || doc.blogPostId) || '',
      blogPostOwnerId: identifierToBase58(data.blogPostOwnerId || doc.blogPostOwnerId) || '',
      content: (data.content || doc.content || '') as string,
    }
  }

  async createComment(
    ownerId: string,
    blogPostId: string,
    blogPostOwnerId: string,
    content: string
  ): Promise<BlogComment> {
    const trimmedContent = content.trim()
    if (!trimmedContent) {
      throw new Error('Comment content is required')
    }
    if (trimmedContent.length > 500) {
      throw new Error('Comment content exceeds 500 characters')
    }

    return this.create(ownerId, {
      blogPostId: requireIdentifierBytes(blogPostId, 'blogPostId'),
      blogPostOwnerId: requireIdentifierBytes(blogPostOwnerId, 'blogPostOwnerId'),
      content: trimmedContent,
    })
  }

  async deleteComment(commentId: string, ownerId: string): Promise<boolean> {
    const comment = await this.get(commentId)
    if (!comment || comment.ownerId !== ownerId) {
      return false
    }
    return this.delete(commentId, ownerId)
  }

  async getCommentsByPost(blogPostId: string, options: BlogCommentQueryOptions = {}): Promise<BlogComment[]> {
    const blogPostIdBytes = requireIdentifierBytes(blogPostId, 'blogPostId')
    const queryOptions: QueryOptions = {
      where: [['blogPostId', '==', blogPostIdBytes]],
      orderBy: [['$createdAt', 'asc']],
      limit: options.limit,
      startAfter: options.startAfter,
    }
    const result = await this.query(queryOptions)
    return result.documents
  }

  async getCommentsByOwner(ownerId: string, options: BlogCommentQueryOptions = {}): Promise<BlogComment[]> {
    const queryOptions: QueryOptions = {
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$createdAt', 'asc']],
      limit: options.limit,
      startAfter: options.startAfter,
    }
    const result = await this.query(queryOptions)
    return result.documents
  }
}

export const blogCommentService = new BlogCommentService()
