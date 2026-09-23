/**
 * Shared machinery for the DM v5 specs (docs/DM_V5.md), which run only
 * against the moutai devnet build with `NEXT_PUBLIC_DM_TOPOLOGY=v5`.
 *
 * Two kinds of actor:
 *
 * - **Devices**: a browser context per (identity, device), logged in by seeding
 *   the session, the AUTHENTICATION/HIGH key and the ENCRYPTION key (seed key
 *   index 4, the one registered on every pool identity). Several devices of
 *   one identity are several contexts with separate storage, exactly like two
 *   browsers.
 * - **Node actors**: the same identities signing documents straight from Node,
 *   for what the UI will not do on purpose (a squatted tag, a forged grant, a
 *   removed member writing on the old base) and for bulk history. They build
 *   their payloads with the app's own `lib/dm` code, so a squatted message is
 *   byte-for-byte what a real client would read.
 *
 * Nothing here prints a key: WIFs and private keys only ever go into browser
 * init scripts and SDK signers.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import bs58 from 'bs58'
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { bytesEqual, bytesToHex } from '../../lib/bytes'
import { getPublicKey } from '../../lib/crypto/keys'
import { wifToPrivateKey } from '../../lib/crypto/wif'
import { keyringHandle, keyringNonce, openRoster, rosterHandle } from '../../lib/dm/group'
import { bucketLevels, createInvite, isInviteForMe } from '../../lib/dm/invite'
import { deriveDirectKeys, deriveEpochKey, deriveGroupId, deriveGroupSecret, deriveSelfRoot, deriveStateKey } from '../../lib/dm/keys'
import { decryptSelfState } from '../../lib/dm/self-state'
import { deriveStreamKey, directOwnerId, encryptMessage, messageTag, tryDecryptMessage } from '../../lib/dm/stream'
import type { DmPlaintext, MessagePointer, RosterContent, SelfState } from '../../lib/dm/types'
import { encryptToBinary } from '../../lib/message-encryption'
import { appUrl, scopedKey } from './app'
import { seedContext } from './auth'

// ---------------------------------------------------------------------------
// Gates (synchronous, so they can skip a whole serial describe)

const ENV_FILE = process.env.E2E_ENV_FILE?.trim() || '.env.testing'

function envValue(name: string): string {
  if (process.env[name]) return process.env[name] as string
  try {
    const match = readFileSync(join(process.cwd(), ENV_FILE), 'utf8').match(new RegExp(`^${name}=(\\S*)`, 'm'))
    return match?.[1] ?? ''
  } catch {
    return ''
  }
}

export const IS_DEVNET_RUN = ENV_FILE.includes('devnet')
export const NOT_DEVNET_REASON = 'E2E_ENV_FILE does not select the devnet deployment — DM v5 is only deployed there'
export const DM_V5_CONTRACT_ID = envValue('NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID')
export const LEGACY_DM_CONTRACT_ID = envValue('NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID')
export const DM_V5_BUILD = envValue('NEXT_PUBLIC_DM_TOPOLOGY') === 'v5' && DM_V5_CONTRACT_ID !== ''
export const NOT_V5_REASON = 'the env file does not set NEXT_PUBLIC_DM_TOPOLOGY=v5 with a DM v5 contract id'

/**
 * Pool slots the DM specs use (derivation indices of the devnet CI seed). Slot 0
 * belongs to the topology spec. Every file sets up what it needs, so a file can
 * run alone: direct = A, B; history = E, F (+ A, B as passive partners);
 * groups = A–E; recovery = G, H. Files sharing an identity must not run at
 * the same time (the suite runs with one worker).
 */
export const SLOT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8 } as const
const POOL_NEEDED = 9

export function poolTooSmall(): boolean {
  const raw = envValue('E2E_IDENTITY_IDS')
  return raw.split(',').filter((id) => id.trim()).length < POOL_NEEDED
}
export const POOL_REASON = `E2E_IDENTITY_IDS needs ${POOL_NEEDED} identities (slots 1-8 are the DM v5 actors)`

