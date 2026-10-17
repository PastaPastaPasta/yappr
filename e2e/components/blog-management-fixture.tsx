import { useState } from 'react'
import { BlogSettings } from '@/components/blog/blog-settings'
import { MyBlogPosts } from '@/components/blog/my-blog-posts'
import { managedBlog, managementSnapshot } from './blog-management-mocks'

declare global { interface Window { blogManagementSnapshot: typeof managementSnapshot } }
window.blogManagementSnapshot = managementSnapshot
export function BlogManagementFixture() {
  const [deleted, setDeleted] = useState(false)
  return deleted
    ? <MyBlogPosts ownerId="owner" />
    : <BlogSettings blog={managedBlog} ownerId="owner" onDeleted={() => setDeleted(true)} />
}
