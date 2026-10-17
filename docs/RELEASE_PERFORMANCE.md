# Release performance and request load

Measured 2026-10-17 with Platform SDK 5.0.0-rc.3 and the committed Sakura
`build:devnet` environment. The baseline is staging `9f0e6fb5`, rebuilt separately
from an archive of that revision. Both exports use `/devnet` and the same contract
pins. Sizes below include only the unique script `src` references in each route's
exported HTML; they exclude later dynamic imports. Gzip is calculated locally per
script, rather than assuming the deployment's compression settings.

## Initial JavaScript

Baseline → updated, bytes raw / gzip:

- `/`: 17,509,434 / 10,505,427 → 5,501,948 / 1,505,021.
- `/feed`: 17,540,212 / 10,516,016 → 5,532,666 / 1,515,631.
- `/post?id=…`: 17,525,231 / 10,510,944 → 5,517,751 / 1,510,534.
- `/user?id=…`: 17,598,460 / 10,529,912 → 5,590,971 / 1,529,518.
- `/terms`: 17,285,349 / 10,436,226 → 5,277,796 / 1,435,754.

The feed's eager transfer is 85.6% smaller with gzip (68.5% smaller raw).
The WASM payload and BlockNote/Mantine are absent from those eager scripts.
The SDK is still needed to read Platform data and starts from the existing
provider initialization after hydration. BlockNote loads when the blog editor or
article viewer renders. The large WASM asset still exists as an asynchronous
chunk: this change defers that cost; it does not remove it from a data session.

Reproduce with `npm run build:devnet && node scripts/check-export-sizes.mjs`.
The script reports route sizes as well as the Cloudflare Pages per-file limit,
and enforces an 8 MiB raw eager-JavaScript budget on these public routes.

## Throttled browser probe

Single cold-cache samples in headless Chromium, 390 × 844 viewport, 9 Mbps down,
1 Mbps up, 60 ms latency, and 4× CPU throttle. Both builds were served locally
with the repository static server and read the real Sakura chain. This measures
the first visible `article`, not a Lighthouse score or a production percentile.
Other release jobs were active on the host, so small differences are noise.

- `/feed`: first article 19.327 s → 19.258 s.
- `/post?id=7igoac5erqCajNNr8KgHCEN3bZrsevDw8xt1DSuahHnr`:
  first article 19.761 s → 19.602 s.
- `/user?id=AuPAmquzMYem3mxeyAaWnzpSyok9itGU8MP19GTKMBp9`:
  first article 19.435 s → 19.809 s.
- `/`: DOMContentLoaded 0.723 s → 0.752 s; the probe ended before a paint entry
  was available, so no landing-page first-paint improvement is claimed.

The feed/post/user first-contentful-paint entries were 0.750–0.767 s before and
0.776–0.822 s after. They include the initial loading UI. This probe does not
show a meaningful improvement in first-data time: data still waits for the
roughly 9 MB compressed WASM initializer to load and compile. Streaming/external
WASM and other existing eager UI dependencies remain separate follow-up work.

## Signed-in idle DAPI requests

Two fresh browser contexts, one on `/feed` and one on `/messages`, with the same
existing Sakura CI identity and its messaging key restored. No conversation was
open. A 60-second warmup is excluded, followed by five minutes with each page
visible. Counts are requests entering browser networking, including SDK retries;
they are not estimates from timer frequency. The identity was verified signed in.

| Route | Before, 5 min | After, 5 min | Before / min | After / min | Before hidden, 1 min | After hidden, 1 min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/feed` | 182 | 172 | 36.4 | 34.4 | 12 | 0 |
| `/messages` | 162 | 158 | 32.4 | 31.6 | 8 | 0 |

These are single paired samples: visible counts fell 5.5% and 2.5%, respectively.
The exact five-minute counts come from the minute-five probe log, excluding the
ten-second settling period before the hidden check.

The hidden check sets `document.hidden`/`visibilityState`, dispatches
`visibilitychange`, allows ten seconds for in-flight work to drain, then counts
one minute. This exercises the actual event handlers; it is a deterministic
policy probe rather than an OS background/suspension measurement. A pending
self-state flush remains allowed on hide to preserve read positions. Tests cover
hidden-at-start, cleanup during a request, pause/resume, failure backoff and the
existing feed cursor/DM unread behavior.

The steady visible-tab improvement is modest because notification reads dominate
this identity's workload. Feed checks move from 15 seconds to 30 seconds; DM
cadences remain 30 seconds in the background and four seconds with a conversation
open. All use jitter. Feed/notification requests do not overlap. Hidden pages
stop scheduling these polls and resume with a catch-up read; failed polls back
off exponentially up to five minutes. Partial notification failures also trigger
backoff without advancing the failed source's watermark.

`scripts/measure-idle-dapi.mjs` reproduces this probe on a local `/devnet` export.
Set `E2E_DEVNET_SEED_PHRASE` securely for the pool in `.env.devnet`; the script
never prints keys, records a trace, or navigates a non-devnet build.

## Network resilience

A read-only `epoch.current()` against testnet succeeded at epoch 19695. The
unmodified rc.3 transport emitted three double-slash DAPI requests; the same read
with the shim emitted two single-slash requests and no double-slash requests.
The shim covers configured origins plus discovered HTTPS DAPI nodes on ports
443 and 1443; other paths/protocols/ports are unchanged. Request body, headers,
method, overrides and cancellation remain covered by the transport tests.

`NEXT_PUBLIC_QUORUM_URL` now overrides the trusted service on any selected
network, rather than devnet alone. Each deployment can set it in its environment;
an absent value retains the SDK's network default. Mobile preconnect follows the
same choice. SDK rebuilds retain the five-second floor with 0–20% added jitter;
their wait stays bounded at six seconds so an online signal cannot join a
minutes-long backoff. Polling failures provide the longer load backoff.

No quorum-list response cache is added: freezing proof-key lists across a quorum
rotation would need explicit freshness/invalidation policy and a rotation test.
No denylist of testnet node operators or upstream SDK/node changes is included.

## Validation

Web lint and dead-code checks pass, with 224 unit-test files / 3,259 tests.
The production export builds successfully. The Sakura export passes the
per-file and eager-route size budgets; read-only smoke E2E reports 30 passed
and two skipped. Mobile engine typecheck and lint pass, as do all 522 unit
tests and both testnet/devnet bundle builds. On the busy build host, the mobile
module-import test hit its default five-second timeout; the full suite passed
with two workers and a 30-second test timeout. No assertion was disabled.

An Opus review found and prompted fixes for partial-notification failure
backoff, repeated WASM initialization, and an excessive SDK reconnect wait.
A Sonnet simplification review removed redundant error wrappers and derived
reconnect state.