// The Node actors reach the chain through the scripts' SDK wiring, which reads NETWORK.
if (IS_DEVNET_RUN) process.env.NETWORK ??= 'devnet'

// ---------------------------------------------------------------------------
// Identities

export interface DmBot {
  index: number
  identityId: string
  id: Uint8Array
  hex: string
  /** AUTHENTICATION/HIGH (key 2): the browser's signing key. */
  authWif: string
  /** ENCRYPTION (key 4): the DM v5 key. */
  encWif: string
  encPriv: Uint8Array
  encPub: Uint8Array
  /** AUTHENTICATION/HIGH public key: the legacy (v3/v4) DM key. */
  authPub: Uint8Array
}

type DeriveModule = {
  deriveIdentityKeys: (index: number) => Array<{ keyIndex: number; wif: string; publicKey: Uint8Array }>
  loadIdentityIds: () => string[]
}

const bots = new Map<number, DmBot>()

export async function dmBot(index: number): Promise<DmBot> {
  const cached = bots.get(index)
  if (cached) return cached
  const { deriveIdentityKeys, loadIdentityIds } = (await import('../../scripts/derive-identities.mjs')) as DeriveModule
  const identityId = loadIdentityIds()[index]
  if (!identityId) throw new Error(`No identity at pool slot ${index}`)
  const keys = deriveIdentityKeys(index)
  const auth = keys.find((k) => k.keyIndex === 2)
  const enc = keys.find((k) => k.keyIndex === 4)
  if (!auth || !enc) throw new Error(`Derivation produced no auth/encryption key for slot ${index}`)
  const encPriv = wifToPrivateKey(enc.wif).privateKey
  const id = bs58.decode(identityId)
  const bot: DmBot = {
    index,
    identityId,
    id,
    hex: bytesToHex(id),
    authWif: auth.wif,
    encWif: enc.wif,
    encPriv,
    encPub: getPublicKey(encPriv),
    authPub: Uint8Array.from(auth.publicKey),
  }
  bots.set(index, bot)
  return bot
}

export const directKey = (peer: DmBot): string => `d:${peer.hex}`

// ---------------------------------------------------------------------------
// Devices

export interface Device {
  bot: DmBot
  label: string
  context: BrowserContext
  page: Page
}

/**
 * A logged-in browser for `bot`: its own context (its own localStorage), so
 * two devices of one identity share nothing but the chain.
 */
export async function openDevice(browser: Browser, bot: DmBot, label: string): Promise<Device> {
  const context = await browser.newContext()
  await seedContext(context, { index: bot.index, identityId: bot.identityId, wif: bot.authWif })
  await context.addInitScript(
    ({ key, wif, grantKey, identityId }) => {
      window.localStorage.setItem(key, JSON.stringify(wif))
      // DMs need no YAPP: keep the starter-grant prompt (a modal) out of the way.
      window.localStorage.setItem(grantKey, JSON.stringify([identityId]))
    },
    {
      key: scopedKey(`yappr_secure_ek_${bot.identityId}`),
      wif: bot.encWif,
      grantKey: scopedKey('yappr_starter_grant_settled'),
      identityId: bot.identityId,
    }
  )
  const page = await context.newPage()
  if (process.env.E2E_DM_DEBUG) {
    page.on('console', (message) => {
      if (message.type() !== 'warning' && message.type() !== 'error') return
      const text = message.text().replace(/%c/g, '')
      if (/DM v5|Error creating|Error updating|Error deleting/i.test(text)) console.log(`[${label}] ${message.type()}: ${text.slice(0, 500)}`)
    })
  }
  return { bot, label, context, page }
}

export async function closeDevices(devices: Array<Device | undefined>): Promise<void> {
  await Promise.all(devices.map((device) => device?.context.close().catch(() => undefined)))
}

/** Save pending self-state edits now: the app flushes on `pagehide` (§5.5). */
export async function flushSelfState(device: Device): Promise<void> {
  await device.page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
}

