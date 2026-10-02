# shellcheck shell=bash
# Yappr mobile QA environment. Source it in every shell:
#   source /Users/pasta/workspace/yappr-mobile-qa/env.sh
# Bash commands that touch devices, builds or the network need dangerouslyDisableSandbox: true.

export QA_ROOT=/Users/pasta/workspace/yappr-mobile-qa
export QA_EVIDENCE="$QA_ROOT/evidence"
export QA_BUILDS="$QA_ROOT/builds"
export QA_SRC="$QA_ROOT/src"            # git worktrees (one per built ref) for code reading and builds
export QA_STATE="$QA_ROOT/.state"        # per-device pid files (logs, recordings) used by bin/qa
export QA_PERSONAS="$QA_ROOT/personas"   # 0600 key files written by bin/persona-key (gitignored, never published)

# Toolchain
export ANDROID_HOME=/Users/pasta/workspace/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null)"
export PATH="$QA_ROOT/bin:$HOME/.maestro/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$JAVA_HOME/bin:$PATH"
export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true

# Source repo (the main checkout's git dir owns every worktree)
export YAPPR_REPO=/Users/pasta/workspace/yappr
export YAPPR_REMOTE=https://github.com/PastaPastaPasta/yappr.git

# Builds under test. bin/build-candidate writes builds/<ref-short>/ and points builds/current at it.
# Stable file names inside every build dir:
export QA_BUILD="$QA_BUILDS/current"
export QA_IOS_DEVNET_APP="$QA_BUILD/ios-devnet.app"
export QA_IOS_TESTNET_APP="$QA_BUILD/ios-testnet.app"
export QA_ANDROID_DEVNET_APK="$QA_BUILD/android-devnet.apk"
export QA_ANDROID_TESTNET_APK="$QA_BUILD/android-testnet.apk"

# Variants (release builds: no Metro, no dev menu)
#   variant  bundle id / package  scheme       iOS executable  network
#   devnet   pr.yap.app.dev       yappr-dev    YapprDev        devnet "sakura" (read + write, personas 90-98)
#   testnet  pr.yap.app.beta      yappr-beta   YapprBeta       testnet (production yap.pr contracts: READ ONLY)
export QA_VARIANT="${QA_VARIANT:-devnet}"

# Sakura personas (bin/persona-key). 90-98 QA-usable; 99 has proof posts: sign in by key only, never write.
export YAPPR_SAKURA_IDENTITIES=/Users/pasta/.local/share/yappr-sakura-20261001/identities.json
export YAPPR_SAKURA_ENV_TEMPLATE=/Users/pasta/.local/share/yappr-sakura-20261001/env.devnet.template
export QA_RESPONDER_ADDR="${QA_RESPONDER_ADDR:-127.0.0.1:8789}"   # bin/wallet-respond --serve

# Device table: stream -> platform, device id, theme, personas. Re-check Android serials with
#   adb devices; adb -s <serial> emu avd name     (qa_serial_for_avd resolves them)
#   stream  platform  device                                avd / sim name        theme  personas
#   L1i     ios       7E2918AC-42DF-45F3-86AE-8DCA092BE07B  Yappr iPhone 17       light  90 (+98 second account)
#   L1a     android   emulator-5554                         yappr_pixel           dark   91 (+99 key-entry only)
#   L2i     ios       0BA11478-0F45-486B-9077-7F418A81647A  Yappr iPhone 17 L2    dark   92
#   L2a     android   emulator-5556                         yappr_pixel_l2        light  93
#   L3i     ios       A6B5008C-C31B-4C2D-89BE-6CAADA46CE48  Yappr iPhone 17 L3    light  94
#   L3a     android   emulator-5558                         yappr_pixel_l3        dark   95
#   L4i     ios       A48BD1B8-856D-4D22-9576-14DC405FE330  Yappr iPhone 17 L4    dark   96 (+98 group member)
#   L4a     android   emulator-5560                         yappr_pixel_l4        light  97
#   SPi     ios       0FB7985F-DDC7-4D86-9D21-BD0911D4E5F1  Yappr iPhone 17 (M4 host)  -  SR-repro / harness tests
#   SPa     android   emulator-5570                         yappr_pixel_m4        -      SR-repro / harness tests
# One row per stream: "platform device avd theme personas" (bash 3.2 and zsh safe: no associative arrays).
qa_stream_row() {
  case "$1" in
    L1i) echo "ios 7E2918AC-42DF-45F3-86AE-8DCA092BE07B - light 90,98" ;;
    L1a) echo "android emulator-5554 yappr_pixel dark 91,99" ;;
    L2i) echo "ios 0BA11478-0F45-486B-9077-7F418A81647A - dark 92" ;;
    L2a) echo "android emulator-5556 yappr_pixel_l2 light 93" ;;
    L3i) echo "ios A6B5008C-C31B-4C2D-89BE-6CAADA46CE48 - light 94" ;;
    L3a) echo "android emulator-5558 yappr_pixel_l3 dark 95" ;;
    L4i) echo "ios A48BD1B8-856D-4D22-9576-14DC405FE330 - dark 96,98" ;;
    L4a) echo "android emulator-5560 yappr_pixel_l4 light 97" ;;
    SPi) echo "ios 0FB7985F-DDC7-4D86-9D21-BD0911D4E5F1 - light -" ;;
    SPa) echo "android emulator-5570 yappr_pixel_m4 light -" ;;
    *) echo "unknown stream $1" >&2; return 1 ;;
  esac
}

# Current serial of an AVD name (serials change when emulators restart).
qa_serial_for_avd() {
  local s
  for s in $(adb devices | awk 'NR>1 && $2=="device" {print $1}'); do
    [ "$(adb -s "$s" emu avd name 2>/dev/null | head -n1 | tr -d '\r')" = "$1" ] && { echo "$s"; return 0; }
  done
  return 1
}

# `qa_stream L2a` prints "android emulator-5556" (Android serial re-resolved by AVD name).
qa_stream() {
  local row plat dev avd
  row="$(qa_stream_row "$1")" || return 1
  plat="$(echo "$row" | awk '{print $1}')"; dev="$(echo "$row" | awk '{print $2}')"; avd="$(echo "$row" | awk '{print $3}')"
  if [ "$plat" = android ] && [ "$avd" != "-" ]; then dev="$(qa_serial_for_avd "$avd" || echo "$dev")"; fi
  echo "$plat $dev"
}
