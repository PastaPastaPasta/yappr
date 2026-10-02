#!/usr/bin/env bash
# Builds a release APK and/or AAB for one variant (mobile/RELEASE.md).
#
#   APP_VARIANT=devnet scripts/release-android.sh [apk|aab|all]   (default: all)
#
# Environment:
#   APP_VARIANT          devnet (default) | testnet | production
#   YAPPR_BUILD_NUMBER   versionCode (default 1); CI passes its run number
#   YAPPR_ANDROID_ABIS   native ABIs to build and package (default arm64-v8a)
#   YAPPR_SKIP_PREBUILD  1 to reuse the existing android/ project
#   YAPPR_UPLOAD_STORE_FILE, YAPPR_UPLOAD_STORE_PASSWORD,
#   YAPPR_UPLOAD_KEY_ALIAS, YAPPR_UPLOAD_KEY_PASSWORD
#                        the upload key; unset signs with the debug key
#                        (scripts/android-upload-keystore.sh makes a local one)
#
# Outputs land in build/release/ as yappr-<variant>-<version>-<build>.{apk,aab}.
set -euo pipefail

cd "$(dirname "$0")/.."
what="${1:-all}"
case "$what" in apk | aab | all) ;; *) echo "usage: $0 [apk|aab|all]" >&2; exit 2 ;; esac

export APP_VARIANT="${APP_VARIANT:-devnet}"
build_number="${YAPPR_BUILD_NUMBER:-1}"
abis="${YAPPR_ANDROID_ABIS:-arm64-v8a}"
version="$(node -p "require('./package.json').version")"
out="build/release"
name="yappr-${APP_VARIANT}-${version}-${build_number}"

if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21)"
  export JAVA_HOME
fi

if [[ "${YAPPR_SKIP_PREBUILD:-}" != "1" ]]; then
  npx expo prebuild --clean --no-install --platform android
fi

if [[ -z "${YAPPR_UPLOAD_STORE_FILE:-}" ]]; then
  echo "warning: YAPPR_UPLOAD_STORE_FILE is not set; signing with the debug key (not uploadable)." >&2
fi

tasks=()
[[ "$what" != "aab" ]] && tasks+=(":app:assembleRelease")
[[ "$what" != "apk" ]] && tasks+=(":app:bundleRelease")

(cd android && ./gradlew "${tasks[@]}" -PreactNativeArchitectures="$abis" --no-daemon)

mkdir -p "$out"
if [[ "$what" != "aab" ]]; then
  cp android/app/build/outputs/apk/release/app-release.apk "$out/$name.apk"
fi
if [[ "$what" != "apk" ]]; then
  cp android/app/build/outputs/bundle/release/app-release.aab "$out/$name.aab"
fi
ls -l "$out/$name".*
