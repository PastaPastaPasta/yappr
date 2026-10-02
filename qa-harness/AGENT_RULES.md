# Rules for every Yappr mobile agent (read first)

You are one agent on a team building the Yappr native iOS and Android apps. The mobile lead orchestrates the team.

## Read before you start
- `docs/mobile/ADR-001-mobile-1.0.md` is the binding decision record. If it's missing from your worktree, read it from `/Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/docs/mobile/ADR-001-mobile-1.0.md`.
- Background research:
  - `/tmp/claude/yappr-mobile/web-inventory.md`: web routes, user stories, design tokens, copy and limits.
  - `/tmp/claude/yappr-mobile/advisor-opus.md` and `/tmp/claude/yappr-mobile/advisor-fable.md`: the two architecture proposals the ADR reconciles.
- The repo `CLAUDE.md` describes the web app: static export, no backend, and the validation checklist.

## Environment
- **Bash sandbox.** Your worktree is outside the Bash sandbox's write allowlist, so run Bash commands that write there, use the network, or touch simulators/emulators with `dangerouslyDisableSandbox: true`. The Read/Edit/Write tools work normally.
- **Android:**
  - `ANDROID_HOME=/Users/pasta/workspace/android-sdk` (NDK 27.1.12297006, emulator, `system-images;android-35;google_apis;arm64-v8a`)
  - `JAVA_HOME=$(/usr/libexec/java_home -v 21)`
  - The AVD `yappr_pixel` may already be running as `emulator-5554`. Check with `adb devices`.
- **iOS:** Xcode 26.6. The simulator "Yappr iPhone 17" (iOS 26.5) may already be booted.
- **Toolchain:** Node 22, CocoaPods, Rust 1.97.
- **Networks:**
  - **Testnet** (production yap.pr contracts, topology v2) is readable now.
  - **Sakura** (Platform 5.0.0-beta.1) has identities but its Yappr contracts are not published yet, and the staging root still pins evo-sdk 4.2.0-beta.7.
  - Never write to testnet production contracts from automated tests.
- **Git:**
  - Never `git add -A` or `git add .`; add specific paths.
  - Use conventional commit messages, ending with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Commits are signed automatically. Never pass `--no-gpg-sign` or change signing config. If signing fails, stop and report.
  - The git hook may block commits inside the sandbox; run `git commit` with `dangerouslyDisableSandbox: true`.
  - Do **not** push or open PRs. The lead does that.
  - Never use bare `git stash`.
- **Web safety.** Do not modify web `lib/`, `app/`, `components/`, `hooks/` or `contexts/` unless your task explicitly says so. Allowed root edits are the `mobile/` excludes in `tsconfig.json`, eslint and knip, and the CI workflow.

## Quality
- Make it work and prove it.
  - Run the relevant checks (typecheck, lint, tests, builds).
  - For UI, take simulator and emulator screenshots: `xcrun simctl io booted screenshot <file>`, and `adb exec-out screencap -p > <file>`.
  - Save evidence under `/tmp/claude/yappr-mobile/evidence/<your-task>/`.
- Before you report done, review your own diff for bugs, leftover debug code, and needless complexity.
- **Final report** (concise): what you built, the files, the commands you ran with their results, the evidence paths, known gaps, and any platform or SDK bugs you found. Give a reproducer for each bug, so the lead can file it.
