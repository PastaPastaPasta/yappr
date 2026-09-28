import type { Post } from '@/lib/types'
import { createModalStore } from '@/lib/modal-store'

interface ReportPostPayload {
  post: Post | null
}

/** The dialog in which a reader reports a post or reply to the moderators, or withdraws their report. */
export const useReportPostModal = createModalStore<ReportPostPayload, [post: Post]>({ post: null }, (post) => ({ post }))