// ---------------------------------------------------------------------------
// Messages UI

export async function gotoMessages(page: Page, query = ''): Promise<void> {
  await page.goto(appUrl(`/messages/${query}`), { waitUntil: 'domcontentloaded' })
  // Only the v5 inbox has this control; the legacy page does not.
  await expect(page.getByRole('button', { name: 'Message settings' })).toBeVisible({ timeout: 90_000 })
  // The first poll (self-state load) has finished once loading is gone.
  await expect(page.getByText('Loading conversations...')).toHaveCount(0, { timeout: 120_000 })
}

export const row = (page: Page, key: string): Locator => page.locator(`[data-testid="dm-row"][data-key="${key}"]`)
export const rowNamed = (page: Page, name: string): Locator => page.getByTestId('dm-row').filter({ hasText: name })
export const thread = (page: Page): Locator => page.getByTestId('dm-thread')
export const bubbles = (page: Page, text?: string | RegExp): Locator =>
  text === undefined ? page.getByTestId('dm-message') : page.getByTestId('dm-message').filter({ hasText: text })
export const composer = (page: Page): Locator => thread(page).getByRole('textbox', { name: 'Message', exact: true })

export async function openRow(page: Page, target: Locator, timeout = 120_000): Promise<void> {
  await expect(target).toBeVisible({ timeout })
  await target.click()
  await expect(thread(page)).toBeVisible()
}

/** Send from the open thread and wait for the app's own success signal (the draft clears). */
export async function send(page: Page, text: string): Promise<void> {
  const box = composer(page)
  await expect(box).toBeEnabled({ timeout: 60_000 })
  await box.fill(text)
  await thread(page).getByRole('button', { name: 'Send message' }).click()
  // The draft clears on success. On failure it stays and the app shows a short-lived error toast,
  // whose text is the useful part of the report, so watch for one while waiting.
  let toast = ''
  const watch = page.getByRole('status').first().waitFor({ timeout: 180_000 }).then(async () => {
    toast = await page.getByRole('status').allInnerTexts().then((t) => t.join(' | ')).catch(() => '')
  }).catch(() => undefined)
  await expect(box).toHaveValue('', { timeout: 180_000 }).catch((error: Error) => {
    throw new Error(`${error.message}\nerror toast: ${toast || '(none seen)'}`)
  })
  void watch
}

/** Open a conversation's options menu and pick an item. */
export async function threadMenu(page: Page, item: string | RegExp): Promise<void> {
  await thread(page).getByRole('button', { name: 'Conversation options' }).click()
  await page.getByRole('menuitem', { name: item }).click({ timeout: 15_000 })
}

/** Pick a user in the open picker by DPNS search. */
export async function pickUser(scope: Locator, page: Page, username: string): Promise<void> {
  await scope.getByPlaceholder('Search by username...').fill(username)
  const result = scope.getByRole('button').filter({ hasText: `@${username}` })
  await expect(result).toBeVisible({ timeout: 60_000 })
  await result.click()
  // A multi-select picker keeps its query: clear it so the next search starts clean. A
  // single-pick one (group settings) disables and then closes itself, so this is best-effort.
  await scope.getByPlaceholder('Search by username...').fill('', { timeout: 2_000 }).catch(() => undefined)
  await page.waitForTimeout(200)
}

/** Expect `locator` to stay absent for `ms` (for "never shows up" assertions under polling). */
export async function expectAbsentFor(page: Page, locator: Locator, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await expect(locator).toHaveCount(0)
    await page.waitForTimeout(2_000)
  }
}

// ---------------------------------------------------------------------------
// Node actors

type SdkHandle = { sdk: Sdk; connect: () => Promise<unknown> }
// The scripts are untyped .mjs; this is the slice of the SDK the specs use.
type Sdk = {
  documents: {
    query(q: Record<string, unknown>): Promise<Map<unknown, { toObject(): Record<string, unknown> } | undefined>>
    create(a: Record<string, unknown>): Promise<unknown>
    delete(a: Record<string, unknown>): Promise<unknown>
  }
  stateTransitions: { broadcastStateTransition(st: unknown): Promise<unknown> }
  wasm: { getIdentityContractNonce(owner: string, contract: string): Promise<bigint | undefined> }
}

