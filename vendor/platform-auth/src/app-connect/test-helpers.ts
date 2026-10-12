import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { deriveYapprSharedSecret, hash160 } from '../key-exchange/yappr-protocol'
import { APP_CONNECT_HKDF_INFO, appConnectAad, sealAppConnectPayload } from './crypto'
import { appConnectRequestHash, buildAppConnectUri, encodeAppConnectRequest, type AppConnectRequest } from './request'
import { KeyPurpose, KeySecurityLevel } from './types'

/** Deterministic 32 bytes for fixtures: sha256("dash app-connect v2 vector/" + label). */
export function seed(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(`dash app-connect v2 vector/${label}`))
}

export const DASHPAY_CONTRACT_ID = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7'
export const VECTOR_CREATED_AT = 1791676800000 // 2026-10-11T00:00:00Z
export const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

export const vectorKeys = {
  appEphemeralPrivateKey: seed('app ephemeral'),
  walletEphemeralPrivateKey: seed('wallet ephemeral'),
  appId: seed('app id'),
  groupId: seed('group id'),
  ownerId: seed('owner'),
  connectionId: seed('connection id').slice(0, 16),
  nonce: seed('nonce').slice(0, 12),
  groupKey: seed('slot group key'),
  profileKey: seed('slot dashpay profile key'),
  encryptionKey: seed('slot encryption key'),
}

/** Yappr's request: group key CRITICAL 0.5 DASH / 90 d, DashPay profile HIGH 1e9 / 90 d, encryption on the anchor. */
export function yapprVectorRequest(): AppConnectRequest {
  const expiresAt = VECTOR_CREATED_AT + NINETY_DAYS_MS
  return {
    appEphemeralPubKey: secp256k1.getPublicKey(vectorKeys.appEphemeralPrivateKey, true),
    appId: vectorKeys.appId,
    label: 'Yappr',
    authBindings: [
      {
        kind: 'contractGroup',
        id: vectorKeys.groupId,
        securityLevel: KeySecurityLevel.CRITICAL,
        totalBudget: 50_000_000_000n,
        expiresAt,
      },
      {
        kind: 'documentType',
        id: bs58.decode(DASHPAY_CONTRACT_ID),
        documentTypeName: 'profile',
        securityLevel: KeySecurityLevel.HIGH,
        totalBudget: 1_000_000_000n,
        expiresAt,
      },
    ],
    encBindings: [{ contractId: vectorKeys.appId, purpose: KeyPurpose.ENCRYPTION }],
    createdAt: VECTOR_CREATED_AT,
    connectionId: vectorKeys.connectionId,
  }
}

/** A renewal for a known identity: adds IDENTITY_HINT and MODE = renew, group binding only. */
export function renewVectorRequest(): AppConnectRequest {
  const base = yapprVectorRequest()
  return {
    ...base,
    authBindings: [base.authBindings[0]],
    encBindings: [],
    identityHint: vectorKeys.ownerId,
    mode: 'renew',
  }
}

export async function buildAppConnectVectors() {
  const request = yapprVectorRequest()
  const requestHash = appConnectRequestHash(request)
  const callbackUrl = `https://yap.pr/connect?r=${bytesToHex(requestHash)}`
  const slots = [vectorKeys.groupKey, vectorKeys.profileKey, vectorKeys.encryptionKey]
  const sealed = await sealAppConnectPayload({
    appEphemeralPubKey: request.appEphemeralPubKey,
    ownerId: vectorKeys.ownerId,
    slots,
    walletEphemeralPrivateKey: vectorKeys.walletEphemeralPrivateKey,
    nonce: vectorKeys.nonce,
  })
  const renew = renewVectorRequest()

  return {
    inputs: {
      appEphemeralPrivateKey: bytesToHex(vectorKeys.appEphemeralPrivateKey),
      appId: bs58.encode(vectorKeys.appId),
      groupId: bs58.encode(vectorKeys.groupId),
      dashpayContractId: DASHPAY_CONTRACT_ID,
      ownerId: bs58.encode(vectorKeys.ownerId),
      connectionId: bytesToHex(vectorKeys.connectionId),
      createdAt: VECTOR_CREATED_AT,
      expiresAt: VECTOR_CREATED_AT + NINETY_DAYS_MS,
      walletEphemeralPrivateKey: bytesToHex(vectorKeys.walletEphemeralPrivateKey),
      nonce: bytesToHex(vectorKeys.nonce),
      slotPrivateKeys: slots.map(bytesToHex),
    },
    request: {
      appEphemeralPubKey: bytesToHex(request.appEphemeralPubKey),
      bytes: bytesToHex(encodeAppConnectRequest(request)),
      uri: buildAppConnectUri(request, 'devnet', callbackUrl),
      appEphemeralPubKeyHash: bytesToHex(requestHash),
    },
    response: {
      walletEphemeralPubKey: bytesToHex(sealed.walletEphemeralPubKey),
      sessionKey: bytesToHex(deriveYapprSharedSecret(
        vectorKeys.walletEphemeralPrivateKey,
        request.appEphemeralPubKey,
        new TextEncoder().encode(APP_CONNECT_HKDF_INFO),
      )),
      aad: bytesToHex(appConnectAad(request.appEphemeralPubKey, vectorKeys.ownerId)),
      plaintext: slots.map(bytesToHex).join(''),
      encryptedPayload: bytesToHex(sealed.encryptedPayload),
      slotPublicKeys: slots.map((slot) => bytesToHex(secp256k1.getPublicKey(slot, true))),
      slotPublicKeyHashes: slots.map((slot) => bytesToHex(hash160(secp256k1.getPublicKey(slot, true)))),
    },
    renewRequest: {
      bytes: bytesToHex(encodeAppConnectRequest(renew)),
      uri: buildAppConnectUri(renew, 'testnet'),
    },
  }
}
