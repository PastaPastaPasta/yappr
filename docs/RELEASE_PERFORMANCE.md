# Release performance and request load

## UX-01: external streaming WASM (2026-10-18)

The UX/a11y lane measured the hosted `520c72ba` feed at 12.362–13.009 s on
Fast 4G / 4× CPU, dominated by the SDK initializer download. This follow-up
keeps the editor and SDK lazy-loading work below, but replaces the SDK's
base64/gzip JavaScript initializer with a content-addressed `.wasm.gz` asset.
The asset is emitted by webpack, so every export includes the matching bytes
and the version changes automatically with the installed SDK.

The raw rc.4 WASM is **26,458,473 B**, exceeding Cloudflare Pages' 25 MiB file
limit. The explicit gzip asset is **8,973,985 B** and stays below the limit
without depending on the host compressing `application/wasm`. Both Cloudflare
and the GitHub Pages origin were checked: the old embedded initializer is
already HTTP-gzipped (Cloudflare `max-age=14400`, origin `max-age=600`, with
`Vary: Accept-Encoding`). Brotli was offered, but both returned gzip. Merely
turning on HTTP compression would not fix the bottleneck. A local Brotli
experiment produced 6,872,245 B at quality 5, but Chromium 151 does not support
`DecompressionStream('brotli')`; adding a decoder is outside this change.

Feed, post and profile HTML start the download while the document parses,
before hydration. The SDK consumes that same promise and streams decompression
into wasm-bindgen's `WebAssembly.instantiateStreaming`. Download and compile
can overlap; there is no base64 decode, worker handoff or second WASM instance.
Already HTTP-decoded WASM is accepted too. Cache Storage keeps the versioned
asset across visits, namespaced by deployment base path. Only successfully
initialized bytes are stored; older versions are removed after that write.
Storage failure falls back to the HTTP
cache/network. A corrupt entry or failed speculative download gets one fresh
network attempt; retries remain bounded. No service worker controls pages or
application HTML. On static hosts, Next's `headers()` cannot change cache
headers; the versioned Cache Storage entry avoids reliance on that policy.

Quorum/node caching was evaluated and deliberately left to the SDK. On devnet,
the address pool is already configured, so no masternode-discovery request
blocks startup. Current and previous quorum lists are fetched concurrently
on every navigation, including warm visits. Their ~0.2 s cold interval is much
smaller than the payload transfer. Persisting a trusted list would require a
separate rotation/revalidation policy; this change stores executable bytes
only and preserves all proof verification. Contract preloading and first
queries remain unchanged. The existing profile header decorations contain
additional sequential work, which remains a possible follow-up. Feed loading
copy now says “Loading posts…” instead of describing the Platform connection.

Measurements below use separate static exports of baseline
`520c72ba361b78bab3c4c832b68c45571a756609` and this change, the same live Sakura
read-only routes, Chromium 151, and a local gzip server with a four-hour HTTP
cache policy for hashed assets. This reproduces the hosted transfer shape;
it does not measure Cloudflare/origin latency. Mobile: 390×844, 9 Mbps down,
1 Mbps up, 60 ms latency, 4× CPU. Desktop: 1440×900, unthrottled. Each route
gets a fresh browser context (cold) then a second full navigation retaining
HTTP/Cache Storage (warm), without retaining application memory. The metric
is first `article` insertion, not complete author/media enrichment. One paired
sample per cell, with other release work active; small desktop differences
are noise and these are not production percentiles. The public data can change
between probes. The earlier lane's hosted samples are context, not the
baseline for this paired comparison.

| Profile / route | Cold before → after, s | Warm before → after, s |
| --- | ---: | ---: |
| Mobile / feed | 12.811 → 11.600 | 1.891 → 1.692 |
| Mobile / post | 11.796 → 10.919 | 1.435 → 1.064 |
| Mobile / profile | 12.610 → 11.567 | 1.837 → 1.594 |
| Desktop / feed | 1.276 → 1.166 | 1.102 → 0.941 |
| Desktop / post | 1.022 → 0.884 | 0.626 → 0.633 |
| Desktop / profile | 1.480 → 1.212 | 1.268 → 0.946 |

Mobile feed improved **1.211 s (9.5%) cold** and **0.199 s (10.5%) warm**.
The post's ~7 ms desktop warm increase is within measurement noise.

Cold mobile feed stage boundaries, seconds after navigation start (overlapping
intervals must not be summed):

| Part | Before | After |
| --- | --- | --- |
| HTML / JS shell | HTML received 0.080; shell FCP 0.240; load event 1.821 | HTML received 0.081; shell FCP 0.272; load event 2.269 |
| WASM download plus preparation/compile | SDK JS download 1.895–10.370; native instantiation 10.904–10.917 | gzip download 0.298–9.743; streaming instantiate/compile 2.457–9.823, overlapping download |
| Quorums / node discovery | current + previous lists 10.939–11.148; no node discovery request | current + previous lists 9.845–10.090; no node discovery request |
| First queries | contracts 11.376–11.616; revalidation/read 11.716–11.971; posts 12.037–12.419; first article 12.811 | contracts 10.289–10.522; revalidation/read 10.613–10.866; posts 10.926–11.312; first article 11.600 |