let handle: Promise<Sdk> | null = null

export function nodeSdk(): Promise<Sdk> {
  if (!handle) {
    handle = (async () => {
      const { ensureInitialized } = await import('@dashevo/evo-sdk')
      await ensureInitialized()
      const seedLib = (await import('../../scripts/seed/seed-lib.mjs')) as unknown as { createSdkHandle: (o: { contractIds: string[] }) => SdkHandle }
      const created = seedLib.createSdkHandle({ contractIds: [DM_V5_CONTRACT_ID, LEGACY_DM_CONTRACT_ID].filter(Boolean) })
      await created.connect()
      return created.sdk
    })()
  }
  return handle
}

interface Signing {
  ownerId: string
  identityKey: unknown
  signer: unknown
  wif: string
}

const signing = new Map<number, Promise<Signing>>()

/** The CRITICAL auth key of a pool identity, as a Node signer. */
function signingFor(bot: DmBot): Promise<Signing> {
  let found = signing.get(bot.index)
  if (!found) {
    found = (async () => {
      const sdk = await nodeSdk()
      const ownerKeys = (await import('../../scripts/owner-keys.mjs')) as unknown as {
        resolveOwner: (o: { botIndex: number; ownerId: string }) => { ownerId: string; wif: string }
        signerFor: (sdk: Sdk, owner: unknown) => Promise<{ identityKey: unknown; signer: unknown }>
      }
      const owner = ownerKeys.resolveOwner({ botIndex: bot.index, ownerId: bot.identityId })
      const { identityKey, signer } = await ownerKeys.signerFor(sdk, owner)
      return { ownerId: bot.identityId, identityKey, signer, wif: owner.wif }
    })()
    signing.set(bot.index, found)
  }
  return found
}

type BuildDocument = (o: Record<string, unknown>) => { document: unknown; id: string | null }

async function seedLib(): Promise<{ buildDocument: BuildDocument; randomEntropy: () => Uint8Array }> {
  return (await import('../../scripts/seed/seed-lib.mjs')) as unknown as { buildDocument: BuildDocument; randomEntropy: () => Uint8Array }
}

export type Doc = Record<string, unknown>

export async function queryDocs(contractId: string, documentTypeName: string, shape: Record<string, unknown>): Promise<Doc[]> {
  const sdk = await nodeSdk()
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await sdk.documents.query({ dataContractId: contractId, documentTypeName, ...shape })
      return Array.from(result.values()).filter((doc): doc is { toObject(): Doc } => doc !== undefined).map((doc) => doc.toObject())
    } catch (error) {
      if (attempt >= 5) throw new Error(`${documentTypeName} query failed: ${wasmMessage(error)}`)
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt))
    }
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

/** The message of an SDK error: wasm errors expose it through a getter, not as an own property. */
function wasmMessage(error: unknown): string {
  const value = error as { message?: unknown } | null
  return typeof value?.message === 'string' ? value.message : String(error)
}
const asBytes = (value: unknown): Uint8Array => (value instanceof Uint8Array ? value : Uint8Array.from(value as ArrayLike<number>))
const b58 = (value: unknown): string => (typeof value === 'string' ? value : bs58.encode(asBytes(value)))

/**
 * Create one document as `bot` and wait until `landed()` sees it. A create
 * that throws after broadcasting (the DAPI timeout) counts if it landed.
 */
