# Media takedown runbook

This documents the existing source-maintained media denylist, not a promise to
review reports or remove content. D35 says Yappr has no centralized moderation:
it is open-source code for Dash Platform, and its authors cannot change, remove
or recover data on the network. On-chain moderation belongs to independent teams
elected by the community through masternode votes. General contact:
`support@dash.org`; email does not file an on-chain report or guarantee action.

**Owner question:** does this team-maintained client display filter conflict
with “no centralized moderation”? The mechanism remains unchanged pending that
decision. Earlier plans for a signed runtime moderation list or a response SLA
are superseded by D35 and are not release gates.

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
  any other spelling (`z…`, `f…`, `k…`, `u…`) is refused outright, so it
  can't be used to get around an entry. IPNS names (`/ipns/…`, `….ipns.…`)
  are refused too: they are mutable and can point at anything. An entry covers everything under its CID, but
  not the same file wrapped in a new directory, which has a different root
  CID: list that CID too.
- **Any other https URL, by the sha256 of its canonical form**: the URL as a
  browser requests it (host lowercased, default port and fragment dropped,
  `.`/`..` segments resolved), so equivalent spellings match one entry. The
  query string counts, so `?a=1` and `?a=2` are different entries, and a
  server that serves the same file under other paths needs an entry per path.
  Only the hash goes in the public repository, never the URL.

It does **not** remove anything from the chain or from IPFS. Other clients
and public gateways still serve the bytes. The app may not display some media, while the original remains available elsewhere.

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
  Production (`yap.pr`) deploys from `master`, so a display-filter update needs the
  owner to merge the denylist commit to `master` (or promote `staging`) and
  confirm the Pages deploy ran. The `/testing` and `/devnet` builds pick it up
  on their next deploy.
- **Mobile.** The list is in the JS bundle, so it takes effect with the next
  app build. A display-filter update
  means a new build to TestFlight and Play internal testing.
- **Check it.** After the deploy, open the post, profile or store that showed
  the media. The placeholder should appear and the network panel should show
  no request for the item.

## Other services and on-chain content

Only the community-elected teams can use the moderation powers in their
contracts. App maintainers do not direct them. Hosts, pinning providers, public
gateways and image proxies have their own policies and support channels; a
client denylist entry does not delete their copies or purge their caches.
If a child is in danger, contact local police or the NCMEC CyberTipline.

## Removing an entry

Delete the entry from `lib/media/media-denylist.json` in a reviewed PR that
gives the reason in its description, citing the `ref`.
