'use client'

import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeftIcon, CameraIcon } from '@heroicons/react/24/outline'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/ui/avatar-image'
import { BannerImage } from '@/components/ui/banner-image'
import { AvatarCustomization } from '@/components/settings/avatar-customization'
import { BannerCustomization } from '@/components/settings/banner-customization'
import { getPlatformLabel } from '@/components/profile/social-links-input'
import {
  DEFAULT_TIP_SCHEME, ProfileEditForm, tipSchemeLabel, type ProfileDraft, type ProfileFields,
} from '@/components/profile/profile-edit-form'
import {
  checkLinkRows, checkTipRows, normalizeWebsite, rowKey, tipRowFromUri, type Keyed, type TipRow,
} from '@/lib/profile/edit-rows'
import type { SocialLink } from '@/lib/types'
import { fieldLimits } from '@/lib/field-limits'

interface EditProfileModalProps {
  /** The profile to edit; null keeps the dialog closed. */
  initial: ProfileDraft | null
  userId: string
  bannerUri?: string
  /** Bumped after an avatar or banner save so the previews refetch. */
  avatarKey: number
  bannerKey: number
  isSaving: boolean
  /** No profile exists yet, so Save writes one even with nothing changed. */
  createsProfile: boolean
  onCancel: () => void
  onSave: (draft: ProfileDraft) => void
  onAvatarSaved: () => void
  onBannerSaved: (bannerUrl: string | null) => void
}

/** The edit-profile dialog: a full-height sheet on phones, a centred card elsewhere. */
export function EditProfileModal({ initial, ...props }: EditProfileModalProps) {
  // Escape and the overlay go through the dialog, which may ask to discard first.
  const requestClose = useRef<() => void>(() => {})
  // The panel animates out after `initial` clears; it keeps the last profile meanwhile.
  const [shown, setShown] = useState(initial)
  if (initial && initial !== shown) setShown(initial)
  return (
    <Modal
      open={initial !== null}
      onOpenChange={(open) => { if (!open) requestClose.current() }}
      variant="sheet"
      overlayClassName="items-stretch px-0 sm:items-center sm:px-4"
      className="flex h-[100dvh] max-w-[600px] flex-col rounded-none sm:h-auto sm:max-h-[90vh] sm:rounded-2xl"
    >
      {/* While it animates out, it takes no more input (a stray Save would write again). */}
      {shown && <EditProfileDialog initial={shown} requestCloseRef={requestClose} {...props} isSaving={props.isSaving || initial === null} />}
    </Modal>
  )
}

type View = 'form' | 'avatar' | 'banner'

const SUBVIEW_TITLES: Record<View, string | null> = { form: null, avatar: 'Edit avatar', banner: 'Edit banner' }

/** Equal for drafts that would save the same profile. */
function draftKey(d: ProfileDraft): string {
  return JSON.stringify([
    d.displayName, d.bio, d.location, d.website, d.pronouns, d.nsfw, d.paymentUris,
    d.socialLinks.map((link) => [link.platform, link.handle]),
  ])
}

function fieldsOf({ displayName, bio, location, website, pronouns, nsfw }: ProfileDraft): ProfileFields {
  return { displayName, bio, location, website, pronouns, nsfw }
}

