import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { openAppConnectPayload } from './crypto'
import { buildAppConnectUri, decodeAppConnectRequest, parseAppConnectUri } from './request'
import { buildAppConnectVectors, renewVectorRequest, vectorKeys, yapprVectorRequest } from './test-helpers'

/**
 * The published interop vectors. `vectors.json` is what the code produces;
 * docs/APP_CONNECT_PROFILE.md embeds the same JSON for wallet teams, so both
 * are checked here.
 */
const fixture = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))

/** The devnet `dashpay://connect` URI from the DIP's "Request Vector" section (dashpay/dips#181), copied verbatim. */
const DIP_CONNECT_URI =
  'dashpay://connect?v=2&n=d&r=AgPoPLkn6F-WrlCpXKO-Icx6N1UTmpQbFdmbAa9P7PDScPiDPHotWKuBbCSukV_iqpRnZYi0Z7oenyskwaPff9t4BVlhcHByAjICAbBZDlkmnGiFrPcdJ9386FGH4syXNsQulYEnzTW-bTjoAAAAC6Q7dAAAAAGi9760AAI6AQKiobSsb-8i6ioaaOgSNkSzV4dfa0EsGBCSgcFG57JxvAAAAAA7msoAAAABove-tAAHcHJvZmlsZQMQppsbT2ZmgUU97Dc0ZnpasgQh-IM8ei1Yq4FsJK6RX-KqlGdliLRnuh6fKyTBo99_23gBBggAAAGhKEJcAA&cb=https%3A%2F%2Fyap.pr%2Fconnect%3Fr%3Dd77dc0da9df83a47755a15c42c5d9db9d7a7fd62'

describe('App Connect v2 test vectors', () => {
  it('reproduces vectors.json exactly', async () => {
    expect(await buildAppConnectVectors()).toEqual(fixture)
  })

  it('matches the vectors published in docs/APP_CONNECT_PROFILE.md', () => {
    const doc = readFileSync(new URL('../../../../docs/APP_CONNECT_PROFILE.md', import.meta.url), 'utf8')
    const block = doc.match(/<!-- app-connect-vectors -->\s*```json\n([\s\S]*?)\n```/)
    expect(block, 'the profile must embed the vectors after <!-- app-connect-vectors -->').not.toBeNull()
    expect(JSON.parse(block![1])).toEqual(fixture)
  })

  it('parses the published URIs back to the vector requests', () => {
    const parsed = parseAppConnectUri(fixture.request.uri)
    expect(parsed.request).toEqual(yapprVectorRequest())
    expect(parsed.network).toBe('devnet')
    expect(parsed.callbackUrl).toBe(`https://yap.pr/connect?r=${fixture.request.appEphemeralPubKeyHash}`)
    expect(parseAppConnectUri(fixture.renewRequest.uri).request).toEqual(renewVectorRequest())
  })

  it('builds the DIP dashpay://connect devnet vector exactly and parses it back', () => {
    const request = decodeAppConnectRequest(hexToBytes(fixture.request.bytes))
    const callbackUrl = `https://yap.pr/connect?r=${fixture.request.appEphemeralPubKeyHash}`
    expect(buildAppConnectUri(request, 'devnet', callbackUrl, 'dashpay')).toBe(DIP_CONNECT_URI)

    const parsed = parseAppConnectUri(DIP_CONNECT_URI)
    expect(parsed.request).toEqual(yapprVectorRequest())
    expect(bytesToHex(parsed.requestBytes)).toBe(fixture.request.bytes)
    expect(parsed.network).toBe('devnet')
    expect(parsed.callbackUrl).toBe(callbackUrl)
  })

  it('decrypts with an independent AES-256-GCM (node:crypto)', () => {
    const payload = hexToBytes(fixture.response.encryptedPayload)
    const decipher = createDecipheriv('aes-256-gcm', hexToBytes(fixture.response.sessionKey), payload.subarray(0, 12))
    decipher.setAAD(hexToBytes(fixture.response.aad))
    decipher.setAuthTag(payload.subarray(payload.length - 16))
    const plaintext = Buffer.concat([decipher.update(payload.subarray(12, payload.length - 16)), decipher.final()])
    expect(plaintext.toString('hex')).toBe(fixture.response.plaintext)
  })

  it('opens on the app side', async () => {
    const slots = await openAppConnectPayload({
      appEphemeralPrivateKey: vectorKeys.appEphemeralPrivateKey,
      ownerId: vectorKeys.ownerId,
      walletEphemeralPubKey: hexToBytes(fixture.response.walletEphemeralPubKey),
      encryptedPayload: hexToBytes(fixture.response.encryptedPayload),
    })
    expect(slots).toEqual(fixture.inputs.slotPrivateKeys.map(hexToBytes))
  })
})
