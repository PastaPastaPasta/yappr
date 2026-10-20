'use client'

import { useId, useState, type ReactNode } from 'react'
import { ChevronDownIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { SocialLink } from '@/lib/types'
import { LimitedInput, LimitedTextarea } from '@/components/ui/limited-text'
import { Switch } from '@/components/ui/switch'
import { PAYMENT_SCHEME_LABELS } from '@/components/ui/payment-icons'
import { SOCIAL_PLATFORMS, getPlatformLabel, getPlatformPlaceholder } from '@/components/profile/social-links-input'
import { fieldLimits } from '@/lib/field-limits'
import { textBytes } from '@/lib/text-limits'
import { APPROVED_PAYMENT_SCHEMES } from '@/lib/utils/payment-uri'
import { profileTextLimits } from '@/lib/profile/v10-profile'
import { rowKey, splitPaymentUri, type Keyed, type TipRow } from '@/lib/profile/edit-rows'
import type { TextLimits } from '@/lib/text-limits'
import { cn } from '@/lib/utils'

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

/** The text fields and the NSFW flag; links and tips are edited as rows. */
export type ProfileFields = Omit<ProfileDraft, 'paymentUris' | 'socialLinks'>

const MAX_ROWS = 10

/**
 * The default tip coin: Dash, written `dash:` as the wallets do on every
 * network (the address must be this build's network's). A saved `tdash:` tip
 * keeps its own row.
 */
export const DEFAULT_TIP_SCHEME = 'dash:'

/** A tip currency's name; this network's Dash is plain "Dash". */
export function tipSchemeLabel(scheme: string): string {
  return scheme === DEFAULT_TIP_SCHEME ? 'Dash' : PAYMENT_SCHEME_LABELS[scheme] ?? scheme
}

const FIELD =
  'h-auto rounded-lg border-gray-300 bg-transparent px-3 py-2.5 text-[15px] focus-visible:ring-yappr-500 focus-visible:ring-offset-0 dark:border-gray-700 dark:bg-transparent dark:focus-visible:ring-yappr-500'
const SELECT =
  'w-[7.5rem] shrink-0 rounded-lg border border-gray-300 bg-transparent px-2 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500 dark:border-gray-700 dark:bg-neutral-900 disabled:opacity-50'

/** What is left of a stored field's limits once `prefix` (a scheme or platform) takes its share. */
function afterPrefix(limits: TextLimits, prefix: string, fallback: number): TextLimits {
  return { maxLength: (limits.maxLength ?? fallback) - [...prefix].length, maxBytes: (limits.maxBytes ?? fallback) - textBytes(prefix) }
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-gray-600 dark:text-gray-400">{label}</label>
      {children}
    </div>
  )
}

interface ProfileEditFormProps {
  fields: ProfileFields
  onFieldsChange: (fields: ProfileFields) => void
  links: Keyed<SocialLink>[]
  onLinksChange: (links: Keyed<SocialLink>[]) => void
  linkErrors: (string | null)[]
  tips: Keyed<TipRow>[]
  onTipsChange: (tips: Keyed<TipRow>[]) => void
  tipErrors: (string | null)[]
  /** Errors show for every row once a save was attempted, else only for rows left. */
  showAllErrors: boolean
  extrasOpen: boolean
  onExtrasOpenChange: (open: boolean) => void
  disabled: boolean
}

