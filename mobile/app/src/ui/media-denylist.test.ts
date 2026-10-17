import { resolveMediaUrl, safeExternalUrl } from './media-url';

// The web's checked-in takedown list (lib/media/media-denylist.json), with one entry.
jest.mock('../../../../lib/media/media-denylist.json', () => ({
  cids: [{ cid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', added: '2026-10-16', ref: 'TEST' }],
  urlSha256: [],
}));

describe('the media takedown denylist on mobile', () => {
  it('never resolves listed media, in any IPFS spelling', () => {
    const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
    for (const url of [`ipfs://${cid}`, `ipfs://${cid.toUpperCase()}/a.png`, `https://ipfs.io/ipfs/${cid}`]) {
      expect(resolveMediaUrl(url)).toBeNull();
    }
    expect(safeExternalUrl(`ipfs://${cid}`)).toBeNull();
    expect(resolveMediaUrl('ipfs://bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va')).not.toBeNull();
  });
});
