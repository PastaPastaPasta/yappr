import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalHttpsUrl as scriptCanonical, effectiveDestination as scriptDestination, ipfsCidOf as scriptCid, urlSha256 } from '../../scripts/media-denylist.mjs'
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

  it('hashes equivalent spellings of a URL alike, and different queries apart', () => {
    const listed = canonicalHttpsUrl('https://tracker.example/pixel.png?id=1')
    for (const same of [
      'https://tracker.example:443/pixel.png?id=1',
      'https://tracker.example:0443/pixel.png?id=1',
      'https://TRACKER.example./pixel.png?id=1#x',
      'https://tracker.example/unused/../pixel.png?id=1',
      'https://tracker.example/unused/%2E%2e/./pixel.png?id=1',
      'https://tracker.example/unused\\..\\pixel.png?id=1',
    ]) {
      expect(canonicalHttpsUrl(same)).toBe(listed)
      expect(isDeniedMedia(same)).toBe(true)
    }
    // Browsers send the encoded form of literal non-ASCII and spaces.
    expect(canonicalHttpsUrl('https://cdn.example/caf\u00e9 1.png?q=\u00e9 x')).toBe(canonicalHttpsUrl('https://cdn.example/caf%c3%a9%201.png?q=%C3%A9%20x'))
    expect(canonicalHttpsUrl('https://cdn.example/caf\u00e9.png')).toBe('https://cdn.example/caf%C3%A9.png')
    expect(canonicalHttpsUrl('https://cdn.example/pix\nel.png')).toBe('https://cdn.example/pixel.png')
    expect(canonicalHttpsUrl('https://tracker.example')).toBe('https://tracker.example/')
    // A fragment is never part of the request, even when it looks like a query.
    expect(canonicalHttpsUrl('https://cdn.example#?ignored=1')).toBe('https://cdn.example/')
    expect(canonicalHttpsUrl('https://cdn.example/a#?ignored=1')).toBe('https://cdn.example/a')
    expect(canonicalHttpsUrl('https://tracker.example/a/..')).toBe('https://tracker.example/')
    expect(canonicalHttpsUrl('https://tracker.example:8443/pixel.png?id=1')).toBe('https://tracker.example:8443/pixel.png?id=1')
    // Other spellings of an IPv4 address can't be hashed alike, so they are refused; dotted decimal is fine.
    for (const host of ['16843009', '0x1.1.1.1', '01.1.1.1', '1.1.257', '1.1.1.1.']) {
      expect(isDeniedMedia(`https://${host}/pixel.png`)).toBe(true)
      expect(scriptCid(`https://${host}/ipfs/${CID_V1}`)).toBeNull()
    }
    expect(isDeniedMedia('https://1.1.1.1/pixel.png')).toBe(false)
    expect(isDeniedMedia('https://tracker.example/pixel.png?id=2')).toBe(false)
    expect(isDeniedMedia('https://tracker.example/pixel.png?id=1&x')).toBe(false)
  })

  it('has a script that hashes exactly as the renderers do', () => {
    for (const url of [
      DENIED_URL, 'https://a.b/c?d=e&f=g', 'https://EXAMPLE.com', `https://${CID_V1}.ipfs.dweb.link/x`,
      'https://a.b:443/x/../y/./z?q#f', 'https://a.b.:8443/%2e%2E/x\\y', 'https://a.b/x/..',
      'https://a.b/caf\u00e9 x.png?q=\u00e9"\'<>', 'https://a.b/%c3%a9`{}',
    ]) {
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
    // Only a CID can follow a path gateway's /ipfs/: anything else is refused, not guessed at.
    expect(imageSourceFor('https://example.com/ipfs/notacid.png')).toEqual({ kind: 'denied' })
  })

  it('refuses any other spelling of a CID, so it cannot slip past the denylist', () => {
    for (const url of [
      'ipfs://zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7',
      'https://ipfs.io/ipfs/f01701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a',
      'https://k2jmtxw8rjh1z69c6not3wbfllaqxlycv9mmnvh62ztxrh3edhprnl6t.ipfs.dweb.link/',
      'ipfs://bafy',
      // base64url (`u…`) carries punctuation, which no alphabet heuristic catches.
      'https://ipfs.io/ipfs/uAXASIJ00OJvXLJYZ46V2uRPI2G68_2AOFWMsGCPx18olnBqo',
      'ipfs://uAXASIJ00OJvXLJYZ46V2uRPI2G68_2AOFWMsGCPx18olnBqo/a.png',
      'https://ipfs.io/ipfs/mAXASIJ00OJvXLJYZ46V2uRPI2G68+2AOFWMsGCPx18olnBqo',
      // The same bytes with base32's unused trailing bits set (`…va` → `…vb`).
      `ipfs://${CID_V1.slice(0, -1)}b`,
      `https://ipfs.io/ipfs/${CID_V1.slice(0, -1)}b/a.png`,
      `https://${CID_V1.slice(0, -1)}b.ipfs.dweb.link/`,
      // IPNS names are mutable and can point at anything.
      'https://ipfs.io/ipns/example.com/a.png',
      'https://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8.ipns.dweb.link/',
      'ipns://example.com',
    ]) {
      expect(isDeniedMedia(url)).toBe(true)
      expect(imageSourceFor(url)).toEqual({ kind: 'denied' })
      expect(scriptCid(url)).toBeNull()
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
      // Hostname processing maps these to ASCII: `。` to `.`, fullwidth letters to their ASCII forms.
      `https://${CID_V1}\u3002ipfs.dweb.link/a.png`,
      `https://${CID_V1}.\uff49pfs.dweb.link/a.png`,
      `https://ipfs\uff0eio/ipfs/${CID_V1}`,
      // An escaped authority, with a malformed path escape that would stop whole-URL decoding.
      `https://${CID_V1}%E3%80%82ipfs.dweb.link/photo%FF.png`,
      `https://ipfs.io/%69pfs/${CID_V1}/photo%FF.png`,
      `https://ipfs.io/x%2F..%2Fipfs/${CID_V1}/photo%FF.png`,
      // Backslashes or extra slashes before the host: browsers skip them and start the host after.
      `https://\\${CID_V1}.ipfs.dweb.link/a.png`,
      `https:///${CID_V1}.ipfs.dweb.link/a.png`,
      `https:\\\\${CID_V1}.ipfs.dweb.link/a.png`,
      `https://ipfs.io\\ipfs/${CID_V1}`,
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
    // Non-ASCII paths are fine; only the host has to be plain ASCII.
    expect(imageSourceFor('https://cdn.example/caf\u00e9.png').kind).toBe('proxied')
    expect(imageSourceFor('https://cdn.example:8443/a.png?x=1#y').kind).toBe('proxied')
  })

  it('reads a subdomain gateway by its host CID, even with an /ipfs/ path', () => {
    const other = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
    const url = `https://${CID_V1}.ipfs.dweb.link/ipfs/${other}/photo.jpg`
    expect(ipfsCidOf(url)).toBe(CID_V1)
    expect(scriptCid(url)).toBe(CID_V1)
    expect(isDeniedMedia(url)).toBe(true)
    expect(imageSourceFor(`https://${other}.ipfs.dweb.link/ipfs/x/a.png`))
      .toEqual({ kind: 'ipfs', ipfsUrl: `ipfs://${other}/ipfs/x/a.png` })
  })

  it('refuses repeated slashes before a CID, which gateways collapse, and the script lists the CID they reach', () => {
    for (const url of [`https://ipfs.io/ipfs//${CID_V1}/photo.jpg`, `https://ipfs.io//ipfs/${CID_V1}`, `https://ipfs.io/x//../ipfs/${CID_V1}`]) {
      expect(isDeniedMedia(url)).toBe(true)
      expect(imageSourceFor(url)).toEqual({ kind: 'denied' })
      expect(scriptCid(scriptDestination(url))).toBe(CID_V1)
    }
    // An ordinary site with a double slash stays ordinary.
    expect(imageSourceFor('https://cdn.example//a.png').kind).toBe('proxied')
  })

  it('refuses a URL with a tab or newline, which browsers drop (`i\\tpfs` is `ipfs`)', () => {
    for (const url of [`https://ipfs.io/i\tpfs/${CID_V1}`, `https://ipfs.io/ipfs/${CID_V1.slice(0, 10)}\n${CID_V1.slice(10)}`]) {
      expect(isDeniedMedia(url)).toBe(true)
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
      expect(scriptCid(url)).toBeNull()
    }
  })

  it('refuses an unpaired surrogate instead of throwing, and keeps paired ones', () => {
    for (const url of ['https://cdn.example/\uD800.png', 'https://cdn.example/a\uDC00b.png', `ipfs://${CID_V1}/\uD800`]) {
      expect(() => imageSourceFor(url)).not.toThrow()
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
      expect(isDeniedMedia(url)).toBe(true)
      expect(scriptCid(url)).toBeNull()
    }
    expect(imageSourceFor('https://cdn.example/\u{1F600}.png').kind).toBe('proxied')
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
