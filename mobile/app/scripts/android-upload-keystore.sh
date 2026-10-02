#!/usr/bin/env bash
# Generates a local Android upload keystore OUTSIDE the repository and prints
# the environment scripts/release-android.sh reads (mobile/RELEASE.md).
#
#   scripts/android-upload-keystore.sh [path]   (default: ~/.yappr/yappr-upload.jks)
#
# For Play, this key is only the *upload* key: Play App Signing holds the app
# signing key. Keep the file and its password in a password manager; losing it
# means a key reset request to Google.
set -euo pipefail

store="${1:-$HOME/.yappr/yappr-upload.jks}"
alias="yappr-upload"

if [[ -e "$store" ]]; then
  echo "$store already exists; not overwriting." >&2
  exit 1
fi
mkdir -p "$(dirname "$store")"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
case "$(cd "$(dirname "$store")" && pwd)/" in
  "$repo/"*)
    echo "Refusing to write a keystore inside the repository." >&2
    exit 1
    ;;
esac

password="$(openssl rand -base64 24)"
keytool -genkeypair -v -storetype PKCS12 -keystore "$store" -alias "$alias" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$password" -keypass "$password" \
  -dname "CN=Yappr upload key, O=Yappr" >/dev/null
chmod 600 "$store"

cat <<EOF
Created $store. Store the password somewhere safe, then export:

export YAPPR_UPLOAD_STORE_FILE='$store'
export YAPPR_UPLOAD_STORE_PASSWORD='$password'
export YAPPR_UPLOAD_KEY_ALIAS='$alias'
export YAPPR_UPLOAD_KEY_PASSWORD='$password'
EOF
