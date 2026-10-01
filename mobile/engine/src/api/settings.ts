import { useSettingsStore, type NotificationSettings, type PayWith, type SensitiveContentMode } from '@/lib/store'
import { RpcError } from '../protocol/envelope'

/**
 * The user preferences lib itself reads (`yappr-settings`, lib/store.ts),
 * read and written through the same zustand store web uses, so services see
 * the change at once and `persist` writes it through to the host. They are
 * device-wide: account switches and sign-out keep them (PRD SET).
 */
export interface SettingsDTO {
  linkPreviewsEnabled: boolean
  gateMediaFromNonFollowed: boolean
  sendReadReceipts: boolean
  sensitiveContentMode: SensitiveContentMode
  notificationSettings: NotificationSettings
  payWith: PayWith
  feedLanguage: string
}

export type SettingsPatch = Partial<Omit<SettingsDTO, 'notificationSettings'> & { notificationSettings: Partial<NotificationSettings> }>

const FIELDS = [
  'linkPreviewsEnabled', 'gateMediaFromNonFollowed', 'sendReadReceipts', 'sensitiveContentMode', 'notificationSettings', 'payWith', 'feedLanguage',
] as const satisfies readonly (keyof SettingsDTO)[]
const SENSITIVE_MODES: readonly SensitiveContentMode[] = ['blur', 'show', 'hide']
const PAY_WITH: readonly PayWith[] = ['yapp', 'credits']
const NOTIFICATION_KEYS: readonly (keyof NotificationSettings)[] = ['likes', 'reposts', 'replies', 'follows', 'mentions', 'messages', 'blogPosts']
/** BCP 47-ish language tag, as web's feed-language select produces (`en`, `pt`, `zh`). */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

function read(): SettingsDTO {
  const state = useSettingsStore.getState()
  return {
    linkPreviewsEnabled: state.linkPreviewsEnabled,
    gateMediaFromNonFollowed: state.gateMediaFromNonFollowed,
    sendReadReceipts: state.sendReadReceipts,
    sensitiveContentMode: state.sensitiveContentMode,
    notificationSettings: { ...state.notificationSettings },
    payWith: state.payWith,
    feedLanguage: state.feedLanguage,
  }
}

function invalid(field: string): never {
  throw new RpcError(`Invalid setting: ${field}`, 'BAD_REQUEST')
}

function assertBoolean(field: string, value: unknown): void {
  if (typeof value !== 'boolean') invalid(field)
}

/** Validate the whole patch before applying any of it, so a bad field changes nothing. */
function validate(patch: SettingsPatch): void {
  if (typeof patch !== 'object' || patch === null) invalid('patch')
  for (const key of Object.keys(patch)) if (!(FIELDS as readonly string[]).includes(key)) invalid(key)
  for (const key of ['linkPreviewsEnabled', 'gateMediaFromNonFollowed', 'sendReadReceipts'] as const) {
    if (patch[key] !== undefined) assertBoolean(key, patch[key])
  }
  if (patch.sensitiveContentMode !== undefined && !SENSITIVE_MODES.includes(patch.sensitiveContentMode)) invalid('sensitiveContentMode')
  if (patch.payWith !== undefined && !PAY_WITH.includes(patch.payWith)) invalid('payWith')
  if (patch.feedLanguage !== undefined && (typeof patch.feedLanguage !== 'string' || !LANGUAGE_TAG.test(patch.feedLanguage))) invalid('feedLanguage')
  if (patch.notificationSettings !== undefined) {
    const notifications = patch.notificationSettings
    if (typeof notifications !== 'object' || notifications === null) invalid('notificationSettings')
    for (const [key, value] of Object.entries(notifications)) {
      if (!NOTIFICATION_KEYS.includes(key as keyof NotificationSettings)) invalid(`notificationSettings.${key}`)
      assertBoolean(`notificationSettings.${key}`, value)
    }
  }
}

export const settings = {
  async get(): Promise<SettingsDTO> {
    return read()
  },

  /** Apply a partial update through the store's own setters; returns the settings after it. */
  async set(patch: SettingsPatch): Promise<SettingsDTO> {
    validate(patch)
    const store = useSettingsStore.getState()
    if (patch.linkPreviewsEnabled !== undefined) store.setLinkPreviewsEnabled(patch.linkPreviewsEnabled)
    if (patch.gateMediaFromNonFollowed !== undefined) store.setGateMediaFromNonFollowed(patch.gateMediaFromNonFollowed)
    if (patch.sendReadReceipts !== undefined) store.setSendReadReceipts(patch.sendReadReceipts)
    if (patch.sensitiveContentMode !== undefined) store.setSensitiveContentMode(patch.sensitiveContentMode)
    if (patch.notificationSettings !== undefined) store.setNotificationSettings(patch.notificationSettings)
    if (patch.payWith !== undefined) store.setPayWith(patch.payWith)
    if (patch.feedLanguage !== undefined) store.setFeedLanguage(patch.feedLanguage)
    return read()
  },
}