The old initializer compiles in a worker that the page's native-call wrappers
cannot time directly. Its 0.547 s download-to-instantiation-end gap includes
JS evaluation, decoding, worker compilation and scheduling; the 13 ms native
instantiation alone is not its total compile cost. The new streaming interval
includes waiting for the download and is not 7.37 s of CPU work. Starting WASM
earlier shares bandwidth with shell JS (hence its later load event), while
removing the sequential post-download preparation. Detailed cross-origin
TTFB/body sizes remain unavailable without Timing-Allow-Origin.

Final validation: web lint, dead-code check, 249 test files / 3,673 tests,
production and devnet exports, and export-size budgets pass. Both mobile
engine variants build and the engine typecheck passes. The final exported
bootstrap was checked for all three routes: it has no speculative cache write
and remains self-contained. Independent Opus review approved the final code;
Sonnet simplification review found no remaining blockers.

The read-only probe is `scripts/measure-first-content.mjs URL/devnet result.json`.
It records browser-clock resource timings, WASM calls, console milestones,
paint entries, errors and article timestamps for all twelve route/profile/cache
combinations. The post and profile IDs are fixed in that script. Local evidence
(including the gzip server, full exports and raw JSON) is retained under
`~/.local/share/yappr-release-audit-20261016/perf2/`.

An extra browser check cleared the HTTP cache, disabled it, blocked WASM
network requests, and reloaded the feed: 20 articles rendered from Cache Storage
with zero attempted WASM network requests, while both quorum lists were fetched
fresh. This distinguishes persistent asset reuse from a fast HTTP cache hit.

The remaining large cold transfer is real: this change makes it start earlier
and compile during transfer, rather than removing the ~9 MB requirement.

## Earlier release performance work

Measured 2026-10-17 with Platform SDK 5.0.0-rc.3 and the committed Sakura
`build:devnet` environment. The baseline is staging `9f0e6fb5`, rebuilt separately
from an archive of that revision. Both exports use `/devnet` and the same contract
pins. Sizes below include only the unique script `src` references in each route's
exported HTML; they exclude later dynamic imports. The updated size export
includes the staging legal-page changes merged into this branch. Gzip is
calculated locally per script, rather than assuming the deployment's compression
settings.

## Initial JavaScript

Baseline → updated, bytes raw / gzip:

- `/`: 17,509,434 / 10,505,427 → 5,510,121 / 1,506,971.
- `/feed`: 17,540,212 / 10,516,016 → 5,540,353 / 1,517,493.
- `/post?id=…`: 17,525,231 / 10,510,944 → 5,525,404 / 1,512,378.
- `/user?id=…`: 17,598,460 / 10,529,912 → 5,598,624 / 1,531,363.
- `/terms`: 17,285,349 / 10,436,226 → 5,294,316 / 1,440,629.

The feed's eager transfer is 85.6% smaller with gzip (68.4% smaller raw).
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

Two fresh browser contexts, one on `/feed` and one on `/messages` with DM v5,
used the same existing Sakura CI identity and its restored messaging key. No conversation was
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
v5 cadences remain 30 seconds in the background and four seconds with a conversation
open. All use jitter. Feed/notification requests do not overlap. Hidden pages
stop scheduling these polls and resume with a catch-up read; failed polls back
off exponentially up to five minutes. Partial notification failures also trigger
backoff without advancing the failed source's watermark.
Following-feed continuation failures retain partial posts and their retry
watermark while triggering backoff; an intentional batch cap alone does not.
DM polls share one pending operation, including duplicate mobile foreground
signals, and recheck visibility when dequeued. State flushes, explicit sends and explicit refresh checks
still run while hidden; explicit checks wait for a fresh poll. DM stream continuation failures retain partial messages
and retryable cursors, finish healthy work, then trigger polling backoff.

The legacy v3/v4 active-conversation poller is outside this DM-v5 engine policy.
The current default config still selects that older path. The release audit
assigns the v5 production config cut-over to R-B1 / WP15 and deletion of legacy
DMs to R-C2 / WP17. [Issue #784](https://github.com/PastaPastaPasta/yappr/issues/784)
tracks ensuring that poller is unreachable/removed before testnet go-live; these
measurements do not establish a legacy active-conversation request budget.

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

Web lint and dead-code checks pass, with 224 unit-test files / 3,264 tests.
The production export builds successfully. The Sakura export passes the
per-file and eager-route size budgets; read-only smoke E2E reports 33 passed
and two skipped. Mobile engine typecheck and lint pass, as do all 523 unit
tests and both testnet/devnet bundle builds. On the busy build host, the mobile
module-import test hit its default five-second timeout; the full suite passed
with two workers and a 30-second test timeout. No assertion was disabled.

An Opus review found and prompted fixes for partial-notification failure
backoff, repeated WASM initialization, and an excessive SDK reconnect wait.
The follow-up Opus review approved the implementation with nonblocking
suggestions. A Sonnet simplification review removed redundant error wrappers;
the reconnect design no longer needs growing-backoff state.