export async function createDoc(bot: DmBot, contractId: string, docType: string, data: Doc, landed: () => Promise<boolean>): Promise<void> {
  const sdk = await nodeSdk()
  const who = await signingFor(bot)
  const { buildDocument, randomEntropy } = await seedLib()
  const seen = async () => landed().catch(() => false)
  let lastError = ''
  // A refused or dropped create (a DAPI timeout, an exhausted address pool) is retried with a fresh
  // document; a create that threw after broadcasting counts if it landed.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { document } = buildDocument({ contractId, docType, ownerId: who.ownerId, data, entropy: randomEntropy() })
    try {
      await sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer })
    } catch (error) {
      lastError = wasmMessage(error)
    }
    for (let i = 0; i < 20; i++) {
      if (await seen()) return
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
  }
  throw new Error(`${docType} create by slot ${bot.index} never landed: ${lastError || 'no error reported'}`)
}

export async function deleteDoc(bot: DmBot, contractId: string, docType: string, id: string, gone: () => Promise<boolean>): Promise<void> {
  const sdk = await nodeSdk()
  const who = await signingFor(bot)
  try {
    await sdk.documents.delete({ document: { id, ownerId: who.ownerId, dataContractId: contractId, documentTypeName: docType }, identityKey: who.identityKey, signer: who.signer })
  } catch (error) {
    if (!(await gone())) throw error
  }
  await expect.poll(gone, { timeout: 60_000 }).toBe(true)
}


// ---------------------------------------------------------------------------
// DM v5 on chain, computed with lib/dm

export async function messagesAt(tags: Uint8Array[]): Promise<Doc[]> {
  const out: Doc[] = []
  for (let i = 0; i < tags.length; i += 100) {
    out.push(
      ...(await queryDocs(DM_V5_CONTRACT_ID, 'dmMessage', {
        where: [['tag', 'in', tags.slice(i, i + 100).map(b64)]],
        orderBy: [['tag', 'asc']],
        limit: 100,
      }))
    )
  }
  return out
}

/** The 1:1 stream of `sender` in the conversation `me`–`peer`, computed by `me`. */
export function directStream(me: DmBot, peer: DmBot, sender: DmBot): Uint8Array {
  const { key } = deriveDirectKeys(me.encPriv, peer.encPub, me.id, peer.id)
  return deriveStreamKey(key, directOwnerId(), sender.id)
}

export interface StreamDoc {
  j: number
  doc: Doc
  ownerId: string
  bodyLength: number
}

/** Every document at tags j = 0.. of week `w` of a stream, page by page until an empty page. */
export async function streamWeek(streamKey: Uint8Array, w: number): Promise<StreamDoc[]> {
  const out: StreamDoc[] = []
  for (let from = 0; ; from += 100) {
    const tags = Array.from({ length: 100 }, (_, i) => messageTag(streamKey, w, from + i))
    const byTag = new Map(tags.map((tag, i) => [bytesToHex(tag), from + i]))
    const docs = await messagesAt(tags)
    for (const doc of docs) {
      const j = byTag.get(bytesToHex(asBytes(doc.tag)))
      if (j !== undefined) out.push({ j, doc, ownerId: b58(doc.$ownerId), bodyLength: asBytes(doc.body).length })
    }
    if (docs.length === 0) return out.sort((a, b) => a.j - b.j)
  }
}

export async function decryptAt(streamKey: Uint8Array, sender: DmBot, w: number, j: number, doc: Doc): Promise<DmPlaintext | null> {
  return tryDecryptMessage({ streamKey, senderId: sender.id, w, j }, asBytes(doc.body))
}

export const currentWeek = (): number => Math.floor(Date.now() / 604_800_000)

/** Every invite ever written in `to`'s bucket levels, with those addressed to `to` from `from` counted. */
export async function invitesBetween(from: DmBot, to: DmBot): Promise<number> {
  let count = 0
  let startAfter: string | undefined
  for (;;) {
    const docs = await queryDocs(DM_V5_CONTRACT_ID, 'dmInvite', {
      where: [['bucket', 'in', bucketLevels(to.id)], ['$createdAt', '>=', 0]],
      orderBy: [['bucket', 'asc'], ['$createdAt', 'asc']],
      limit: 100,
      ...(startAfter ? { startAfter } : {}),
    })
    for (const doc of docs) {
      const owner = asBytes(bs58.decode(b58(doc.$ownerId)))
      if (b58(doc.$ownerId) !== from.identityId) continue
      if (isInviteForMe(to.encPriv, { bucket: Number(doc.bucket), epk: asBytes(doc.epk), check: asBytes(doc.check) }, owner)) count++
    }
    if (docs.length < 100) return count
    startAfter = b58(docs[docs.length - 1].$id)
  }
}

