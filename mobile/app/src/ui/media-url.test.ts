import { resolveMediaUrl, safeExternalUrl } from './media-url';

describe('media and link URLs', () => {
  it('sends IPFS through the gateway and passes http(s) through', () => {
    expect(resolveMediaUrl('ipfs://bafy/a.png')).toBe('https://ipfs.io/ipfs/bafy/a.png');
    expect(resolveMediaUrl('ipfs://ipfs/bafy', 'https://gw.example/ipfs/')).toBe(
      'https://gw.example/ipfs/bafy',
    );
    expect(resolveMediaUrl('https://x.org/a.png')).toBe('https://x.org/a.png');
    expect(resolveMediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
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
