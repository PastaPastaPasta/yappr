# Recovering moderator-deleted content

The read-only CLI recovers a verified copy of content removed by a moderator
from the social v17, blog v9 and storefront v10 contracts. It never signs,
broadcasts, spends DASH, or restores a document on-chain. No secrets are needed.
The official app's recovery UI is outside this tool. The CLI source is
MIT-licensed; see [the scoped license](../scripts/recovery/LICENSE).

Install the repository's pinned dependencies with Node.js 20+ and `npm ci`.
Run from the repository root:

```sh
NETWORK=testnet node scripts/recover-deleted.mjs list \
  --contract HAEBfyZP9ECiX8crakwRSdjvVDkeJKPbG8Zs4YaRQrRa --type blog

NETWORK=testnet node scripts/recover-deleted.mjs recover \
  --contract HAEBfyZP9ECiX8crakwRSdjvVDkeJKPbG8Zs4YaRQrRa --type blog \
  --id F9eSmdE32Y2ywKL6bHhpd177yRzGwgxXAVzLCvwtLZNy --out ./recovered
```

Both commands accept `--owner ID` or `--id ID`. Without either, they page all
records for the supplied contract and type. `list --out FILE` exports the
proved pages and wire responses. `recover --out DIRECTORY` writes one JSON
bundle per matching document, refuses to overwrite existing files, and exits
nonzero if any record cannot be recovered. A bundle is kept and reported as
recovered only after a fresh process verifies it offline. A failed read never becomes an
empty result. A type that cannot keep moderator-removal records (such as DPNS
`domain` or Yappr `report`) is reported separately using its proved contract
configuration. An unknown contract or type is an error.

Use `NETWORK=mainnet` explicitly for mainnet **reads** and supply the mainnet
contract ID. The tool does not assume a Yappr mainnet deployment ID.

## What the evidence proves

Platform computes a double SHA-256 of the document serialized at deletion and
permanently stores it in the removal record. The CLI reads records with SDK
proof verification, obtains candidate create/replace transition bytes from
untrusted archives, selects the exact contract/type/document/owner within a
batch, rebuilds the document, and accepts only a byte serialization matching
that hash. This binds the recovered content, owner, revision and system times
to the document Platform removed. It also displays the proved moderator,
reason, deletion time and record height. Private-feed content stays ciphertext.

A separate proved document read reports presence or absence **at its own
exported height**. Restored records remain in the record list; a restored
or subsequently edited document can be present. A document can also be absent
after its owner deleted it following a restore. These reads are not an atomic
snapshot, and an exported absence is not a promise of future absence.

The tool does not recover author deletions/tombstones without a moderator
record, reports whose types discard records, or older revisions not committed
by a removal record. Bans and suspensions delete no content. A verified copy
**does not undo a deletion**, override a ban, or grant permission to republish.
It does not separately verify the source transition's author signature or its
block inclusion. The hash commitment is the authority for the recovered copy;
a signature merely being present in the source bytes is not signature verification.

## Sources and serialization

The default testnet archive is `https://testnet.platform-explorer.pshenmic.dev`.
Mainnet tries `https://api.pe.dashhq.org` and
`https://platform-explorer.pshenmic.dev`. Supply repeated `--explorer URL`
options to replace the defaults with compatible APIs. Each must expose paged
`/document/ID/revisions?limit=100&order=asc&page=N` (`resultSet`, optional
`pagination.total`) and `/transaction/HASH` (`data`, base64 raw transition).
History is paged up to 100 pages (10,000 revisions), with a 60-second deadline
per source and an 8 MiB cap per response. Repeated pages fail over. Eligible
create/replace candidates are tried
newest first, through multiple sources until one matches. Archive omission or
bad metadata can prevent recovery, but cannot make an altered copy hash-match.

For a local raw binary transition, add `--transition FILE --created-at MS
--updated-at MS` to `recover` (timestamps are decimal milliseconds). Kept
record fields take precedence. Or pass repeated `--source-file FILE` options
containing:

```json
{"candidates":[{"transitionBase64":"…","createdAt":1792350204067,"updatedAt":1792350204067,"revision":1}]}
```