export { asBytes, b58, b64 }

// ---------------------------------------------------------------------------
// Self-state (§5.5), read with the owner's key

export async function selfStateOf(bot: DmBot): Promise<{ id: string; revision: number; state: SelfState } | null> {
  const [doc] = await queryDocs(DM_V5_CONTRACT_ID, 'dmSelfState', { where: [['$ownerId', '==', bot.identityId]], limit: 1 })
  if (!doc) return null
  const field = (name: string) => (doc[name] === undefined || doc[name] === null ? null : asBytes(doc[name]))
  const state = await decryptSelfState(deriveStateKey(deriveSelfRoot(bot.encPriv)), { blob: asBytes(doc.blob), blob2: field('blob2'), blob3: field('blob3') })
  return { id: b58(doc.$id), revision: Number(doc.$revision ?? 1), state }
}

export const hasDirect = (state: SelfState, peer: DmBot): boolean => state.directs.some((d) => bytesEqual(d.peer, peer.id))

// ---------------------------------------------------------------------------
// Writing DM v5 documents from Node with the app's own encodings

/** Write one message on `sender`'s stream `streamKey` at `(w, j)`. Resolves once it reads back. */
export async function writeMessage(sender: DmBot, streamKey: Uint8Array, w: number, j: number, plaintext: DmPlaintext): Promise<void> {
  const { tag, body } = await encryptMessage({ streamKey, senderId: sender.id, w, j }, plaintext)
  await createDoc(sender, DM_V5_CONTRACT_ID, 'dmMessage', { tag, body }, async () => {
    const [doc] = await messagesAt([tag])
    return Boolean(doc && b58(doc.$ownerId) === sender.identityId)
  })
}

/** Raw write at `tag` with an arbitrary body (a squat); resolves once `sender` holds the tag. */
export async function writeRawMessage(sender: DmBot, tag: Uint8Array, body: Uint8Array): Promise<void> {
  await createDoc(sender, DM_V5_CONTRACT_ID, 'dmMessage', { tag, body }, async () => {
    const [doc] = await messagesAt([tag])
    return Boolean(doc && b58(doc.$ownerId) === sender.identityId)
  })
}

export async function writeInvite(sender: DmBot, recipient: DmBot): Promise<void> {
  const invite = createInvite({ recipientPublicKey: recipient.encPub, recipientId: recipient.id, senderId: sender.id, bucketLevel: 0 })
  await createDoc(sender, DM_V5_CONTRACT_ID, 'dmInvite', { bucket: invite.bucket, epk: invite.epk, check: invite.check }, async () => {
    const docs = await queryDocs(DM_V5_CONTRACT_ID, 'dmInvite', { where: [['bucket', '==', invite.bucket]], orderBy: [['$createdAt', 'desc']], limit: 20 })
    return docs.some((doc) => b58(doc.$ownerId) === sender.identityId && bytesEqual(asBytes(doc.check), invite.check))
  })
}


/**
 * Many messages on one stream, fast: transitions are built and signed here
 * with locally assigned identity-contract nonces and broadcast `window` at a
 * time (the pattern of scripts/seed/pipeline.mjs), each window waited for
 * before the next so the nonce gap stays small. Each message links to the
 * previous one through `prev`; `first` is the `prev` of the first. Resolves
 * once every tag reads back as `sender`'s.
 */
