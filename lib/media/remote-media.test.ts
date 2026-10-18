import { describe, expect, it } from 'vitest'
import {
  canonicalHttpsUrl,
  imageSourceFor,
  ipfsCidOf,
  isSafeMediaUrl,
  proxiedImageUrl,
} from './remote-media'

const CID_V1 = 'bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va'
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
const PREVIOUSLY_FILTERED_URL = 'https://Tracker.example/pixel.png?id=1#frag'

describe('ipfsCidOf', () => {
  it('reads the CID from every IPFS spelling', () => {
    expect(ipfsCidOf(`ipfs://${CID_V1}`)).toBe(CID_V1)
    expect(ipfsCidOf(`ipfs://ipfs/${CID_V1}/a.png`)).toBe(CID_V1)
    expect(ipfsCidOf(`https://gateway.pinata.cloud/ipfs/${CID_V0}/x`)).toBe(CID_V0)
    expect(ipfsCidOf(`https://${CID_V1}.ipfs.dweb.link/a.png`)).toBe(CID_V1)
    expect(ipfsCidOf('https://example.com/a.png')).toBeNull()
  })
})

describe('media URL safety', () => {
  it('renders formerly filtered-style CIDs and https URLs without a client content list', () => {
    for (const url of [`ipfs://${CID_V1}`, `ipfs://${CID_V1.toUpperCase()}/file.jpg`, `https://${CID_V1}.ipfs.dweb.link/`, `https://ipfs.io/ipfs/${CID_V0}`]) {
      expect(isSafeMediaUrl(url)).toBe(true)
      expect(imageSourceFor(url).kind).toBe('ipfs')
    }
    expect(imageSourceFor(PREVIOUSLY_FILTERED_URL)).toEqual({ kind: 'proxied', url: proxiedImageUrl(PREVIOUSLY_FILTERED_URL) })
  })

  it('canonicalizes equivalent spellings of a URL and preserves distinct queries', () => {
    const canonical = canonicalHttpsUrl('https://tracker.example/pixel.png?id=1')
    for (const same of [
      'https://tracker.example:443/pixel.png?id=1',
      'https://tracker.example:0443/pixel.png?id=1',
      'https://TRACKER.example./pixel.png?id=1#x',
      'https://tracker.example/unused/../pixel.png?id=1',
      'https://tracker.example/unused/%2E%2e/./pixel.png?id=1',
      'https://tracker.example/unused\\..\\pixel.png?id=1',
    ]) {
      expect(canonicalHttpsUrl(same)).toBe(canonical)
      expect(isSafeMediaUrl(same)).toBe(true)
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
    // Other spellings of an IPv4 address are ambiguous, so they are refused; dotted decimal is fine.
    for (const host of ['16843009', '0x1.1.1.1', '01.1.1.1', '1.1.257', '1.1.1.1.']) {
      expect(isSafeMediaUrl(`https://${host}/pixel.png`)).toBe(false)
    }
    expect(isSafeMediaUrl('https://1.1.1.1/pixel.png')).toBe(true)
    expect(isSafeMediaUrl('https://tracker.example/pixel.png?id=2')).toBe(true)
    expect(isSafeMediaUrl('https://tracker.example/pixel.png?id=1&x')).toBe(true)
    // A fragment is never requested, whatever it holds (line separators included).
    for (const fragment of ['#a\u2028b', '#a\u2029b']) {
      expect(canonicalHttpsUrl(`https://tracker.example/pixel.png?id=1${fragment}`)).toBe(canonical)
      expect(isSafeMediaUrl(`https://tracker.example/pixel.png?id=1${fragment}`)).toBe(true)
    }
  })
})

describe('IPFS spellings', () => {
  it('treats only CIDs in the two spellings Yappr writes as IPFS content', () => {
    expect(ipfsCidOf('https://docs.ipfs.tech/logo.png')).toBeNull()
    expect(imageSourceFor('https://docs.ipfs.tech/logo.png').kind).toBe('proxied')
    // Only a CID can follow a path gateway's /ipfs/: anything else is refused, not guessed at.
    expect(imageSourceFor('https://example.com/ipfs/notacid.png')).toEqual({ kind: 'none' })
  })

  it('refuses any other spelling of a CID, to keep gateway routing unambiguous', () => {
    for (const url of [
      'ipfs://zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7',
      'https://ipfs.io/ipfs/f01701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a',
      'https://k2jmtxw8rjh1z69c6not3wbfllaqxlycv9mmnvh62ztxrh3edhprnl6t.ipfs.dweb.link/',
      'ipfs://bafy',
      // base64url (`u…`) carries punctuation, which no alphabet heuristic catches.
      'https://ipfs.io/ipfs/uAXASIJ00OJvXLJYZ46V2uRPI2G68_2AOFWMsGCPx18olnBqo',
      'ipfs://uAXASIJ00OJvXLJYZ46V2uRPI2G68_2AOFWMsGCPx18olnBqo/a.png',
      'https://ipfs.io/ipfs/mAXASIJ00OJvXLJYZ46V2uRPI2G68+2AOFWMsGCPx18olnBqo',
      // The CIDv0 bytes of a CID, spelled in base32 (gateways accept it).
      'https://ipfs.io/ipfs/bciqj2nbytplszfqz4osxnoitzdmg5ph7mahbkyzmdar7dv6kewobvka',
      'ipfs://bciqj2nbytplszfqz4osxnoitzdmg5ph7mahbkyzmdar7dv6kewobvka',
      // The same bytes with base32's unused trailing bits set (`…va` → `…vb`).
      `ipfs://${CID_V1.slice(0, -1)}b`,
      `https://ipfs.io/ipfs/${CID_V1.slice(0, -1)}b/a.png`,
      `https://${CID_V1.slice(0, -1)}b.ipfs.dweb.link/`,
      // IPNS names are mutable and can point at anything.
      'https://ipfs.io/ipns/example.com/a.png',
      'https://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8.ipns.dweb.link/',
      'ipns://example.com',
    ]) {
      expect(isSafeMediaUrl(url)).toBe(false)
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
    }
  })

  it('refuses a path that could leave its CID, so gateway routing stays within its CID', () => {
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
      expect(isSafeMediaUrl(url)).toBe(false)
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
    }
    expect(imageSourceFor(`ipfs://${other}/a..b/c.png`)).toEqual({ kind: 'ipfs', ipfsUrl: `ipfs://${other}/a..b/c.png` })
  })

  it('refuses a percent-encoded IPFS reference, rather than guessing at gateway routing', () => {
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
      // A non-UTF-8 byte inside the same segment as the encoded separators.
      `https://ipfs.io/ipfs%2Fx%FF%2F..%2F${CID_V1}/photo.jpg`,
      // Backslashes or extra slashes before the host: browsers skip them and start the host after.
      `https://\\${CID_V1}.ipfs.dweb.link/a.png`,
      `https:///${CID_V1}.ipfs.dweb.link/a.png`,
      `https:\\\\${CID_V1}.ipfs.dweb.link/a.png`,
      `https://ipfs.io\\ipfs/${CID_V1}`,
      `https://ipfs.io/ipfs/%62${CID_V1.slice(1)}`,
      `https://ipfs.io/%69pfs/${CID_V1}`,
      `https://ipfs.io/%69pfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy`,
    ]) {
      expect(isSafeMediaUrl(url)).toBe(false)
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
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
    expect(isSafeMediaUrl(url)).toBe(true)
    expect(imageSourceFor(`https://${other}.ipfs.dweb.link/ipfs/x/a.png`))
      .toEqual({ kind: 'ipfs', ipfsUrl: `ipfs://${other}/ipfs/x/a.png` })
  })

  it('refuses repeated slashes before a CID, which gateways collapse', () => {
    for (const url of [`https://ipfs.io/ipfs//${CID_V1}/photo.jpg`, `https://ipfs.io//ipfs/${CID_V1}`, `https://ipfs.io/x//../ipfs/${CID_V1}`]) {
      expect(isSafeMediaUrl(url)).toBe(false)
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
    }
    // An ordinary site with a double slash stays ordinary.
    expect(imageSourceFor('https://cdn.example//a.png').kind).toBe('proxied')
  })

  it('refuses a URL with a tab or newline, which browsers drop (`i\\tpfs` is `ipfs`)', () => {
    for (const url of [`https://ipfs.io/i\tpfs/${CID_V1}`, `https://ipfs.io/ipfs/${CID_V1.slice(0, 10)}\n${CID_V1.slice(10)}`]) {
      expect(isSafeMediaUrl(url)).toBe(false)
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
    }
  })

  it('refuses an unpaired surrogate instead of throwing, and keeps paired ones', () => {
    for (const url of ['https://cdn.example/\uD800.png', 'https://cdn.example/a\uDC00b.png', `ipfs://${CID_V1}/\uD800`]) {
      expect(() => imageSourceFor(url)).not.toThrow()
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
      expect(isSafeMediaUrl(url)).toBe(false)
    }
    expect(imageSourceFor('https://cdn.example/\u{1F600}.png').kind).toBe('proxied')
  })

  it('bounds the work of a deeply escaped or overlong URL and fails closed', () => {
    const deep = `https://cdn.example/%${'25'.repeat(20000)}41.png`
    const nested = `https://cdn.example/%${'25'.repeat(500)}41.png`
    for (const url of [deep, nested]) {
      expect(() => imageSourceFor(url)).not.toThrow()
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
    }
    // One or two layers, as real URLs have, are fine.
    expect(imageSourceFor('https://cdn.example/a%2520b.png').kind).toBe('proxied')
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

  it('loads nothing with plain http, protocol-relative or another scheme', () => {
    for (const url of ['http://example.com/a.png', '//example.com/a.png', '/\\example.com/a.png', '/\t/example.com/a.png', 'javascript:alert(1)', 'data:text/html,unsafe', 'file:///x', '', '   ', null, undefined]) {
      expect(imageSourceFor(url)).toEqual({ kind: 'none' })
    }
  })
})
