# M4 EngineHost timings (dev builds, Metro dev JS; testnet unless noted; evo-sdk 5.0.0-beta.1)

| Platform | Run | prepare | mount→hello | boot (SDK) | mount→ready | first feed.home (2 posts) |
| --- | --- | --- | --- | --- | --- | --- |
| iOS 26.5 sim (iPhone 17) | 5 cold launches | ~300–375 ms (15 MB html read) | ~0.9–1.3 s | 655–1652 ms | 1539–2596 ms (p50 1584) | 1.6 s (warm) – 5.4 s (first) |
| Android 15 emu (Pixel 7, WebView 124) | 5 cold launches | 81–146 ms (loader page) | ~0.7–1.2 s | 953–1598 ms | 1606–2282 ms (p50 2060) | 3.4 s |
| iOS devnet (sakura) | 1 | 375 ms | 1.3 s | 981 ms | 2313 ms | fails: quorum cache (see report) |
| Android devnet (sakura) | 1 (first ever) | 146 ms | 3.7 s | 2273 ms | 6066 ms | — |

Memory (RSS after ready): iOS WebContent 590–645 MB on the simulator (macOS process RSS, not device-representative);
Android renderer ~240 MB, app process ~695 MB (dev build).
Timer probe (O4, 0×0 WebView, foreground): iOS 20×50 ms → mean 52.0–52.2 ms, max 55 ms; Android mean 50.0 ms, max 51–70 ms. No throttling.
Background flush: iOS 110–177 ms, Android 290 ms (within 2 s).
Crash → ready: iOS 1.6–7.0 s incl. backoff; Android 2.0 s. Interrupted feed.home replayed and resolved on both.