export async function writeStreamBulk(
  sender: DmBot,
  streamKey: Uint8Array,
  w: number,
  fromJ: number,
  texts: string[],
  first: MessagePointer | null,
  window = 8
): Promise<void> {
  const sdk = await nodeSdk()
  const who = await signingFor(sender)
  const { buildDocument, randomEntropy } = await seedLib()
  const { BatchTransition, BatchedTransition, DocumentCreateTransition, PrivateKey } = await import('@dashevo/evo-sdk')
  const privateKey = PrivateKey.fromWIF(who.wif)
  const payloads = await Promise.all(
    texts.map((text, i) =>
      encryptMessage(
        { streamKey, senderId: sender.id, w, j: fromJ + i },
        { prev: i === 0 ? first : { w, b: 0, r: 0, j: fromJ + i - 1 }, content: { type: 'text', text } }
      )
    )
  )
  const landed = async (batch: typeof payloads): Promise<Set<string>> => {
    const docs = await messagesAt(batch.map((p) => p.tag))
    return new Set(docs.filter((doc) => b58(doc.$ownerId) === sender.identityId).map((doc) => bytesToHex(asBytes(doc.tag))))
  }
  const sequenceMask = (BigInt(1) << BigInt(40)) - BigInt(1)

  for (let i = 0; i < payloads.length; i += window) {
    const batch = payloads.slice(i, i + window)
    for (let attempt = 1; ; attempt++) {
      const have = await landed(batch)
      const missing = batch.filter((p) => !have.has(bytesToHex(p.tag)))
      if (missing.length === 0) break
      if (attempt > 5) throw new Error(`bulk window at ${i}: ${missing.length} message(s) never landed`)
      let nonce: bigint
      try {
        nonce = ((await sdk.wasm.getIdentityContractNonce(sender.identityId, DM_V5_CONTRACT_ID)) ?? BigInt(0)) & sequenceMask
      } catch (error) {
        // A transient DAPI failure: try the window again.
        console.warn(`bulk: nonce read failed (${wasmMessage(error)}), retrying`)
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        continue
      }
      const signed = missing.map((payload) => {
        nonce += BigInt(1)
        const { document } = buildDocument({ contractId: DM_V5_CONTRACT_ID, docType: 'dmMessage', ownerId: sender.identityId, data: { tag: payload.tag, body: payload.body }, entropy: randomEntropy(), nonce })
        const create = new DocumentCreateTransition({ document, identityContractNonce: nonce } as never)
        const batchTransition = BatchTransition.fromBatchedTransitions([new BatchedTransition(create.toDocumentTransition())], sender.identityId, 0)
        const st = batchTransition.toStateTransition()
        st.setIdentityContractNonce(nonce)
        st.sign(privateKey, who.identityKey as never)
        return st
      })
      // Refusals (a nonce a pending transition already holds, a duplicate tag) and transport errors
      // are all settled by the readback below; the window is simply retried.
      await Promise.all(signed.map((st) => sdk.stateTransitions.broadcastStateTransition(st).catch((error: unknown) => {
        console.warn(`bulk: broadcast refused (${wasmMessage(error).slice(0, 160)})`)
      })))
      await expect
        .poll(async () => (await landed(batch)).size, { timeout: 45_000, intervals: [2_000, 3_000] })
        .toBe(batch.length)
        .catch(() => undefined)
    }
  }
}

// ---------------------------------------------------------------------------
// Groups, read with the app's own derivations

/** Every roster-visible fact of a group the given member can read, by trying its epochs. */
export async function groupDocsOf(owner: DmBot, handles: Uint8Array[]): Promise<Doc[]> {
  return queryDocs(DM_V5_CONTRACT_ID, 'dmGroupDoc', {
    where: [['$ownerId', '==', owner.identityId], ['handle', 'in', handles.map(b64)]],
    orderBy: [['handle', 'asc']],
    limit: 100,
  })
}

/** The owner's n-th group id and secret (§4.4). */
export function ownedGroup(owner: DmBot, n: number): { gid: Uint8Array; secret: Uint8Array } {
  const gid = deriveGroupId(deriveSelfRoot(owner.encPriv), n)
  return { gid, secret: deriveGroupSecret(owner.encPriv, gid) }
}

