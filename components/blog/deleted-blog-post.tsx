'use client'

import Link from 'next/link'
import { TrashIcon } from '@heroicons/react/24/outline'
import type { Blog } from '@/lib/types'
import { getBlogUrl } from '@/lib/blog/content-utils'

/**
 * What a reader sees at a deleted post's URL (a blog v7 tombstone): the post
 * is gone, its link still resolves, and it takes no comments (the tombstone
 * stores comments off, and consensus refuses a comment on it).
 */
export function DeletedBlogPost({ blog }: { blog: Blog }) {
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-gray-300 px-6 py-12 text-center dark:border-gray-700" data-testid="deleted-blog-post">
      <TrashIcon className="mx-auto h-8 w-8 text-gray-400" aria-hidden="true" />
      <h1 className="mt-3 text-lg font-semibold text-gray-900 dark:text-white">This post was deleted</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Its author removed it from {blog.name}. It no longer takes comments.
      </p>
      <Link
        href={getBlogUrl(blog.id)}
        className="mt-4 inline-block text-sm font-medium text-yappr-700 hover:text-yappr-800 dark:text-yappr-400 dark:hover:text-yappr-300"
      >
        More from {blog.name}
      </Link>
    </div>
  )
}
