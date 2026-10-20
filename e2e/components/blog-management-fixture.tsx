import { useState } from 'react'
import { BlogSettings } from '@/components/blog/blog-settings'
import { MyBlogPosts } from '@/components/blog/my-blog-posts'
import { liveBlogIds, managedBlog, managementSnapshot, releaseManagementPage } from './blog-management-mocks'

declare global { interface Window { blogManagementSnapshot: typeof managementSnapshot; releaseManagementPage: typeof releaseManagementPage } }
window.blogManagementSnapshot = managementSnapshot
window.releaseManagementPage = releaseManagementPage
export function BlogManagementFixture() {
  const [deleted, setDeleted] = useState(false)
  return deleted
    ? <MyBlogPosts ownerId="owner" liveBlogIds={liveBlogIds} />
    : <BlogSettings blog={managedBlog} ownerId="owner" onDeleted={() => setDeleted(true)} />
}
