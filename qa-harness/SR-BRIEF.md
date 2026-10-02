# Static-review stream (SR): Yappr Mobile 1.0

You are the static-review stream of the Yappr Mobile 1.0 agentic QA pass. **No device.** You read the candidate's code
and file code-level findings (SR-01, SR-02, …) with file:line, a concrete failure scenario and a proposed severity, so
that a second wave can reproduce each one on a device (SR-REPRO). You do not modify, build or run the app. You may
run the existing unit tests and type checks read-only if it helps you prove a point (`npm test`, `npm run typecheck`
in `mobile/app`; `npm test` in `mobile/engine`), writing nothing into the worktree except their usual caches.

- **Code:** `$QA_BUILD/src` (= `/Users/pasta/workspace/yappr-mobile-qa/builds/current/src`, the exact worktree the
  candidate was built from; read `builds/current/BUILD-INFO.md` for the sha). About 40k lines in
  `mobile/app/src` (Expo app, routes in `src/app/`, data layer `src/data/`, engine host `src/engine/`, features
  `src/features/*`, native modules `modules/{background-flush,secure-window}`, config plugins
  `plugins/{engine-assets,release-hardening,wallet-schemes}`) and `mobile/engine/src` (the WebView engine: `api/`,
  `writes/`, `dm/`, `session/`, `rpc/`, `protocol/`, `shims/`, `entry.webview.ts`). Web `lib/` and `vendor/platform-auth`
  are shared with the web app: findings there are "shared with web" (still file them, flagged).
- **Specs:** `docs/mobile/ADR-001-mobile-1.0.md` (binding), `ENGINE.md` (§3 transport, §4 supervisor, §9 storage, §11
  security checklist, §14 open items), `PRD.md` (stories + global rules G-1..G-16), `UX_SPEC.md`, `mobile/CLAUDE.md`,
  `mobile/RELEASE.md`, `docs/mobile/COMPLIANCE.md`.
- **Output:** `$QA_EVIDENCE/SR/REPORT.md` (+ `notes.md` journal; grep outputs as `.txt` next to it). If you cannot
  write the file, put the whole report in your final message. Time budget ~3 h.

## Focus, in risk order (QA-PLAN §2)

1. **Keys and secrets.** Where private keys, login keys, encryption keys and the MMKV encryption key live
   (Keychain/Keystore accessibility class, `expo-secure-store` options, `requireAuthentication`), what crosses the
   RN↔WebView bridge, redaction (`src/engine/redact.ts`, `logs.ts`) and whether any path logs or persists a key
   (`console.*`, error messages, diagnostics text, React Query persister, MMKV plain instance). Sign-out and account
   removal: is every secret, draft, cache and DM state deleted (AUTH-11)? Reinstall wipe on iOS (Keychain survives
   uninstall; `modules/background-flush` wipeKeychainServices). Key entry field: autocorrect/autofill off, cleared on
   close (AUTH-08). App lock (AUTH-12): timeout logic, background/foreground races, app-switcher snapshot, FLAG_SECURE
   coverage (`modules/secure-window`, `src/ui/screen-capture.ts`). ENGINE §11 checklist: CSP, navigation blocking,
   `originWhitelist`, `onShouldStartLoadWithRequest`, `webviewDebuggingEnabled`, file access, mixed content.
2. **Writes.** `src/data/writes.ts`, `optimistic.ts`, engine `writes/` and tickets: can a write be sent twice (retry
   before proving absence, a restart replaying a write, `methods.ts` classifying a write as a read)? Can one be lost
   (optimistic state dropped on restart/kill, draft deleted before the broadcast is accepted)? 504/unconfirmed
   handling (G-3), rollback + toast on failure (G-4), "Check again" vs blind resend (COMP-10), thread partial post
   and resume (COMP-05), nonce races between quick writes, account switch while a write is in flight.
3. **DMs.** DM v5 key handling, group membership/keys, `pagehide`/`visibilitychange` flush on background (DM-14),
   whether decrypted plaintext is ever persisted (MMKV, query cache, logs), unlock-key validation (DM-02), blocked
   senders ignored (DM-10).
4. **Engine supervisor and lifecycle.** `src/engine/supervisor.ts`, `EngineHost.tsx`, `lifecycle.ts`, `page.ts`,
   `webview-transport.ts`, engine `rpc/`: boot queueing, ping/hang detection, restart backoff, the 3-restarts-in-2-min
   cap (NET-04), read replay exactly once, epoch handling of late replies from a dead engine, timers in background
   (NET-08 foreground-only), what happens to queued calls on restart, memory growth of queues/log buffers.
5. **Feeds, paging, caches.** Persisted queries (what is persisted; never DMs/notifications/balances), cache busting
   (app version + bundle hash + network), per-account isolation after switch (AUTH-10), block propagation into caches
   (G-6), the 3-page auto-load cap and 200-post cache cap (FEED-07, FEED-11).
6. **Compose limits.** RN counter vs `lib/compose/limits.ts` (code points vs UTF-16 vs graphemes, bytes),
   `hasVisibleContent`, hashtag/mention inline rules, draft persistence timing (500 ms + background) and limits (1 new +
   20 reply/quote drafts, 30 days).
7. **Deep links.** `src/navigation/deep-links.ts`, `src/app/+native-intent.tsx`: injection, encoded ids, prefix
   confusion (`/devnet` vs `/testing`), never-from-outside routes, `allowAppRoutes` really false in Release.
8. **Gating and copy.** Capability flags used instead of variant/topology checks (G-10); hard-coded limits; copy that
   diverges from UX_SPEC §5 on error paths.
9. **Release hardening.** `plugins/release-hardening`, `app.config.ts`: permissions, cleartext, backup rules, ATS,
   dev-launcher leftovers, `exp+yappr` scheme, debuggable flags, ProGuard/R8 keep rules that could break reflection.
10. **Accessibility.** Controls without `accessibilityLabel`/role/testID, hit targets under 44 pt/48 dp, text that
    does not scale (`allowFontScaling={false}`, fixed heights), animations ignoring Reduce Motion.

## Method

- Read the specs' acceptance bullets first, then the code path that implements each risky one. Prefer **concrete,
  reproducible** findings ("tap Like twice within 300 ms while the first ticket is pending → two `like` documents
  because … at writes.ts:142") over style comments. No nits, no refactor suggestions.
- For each finding give: id, proposed severity (QA-PLAN §5), area, file:line (several if needed), what the code does,
  what the spec says, the user-visible impact, and a **device reproduction recipe** (steps a stream can run with
  `bin/qa`, including any fault injection: `engine-kill`, `network stall`, `kill`, `background`, account switch) and
  the log lines or Diagnostics fields that would prove it. Mark findings you are unsure of as "suspected".
- Check the unit tests next to the code: is the risky case tested? A missing test for a risky path is worth a line
  in the finding, not a separate finding.
- Cross-check ENGINE §14 open items O1–O8 and EXECUTION §7 gate 5 (security checklist): for each, say whether the code
  satisfies it (with file:line) or not.

## REPORT.md shape

1. Header: sha, files/areas read, time spent, tests run (with results).
2. Summary table: `| SR-id | Sev | Area | Title | Confidence (confirmed in code / suspected) | Repro recipe ready? |`.
3. One section per finding (fields above).
4. Security checklist (ENGINE §11 / EXECUTION §7 gate 5) table: item → satisfied? → evidence.
5. Spec gaps: acceptance bullets with no implementation found (story id + where you looked).
6. Notes for the SR-REPRO wave (which device/platform each item needs, fixtures, expected duration).
