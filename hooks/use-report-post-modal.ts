import type { TargetKind } from '@/lib/contract-topology'
import type { Post } from '@/lib/types'
import { createModalStore } from '@/lib/modal-store'

/** What the report dialog is about: a post or reply, or (v13) an identity's profile. */
export type ReportSubject =
  | { kind: TargetKind; post: Post }
  | { kind: 'profile'; identityId: string; name: string }

interface ReportPayload {
  subject: ReportSubject | null
}

/** The dialog in which a reader reports a post, a reply or a profile to the moderators, or withdraws their report. */
export const useReportPostModal = createModalStore<ReportPayload, [subject: ReportSubject]>({ subject: null }, (subject) => ({ subject }))