/** The fields of the edit-profile dialog; the dialog owns the state and saves it. */
export function ProfileEditForm({
  fields, onFieldsChange, links, onLinksChange, linkErrors, tips, onTipsChange, tipErrors,
  showAllErrors, extrasOpen, onExtrasOpenChange, disabled,
}: ProfileEditFormProps) {
  const id = useId()
  const set = <K extends keyof ProfileFields>(key: K, value: ProfileFields[K]) => onFieldsChange({ ...fields, [key]: value })
  // v10 keeps the name and bio in the DashPay profile, which caps them lower.
  const limits = profileTextLimits()
  const [touched, setTouched] = useState<Set<number>>(() => new Set())
  const touch = (key: number) => setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  const errorFor = (key: number, error: string | null) => (showAllErrors || touched.has(key) ? error : null)

  const linkLimits = fieldLimits('social', 'yapprProfile', 'socialLinks[]')
  const tipLimits = fieldLimits('social', 'yapprProfile', 'paymentUris[]')
  const tipSchemes = APPROVED_PAYMENT_SCHEMES.filter((scheme) =>
    scheme === DEFAULT_TIP_SCHEME || !['dash:', 'tdash:'].includes(scheme) || tips.some((tip) => tip.scheme === scheme))

  const added = links.filter((l) => l.handle.trim()).length + tips.filter((t) => t.address.trim()).length
  const extrasId = `${id}-extras`

  const updateLink = (key: number, patch: Partial<SocialLink>) =>
    onLinksChange(links.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  const updateTip = (key: number, patch: Partial<TipRow>) =>
    onTipsChange(tips.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  return (
    <div className="space-y-4">
      <Field label="Name" htmlFor={`${id}-name`}>
        <LimitedInput limits={{ maxLength: limits.displayName }} id={`${id}-name`} type="text" value={fields.displayName} onChange={(e) => set('displayName', e.target.value)} disabled={disabled} className={FIELD} />
      </Field>
      <Field label="Bio" htmlFor={`${id}-bio`}>
        <LimitedTextarea limits={{ maxLength: limits.bio }} id={`${id}-bio`} value={fields.bio} onChange={(e) => set('bio', e.target.value)} disabled={disabled} className={cn(FIELD, 'min-h-[88px] resize-none')} rows={3} />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Pronouns" htmlFor={`${id}-pronouns`}>
          <LimitedInput contract="social" document="yapprProfile" field="pronouns" id={`${id}-pronouns`} type="text" value={fields.pronouns} onChange={(e) => set('pronouns', e.target.value)} placeholder="e.g. she/her" disabled={disabled} className={FIELD} />
        </Field>
        <Field label="Location" htmlFor={`${id}-location`}>
          <LimitedInput contract="social" document="yapprProfile" field="location" id={`${id}-location`} type="text" value={fields.location} onChange={(e) => set('location', e.target.value)} disabled={disabled} className={FIELD} />
        </Field>
      </div>
      <Field label="Website" htmlFor={`${id}-website`}>
        <LimitedInput contract="social" document="yapprProfile" field="website" id={`${id}-website`} type="url" inputMode="url" autoComplete="url" value={fields.website} onChange={(e) => set('website', e.target.value)} placeholder="yoursite.com" disabled={disabled} className={FIELD} />
      </Field>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800">
        <button
          type="button"
          aria-expanded={extrasOpen}
          aria-controls={extrasId}
          onClick={() => onExtrasOpenChange(!extrasOpen)}
          className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
        >
          <span className="font-medium">Links and tips</span>
          <span className="flex items-center gap-2 text-sm text-gray-500">
            {added > 0 && <span>{added} added</span>}
            <ChevronDownIcon aria-hidden="true" className={cn('h-4 w-4 transition-transform', extrasOpen && 'rotate-180')} />
          </span>
        </button>
        {extrasOpen && (
          <div id={extrasId} className="space-y-5 border-t border-gray-200 px-4 pb-4 pt-3 dark:border-gray-800">
            <RowList
              title="Links"
              addLabel="Add link"
              canAdd={links.length < MAX_ROWS}
              disabled={disabled}
              onAdd={() => onLinksChange([...links, { key: rowKey(), platform: 'twitter', handle: '' }])}
            >
              {links.map((row, index) => (
                  <Row
                    key={row.key}
                    error={errorFor(row.key, linkErrors[index] ?? null)}
                    removeLabel={`Remove ${getPlatformLabel(row.platform)} link`}
                    onRemove={() => onLinksChange(links.filter((l) => l.key !== row.key))}
                    disabled={disabled}
                  >
                    <select aria-label="Link type" value={row.platform} onChange={(e) => updateLink(row.key, { platform: e.target.value })} disabled={disabled} className={SELECT}>
                      {SOCIAL_PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      {!SOCIAL_PLATFORMS.some((p) => p.id === row.platform) && <option value={row.platform}>{getPlatformLabel(row.platform)}</option>}
                    </select>
                    <LimitedInput
                      limits={afterPrefix(linkLimits, `${row.platform}:`, 256)}
                      aria-label={`${getPlatformLabel(row.platform)} handle`}
                      type="text"
                      value={row.handle}
                      onChange={(e) => updateLink(row.key, { handle: e.target.value })}
                      onBlur={() => touch(row.key)}
                      placeholder={getPlatformPlaceholder(row.platform)}
                      disabled={disabled}
                      className={FIELD}
                    />
                  </Row>
              ))}
            </RowList>

            <RowList
              title="Tip addresses"
              addLabel="Add address"
              canAdd={tips.length < MAX_ROWS}
              disabled={disabled}
              onAdd={() => onTipsChange([...tips, { key: rowKey(), scheme: DEFAULT_TIP_SCHEME, address: '' }])}
            >
              {tips.map((row, index) => (
                <Row
                  key={row.key}
                  error={errorFor(row.key, tipErrors[index] ?? null)}
                  removeLabel={`Remove ${tipSchemeLabel(row.scheme)} address`}
                  onRemove={() => onTipsChange(tips.filter((t) => t.key !== row.key))}
                  disabled={disabled}
                >
                  <select aria-label="Currency" value={row.scheme} onChange={(e) => updateTip(row.key, { scheme: e.target.value })} disabled={disabled} className={SELECT}>
                    {tipSchemes.map((scheme) => <option key={scheme} value={scheme}>{tipSchemeLabel(scheme)}</option>)}
                  </select>
                  <LimitedInput
                    limits={afterPrefix(tipLimits, row.scheme, 512)}
                    aria-label={`${tipSchemeLabel(row.scheme)} address`}
                    type="text"
                    value={row.address}
                    onChange={(e) => {
                      // A pasted `bitcoin:bc1…` picks its own currency.
                      const pasted = splitPaymentUri(e.target.value)
                      updateTip(row.key, pasted ?? { address: e.target.value })
                    }}
                    onBlur={() => touch(row.key)}
                    placeholder="Address"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={disabled}
                    className={cn(FIELD, 'font-mono text-sm')}
                  />
                </Row>
              ))}
            </RowList>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 py-1">
        <label htmlFor={`${id}-nsfw`} className="min-w-0 cursor-pointer">
          <span className="block font-medium">Adult content</span>
          <span className="block text-sm text-gray-500">People see a warning before viewing your profile.</span>
        </label>
        <Switch id={`${id}-nsfw`} checked={fields.nsfw} onCheckedChange={(checked) => set('nsfw', checked)} disabled={disabled} />
      </div>
    </div>
  )
}

function RowList({ title, addLabel, canAdd, disabled, onAdd, children }: {
  title: string
  addLabel: string
  canAdd: boolean
  disabled: boolean
  onAdd: () => void
  children: ReactNode
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400">{title}</h3>
      {children}
      {canAdd && (
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full py-1 text-sm font-medium text-yappr-600 hover:underline disabled:opacity-50 dark:text-yappr-400"
        >
          <PlusIcon aria-hidden="true" className="h-4 w-4" />
          {addLabel}
        </button>
      )}
    </div>
  )
}

function Row({ error, removeLabel, onRemove, disabled, children }: {
  error: string | null
  removeLabel: string
  onRemove: () => void
  disabled: boolean
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-start gap-2">
        {children}
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          disabled={disabled}
          className="mt-1.5 shrink-0 rounded-full p-1.5 text-gray-500 hover:bg-gray-100 hover:text-red-500 disabled:opacity-50 dark:hover:bg-gray-800"
        >
          <XMarkIcon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-sm text-red-500">{error}</p>}
    </div>
  )
}
