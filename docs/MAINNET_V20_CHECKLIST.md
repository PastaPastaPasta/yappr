# Mainnet v20 readiness checklist

**Status: preparation only. Nothing here has run on mainnet.** On
2026-11-22 the mainnet path from a fresh maker through registration, charter
seating and a root export ran on **testnet**, with the same scripts and
switches ([section 12](#12-testnet-rehearsal-of-the-mainnet-path-2026-11-22)); the per-index readback (step 5.6) was added afterwards and read the same set (section 12, item 15).
The whole rehearsal was rerun the same day with the SDK at 5.0.3 against
testnet Drive 5.0.3, the version mainnet runs ([section 12.1](#121-rerun-with-sdk-503-2026-11-22));
what still needs a person is [section 13](#13-what-still-needs-a-human). Mainnet
registration, the root site and `master` are held for QuantumExplorer's
go-ahead. This file lists what has to be true, run, configured and funded
before and after that go-ahead, and calls out what is still unknown. It
complements [MAINNET_RELEASE.md](MAINNET_RELEASE.md) (build configuration),
[SOCIAL_V20.md](SOCIAL_V20.md) (the social cut) and
[TESTNET_RELEASE.md](TESTNET_RELEASE.md) (the testnet runs this mirrors).

Written against staging `f578c596` (2026-11-21). Fees are in credits
(100e9 credits = 1 DASH) with ¢ at the repo's usual $60/DASH
(1M credits ≈ 0.06¢).

Owner tags: **[O]** owner (Pasta / QuantumExplorer), **[A]** agent or operator.

## 1. What mainnet registers

A fresh eight-member App Connect set from one new maker, in nonce order
(`scripts/app-connect-entries.cjs`, the default set for every network):

| # | Entry | File | SHA-256 (pinned) | Testnet fee for the same file, credits (≈¢) |
| ---: | --- | --- | --- | ---: |
| N | app anchor (registers the group) | `yappr-app-contract.json` | `d3acd888…41f41` | 13.10e9 (≈786¢) |
| N+1 | social **v20** | `yappr-social-contract-v20.json` | `40614b81…62e98` | 91.79e9 (≈5,508¢) |
| N+2 | blocks | `yappr-blocks-contract.json` | `ba0ef67a…d3677` | 19.11e9 (≈1,147¢) |
| N+3 | DM v5 | `yappr-dm-contract-v5.json` | `4fe2b3f4…37c21` | 22.19e9 (≈1,331¢) |
| N+4 | blog v11 | `yappr-blog-contract-v11.json` | `d1a53c31…dca6c` | 38.43e9 (≈2,306¢) |
| N+5 | pollr v8 | `pollr-contract.json` | `a77afe5f…d2347` | 17.16e9 (≈1,030¢) |
| N+6 | storefront v12 | `yappr-storefront-contract-v12.json` | `873dc5c6…0f214` | 60.75e9 (≈3,645¢) |
| N+7 | passkey vault | `yappr-passkey-vault-contract.json` | `14094cad…f73c5` | 13.09e9 (≈785¢) |
| | **Total** | | | **≈275.6e9 (≈2.76 DASH, ≈16,540¢)** |

Testnet fees are from the 2026-11-12 set and the 2026-11-20 v20 append at
fee multiplier 1000‰. Mainnet's proved epoch 89 also reports 1000‰ (read
2026-11-21), so the same order of cost is expected, **not guaranteed**.

Unlike testnet, mainnet has no v19 member: the group holds exactly these eight,
so `.env.mainnet` pins eight `id:1` entries and no `unusedMembersOf` exception
applies (`scripts/release-config.cjs`).

## 2. Policy frozen at registration (decide before `--plan`)

These go into every elected contract (social, blog, storefront) and can never
change. `scripts/registration-policy.mjs` refuses a mainnet run that omits or
violates them.

- [ ] **Interim:** `--interim notYetUsable` (as both testnet sets). Posting
      stays closed until each contract's team is seated. **[O] confirm.**
- [ ] **Election windows:** `--election-windows <join>,<vote>`, each at least
      86,400 s on mainnet (enforced). The 2026-10-21 testnet set used
      `86400,86400`. **[O] choose; longer windows delay launch day for day.**
- [ ] **Election delay:** `--election-delay 604800`. Mainnet requires exactly
      seven days (`MAINNET_ELECTION_DELAY`); nothing else is accepted.
- [ ] **Challenge cool-down:** `--challenge-cool-down <s>`, 1,209,600 to
      94,608,000 s. Testnet used 1,209,600. **[O] confirm.** Protocol 14 does
      not implement challenges, so this is inert today but frozen.
- [ ] **Moderated types** come from the files: social `post`, `reply`,
      `report`, `yapprProfile`; blog `blog`, `blogPost`, `blogComment`,
      `report`; storefront `store`, `storeItem`, `storeReview`, `itemReview`,
      `report`.

**Earliest posting date.** With a seven-day delay and one-day windows, a sole
contender seats no earlier than creation + 7 d (election opens) + 1 d (join
window) ≈ **8 days after registration**. A contested election adds the vote
window. Plan the announcement around that, not around registration day.

## 3. Identities and credits

| Need | Amount | Status |
| --- | --- | --- |
| **Mainnet maker** (new identity, never used for anything else; signs with an enabled CRITICAL AUTHENTICATION key from a 0600 key file) | registration ≈275.6e9; fund to at least what `--dry-run` on mainnet reports as needed (estimate + 20%), plus the float. Rehearsal: the eight-create gate asked **335.43e9** for a 279.53e9 estimate; the creates cost **275.62e9** (≈16,537¢) | **UNKNOWN: no mainnet maker is named.** [O] create, back up (two encrypted copies, named holders), fund. |
| **Sponsorship float** on the maker (it pays gas for YAPP-sponsored post/reply/like: D4) | unmeasured on mainnet; testnet monitoring floor was 200e9 | **UNKNOWN: size it.** [O] decide float and alert floor. |
| **Charter leaders** (social, blog, storefront; one leader may serve several with separate journals) | ≥ 0.51 DASH each per application (0.5 DASH contest deposit + gas): **≥ 1.53 DASH** for three | **UNKNOWN: who leads on mainnet.** Testnet leaders were rehearsal personas; mainnet needs real people. |
| **Charter members** (≥ 2 per team, 3 recommended) | ≥ 0.001 DASH reserve each, plus key-add gas | **UNKNOWN: the mainnet teams.** |
| **Funding route** | testnet funded the 2026-11-12 maker by identity credit transfer from the old maker; the 2026-11-22 rehearsal created a brand-new maker, leader and members **by asset lock** and topped the maker up twice the same way | **[O] choose:** asset lock (`scripts/build-asset-lock.mjs` + `provision-test-identity.mjs`; mainnet needs #972, which makes the lock follow `NETWORK`) or a credit transfer from an existing mainnet identity. A top-up by asset lock spends **no** identity nonce (rehearsal: nonce 0 before `--plan`, 8 after the creates and a later top-up), so it is safe inside the nonce freeze; a credit transfer out of the maker is not. |
| **Masternode votes** (only if an election is contested) | 2M credits per landed vote, paid from the contest fund | **RISK:** on testnet the owner's masternodes decide contested elections. On mainnet Yappr does not control a masternode majority. A rival contender can win a seat. |

Key-change rule: make every key change on the maker **before** `--plan`. Key
changes consume identity nonces and move every planned id.

## 4. Pre-registration gates

- [ ] **[O] Go-ahead from QuantumExplorer** for mainnet registration.
- [ ] **Release cut frozen.** The eight file SHA-256s in
      `scripts/app-connect-entries.cjs` are final. Any re-cut after this point
      means re-running every offline gate below.
- [ ] **Offline contract gates pass** at the frozen commit:
      `node scripts/validate-contract-offline.mjs contracts/<file> --strict-size --network mainnet`
      for each member (social v20 estimate 18,361 B, budget 20,000 B), plus
      `npm run test` (includes `scripts/recoverable-contracts.test.mjs`,
      `lib/contract-topology.test.ts`, `scripts/mainnet-release.test.mjs`,
      `scripts/registration-policy.test.mjs`).
- [x] **v20-specific network proof, SDK rc.4** (testnet, 2026-11-22, on the
      rehearsal set; section 12, item 9): the `d1e`, `r1z3a`, `c1e` refusals
      (40120) and the `c1f` embed; moderator removal of a direct and a nested
      reply with the expected kept fields, then `recover-deleted.mjs recover` +
      `verify` on both; fees of the three reference-read shapes (≈13–15k
      credits each over v19, so the offline estimate stands). The harness is
      `scripts/prove-v20-references.mjs` (#975), which refuses mainnet.
  - [x] **Rerun the same proofs on testnet after the SDK bump** to 5.0.3
        (section 11, item 6), with `prove-v20-references.mjs`: all PASS on
        a fresh set registered from 5.0.3 (section 12.1). The seated-member
        41102 refusal from section 12 was not part of the rerun.
- [ ] **Live /staging QA green** on v20 (web smoke matrix, App Connect with a
      real DashPay wallet). See the 2026-11-21 QA report on the PR that adds
      this file.
- [ ] **Open payment/nonce PRs resolved or consciously deferred.** #929
      (wallet QR nonce reservations), #936 (charter key race), #937 (mobile
      App Connect kill/resume) and #935 (bulk hide) are open on staging with
      standing review blockers; deferred follow-ups #951, #952, #956. #929 in
      particular decides whether a wallet payment can be sent twice.
- [ ] **Read-only mainnet preflight** [A], no keys:
  - [x] Proved epoch reports **protocol 14**, fee multiplier 1000‰ (epoch 89,
        first block 2026-11-18T00:52Z; read 2026-11-21 with
        `EvoSDK.mainnetTrusted()`).
  - [x] System contracts present on mainnet, read 2026-11-21 with SDK
        **5.0.0-rc.4** through the snapshot tool's own path (one DPNS
        `contracts.fetch` to warm the connection, then `contracts.getMany`)
        and again with `contracts.fetch` per id: DPNS v2, DashPay v2
        `Bwr4WHCP…`, token history v2 `43gujrzZ…` and moderation-charters v1
        `EG7RGfV8…` all present. The same probe on testnet also returned social
        v20 `63JuBhMj…`. (An earlier run that day reported them absent because
        it ran against a stale `node_modules` holding evo-sdk 3.1.0-dev.8;
        that SDK can't even see social v20 on testnet. These results are from
        `5.0.0-rc.4`; run every later probe from a checkout installed from the
        release commit's lockfile, so it uses the SDK that will register.)
  - [ ] **Stop gate:** repeat that read-only probe right before the anchor
        create, from the release checkout (pinned SDK, `NETWORK=mainnet`,
        `scripts/sdk-env.mjs` `connectSdk()`), with the snapshot tool's DPNS
        warm-up and `getMany` over the DPNS, DashPay and token-history ids it
        will snapshot, plus the charters contract. Don't register unless all
        four come back present: otherwise `contracts:snapshot` can't build the
        bundle after registration and the filer can't prepare.
  - [ ] Mainnet Drive/DAPI version is compatible with the SDK for writes.
        **Reopened 2026-11-26:** testnet moved to protocol 15 (Drive
        5.1.0-rc.1), whose DPNS contract 5.0.3 can't decode, so the pin moved
        to **5.1.0** (#992). 5.1.0 reads mainnet (protocol 14) and stays at
        14 there; documents and contracts are built at `sdk.version()`
        (`lib/platform-version.mjs`), never `PlatformVersion.latest()` /
        `current()`, which are 15 on 5.1. No write from it has been
        rehearsed against protocol 14 yet: rehearse before registering. The 5.0.3 evidence below stays as the record.
        Read 2026-11-22 (`system.status`, read-only): **mainnet runs Drive and
        DAPI 5.0.3**, protocol 14, epoch 89. The pin moved from 5.0.0-rc.4 to
        **5.0.3** (#978), and by the rerun testnet ran Drive 5.0.3 too (it ran
        5.0.0-rc.8 for the first rehearsal). Section 12.1 registered all eight
        contracts, filed three charters, and ran the v20 writes and moderator
        removals from SDK 5.0.3 against Drive 5.0.3. No write has touched
        mainnet itself; the stop gate's read-only probe stays.
  - [ ] Maker nonce and balance as expected; none of the planned ids or the
        group exist yet (`--dry-run` proves this).

## 5. Registration run (mirrors testnet Phase 4)

All commands take `NETWORK=mainnet`. Keep the journal and key files in a 0700
operator directory; key files 0600. Never pass keys on the command line.

```sh
POLICY='--interim notYetUsable --election-windows <join>,<vote> --election-delay 604800 --challenge-cool-down <s>'
NETWORK=mainnet node scripts/register-app-connect-contracts.mjs --plan --maker <MAKER> --start-nonce <N> $POLICY
NETWORK=mainnet node scripts/register-app-connect-contracts.mjs --dry-run --maker <MAKER> --start-nonce <N> $POLICY
NETWORK=mainnet node scripts/register-app-connect-contracts.mjs --signed-dry-run --maker <MAKER> --start-nonce <N> $POLICY \
  --maker-key-file <0600 file> --maker-key-id <id>
NETWORK=mainnet node scripts/register-app-connect-contracts.mjs --live --production --upto app --journal <journal> \
  --maker <MAKER> --start-nonce <N> $POLICY --maker-key-file <0600 file> --maker-key-id <id>
# read back the group (owner = maker, no admins, name Yappr). Then run this once per
# member, in order (social, blocks, dmV5, blog, pollr, storefront, passkeyVault), by hand:
NETWORK=mainnet node scripts/register-app-connect-contracts.mjs --live --production --upto <member> --journal <journal> ...same flags...
# CHECKPOINT: read <member>'s nonce and id from the journal. Do not run the next
# member unless both equal the plan (step 4). Don't script this as a loop.
```

1. [ ] `--plan`: record APP_ID, GROUP_ID and the eight planned ids. **Start
       the maker nonce freeze.**
2. [ ] `--dry-run` and `--signed-dry-run` produce the same ids, nonces and
       file pins; the balance gate passes.
3. [ ] Charter filers prepared and **armed before** the member creates (section 6).
4. [ ] `--live --upto app`, then read back the group. Then create the
       members **one at a time** with `--live --upto <member>` (social,
       blocks, dmV5, blog, pollr, storefront, passkeyVault), and after each
       one read its nonce and id from the journal. Stop before the next create
       if either differs from the plan. The tool hard-stops only when the
       anchor's nonce drifts: for a later member it prints
       `NOTE: … takes nonce …, not the planned …`, derives the id from the
       actual nonce and carries on, so one `--live` for all members could land
       permanent ids that the prepared charter manifests don't name.
5. [ ] Verify the group with the journal's values. The script reads pins
       only from its arguments or the process environment, never from
       `.env.mainnet` (which is filled later, in section 7):
       ```sh
       NETWORK=mainnet node scripts/verify-appconnect.mjs --only g1,g2,g3,a1 \
         --contract <APP_ID> --group <GROUP_ID> --owner <MAKER> \
         --members <anchor>:1,<social>:1,<blocks>:1,<dmV5>:1,<blog>:1,<pollr>:1,<storefront>:1,<passkeyVault>:1
       ```
       Expect **32/0**.
6. [ ] One proved read per declared index, from the journal:
       ```sh
       NETWORK=mainnet node scripts/read-contract-indexes.mjs --journal <journal> --out <operator dir>/index-reads.json
       ```
       Expect **95/95 indexes answered** on the v20 set. Each index gets a
       `documents.query` shaped to it (equality pins on every property
       but the last, ordered by the last; Drive picks the index whose
       properties match exactly, so a shorter index such as `vote.byPoll`
       is read by itself, not by a longer sibling with the same prefix; a `timeRange` index is read over its
       newest window), plus `count` on countable indexes and `ranked` on
       ranked ones (oldest open window when windowed). Pins take a stored
       document's values when the type has one, else typed placeholders, which
       prove the node serves the index (empty), not that writes land in it; on
       a fresh mainnet set every index answers empty. The six indexes of the
       indexOnly `like` and `likeReply` types, and the count-only
       (`summableOffCountIndex`) ones, are read by `count` (and `ranked`)
       alone: there are no documents to query. Counts pin every
       property (or a range on the last), so a longer sibling index can't answer;
       averageable indexes are also ranked by average; a window read the node
       can't prove fails the index. Rehearsal result: section 12, item 15.
7. [ ] Journal backed up off the machine (0600 copy). **[O]** End the nonce freeze.
       Back up by copying once the run is done. The tool replaces the
       journal with `rename`, so a journal turned into a symlink mid-run
       stops being the backed-up file.
8. [ ] YAPP id = `tokens.calculateId(social, 0)`, total supply 0, authority
       = the maker.

## 6. Charters (mirrors testnet "Charter preparation, filing, and masternode votes")

`scripts/file-release-charters.mjs` refuses mainnet unless `--allow-mainnet` is
given, and broadcasts need `--production`.

- [ ] Manifests for social, blog and storefront with the **predicted** mainnet
      ids, `expected` matching section 2 exactly, a leader and three members,
      reasons (testnet: SPM, ABU, ILG), `moderatorsShare` and `rewardSplit`.
      **[O] decide the mainnet reasons, share and split.**
- [ ] `--plan`, `--dry-run`, then `--live --production --prepare` per team.
      When teams share an actor, run the live prepares **one after another**
      too (a prepare can spend the leader's moderation-charters nonce on
      reason documents), passing each completed journal to the next live
      command with `--prior-journal` (the CLI rejects it with `--plan` and
      `--dry-run`). Key files must be **regular
      files**: the filer refuses a symlink (`lstat`), so pass the resolved
      path of a key kept in a secret store, and keep the generated
      `<id>-decryption.json` / `<id>-encryption.json` as regular 0600 files in
      the journal directory. In the rehearsal, the first `--prepare` stopped
      with `new bound key could not be proved` even though the key had landed;
      the filer read it back once. #970 polls for 60 s, and the rerun adopted
      the landed key.
- [ ] **Stop gate before the anchor create:** `--prepare` must succeed for
      all three teams on mainnet. The filer itself reads the charters contract
      with `sdk.contracts.fetch(EG7RGfV8…)` and aborts if that read comes back
      absent. That read succeeded on mainnet with SDK 5.0.0-rc.4 on 2026-11-21
      (section 4), but only a successful `--prepare` proves the filer's own
      path. If it fails, fix and validate the filer first, and don't
      register.
- [ ] Arm `--live --production --wait-registration 600` before the creates.
      `--wait-registration` bounds only the poll for the target contract to
      appear (600 s). Once it is found, the filer waits for the election to
      open on proved chain time with no bound, so one invocation can sit
      through the seven-day delay. A process exit or network failure means
      resuming the same journal, not re-arming from scratch.
- [ ] **Teams that share a leader or member file sequentially**, never
      concurrently: each invocation reads the other journals' nonce floors
      (`--prior-journal`) only at startup, and its lock covers only its own
      journal, so two live filers sharing an actor can use the same
      moderation-charters nonce. Before each invocation import the latest
      journal of every team that shares an actor with it. Only teams with
      disjoint actors may be armed in parallel.
- [ ] **Schedule.** A target accepts its first application from its
      creation time + 604,800 s. There is no join cutoff until an elected
      application starts the contest: Drive sets the join deadline from that
      block, and the filer reads it from the contest poll (`joinClosesAtMs`).
      The filer refuses an application once a contest has left the joining
      phase ("joining is closed"), and it returns after the application
      lands, not after seating.
  - *Disjoint teams:* arm all three filers before the creates; each waits
    for its own target to open and files.
  - *Shared-actor teams:* arm only the first team's filer. When it returns
    (application proved), start the next team at once, importing every
    journal written so far, then the third the same way. Before each start,
    check eligibility against that target's creation time + the delay. If
    `--watch` shows no contender on the target, there is no cutoff yet and
    the first application is still open. If an application (ours or a
    rival's) has already started a contest, use that poll's proved join
    deadline and leave enough of it for the proposal, the joins and the
    application. Don't wait for another delay period: a rival's application
    may have started the clock in the meantime.
- [ ] `--watch --targets social=…,blog=…,storefront=…` prints one snapshot
      and exits: **rerun it periodically** (at least every few hours) through
      the join and, if contested, vote windows to catch rival contenders,
      phase changes and seating.
- [ ] Seating proved for all three (`seated`, winner = our leader, members as
      filed), then one real moderated write on each contract.

## 7. Build and deploy configuration

- [ ] `.env.mainnet` from `.env.mainnet.template`: the eight ids, app/group/
      owner, maker as `YAPP_TOKEN_AUTHORITY_ID`, `YAPP_TOKEN_ID`, eight
      `id:1` pins in registration order, topology `v20` / storefront `v12` /
      blog `v11` / pollr `v8` / DM `v5` / profile `v2`, carrier `dashpay`,
      `STORAGE_EPOCH=mainnet-release-1`, retired ids and devnet overrides
      blank, archive flags blank.
- [ ] `NEXT_PUBLIC_MASTERNODE_VOTE_URL`: **UNKNOWN.** No reviewed HTTPS
      mainnet voting site is chosen; the build refuses blank and any
      `testnet`/`devnet` URL. **[O]**
- [ ] `NETWORK=mainnet npm run contracts:snapshot` writes
      `lib/contracts/bundled/mainnet.json` (it prunes and checks the pins).
      Commit env and snapshot together. Since #971 a mainnet release build
      **refuses to start without this snapshot**. The release config only
      rejects ids the repo knows from other networks: in the rehearsal, a
      mainnet-shaped env holding the fresh testnet set's ids passed it, and a
      mainnet build of it exported. Only the snapshot refused it
      (`Missing contracts on mainnet; snapshot unchanged: <the eight ids>`).
- [ ] `npm run lint`, `npm run test`, `npm run lint:dead`, `npm run build` and
      `npm run build:mainnet` pass.
- [ ] **Hosting: UNKNOWN.** There is no mainnet deploy job
      (`.github/workflows/deploy.yml` builds only testnet targets). Today
      `yap.pr/` serves testnet `master`, `/staging` and `/testing` are testnet,
      and mainnet builds refuse those subpaths. **[O] decide where mainnet is
      served** (root swap, new domain or new subpath), then add a gated
      deployment job with its own CI check, keeping the testnet deployments.
- [ ] Cloudflare headers as testnet Phase 6 (frame-ancestors / X-Frame-Options
      except `/embed/*`, HSTS, Referrer-Policy).
- [ ] Rollback plan written for the chosen hosting path (testnet's section 5
      assumes a legacy tag and archive project that do not exist for mainnet).

## 8. Wallets and mobile

- [ ] **Wallet sign-in on mainnet: UNKNOWN.** Mainnet accepts only
      `dashpay://connect` (request v2). DashPay Android 11.9.2 (testnet APK)
      completed App Connect v2 sign-in on `/staging` on 2026-11-11; no mainnet
      DashPay release has been tested, and no iOS DashPay App Connect sign-in
      has been tested at all. Raw-key sign-in remains available. **Public
      announcement waits for a mainnet wallet that completes sign-in, renewal
      and revoke against the production anchor.**
- [ ] **Mobile apps:** the mobile config refuses mainnet builds ("Mainnet
      needs the Rust engine (ADR-001 E1/E6)", `mobile/app/app.config.ts`).
      Mainnet ships **web only** until that work lands. **[O] confirm.**

## 9. After registration

- [ ] Monitoring (testnet Phase 8): site smoke, contract id/hash chain probe,
      DAPI and quorum health, maker and pot balances with an alert floor,
      rival charter contenders, post and report rate.
- [ ] `scripts/recover-deleted.mjs list/recover/verify` proved against the
      first mainnet removal record (recoverable removal is a launch promise).
- [ ] Mainnet QA identities (a throwaway author, follower, buyer) funded
      with a small, capped amount; never reuse the retired QA maker.

## 10. Known risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Everything in section 2 and every contract schema is frozen at create; `refersTo` and `deleteKeepsFields` can never be added later | A mistake needs a new contract, new group membership, new YAPP and a storage reset | Finish the section 4 network proofs on testnet v20 first |
| Group membership is append-only | A wrong member or extra create stays in the group forever; App Connect refuses builds whose pins differ (`unexpected-members` / `missing-members`) | Nonce freeze, `--signed-dry-run` before `--live`, short window between create and deploy |
| Maker spends a nonce between `--plan` and `--live` | Every planned id shifts | Nonce freeze; the tool hard-stops only on anchor drift, so create members one `--upto` at a time and check each (section 5) |
| Charter filers sharing an actor run concurrently | Duplicate moderation-charters nonces, interrupted filing | File shared-actor teams sequentially (section 6) |
| No masternode majority on mainnet | A rival can contest and win a moderation seat | File promptly after the delay; have a plan if a rival seats |
| Seven-day election delay | No posting for ≈8 days after registration | Register well ahead of launch |
| v20 reference-read fees | Follow requests, reports and posts with embeds cost slightly more than the offline estimate | Measured on testnet: ≈13–15k credits (≈0.001¢) per write (section 12, item 9); after the SDK bump the whole writes cost within 1% of before on a second pass (section 12.1) |
| Probing with the wrong SDK | A stale install misreports system contracts as absent (seen 2026-11-21) | Probe only from a checkout at the pinned SDK; repeat the section 4 stop gate |
| Payment nonce handling (#929) unresolved | A wallet QR plus a local fallback could pay twice | Land or gate #929 before tips/purchases go live on mainnet |
| Credit tips | Credit tips stay `off` (D23); YAPP is non-purchasable and non-transferable | Keep the flag off |

## 11. Unknowns to resolve (summary)

Updated 2026-11-22 after the testnet rehearsal (section 12).

1. Who the mainnet maker is, and how it is funded. **[O]** The asset-lock
   route and top-ups work (rehearsed), and need #972 on mainnet.
2. Election windows and cool-down to freeze (delay is fixed at 604,800 s).
   **[O]** On mainnet the tool requires each window between 86,400 s and
   2,419,200 s, a cool-down between 1,209,600 s and 94,608,000 s, and the delay at exactly
   604,800 s. Rehearsed offline with the minimum windows: 3600 s windows or a
   3600 s delay are refused, and 86,400 s / 604,800 s plan the same ids as the
   testnet policy. The window and cool-down values are the operator's choice
   within those ranges.
3. Mainnet charter leaders and members, reasons, moderators' share and reward split. **[O]**
4. Sponsorship float size and alert floor. **[O]** Still unmeasured: the
   testnet release maker was topped up between reads, so no drain rate can be
   derived from its balance.
5. ~~System contracts on mainnet~~: present (2026-11-21, SDK rc.4; again
   2026-11-22 through `contracts:snapshot`). Re-check at the stop gate.
6. SDK versus mainnet Drive for writes. **[O]** Reopened 2026-11-26: the pin
   moved from 5.0.3 (#978, rehearsed against testnet Drive 5.0.3 in section
   12.1) to 5.1.0 (#992) for testnet's protocol 15. Rehearse its writes
   against protocol 14 before registration.
7. The mainnet voting URL. **[O]**
8. Where mainnet is hosted, its deploy job and rollback. **[O]** The root
   build itself is rehearsed (section 12).
9. Which wallet build signs in on mainnet (Android and iOS). **[O]**
10. Whether launch is web-only (mobile mainnet needs the Rust engine). **[O]**
11. ~~v20's reference-read fees and network probes~~: proved on testnet (section 12, item 9); the reference read costs ≈0.001¢ per write.
12. ~~Whether teams can share actors~~: they can. The rehearsal filed three
    teams with one leader and the same three members, back to back with
    `--prior-journal`, in about 4 minutes from the window opening. Disjoint
    teams are still the safer choice against a rival opening a contest.
13. Whether the charter filer's `--prepare` succeeds on mainnet: it works on
    testnet with #970; it remains the mainnet stop gate.
14. Step 5.6's per-index reader is `scripts/read-contract-indexes.mjs`; on mainnet it proves each index is served, and answers with rows only where documents exist.

## 12. Testnet rehearsal of the mainnet path (2026-11-22)

Run from staging `15fb0e98` plus #970, SDK 5.0.0-rc.4, against testnet
(PV14, Drive 5.0.0-rc.8, fee multiplier 1000‰), by the same scripts and
switches as section 5. Everything is throwaway testnet state; the operator
directory and key files are kept privately, outside the repository.

Differences from mainnet, all forced by the clock or the network:
- Policy `--interim notYetUsable --election-windows 3600,3600 --election-delay 3600 --challenge-cool-down 1209600`,
  so seating fits in one night. The mainnet policy (86,400 s windows,
  604,800 s delay) was run through `--plan` offline with the same maker and
  start nonce: same ids and file pins, and short windows or delays are refused.
- Teams are throwaway identities (one leader, the same three members on all
  three teams, so they filed sequentially).
- Testnet funds came from the faucet; nothing touched mainnet except
  read-only queries (status, `contracts:snapshot`).

| Step | Result |
| --- | --- |
| 1. New maker, leader, three members | Created by asset lock from faucet tDASH (`provision-test-identity.mjs` + `build-asset-lock.mjs`). Maker `BiGPyD6DotrMgBgutxXtbQEGixiihkixZdyERFkBTfNB`, nonce 0. |
| 2. Maker top-up before `--plan` | Asset lock +150e9 → 399.86e9 credits; nonce unchanged. |
| 3. Offline contract gates | `validate-contract-offline.mjs --strict-size --network mainnet`: 8/8 ok (social v20 ≈18,361 B). |
| 4. `--plan` / `--dry-run` / `--signed-dry-run` | Same ids, nonces 1–8 and file pins in all three. Balance gate: needs 335.43e9 (estimate 279.53e9 + 20%), PASS. |
| 5. Charter `--prepare` before any create | Social stopped once: `new bound key could not be proved`, though the key had landed (a single lagging readback). Fixed in #970; the reruns of all three, with `--prior-journal`, proved the bound keys and the reasons SPM/ABU/ILG. |
| 6. `--live --upto app`, then one member at a time | App `3ZipbzKa7fgmRLX87V8H3YHFQBi53WJjv3ob2zrL5ZjV` (nonce 1), group `6tkUDtedA7UiJKHhKuo6aP1cn7wyP25bUUCL7J27nzum`. The social filer was armed (`--wait-registration 600`) before social's create. After each create the journal's nonce and id were compared with the plan before the next: 8/8 equal, every create landed on its first broadcast, 02:41:08Z–02:43:14Z. |
| 7. Fees (maker's proved delta) | app 13.10e9, social v20 91.79e9, blocks 19.11e9, DM v5 22.18e9, blog 38.43e9, pollr 17.16e9, storefront 60.75e9, passkey vault 13.09e9: **275.62e9 (≈16,537¢)**. These match the 2026-11-12 set within 0.01%. |
| 8. `verify-appconnect --only g1,g2,g3,a1` | **32/0** with the journal's values. YAPP `DSvFQYi43aJkdhcWqJFdHChUZih6VauCPAefoh141ak6` = `tokens.calculateId(social, 0)`, supply 0, minting `noOne`. |
| 9. v20 network proofs | PASS (`scripts/prove-v20-references.mjs`, #975). **Recoverable removal:** the seated leader removed a direct and a nested reply by a non-member (SPM); each kept record holds `rootPostId` and the `$` fields, the nested one also `replyToReplyId`; `recover-deleted.mjs` rebuilt and hash-verified 2/2. A seated member's own reply is refused (41102: team content can't be moderated). **Reference checks:** a follow request and an account report to a missing identity, and a post embedding a missing contract, are refused with 40120; an embed of the real Pollr contract lands (v19 accepted all three missing targets). **Fees:** follow request ≈54.0M, account report ≈32.4M (20M moderator fee), post with embed ≈104.2M; the reference read adds ≈13–15k credits (≈0.001¢), so the offline estimate stands. |
| 10. Charter filing | Social opened at 03:41:43Z (chain time); proposal, three joins and the elected application proved within 40 s. Blog and storefront filed right after it, each importing the other journals: three applications proved by 03:44Z. |
| 11. Seating | All three seated at the first block after their join windows closed, sole contender, no votes needed: social 04:42:05Z (block 724,324, charter `9JKyMWgP…`), blog 04:43:27Z (724,344, `3akpqZ4h…`), storefront 04:43:39Z (724,349, `AD3jto8H…`). `--watch` shows winner = the leader and the three members on each team. |
| 12. Release config | A `.env.mainnet`-shaped file built from the journal passed `loadReleaseEnv(…, 'mainnet')`: env validation only rejects ids known from other networks, so fresh testnet ids get through. Before #971 the mainnet build then exported without a snapshot; since #971 it requires `lib/contracts/bundled/mainnet.json` matching the pins (section 7). Only `contracts:snapshot` reads mainnet: `NETWORK=mainnet contracts:snapshot` refused: the eight ids are missing there, the three system contracts present. The same values as `.env.testnet` passed the testnet release config. |
| 13. Root build | `contracts:snapshot --prune` (testnet, 13 contracts), then the root release build (`BASE_PATH` empty, `STORAGE_EPOCH=testnet-mainnet-rehearsal-1`). The static export served at `/` loaded the home page, the feed and Moderation teams with 0 console errors. It read the rehearsal set live: the election banner gave this set's own apply-from times. The `build:mainnet` export of the mainnet-shaped env also completed (49 files), before #971 made that impossible without a snapshot. |
| 14. Maker top-up after registration | Asset lock +49.99e9 → 174.23e9; nonce still 8. |
| 15. Per-index read (section 5, step 6) | `read-contract-indexes.mjs --journal <journal>` (SDK 5.0.0-rc.4, read 2026-11-22): **95/95 indexes answered** across the eight contracts (app 1, social 37, blocks 3, DM v5 4, blog 18, pollr 3, storefront 28, passkey vault 1), every read proved, with at least one real read per index (no document query on the six `like`/`likeReply` indexes, which are indexOnly; counts pin every property; the two storefront rating indexes also ranked by average). Pins came from stored documents for the four social types the v20 proofs wrote (followRequest, report, post, reply); six of their indexes answered with rows (`followRequest.pair`/`target`, `post.ownerAndTime`/`timeline`, `reply.ownerAndTime`, `report.byTarget`), the rest empty. No cold windows. |

Gaps found and fixed: #970 (filer readback), #971 (mainnet build without a
snapshot), #972 (asset lock network). The SDK pin is done (#978,
section 12.1).

### 12.1 Rerun with SDK 5.0.3 (2026-11-22)

Same day, from staging `f6e644a2` (SDK **5.0.3**, #978) plus #975 and #977,
against testnet now on **Drive 5.0.3**: the same scripts, switches and
election policy as section 12, a new maker (`EphL37fJ…`, faucet-funded,
249.87e9 → 399.86e9 before `--plan`), and the same leader and members.
Operator directory and keys are kept privately, as before.

| Step | Result | Versus section 12 |
| --- | --- | --- |
| Offline gates, `--plan` (testnet and mainnet policy), `--dry-run`, `--signed-dry-run` | 8/8; same ids and nonces in all four; mainnet policy refuses the 3,600 s delay; balance gate needs 335.43e9, PASS | Same |
| Charter `--prepare` | Three teams prepared; the reused actors' bound keys and reasons proved on resume | The bound-key files from the first run had to be copied into the new charters directory first (`a bound key exists; supply its private half` until then): an operator reusing team identities carries those files over |
| Registration, nonces 1–8 | Every create landed on its first broadcast, id equal to the plan. App `AdnD68vR…`, group `DY23NQBV…`, social `2t8D4GKr…` | Same |
| Fees | app 13.10e9, social 91.79e9, blocks 19.11e9, DM v5 22.18e9, blog 38.43e9, pollr 17.16e9, storefront 60.75e9, passkey vault 13.09e9: **275,619,546,470** | −1,195,220 credits (−0.0004%) |
| `verify-appconnect --only g1,g2,g3,a1` | **32/0**; YAPP `98EExoC6…` = `calculateId(social, 0)`, supply 0, minting `noOne` | Same |
| Per-index read (step 5.6) | 95/95 right after registration, and 95/95 again after the proofs, with the same six indexes answering rows | Same |
| Charter filing and seating | Social proposal, joins and application proved ≈30 s after its window opened (15:45:48Z); all three applications by 15:47:14Z. Seated at the first block after the join windows: social 16:46:03Z (728,004), blog 16:46:54Z (728,008), storefront 16:47:14Z (728,010); winner = the leader with three members on each | Same shape (≈40 s before) |
| v20 proofs (`prove-v20-references.mjs`, with the per-write nonce check) | All PASS on five runs, each against a new target, the last two from #975 as merged (the post-write balance is read only after the proved nonce includes the write, and the nonce is proved again at the balance's height): `d1e`, `r1z3a`, `c1e` refused 40120 on the named property; follow request, report and `c1f` embed land; the moderator removed the direct and nested replies with the expected kept fields; `recover-deleted.mjs` recovered and verified 2/2. Each of the ten writes, refusals included, moved the author's contract nonce by exactly one | Same verdicts for these checks. The 41102 refusal of a moderator removing a seated member's reply (section 12, item 9) was not rerun: the harness refuses a seated author and tests only the 40120 refusals |
| Write fees | follow request 53.89M, report 38.84M, plain post 102.48M, direct reply 121.77M, nested reply 82.96M; refusals 9.91M / 1.35M / 1.34M | Accepted writes within 0.5% of section 12, except the first of each kind on the fresh contract: the report (38.84M against 32.35M) and `c1f` (153.4M, the author's first post; the thread post was first in section 12) pay for new index trees. A second pass on the same set against another target (with the seated-team and signed-nonce checks) gave report 32.55M (+0.6% on section 12), `c1f` 105.06M (+0.8%), follow request 54.08M and refusals 1.29M / 1.36M / 1.35M. These are whole-write balance changes: they show no fee jump from the bump, not that the reference-read share alone is unchanged |
| Release config and root build | Both env files pass `loadReleaseEnv`; `contracts:snapshot --prune` (13 contracts); root build (`STORAGE_EPOCH=testnet-mainnet-rehearsal-2`) served home, feed and Moderation teams with 0 console errors and this set's apply-from times; `build:mainnet` refuses without the mainnet snapshot (#971) | The `NETWORK=mainnet contracts:snapshot` read was not repeated; it is read-only and is covered by the stop gate (section 4) |

No regression from the SDK bump on this path. One regression elsewhere:
5.0.3 can't verify the key-hash identity lookup from `/devnet`'s older Drive,
so key-only sign-in there fails until that devnet upgrades (#979). Testnet
and mainnet are unaffected.

## 13. What still needs a human

- **QuantumExplorer's sign-off** on mainnet registration, and **Pasta's go**.
- **The mainnet maker:** a new identity, its key file (CRITICAL key, 0600)
  with two encrypted backups held by named people, and funding of at least
  what `--dry-run` on mainnet reports as needed (the rehearsal asked
  335.43e9 credits, a little over 3.35 DASH, and spent ≈2.76 DASH), plus the
  sponsorship float on top. Choose the funding route (asset lock or credit transfer).
- **The frozen policy:** election windows (≥ 86,400 s each) and the
  challenge cool-down. The delay is fixed at 604,800 s, so posting opens no
  earlier than about 8 days after registration.
- **Three charter teams of real people:** leaders with **≥ 0.51 DASH** each per
  application (≥ 1.53 DASH in all), at least two members each (three
  recommended), and the reasons, moderators' share and reward split.
- **The mainnet voting URL** (`NEXT_PUBLIC_MASTERNODE_VOTE_URL`).
- **Hosting:** where mainnet is served, the gated deploy job, Cloudflare
  headers and the rollback plan.
- **Wallets:** a mainnet DashPay build that completes App Connect sign-in,
  renewal and revoke against the production anchor; confirm web-only launch.
- **Open payment/nonce PRs** (#929 and the rest in section 4): land or defer
  them deliberately. Deferring #929 means tips and purchases stay gated on
  mainnet until it lands (section 10).
- **Sponsorship float and alert floor** for the maker.
