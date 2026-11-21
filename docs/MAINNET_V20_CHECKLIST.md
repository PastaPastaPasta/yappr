# Mainnet v20 readiness checklist

**Status: preparation only. Nothing here has run on mainnet.** Mainnet
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
| **Mainnet maker** (new identity, never used for anything else; signs with an enabled CRITICAL AUTHENTICATION key from a 0600 key file) | registration ≈275.6e9 + the tool's balance-gate margin (testnet's v20 gate asked 111.53e9 for a 92.94e9 estimate, ≈1.2×) ≈ **335e9 (≈3.35 DASH)** | **UNKNOWN: no mainnet maker is named.** [O] create, back up (two encrypted copies, named holders), fund. |
| **Sponsorship float** on the maker (it pays gas for YAPP-sponsored post/reply/like: D4) | unmeasured on mainnet; testnet monitoring floor was 200e9 | **UNKNOWN: size it.** [O] decide float and alert floor. |
| **Charter leaders** (social, blog, storefront; one leader may serve several with separate journals) | ≥ 0.51 DASH each per application (0.5 DASH contest deposit + gas): **≥ 1.53 DASH** for three | **UNKNOWN: who leads on mainnet.** Testnet leaders were rehearsal personas; mainnet needs real people. |
| **Charter members** (≥ 2 per team, 3 recommended) | ≥ 0.001 DASH reserve each, plus key-add gas | **UNKNOWN: the mainnet teams.** |
| **Funding route** | testnet funded the maker by identity credit transfer from the old maker | **UNKNOWN on mainnet:** asset lock from a Core wallet, or a credit transfer from an existing mainnet identity. [O] |
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
- [ ] **v20-specific network proof on testnet** (SOCIAL_V20.md says none of
      this has run on a network yet):
  - [ ] `verify-v10.mjs` probes `d1e`, `r1z3a`, `c1e` (expect 40120 for a
        follow request to / account report of / embed from something that does
        not exist) and `c1f` (an embed naming a real contract) against
        `63JuBhMj…`;
  - [ ] a moderator removal of a **nested** reply on testnet v20 whose record
        keeps `replyToReplyId`, and of a direct reply whose record omits it,
        then `scripts/recover-deleted.mjs recover` + `verify` on both;
  - [ ] `measure-social-fees.mjs` on v20 for the three new reference reads
        (follow request, report, post with embed). The offline estimate does
        not count reference reads.
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
  - [ ] DPNS, DashPay v2 and token history present at the ids in
        `.env.mainnet.template`. **UNKNOWN today:** on 2026-11-21 the
        documented readback (`sdk.contracts.fetch(id)` after `sdk.connect()`,
        SDK 5.0.0-rc.4) returned DPNS v2 but *absent* for DashPay, token
        history and the moderation-charters contract on **both** mainnet and
        testnet, where those contracts certainly exist. The readback method is
        wrong for system contracts, so presence on mainnet is unproven. Fix
        the probe (or use a proved document query against each contract)
        before relying on it.
  - [ ] Moderation-charters system contract `EG7RGfV8…UmN88` present on
        mainnet (the charter tooling and `/moderation-teams` hard-code it,
        `lib/moderation-charters/rules.mjs`). **UNKNOWN**, same reason.
  - [ ] Mainnet Drive/DAPI version is compatible with SDK 5.0.0-rc.4 (testnet
        runs Drive 5.0.0-rc.8). **UNKNOWN.**
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
# read back the group (owner = maker, no admins, name Yappr), then the members:
NETWORK=mainnet node scripts/register-app-connect-contracts.mjs --live --production --journal <journal> ...same flags...
```

1. [ ] `--plan`: record APP_ID, GROUP_ID and the eight planned ids. **Start
       the maker nonce freeze.**
2. [ ] `--dry-run` and `--signed-dry-run` produce the same ids, nonces and
       file pins; the balance gate passes.
3. [ ] Charter filers prepared and **armed before** the member creates (section 6).
4. [ ] `--live --upto app`, group readback, then `--live` for the members.
       Check each landed id against the plan; on drift take the id from the
       journal and stop to reassess.
5. [ ] `NETWORK=mainnet node scripts/verify-appconnect.mjs --only g1,g2,g3,a1`
       with the eight `id:1` pins: expect **32/0**.
6. [ ] One proved read per index family (testnet: all 95 indexes answered).
7. [ ] Journal backed up off the machine (0600 copy). **[O]** End the nonce freeze.
8. [ ] YAPP id = `tokens.calculateId(social, 0)`, total supply 0, authority
       = the maker.

## 6. Charters (mirrors testnet "Charter preparation, filing, and masternode votes")

`scripts/file-release-charters.mjs` refuses mainnet unless `--allow-mainnet` is
given, and broadcasts need `--production`.

- [ ] Manifests for social, blog and storefront with the **predicted** mainnet
      ids, `expected` matching section 2 exactly, a leader and three members,
      reasons (testnet: SPM, ABU, ILG), `moderatorsShare` and `rewardSplit`.
      **[O] decide the mainnet reasons, share and split.**
- [ ] `--plan`, `--dry-run`, then `--live --production --prepare` per team
      (add `--prior-journal` for shared actors).
- [ ] Arm `--live --production --wait-registration 600` per target before the
      creates; the proposal can only land once the seven-day election delay
      has passed, so the filer must be re-run or kept waiting that long.
      **UNKNOWN:** whether one invocation can wait seven days; plan to re-arm.
- [ ] `--watch --targets social=…,blog=…,storefront=…` through the join (and,
      if contested, vote) windows.
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
      Commit env and snapshot together.
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
| Maker spends a nonce between `--plan` and `--live` | Every planned id shifts | Nonce freeze; the tool hard-stops on drift |
| No masternode majority on mainnet | A rival can contest and win a moderation seat | File promptly after the delay; have a plan if a rival seats |
| Seven-day election delay | No posting for ≈8 days after registration | Register well ahead of launch |
| v20 reference-read fees unmeasured | Follow requests, reports and posts with embeds cost more than the offline estimate | Measure on testnet (section 4) |
| System-contract readback inconclusive | Charter tooling or DashPay profile reads may fail on mainnet | Fix the probe; prove each system contract before registering |
| Payment nonce handling (#929) unresolved | A wallet QR plus a local fallback could pay twice | Land or gate #929 before tips/purchases go live on mainnet |
| Credit tips | Credit tips stay `off` (D23); YAPP is non-purchasable and non-transferable | Keep the flag off |

## 11. Unknowns to resolve (summary)

1. Who the mainnet maker is, and how it is funded.
2. Election windows and cool-down to freeze (delay is fixed at 604,800 s).
3. Mainnet charter leaders and members, reasons, moderators' share and reward split.
4. Sponsorship float size and alert floor.
5. Whether DashPay, token history and moderation-charters system contracts are present on mainnet (current readback can't tell).
6. Mainnet Drive version vs SDK 5.0.0-rc.4.
7. The mainnet voting URL.
8. Where mainnet is hosted, its deploy job and rollback.
9. Which wallet build signs in on mainnet (Android and iOS).
10. Whether launch is web-only (mobile mainnet needs the Rust engine).
11. Whether the filer can wait out the seven-day delay in one run.
