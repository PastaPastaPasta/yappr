#!/usr/bin/env bash
# Builds the iOS app in the Release configuration (mobile/RELEASE.md).
#
#   APP_VARIANT=devnet scripts/release-ios.sh simulator   Release .app for the simulator
#   APP_VARIANT=devnet scripts/release-ios.sh archive     unsigned device .xcarchive plus an
#                                                         unsigned .ipa (for size; not installable)
#
# Environment:
#   APP_VARIANT          devnet (default) | testnet | production
#   YAPPR_BUILD_NUMBER   CFBundleVersion (default 1); CI passes its run number
#   YAPPR_SKIP_PREBUILD  1 to reuse the existing ios/ project (pods installed)
#
# Signing and upload need the owner's Apple credentials; see RELEASE.md.
# Outputs land in build/release/.
set -euo pipefail

cd "$(dirname "$0")/.."
what="${1:-}"
case "$what" in simulator | archive) ;; *) echo "usage: $0 simulator|archive" >&2; exit 2 ;; esac

export APP_VARIANT="${APP_VARIANT:-devnet}"
# app.config.ts: the release Info.plist (no ATS local-networking exception).
export YAPPR_RELEASE=1
build_number="${YAPPR_BUILD_NUMBER:-1}"
version="$(node -p "require('./package.json').version")"
out="$PWD/build/release"
derived="$PWD/build/ios-derived-data"
name="yappr-${APP_VARIANT}-${version}-${build_number}"

if [[ "${YAPPR_SKIP_PREBUILD:-}" != "1" ]]; then
  npx expo prebuild --clean --no-install --platform ios
  (cd ios && pod install)
fi

workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' | head -n 1)"
scheme="$(basename "$workspace" .xcworkspace)"
mkdir -p "$out"

# The bundle id and build number are baked in at prebuild; a reused project must match this build.
# pbxproj writes the id bare or quoted ("…"), depending on the serializer; accept both.
bundle_id_matches() { # <application id> <project.pbxproj>
  grep -qE "PRODUCT_BUNDLE_IDENTIFIER = \"?${1//./\\.}\"?;" "$2"
}
application_id="$(node -p "require('./src/variants.ts').VARIANTS['$APP_VARIANT'].applicationId")"
if ! bundle_id_matches "$application_id" "ios/$scheme.xcodeproj/project.pbxproj" ||
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "ios/$scheme/Info.plist")" != "$build_number" ]]; then
  echo "ios/ was prebuilt for another variant or build number; rerun without YAPPR_SKIP_PREBUILD." >&2
  exit 1
fi

# expo-dev-launcher strips its local-network keys from Release builds in a script phase that
# declares no inputs, so an incremental build can skip it. Strip them here too (the products
# are unsigned, so editing the Info.plist is safe). The app sets no keys of its own. A project
# reused with YAPPR_SKIP_PREBUILD may come from a dev prebuild, so drop the ATS local-networking
# exception as well (app.config.ts leaves it out of release prebuilds).
strip_dev_launcher_keys() {
  local plist="$1/Info.plist"
  if /usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsLocalNetworking' "$plist" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c 'Delete :NSAppTransportSecurity:NSAllowsLocalNetworking' "$plist"
  fi
  if /usr/libexec/PlistBuddy -c 'Print :NSLocalNetworkUsageDescription' "$plist" 2>/dev/null | grep -q 'Expo Dev Launcher'; then
    /usr/libexec/PlistBuddy -c 'Delete :NSLocalNetworkUsageDescription' "$plist"
  fi
  if /usr/libexec/PlistBuddy -c 'Print :NSBonjourServices' "$plist" 2>/dev/null | grep -q '_expo._tcp'; then
    /usr/libexec/PlistBuddy -c 'Delete :NSBonjourServices' "$plist"
  fi
}

log="$out/$name-$what.log"
echo "xcodebuild log: $log"

if [[ "$what" == "simulator" ]]; then
  xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$derived" build >"$log" 2>&1 || { tail -n 40 "$log"; exit 1; }
  app="$derived/Build/Products/Release-iphonesimulator/$scheme.app"
  strip_dev_launcher_keys "$app"
  rm -rf "$out/$name-simulator.app"
  cp -R "$app" "$out/$name-simulator.app"
  echo "Install: xcrun simctl install <udid> $out/$name-simulator.app"
  du -sh "$out/$name-simulator.app"
  exit 0
fi

archive="$out/$name.xcarchive"
rm -rf "$archive"
xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -archivePath "$archive" \
  -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" archive >"$log" 2>&1 ||
  { tail -n 40 "$log"; exit 1; }
strip_dev_launcher_keys "$archive/Products/Applications/$scheme.app"

# An unsigned .ipa is the App Store upload's size before thinning and encryption.
staging="$(mktemp -d)"
mkdir "$staging/Payload"
cp -R "$archive/Products/Applications/$scheme.app" "$staging/Payload/"
rm -f "$out/$name-unsigned.ipa"
(cd "$staging" && zip -qr -9 "$out/$name-unsigned.ipa" Payload)
rm -rf "$staging"
ls -l "$out/$name-unsigned.ipa"
