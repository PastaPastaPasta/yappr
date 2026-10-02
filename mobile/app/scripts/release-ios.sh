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
build_number="${YAPPR_BUILD_NUMBER:-1}"
version="$(node -p "require('./package.json').version")"
out="$PWD/build/release"
derived="$PWD/build/ios-derived-data"
name="yappr-${APP_VARIANT}-${version}-${build_number}"

if [[ "${YAPPR_SKIP_PREBUILD:-}" != "1" ]]; then
  npx expo prebuild --clean --no-install --platform ios
  (cd ios && pod install)
fi

workspace="$(ls -d ios/*.xcworkspace | head -n 1)"
scheme="$(basename "$workspace" .xcworkspace)"
mkdir -p "$out"

if [[ "$what" == "simulator" ]]; then
  xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$derived" build | tail -n 5
  app="$derived/Build/Products/Release-iphonesimulator/$scheme.app"
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
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" archive | tail -n 5

# An unsigned .ipa is the App Store upload's size before thinning and encryption.
staging="$(mktemp -d)"
mkdir "$staging/Payload"
cp -R "$archive/Products/Applications/$scheme.app" "$staging/Payload/"
(cd "$staging" && zip -qr -9 "$out/$name-unsigned.ipa" Payload)
rm -rf "$staging"
ls -l "$out/$name-unsigned.ipa"
