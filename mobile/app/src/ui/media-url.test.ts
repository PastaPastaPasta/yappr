import { resolveMediaUrl, safeExternalUrl } from './media-url';

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

describe('media and link URLs', () => {
  it('sends IPFS through the gateway and other https images through the image proxy', () => {
    expect(resolveMediaUrl(`ipfs://${CID}/a.png`)).toBe(`https://ipfs.io/ipfs/${CID}/a.png`);
    expect(resolveMediaUrl(`ipfs://ipfs/${CID}`, 'https://gw.example/ipfs/')).toBe(
      `https://gw.example/ipfs/${CID}`,
    );
    // A gateway URL is IPFS content too: it goes to the viewer's gateway, not the named host.
    expect(resolveMediaUrl(`https://other.gw/ipfs/${CID}/a.png`)).toBe(`https://ipfs.io/ipfs/${CID}/a.png`);
    expect(resolveMediaUrl('https://x.org/a.png')).toBe(
      'https://wsrv.nl/?url=https%3A%2F%2Fx.org%2Fa.png&w=1600&we&n=-1&output=webp',
    );
    expect(resolveMediaUrl('https://x.org/a.png', undefined, 'avatar')).toContain('&w=256&');
    expect(resolveMediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('loads no plain-http, blob, app-relative or other-scheme image', () => {
    for (const bad of ['http://x.org/a.png', 'blob:x', '/a.png', 'file:///a.png', 'javascript:alert(1)', '', null]) {
      expect(resolveMediaUrl(bad)).toBeNull();
    }
  });

  it('refuses every other scheme for links', () => {
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'yappr://x',
      'data:image/png;base64,AA',
      '',
      null,
    ]) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
    expect(safeExternalUrl('http://x.org')).toBe('http://x.org');
  });
});

describe('media without a client content list', () => {
  it('resolves formerly filtered-style media while refusing malformed URLs', () => {
    const cid = 'bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va';
    expect(resolveMediaUrl(`ipfs://${cid}`)).toBe(`https://ipfs.io/ipfs/${cid}`);
    expect(safeExternalUrl(`ipfs://${cid}`)).toBe(`https://ipfs.io/ipfs/${cid}`);
    expect(resolveMediaUrl('https://tracker.example/pixel.png?id=1')).toContain('https://wsrv.nl/');
    for (const url of ['https://ipfs.io/ipns/example.com', 'https://cdn.example/\uD800.png', `https://ipfs.io/ipfs//${cid}`, `https://user@${cid}.ipfs.dweb.link/`, `https://ipfs.io/i\tpfs/${cid}`]) {
      expect(resolveMediaUrl(url)).toBeNull();
      expect(safeExternalUrl(url)).toBeNull();
    }
  });
});