A raw `--transition` requires `--id`. Local sources are tried before archives. The original create time is needed
when the removal record does not keep it, including for a replaced document.
The signed replace transition supplies its revision. Transfer and price-update
transitions are not supported; no moderated v17 content type is transferable. No edited-then-deleted
live fixture was available for this read-only validation; replacement handling
has an offline synthetic regression test.

The pinned SDK supplies the serializer. `--platform-version` defaults to **14**,
the deletion protocol of this release and the captured fixtures. Use the
version of the deleting block for other deployments; unsupported versions fail.
The tool tries document contract versions 1 through the fetched contract's
version (up to 100), or the explicit `--contract-version N`. It handles the
historical optional revision/update-time combinations by hash matching. If a
later contract schema changed serialization, recovery may require the original
schema and a compatible SDK; this version fetches the current schema and fails
closed when no serialization matches. Retain the lockfile and fixtures when
upgrading the SDK.

## Offline verification and trust

Each bundle contains the record and its proof bytes/metadata, raw transition,
rebuilt JSON and serialized document, presence/absence proof, and the SDK's
recorded read responses and quorum context. Each recovery bundle uses a
fresh single-document removal query and excludes earlier documents' read
responses. Keep the printed **quorum snapshot
SHA256** independently of the bundle. For the checked-in blog fixture:

```sh
node scripts/recover-deleted.mjs verify scripts/recovery/fixtures/blog-testnet.json \
  --trust-quorums 321835727f0bfb7cb2bb4031e9a1ac68cbcac7ef91af48810109fcd5cf132987
```

`verify` blocks every unrecorded request and replays the responses through the
pinned SDK, repeating GroveDB proof and quorum-signature verification, checking
the record against that proof, and rebuilding/hash-checking the content again.
No `NETWORK` or network connectivity is needed. It also re-verifies the
exported presence/absence evidence, at the recorded height.

The SDK runs in **trusted quorum context mode**: online it trusts the public
network quorum-key service, not a locally verified Dash Core chain. Offline,
the digest pins that context. Obtain the digest from your own online recovery
or another trusted channel; copying a digest supplied alongside an untrusted
bundle does not authenticate its quorum keys. The bundle alone is not a
self-authenticating chain-of-trust from Dash Core genesis. Historical key
snapshots remain useful after public quorum services rotate their keys.

## Read-only validation, 2026-11-11

On the `/staging-old` testnet registrations from `.env.staging-old`:

| Contract | Type | Removal records | Hash matches | Proved absent | Proved present |
| --- | --- | ---: | ---: | ---: | ---: |
| Social `AbDUiaXbJML5FQGSpt5oEdx88tXK8FPRXbAt1jwK3Us9` | post | 2 | 2 | 0 | 2 |
| Social | reply / yapprProfile | 0 | 0 | 0 | 0 |
| Blog `HAEBfyZP9ECiX8crakwRSdjvVDkeJKPbG8Zs4YaRQrRa` | blog | 2 | 2 | 2 | 0 |
| Blog | blogPost | 1 | 1 | 1 | 0 |
| Blog | blogComment | 1 | 1 | 1 | 0 |
| Storefront `9Z5W23rzbMdwPBEn9e5pKKz6rmRVAkoCYDTWaqzLpWqS` | store | 1 | 1 | 1 | 0 |
| Storefront | storeItem | 1 | 1 | 1 | 0 |
| Storefront | storeReview | 1 | 1 | 1 | 0 |
| Storefront | itemReview | 1 | 1 | 1 | 0 |
| **Total** | | **10** | **10** | **8** | **2** |

Recovery/presence proofs were read at Platform
heights 668957–668963. All ten exported bundles also passed offline verification.
The checked-in fixtures preserve representative proof, byte-field and restored
cases. Mainnet `list` of DPNS
`GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec/domain` cleanly reported zero
recoverable records: its proved schema does not keep moderator-removal records.

Run `npx vitest run scripts/recovery` for the CLI, pagination, rebuild, source
fallback and tamper-rejection tests, or `npm run test` for the full unit suite.
