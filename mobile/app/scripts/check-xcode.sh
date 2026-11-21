#!/usr/bin/env bash
# Fails unless the selected Xcode (DEVELOPER_DIR or xcode-select) is exactly the
# given release build of the given major version, with a matching iOS SDK. App
# Store Connect rejects beta toolchains and, from April 2027, SDKs older than
# iOS 27 (ITMS-90725).
#
#   check-xcode.sh <major> <build>
set -euo pipefail

major="${1:?usage: check-xcode.sh <major> <build>}"
expected_build="${2:?usage: check-xcode.sh <major> <build>}"
version="$(xcodebuild -version | sed -n 's/^Xcode //p')"
build="$(xcodebuild -version | sed -n 's/^Build version //p')"
sdk="$(xcrun --sdk iphoneos --show-sdk-version)"

echo '### Xcode'
echo "- Developer dir: \`$(xcode-select -p)\`"
echo "- Xcode: \`$version ($build)\`"
echo "- iOS SDK: \`$sdk\`"
echo

failed=0
if [[ "$version" != "$major" && "$version" != "$major".* ]]; then
  echo "::error::Xcode $version is selected, expected Xcode $major" >&2
  failed=1
fi
if [[ "$sdk" != "$major" && "$sdk" != "$major".* ]]; then
  echo "::error::the iOS SDK is $sdk, expected iOS $major" >&2
  failed=1
fi
if [[ "$build" != "$expected_build" ]]; then
  echo "::error::Xcode build $build is selected, expected release build $expected_build" >&2
  failed=1
fi
exit "$failed"