/** `K[b, r]` of an owned group, from its secret and (for b ≥ 1) keyring b's nonce. */
export async function ownerEpochKey(owner: DmBot, gid: Uint8Array, secret: Uint8Array, b: number, r: number): Promise<Uint8Array> {
  if (b === 0) return deriveEpochKey(secret, 0, r)
  const [keyring] = await groupDocsOf(owner, [keyringHandle(gid, b)])
  if (!keyring) throw new Error(`keyring ${b} not found`)
  const nonce = keyringNonce(asBytes(keyring.blob))
  if (!nonce) throw new Error(`keyring ${b} is malformed`)
  return deriveEpochKey(secret, b, r, nonce)
}

/** The current roster of an owned group (the owner's view: every epoch key is derivable). */
export async function ownerRoster(owner: DmBot, n: number): Promise<RosterContent | null> {
  const { gid, secret } = ownedGroup(owner, n)
  const [doc] = await groupDocsOf(owner, [rosterHandle(gid)])
  if (!doc) return null
  const blob = asBytes(doc.blob)
  for (let b = 0; b < 16; b++) {
    let base: Uint8Array
    try {
      base = await ownerEpochKey(owner, gid, secret, b, 0)
    } catch {
      return null
    }
    const opened = await openRoster({ blob, gid, known: { b, r: 0, key: base }, maxSteps: 64 })
    if (opened) return opened.content
  }
  return null
}

/** The group stream of `sender` on epoch `(b, r)`. */
export function groupStream(owner: DmBot, epochKey: Uint8Array, sender: DmBot): Uint8Array {
  return deriveStreamKey(epochKey, owner.id, sender.id)
}

/** How many of the owner's group numbers are taken (the next group gets this n). */
export async function nextGroupNumber(owner: DmBot): Promise<number> {
  const selfRoot = deriveSelfRoot(owner.encPriv)
  for (let start = 0; ; start += 100) {
    const handles = Array.from({ length: 100 }, (_, i) => rosterHandle(deriveGroupId(selfRoot, start + i)))
    const taken = new Set((await groupDocsOf(owner, handles)).map((doc) => bytesToHex(asBytes(doc.handle))))
    const free = handles.findIndex((handle) => !taken.has(bytesToHex(handle)))
    if (free >= 0) return start + free
  }
}

// ---------------------------------------------------------------------------
// The legacy (v3/v4) DM contract, for the migration scenario (§10)

/** A v4 conversation from `sender` to `recipient`: invite (if none) + one message, as the old client wrote them. */
export async function writeLegacyMessage(sender: DmBot, recipient: DmBot, text: string): Promise<void> {
  const combined = [sender.identityId, recipient.identityId].sort().join(':')
  const conversationId = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined))).slice(0, 10)
  const invites = await queryDocs(LEGACY_DM_CONTRACT_ID, 'conversationInvite', {
    where: [['$ownerId', '==', sender.identityId], ['recipientId', '==', recipient.identityId]],
    orderBy: [['recipientId', 'asc']],
    limit: 1,
  })
  if (invites.length === 0) {
    await createDoc(sender, LEGACY_DM_CONTRACT_ID, 'conversationInvite', { recipientId: recipient.id, conversationId }, async () =>
      (await queryDocs(LEGACY_DM_CONTRACT_ID, 'conversationInvite', { where: [['$ownerId', '==', sender.identityId], ['recipientId', '==', recipient.identityId]], orderBy: [['recipientId', 'asc']], limit: 1 })).length > 0
    )
  }
  const encryptedContent = await encryptToBinary(text, sender.authWif, recipient.authPub)
  await createDoc(sender, LEGACY_DM_CONTRACT_ID, 'directMessage', { conversationId, encryptedContent }, async () => {
    const docs = await queryDocs(LEGACY_DM_CONTRACT_ID, 'directMessage', {
      where: [['conversationId', '==', b64(conversationId)], ['$createdAt', '>', 0]],
      orderBy: [['$createdAt', 'desc']],
      limit: 5,
    })
    return docs.some((doc) => bytesEqual(asBytes(doc.encryptedContent), encryptedContent))
  })
}
