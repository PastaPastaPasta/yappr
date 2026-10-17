import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalHttpsUrl as scriptCanonical, ipfsCidOf as scriptCid, urlSha256 } from '../../scripts/media-denylist.mjs'
import {
  canonicalHttpsUrl,
  imageSourceFor,
  ipfsCidOf,
  isDeniedMedia,
  proxiedImageUrl,
  sha256Hex,
} from './remote-media'

const { CID_V1, CID_V0 } = vi.hoisted(() => ({
  CID_V1: 'bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va',
  CID_V0: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
}))
const DENIED_URL = 'https://Tracker.example/pixel.png?id=1#frag'

vi.mock('./media-denylist.json', async () => {
  const { createHash: hash } = await import('node:crypto')
  return {
    default: {
      cids: [{ cid: CID_V1, added: '2026-10-16', ref: 'TEST-1' }, { cid: CID_V0, added: '2026-10-16', ref: 'TEST-1' }],
      urlSha256: [{ sha256: hash('sha256').update('https://tracker.example/pixel.png?id=1').digest('hex'), added: '2026-10-16', ref: 'TEST-2' }],
    },
  }
})

describe('sha256Hex', () => {
  it('matches node:crypto across block boundaries and non-ASCII input', () => {
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'héllo wörld ✓ 🦄']) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    }
  })
})

describe('ipfsCidOf', () => {
  it('reads the CID from every IPFS spelling', () => {
    expect(ipfsCidOf(`ipfs://${CID_V1}`)).toBe(CID_V1)
    expect(ipfsCidOf(`ipfs://ipfs/${CID_V1}/a.png`)).toBe(CID_V1)
    expect(ipfsCidOf(`https://gateway.pinata.cloud/ipfs/${CID_V0}/x`)).toBe(CID_V0)
    expect(ipfsCidOf(`https://${CID_V1}.ipfs.dweb.link/a.png`)).toBe(CID_V1)
    expect(ipfsCidOf('https://example.com/a.png')).toBeNull()
  })
})

describe('the denylist', () => {
  it('blocks a listed CID in any spelling, case-insensitively for CIDv1', () => {
    expect(isDeniedMedia(`ipfs://${CID_V1}`)).toBe(true)
    expect(isDeniedMedia(`ipfs://${CID_V1.toUpperCase()}/file.jpg`)).toBe(true)
    expect(isDeniedMedia(`https://${CID_V1}.ipfs.dweb.link/`)).toBe(true)
    expect(isDeniedMedia(`https://ipfs.io/ipfs/${CID_V0}`)).toBe(true)
    expect(isDeniedMedia('ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy')).toBe(false)
  })

  it('blocks a listed https URL by the sha256 of its canonical form', () => {
    expect(isDeniedMedia(DENIED_URL)).toBe(true)
    expect(isDeniedMedia('  https://tracker.example/pixel.png?id=1 ')).toBe(true)
    expect(isDeniedMedia('https://tracker.example/pixel.png?id=2')).toBe(false)
  })

  it('has a script that hashes exactly as the renderers do', () => {
    for (const url of [DENIED_URL, 'https://a.b/c?d=e&f=g', 'https://EXAMPLE.com', `https://${CID_V1}.ipfs.dweb.link/x`]) {
      expect(scriptCanonical(url)).toBe(canonicalHttpsUrl(url))
      expect(scriptCid(url)).toBe(ipfsCidOf(url))
    }
    expect(urlSha256(DENIED_URL)).toBe(sha256Hex(canonicalHttpsUrl(DENIED_URL) ?? ''))
  })
})

