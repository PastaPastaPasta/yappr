# M10 release measurements (2026-10-02, devnet release builds)

Host: M4 Mac, heavily loaded by parallel agents (load average 14-105 during runs).

## Sizes
| Artifact | Size |
| --- | --- |
| Android release APK, devnet, arm64-v8a only, R8 | 51,310,355 B (48.9 MiB); engine.js 15.4 MB raw / 9.7 MB deflated |
| Android release AAB, devnet | 41,939,387 B (40.0 MiB) |
| Android release APK / AAB, testnet | 50,223,351 B / 41,936,863 B |
| iOS unsigned IPA (device, arm64), devnet | 24,601,709 B (23.5 MiB) |
| iOS .app inside the archive | 60 MB |
| iOS Release simulator .app | 124 MB (simulator slices, not representative) |

## Cold start
iOS (Yappr iPhone 17 (M4 host), Release, Settings -> Engine diagnostics, "Mount -> ready"):
run 1 1,513 ms (hello 842, boot 669), run 2 1,831 ms (hello 804, boot 1,024), run 3 1,612 ms (hello 833, boot 776).
Launch -> first app UI (splash gone, screenshot polling, includes ~0.5 s simctl launch and the
splash's theme hold): 2,633 / 2,445 / 2,624 / 2,601 ms.

Android (yappr_pixel_m4 emulator-5570, release APK):
`am start -W` TotalTime (first frame), lightly loaded host: 1,685 / 1,499 / 1,253 ms (first-ever launch 2,854).
Under heavy host load: 5,087 / 5,189 / 4,124 ms.
Engine "Mount -> ready" (heavily loaded): 7,153 / 6,748 / 6,153 ms (hello 5,082 / 4,323 / 4,301 ms: parsing the 15 MB engine.js in the WebView; boot 2,047 / 2,398 / 1,820 ms).