function EditProfileDialog({
  initial, requestCloseRef, userId, bannerUri, avatarKey, bannerKey, isSaving, createsProfile, onCancel, onSave, onAvatarSaved, onBannerSaved,
}: Omit<EditProfileModalProps, 'initial'> & { initial: ProfileDraft; requestCloseRef: MutableRefObject<() => void> }) {
  const [fields, setFields] = useState<ProfileFields>(() => fieldsOf(initial))
  const [links, setLinks] = useState<Keyed<SocialLink>[]>(() => initial.socialLinks.map((link) => ({ key: rowKey(), ...link })))
  const [tips, setTips] = useState<Keyed<TipRow>[]>(() => initial.paymentUris.map((uri) => ({ key: rowKey(), ...tipRowFromUri(uri, DEFAULT_TIP_SCHEME) })))
  const [extrasOpen, setExtrasOpen] = useState(false)
  const [showAllErrors, setShowAllErrors] = useState(false)
  const [view, setView] = useState<View>('form')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const websiteMax = fieldLimits('social', 'yapprProfile', 'website').maxLength
  const [initialKey] = useState(() => draftKey({ ...initial, website: normalizeWebsite(initial.website, websiteMax) }))

  const linkCheck = checkLinkRows(links, getPlatformLabel, initial.socialLinks)
  const tipCheck = checkTipRows(tips, tipSchemeLabel, initial.paymentUris)
  const hasErrors = [...linkCheck.errors, ...tipCheck.errors].some(Boolean)
  const next: ProfileDraft = {
    ...fields,
    website: normalizeWebsite(fields.website, websiteMax),
    socialLinks: linkCheck.values,
    paymentUris: tipCheck.values,
  }
  const dirty = draftKey(next) !== initialKey

  const requestClose = () => {
    if (isSaving) return
    if (view !== 'form') setView('form')
    else if (confirmDiscard) setConfirmDiscard(false)
    else if (dirty) setConfirmDiscard(true)
    else onCancel()
  }
  useEffect(() => {
    requestCloseRef.current = requestClose
  })

  // While the discard prompt is up, the form behind it takes no focus or clicks.
  const formRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (formRef.current) formRef.current.inert = confirmDiscard
  }, [confirmDiscard])
  const discardTitleId = useId()

  const save = () => {
    if (hasErrors) {
      setShowAllErrors(true)
      setExtrasOpen(true)
      return
    }
    if (!dirty && !createsProfile) onCancel()
    else onSave(next)
  }

  const subview = SUBVIEW_TITLES[view]

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={formRef} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-2 py-2 dark:border-gray-800 sm:px-3">
          {subview ? (
            <button type="button" aria-label="Back" onClick={() => setView('form')} className="rounded-full p-2 hover:bg-gray-100 dark:hover:bg-gray-800">
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
          ) : (
            <Button variant="ghost" size="sm" onClick={requestClose} disabled={isSaving} className="text-sm">
              Cancel
            </Button>
          )}
          <Dialog.Title className="flex-1 truncate text-center text-base font-bold">{subview ?? 'Edit profile'}</Dialog.Title>
          <Dialog.Description className="sr-only">Change your name, bio, pictures and links.</Dialog.Description>
          {subview ? (
            <span className="w-9" aria-hidden="true" />
          ) : (
            <Button size="sm" onClick={save} disabled={isSaving} className="min-w-[4.5rem] text-sm font-bold">
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          )}
        </div>

        <div data-testid="edit-profile-body" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {view === 'avatar' && (
            <div className="p-4">
              <AvatarCustomization compact onSave={() => { onAvatarSaved(); setView('form') }} />
            </div>
          )}
          {view === 'banner' && (
            <div className="p-4">
              <BannerCustomization initialBannerUrl={bannerUri} onSave={(url) => { onBannerSaved(url); setView('form') }} />
            </div>
          )}
          {view === 'form' && (
            <>
              <div className="relative">
                <div className="relative h-32 sm:h-40">
                  <BannerImage key={bannerKey} userId={userId} preloadedUrl={bannerUri} className="h-full w-full" fallbackGradient />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                    <ImageButton label="Change banner" onClick={() => setView('banner')} disabled={isSaving} />
                  </div>
                </div>
                <div className="absolute -bottom-10 left-4 h-20 w-20 rounded-full bg-white p-1 dark:bg-neutral-900">
                  <div className="relative h-full w-full overflow-hidden rounded-full">
                    <UserAvatar key={avatarKey} userId={userId} alt="Your avatar" size="full" />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                      <ImageButton label="Change avatar" onClick={() => setView('avatar')} disabled={isSaving} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="px-4 pb-6 pt-14">
                <ProfileEditForm
                  fields={fields}
                  onFieldsChange={setFields}
                  links={links}
                  onLinksChange={setLinks}
                  linkErrors={linkCheck.errors}
                  tips={tips}
                  onTipsChange={setTips}
                  tipErrors={tipCheck.errors}
                  showAllErrors={showAllErrors}
                  extrasOpen={extrasOpen}
                  onExtrasOpenChange={setExtrasOpen}
                  disabled={isSaving}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {confirmDiscard && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-6">
          <div role="alertdialog" aria-modal="true" aria-labelledby={discardTitleId} className="w-full max-w-xs rounded-2xl bg-white p-5 shadow-xl dark:bg-neutral-900">
            <h3 id={discardTitleId} className="mb-4 text-center text-lg font-bold">Discard changes?</h3>
            <div className="space-y-2">
              <Button variant="destructive" className="w-full rounded-full" onClick={onCancel}>Discard</Button>
              <Button variant="outline" className="w-full rounded-full" onClick={() => setConfirmDiscard(false)} autoFocus>Keep editing</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ImageButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded-full bg-black/60 p-2.5 text-white transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
    >
      <CameraIcon className="h-5 w-5" />
    </button>
  )
}
