import { BlogEditor } from '@/components/blog/blog-editor'

declare global {
  interface Window {
    blogEditorBlocks: unknown[]
    pastedScriptRan?: boolean
  }
}
window.blogEditorBlocks = []

/** The real BlockNote blog editor; image uploads are stubbed (blog-editor-mocks.ts). */
export function BlogEditorFixture() {
  return <BlogEditor onChange={(blocks) => { window.blogEditorBlocks = blocks }} />
}
