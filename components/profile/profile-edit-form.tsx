'use client'

import type { SocialLink } from '@/lib/types'
import { PaymentUriInput } from '@/components/profile/payment-uri-input'
import { SocialLinksInput } from '@/components/profile/social-links-input'

export interface ProfileDraft {
  displayName: string
  bio: string
  location: string
  website: string
  pronouns: string
  nsfw: boolean
  paymentUris: string[]
  socialLinks: SocialLink[]
}

export const EMPTY_DRAFT: ProfileDraft = {
  displayName: '',
  bio: '',
  location: '',
  website: '',
  pronouns: '',
  nsfw: false,
  paymentUris: [],
  socialLinks: [],
}

interface ProfileEditFormProps {
  draft: ProfileDraft
  onChange: (draft: ProfileDraft) => void
  disabled: boolean
}

const INPUT =
  'mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {children}
    </div>
  )
}

/** The in-place editor for your own profile; the page owns the draft and saves it. */
export function ProfileEditForm({ draft, onChange, disabled }: ProfileEditFormProps) {
  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => onChange({ ...draft, [key]: value })
  return (
    <div className="space-y-4">
      <Field label="Name">
        <input type="text" value={draft.displayName} onChange={(e) => set('displayName', e.target.value)} className={INPUT} maxLength={50} />
      </Field>
      <Field label="Pronouns">
        <input
          type="text"
          value={draft.pronouns}
          onChange={(e) => set('pronouns', e.target.value)}
          placeholder="e.g. she/her"
          className={INPUT}
          maxLength={20}
        />
      </Field>
      <Field label="Bio">
        <textarea value={draft.bio} onChange={(e) => set('bio', e.target.value)} className={`${INPUT} resize-none`} rows={3} maxLength={160} />
        <p className="text-xs text-gray-500 mt-1">{draft.bio.length}/160</p>
      </Field>
      <Field label="Location">
        <input type="text" value={draft.location} onChange={(e) => set('location', e.target.value)} className={INPUT} maxLength={50} />
      </Field>
      <Field label="Website">
        <input
          type="text"
          value={draft.website}
          onChange={(e) => set('website', e.target.value)}
          placeholder="https://example.com"
          className={INPUT}
          maxLength={200}
        />
      </Field>

      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
        <PaymentUriInput uris={draft.paymentUris} onChange={(uris) => set('paymentUris', uris)} disabled={disabled} />
      </div>

      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
        <SocialLinksInput links={draft.socialLinks} onChange={(links) => set('socialLinks', links)} disabled={disabled} />
      </div>

      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.nsfw}
            onChange={(e) => set('nsfw', e.target.checked)}
            className="w-4 h-4 text-yappr-500 rounded focus:ring-yappr-500"
          />
          <div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">NSFW Content</span>
            <p className="text-xs text-gray-500">Mark your profile as containing adult content</p>
          </div>
        </label>
      </div>
    </div>
  )
}
