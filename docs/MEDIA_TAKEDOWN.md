# Media takedown runbook

How to stop Yappr's own apps from showing a piece of media: illegal content,
doxxing, a court order, or anything else that has to come down. This is the
minimal static denylist (backlog R-M27). The signed, runtime-updatable list
(Y7a in `docs/mobile/COMPLIANCE.md`) replaces it before any mobile store
submission.

## What the denylist does and doesn't do

`lib/media/media-denylist.json` is bundled into the web build and the mobile
JS bundle. Every image, video and link-preview renderer checks it through
`lib/media/remote-media.ts` (`imageSourceFor` and `isDeniedMedia`):

- web: `IpfsImage` (post and reply media, avatars, banners, store and blog
  images, link-preview pictures and icons), the Radix `AvatarImage`, post
  videos, link-preview cards, and the HTML embed renderer;
- mobile: `resolveMediaUrl` in `mobile/app/src/ui/media-url.tsx`, which every
  `expo-image` source goes through, and `LinkPreviewCard`.

A listed item renders as a neutral "Media unavailable" placeholder, or the
default avatar or banner gradient. A listed link gets no preview card.

The list matches two things:

- **IPFS content, by CID.** Every URL shape is caught: `ipfs://CID/…`, any
  `https://host/ipfs/CID/…` path gateway and any `https://CID.ipfs.host/…`
  subdomain gateway. The apps only load CIDs in the two spellings Yappr
  writes, CIDv0 (`Qm…`) and base32 CIDv1 (`b…`, matched case-insensitively);
  any other spelling (`z…`, `f…`, `k…`) is refused outright, so it can't be
  used to get around an entry. An entry covers everything under its CID, but
  not the same file wrapped in a new directory, which has a different root
  CID: list that CID too.
- **Any other https URL, by the sha256 of its canonical form**: trimmed, with
  scheme and host lowercased and the fragment dropped. The query string
  counts, so `?a=1` and `?a=2` are different entries. Only the hash goes in the
  public repository, never the URL.

It does **not** remove anything from the chain or from IPFS. Other clients
and public gateways still serve the bytes. Pair every entry with the steps in
"Also do" below.

## Add an entry

1. Get the exact reference from the report: the post's media URL, the avatar
   or banner URL, the store or blog image URL, or the link.
2. In a worktree off `staging`, run:

   ```bash
   node scripts/media-denylist.mjs check '<cid | ipfs://… | gateway URL | https URL>'
   node scripts/media-denylist.mjs add '<same>' --ref '<report or ticket id>'
   ```

   - For IPFS, the script lists the CID in its v0 and v1 forms where both
     exist, so `Qm…` and `bafy…` spellings of the same content are both caught.
   - `--ref` is the audit trail. Use a report or ticket id. **Never describe
     the content**, and never paste a non-IPFS URL into the commit, the PR or
     the ref.
3. Commit `lib/media/media-denylist.json` alone, with a neutral message such as
   `chore(moderation): update media denylist`. Open the PR to `staging` and
   merge it once CI is green.

## Ship it

- **Web.** The list takes effect when the build that contains it is deployed.
  Production (`yap.pr`) deploys from `master`, so an urgent takedown needs the
  owner to merge the denylist commit to `master` (or promote `staging`) and
  confirm the Pages deploy ran. The `/testing` and `/devnet` builds pick it up
  on their next deploy.
- **Mobile.** The list is in the JS bundle, so it takes effect with the next
  app build. Until the signed runtime list (Y7a) exists, an urgent takedown
  means a new build to TestFlight and Play internal testing.
- **Check it.** After the deploy, open the post, profile or store that showed
  the media. The placeholder should appear and the network panel should show
  no request for the item.

## Also do

1. **On chain.** If a moderator can still delete the document (posts and
   replies within 7 days), delete it. After that window, only the seated
   elected team can delete it.
2. **The pinning provider.** Report the CID through the abuse channel of the
   uploader's provider, Pinata or Storacha.
3. **Public gateways.** Report the CID to the IPFS Foundation's "badbits"
   denylist, which ipfs.io and dweb.link apply, and to 4everland.
4. **Illegal content.** For child sexual abuse material, report to NCMEC
   (CyberTipline), as the report dialog already links. Don't download or keep
   a copy beyond what the report needs.
5. **Image proxy.** wsrv.nl caches proxied images for up to 31 days and has no
   purge yet. The denylist stops Yappr asking for the URL; if the host has to
   take it down too, contact the host.

## Removing an entry

Delete the entry from `lib/media/media-denylist.json` in a reviewed PR that
gives the reason in its description, citing the `ref`.
