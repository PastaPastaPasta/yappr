# mobile/e2e: the Maestro regression suite

The UI end-to-end suite of ADR-001 E8 (EXECUTION M9), on the iOS simulator and
the Android emulator. `run.sh` runs it on one device; CI runs the smoke suite
nightly (`.github/workflows/mobile-e2e.yml`).

| Suite | Flows | Needs |
| --- | --- | --- |
| `smoke` | `flows/smoke/`: signed-out browse (Home, a thread, a profile), Explore and search, the signed-out tabs, settings toggles (theme, NSFW mode), deep links (cold and warm). Read only. | Nothing secret; any variant |
| `full` | `smoke`, then `flows/full/`: key exchange through the test-wallet responder, key sign-in, post (deleted again), like and unlike, reply, follow and unfollow, a DM round trip, block and unblock, report, notifications, sign out. | The devnet variant (sakura) and two pool personas |

The full suite writes to sakura as pool personas (90–98; never 99, never
testnet; 97 and 98 by default, since the engine's write suite uses 92–96).
A flow that passes leaves nothing behind: it deletes what it posted, and a
follow or a block ends undone (the next run also undoes one an interrupted
run left). The peer deletes its posts when it stops, whatever happened. The
text a flow writes carries the run id, so runs don't collide. DM v5 messages
and reports stay on chain (there is no cheap delete), and a flow that fails
half way can leave its own post behind.

## Running it

```bash
# A dev client: Metro running with the same APP_VARIANT on <port>
mobile/e2e/run.sh --platform ios --device <udid> --metro-port 8181 --suite smoke
YAPPR_SAKURA_IDENTITIES=<identities.json> E2E_PERSONA=97 E2E_PEER_PERSONA=98 \
  mobile/e2e/run.sh --platform android --device emulator-5554 --metro-port 8181 --suite full

# A release build (no Metro): leave out --metro-port
mobile/e2e/run.sh --platform ios --device <udid> --suite smoke
```

`run.sh --help` lists every option. The full suite also needs `npm ci` in the
repo root, `mobile/engine` and `mobile/tools`. It starts:

- the **test-wallet responder** (`mobile/tools`, `E2E_RESPONDER_ADDR`), which
  answers the sign-in QR's `dash-key:` and `dash-st:` links as the app's persona;
- the **peer** (`mobile/engine/harness/e2e-peer.ts`, `E2E_PEER_ADDR`): the engine
  in Node, signed in as the second persona. Flows reach it through
  `scripts/peer.js`: it publishes the posts that like, reply and report act
  on (and deletes them), and answers the DM round trip;
- the **QR bridge** (`host/qr-bridge.mjs`, `E2E_BRIDGE_ADDR`): release builds
  show the sign-in request only as a QR code (the `dash-key:` text is dev
  only), so `scripts/respond.js` asks the bridge, which takes a screenshot of
  the device (`adb screencap`, `simctl io`), decodes the QR code (Core Image,
  so macOS only) and returns the link for the responder.

Run devices in parallel with a different persona pair and different
responder, peer and bridge ports for each, so no two writers share a persona.

Output (`--out`, default `mobile/e2e/out/`, gitignored): `summary.md`,
`junit.xml`, per-flow JUnit and logs, `screenshots/`, and `artifacts/` with
Maestro's command logs and failure screenshots.

## Keys

The app's persona signs in with its AUTHENTICATION/HIGH key and unlocks
messages with its ENCRYPTION key. `run.sh` reads them from `E2E_KEY_FILE` and
`E2E_DM_KEY_FILE`, or writes them from the pool into a private temp dir
(deleted on exit). It hands each key to Maestro in four parts, as
`MAESTRO_SIGN_IN_KEY_1..4` and `MAESTRO_DM_KEY_1..4` environment variables,
which Maestro reads by itself, so no key is ever on a command line. The flows
type the parts one by one (iOS can drop characters from one long input into a
secure field). Maestro echoes typed text into its output and debug files,
including `~/.maestro/tests`, so `run.sh` scrubs every key and every part from
all of it, also when the run is interrupted. Never commit a key, and don't run
a flow that types one outside `run.sh`.

## Writing flows

- Every flow starts from `subflows/launch.yaml`, which stops and starts the
  app (and, with `CLEAR: 'true'`, clears its data). A dev client loads its
  bundle from Metro there and has its floating tools button turned off
  (`subflows/dev-client.yaml`); a release build skips that.
- Signed-in flows call `subflows/ensure-signed-in.yaml` next (it signs out
  any account that isn't the run's persona), so each one also runs alone.
  Flows that act on the peer call `subflows/peer-unblocked.yaml` too.
- Flows get `APP_ID`, `SCHEME`, `DEV_CLIENT_URL` and `RUN` from `run.sh`, and
  in the full suite `SELF_ID`, `SELF_HANDLE`, `PEER_ID`, `PEER_HANDLE`,
  `PEER_URL`, `RESPONDER_URL` and `PERSONA` (the keys come as `MAESTRO_*`).
- Navigate with taps (`subflows/open-tab.yaml`, `subflows/back.yaml`) and
  links through `subflows/open-link.yaml` (iOS 27 asks before it opens one; never
  `openLink` directly): web-form links (`${SCHEME}://post?id=…`, `user?id=`, `hashtag?tag=`,
  `settings?section=`), which every build accepts. App-route links such as
  `yappr-dev:///settings/diagnostics` work in dev builds only.
- Match by `id` (testID) first. A post card on iOS is one accessibility
  element whose label holds the author and the text, so match text with
  `.*…*`, which works on both platforms.
- Never retry a step to hide a failure: wait for the state you expect with
  `extendedWaitUntil`, and fix flakes at their cause.