describe('IPFS spellings', () => {
  it('treats only CIDs in the two spellings Yappr writes as IPFS content', () => {
    expect(ipfsCidOf('https://docs.ipfs.tech/logo.png')).toBeNull()
    expect(imageSourceFor('https://docs.ipfs.tech/logo.png').kind).toBe('proxied')
    expect(imageSourceFor('https://example.com/ipfs/notacid.png').kind).toBe('proxied')
  })

  it('refuses any other spelling of a CID, so it cannot slip past the denylist', () => {
    for (const url of [
      'ipfs://zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7',
      'https://ipfs.io/ipfs/f01701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a',
      'https://k2jmtxw8rjh1z69c6not3wbfllaqxlycv9mmnvh62ztxrh3edhprnl6t.ipfs.dweb.link/',
      'ipfs://bafy',
    ]) {
      expect(isDeniedMedia(url)).toBe(true)
      expect(imageSourceFor(url)).toEqual({ kind: 'denied' })
    }
  })

  it('refuses a path that could leave its CID, so a listed CID cannot hide behind another', () => {
    const other = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
    for (const url of [
      `ipfs://${other}/../${CID_V1}`,
      `ipfs://${other}/%2e%2e/${CID_V1}`,
      `ipfs://${other}/.%2E/${CID_V1}`,
      `ipfs://${other}/./a.png`,
      `https://ipfs.io/ipfs/${other}/..%2f${CID_V1}`,
      `https://ipfs.io/ipfs/${other}/..\\${CID_V1}`,
      `https://${other}.ipfs.dweb.link/../ipfs/${CID_V1}`,
    ]) {
      expect(isDeniedMedia(url)).toBe(true)
      expect(imageSourceFor(url)).toEqual({ kind: 'denied' })
      expect(scriptCid(url)).toBeNull()
    }
    expect(imageSourceFor(`ipfs://${other}/a..b/c.png`)).toEqual({ kind: 'ipfs', ipfsUrl: `ipfs://${other}/a..b/c.png` })
  })

  it('refuses a percent-encoded IPFS reference, which a gateway would decode to listed content', () => {
    for (const url of [
      `https://ipfs.io/unused/../ipfs/${CID_V1}`,
      `https://ipfs.io/unused/%2e%2e/ipfs/${CID_V1}`,
      `https://ipfs.io/unused\\..\\ipfs/${CID_V1}`,
      `https://@${CID_V1}.ipfs.dweb.link/a.png`,
      `https://user:pass@${CID_V1}.ipfs.dweb.link/a.png`,
      `https://user@ipfs.io/ipfs/x/../${CID_V1}`,
      `https://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy.ipfs.example@${CID_V1}.ipfs.dweb.link/a.png`,
      `https://ipfs.io/ipfs/%62${CID_V1.slice(1)}`,
      `https://ipfs.io/%69pfs/${CID_V1}`,
      `https://ipfs.io/%69pfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy`,
    ]) {
      expect(isDeniedMedia(url)).toBe(true)
      expect(imageSourceFor(url)).toEqual({ kind: 'denied' })
      expect(scriptCid(url)).toBeNull()
    }
    expect(imageSourceFor('https://cdn.example/a%20b.png').kind).toBe('proxied')
    // An ordinary site's dot segments or encoded slashes stay ordinary (Firebase Storage paths use %2F).
    expect(imageSourceFor('https://firebasestorage.googleapis.com/v0/b/x/o/images%2Fa.jpg?alt=media').kind).toBe('proxied')
    expect(imageSourceFor('https://cdn.example/a/../b.png').kind).toBe('proxied')
  })

  it('drops a gateway query string from the IPFS path', () => {
    const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
    expect(imageSourceFor(`https://ipfs.io/ipfs/${cid}?filename=a.png`)).toEqual({ kind: 'ipfs', ipfsUrl: `ipfs://${cid}` })
  })
})

describe('imageSourceFor', () => {
  it('sends IPFS to the gateways, keeping the path', () => {
    const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
    expect(imageSourceFor(`ipfs://${cid}/a.png`)).toEqual({ kind: 'ipfs', ipfsUrl: `ipfs://${cid}/a.png` })
    expect(imageSourceFor(`https://ipfs.io/ipfs/${cid}/a.png`)).toEqual({ kind: 'ipfs', ipfsUrl: `ipfs://${cid}/a.png` })
    expect(imageSourceFor(`https://${cid}.ipfs.dweb.link/a.png`)).toEqual({ kind: 'ipfs', ipfsUrl: `ipfs://${cid}/a.png` })
  })

  it('proxies every other https image without cache-busting', () => {
    const source = imageSourceFor('https://cdn.example/a b.jpg?x=1&y=2', 'avatar')
    expect(source).toEqual({
      kind: 'proxied',
      url: 'https://wsrv.nl/?url=https%3A%2F%2Fcdn.example%2Fa%20b.jpg%3Fx%3D1%26y%3D2&w=256&we&n=-1&output=webp',
    })
    expect(proxiedImageUrl('https://cdn.example/a.jpg')).toBe(proxiedImageUrl('https://cdn.example/a.jpg'))
  })

  it('loads inline and same-origin images as they are', () => {
    expect(imageSourceFor('data:image/svg+xml;base64,AAAA')).toEqual({ kind: 'local', url: 'data:image/svg+xml;base64,AAAA' })
    expect(imageSourceFor('blob:https://yap.pr/1234')).toEqual({ kind: 'local', url: 'blob:https://yap.pr/1234' })
    expect(imageSourceFor('/yappr.jpg')).toEqual({ kind: 'local', url: '/yappr.jpg' })
  })

  it('loads nothing that is denied, plain http, protocol-relative or another scheme', () => {
    expect(imageSourceFor(`ipfs://${CID_V1}`)).toEqual({ kind: 'denied' })
    expect(imageSourceFor(DENIED_URL)).toEqual({ kind: 'denied' })
    for (const url of ['http://example.com/a.png', '//example.com/a.png', '/\\example.com/a.png', '/\t/example.com/a.png', 'javascript:alert(1)', 'file:///x', '', '   ', null, undefined]) {
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
    }
  })
})
