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
    // Escaped or non-ASCII hosts are refused, however the rest of the URL is spelled.
    expect(safeExternalUrl(`https://${cid}%E3%80%82ipfs.dweb.link/photo%FF.png`)).toBeNull();
    expect(safeExternalUrl(`https://\\${cid}.ipfs.dweb.link/a.png`)).toBeNull();
    expect(safeExternalUrl(`https://ipfs.io/i\tpfs/${cid}`)).toBeNull();
    // Other CID spellings and IPNS names can't be checked, so they are refused.
    expect(safeExternalUrl('https://ipfs.io/ipfs/uAXASIJ00OJvXLJYZ46V2uRPI2G68_2AOFWMsGCPx18olnBqo')).toBeNull();
    expect(safeExternalUrl('https://ipfs.io/ipns/example.com/')).toBeNull();
    // A subdomain gateway's host CID is the root, whatever /ipfs/ path follows.
    expect(safeExternalUrl(`https://${cid}.ipfs.dweb.link/ipfs/bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va/a.png`)).toBeNull();
    // A valid unlisted CID in the userinfo can't stand in for the listed host.
    expect(safeExternalUrl(`https://bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va.ipfs.x@${cid}.ipfs.dweb.link/`)).toBeNull();
    expect(resolveMediaUrl('ipfs://bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va')).not.toBeNull();
  });
});
