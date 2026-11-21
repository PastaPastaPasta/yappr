#!/usr/bin/env bash
# Checks that an iOS build is signed by the expected Apple team, before anything
# is uploaded (mobile/RELEASE.md, TestFlight). Every check prints its evidence
# as Markdown on stdout and fails the run on a mismatch.
#
#   ios-signing-gate.sh cert <cert.pem>                             distribution certificate
#   ios-signing-gate.sh profile <profile.plist> <bundle id>         decoded provisioning profile
#   ios-signing-gate.sh app <Info.plist> <bundle id> <version> <build>
#   ios-signing-gate.sh ipa <app.ipa> <bundle id> <version> <build> <profile uuid>
#
# Environment:
#   APPLE_TEAM_ID            expected team id (OU of the certificate)
#   APPLE_EXPECTED_ORG_NAME  expected organization name (O of the certificate)
#   SIGNING_NAME_DENYLIST    comma-separated names that must appear nowhere (optional)
set -euo pipefail

: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is not set}"
: "${APPLE_EXPECTED_ORG_NAME:?APPLE_EXPECTED_ORG_NAME is not set}"

failed=0
fail() {
  echo "::error::$1" >&2
  echo "- **FAILED:** $1"
  failed=1
}
# True when the text contains a SIGNING_NAME_DENYLIST entry (case-insensitive substring).
denied() { # <text>
  local entry text entries
  [[ -n "${SIGNING_NAME_DENYLIST:-}" ]] || return 1
  text="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  IFS=',' read -r -a entries <<<"$SIGNING_NAME_DENYLIST"
  for entry in "${entries[@]}"; do
    entry="$(printf '%s' "$entry" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
    [[ -n "$entry" && "$text" == *"$entry"* ]] && return 0
  done
  return 1
}

# Every value is checked against the denylist before it is printed; a hit prints the label only.
deny_check() { # <label> <text>
  if denied "$2"; then fail "$1 contains a denylisted name (value withheld)"; fi
}
evidence() { # <label> <value>
  if denied "$2"; then
    fail "$1 contains a denylisted name (value withheld)"
  else
    printf -- "- %s: \`%s\`\n" "$1" "$2"
  fi
}

expect() { # <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then
    evidence "$1" "$2"
  elif denied "$2" || denied "$3"; then
    fail "$1 does not match the expected value (values withheld: a denylisted name)"
  else
    fail "$1 is '$2', expected '$3'"
  fi
}

# One attribute of an X.509 subject. The multiline form prints each attribute on
# its own line, unescaped, so a comma inside a value ("The Dash Foundation, Inc.")
# stays part of the value.
subject_field() { # <pem> <long name>
  openssl x509 -in "$1" -noout -subject -nameopt multiline,utf8,-esc_msb |
    sed -n "s/^[[:space:]]*$2[[:space:]]*= //p"
}

plist_value() { # <plist> <key path>
  plutil -extract "$2" raw -o - "$1" 2>/dev/null || true
}

check_cert() {
  local pem="$1" org unit cn count
  count="$(subject_field "$pem" organizationName | wc -l | tr -d ' ')"
  [[ "$count" == 1 ]] || fail "certificate subject has $count organizationName attributes"
  count="$(subject_field "$pem" organizationalUnitName | wc -l | tr -d ' ')"
  [[ "$count" == 1 ]] || fail "certificate subject has $count organizationalUnitName attributes"
  org="$(subject_field "$pem" organizationName)"
  unit="$(subject_field "$pem" organizationalUnitName)"
  cn="$(subject_field "$pem" commonName)"
  echo '### Distribution certificate'
  # The unescaped UTF-8 subject is screened before any part of it is printed.
  if denied "$(openssl x509 -in "$pem" -noout -subject -nameopt multiline,utf8,-esc_msb)"; then
    fail 'certificate subject contains a denylisted name (certificate evidence withheld)'
    return
  fi
  evidence 'Subject' "$(openssl x509 -in "$pem" -noout -subject -nameopt RFC2253 | sed 's/^subject= *//')"
  expect 'O' "$org" "$APPLE_EXPECTED_ORG_NAME"
  expect 'OU' "$unit" "$APPLE_TEAM_ID"
  expect 'CN' "$cn" "Apple Distribution: $APPLE_EXPECTED_ORG_NAME ($APPLE_TEAM_ID)"
  evidence 'Not after' "$(openssl x509 -in "$pem" -noout -enddate | sed 's/^notAfter=//')"
  openssl x509 -in "$pem" -noout -checkend 0 >/dev/null || fail 'certificate has expired'
}

check_profile() {
  local plist="$1" bundle_id="$2" now expires
  echo '### Provisioning profile'
  evidence 'Name' "$(plist_value "$plist" Name)"
  evidence 'UUID' "$(plist_value "$plist" UUID)"
  expect 'TeamName' "$(plist_value "$plist" TeamName)" "$APPLE_EXPECTED_ORG_NAME"
  expect 'TeamIdentifier[0]' "$(plist_value "$plist" TeamIdentifier.0)" "$APPLE_TEAM_ID"
  expect 'application-identifier' "$(plist_value "$plist" Entitlements.application-identifier)" "$APPLE_TEAM_ID.$bundle_id"
  expect 'get-task-allow' "$(plist_value "$plist" Entitlements.get-task-allow)" 'false'
  [[ -z "$(plist_value "$plist" ProvisionedDevices.0)" ]] || fail 'profile lists devices; an App Store profile has none'
  [[ "$(plist_value "$plist" ProvisionsAllDevices)" != 'true' ]] || fail 'profile is an enterprise profile'
  expires="$(plist_value "$plist" ExpirationDate)"
  evidence 'Expires' "$expires"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [[ -n "$expires" && "$expires" > "$now" ]] || fail 'profile has expired'
  deny_check 'decoded profile' "$(cat "$plist")"
}

check_app() { # <Info.plist> <bundle id> <version> <build>
  expect 'CFBundleIdentifier' "$(plist_value "$1" CFBundleIdentifier)" "$2"
  expect 'CFBundleShortVersionString' "$(plist_value "$1" CFBundleShortVersionString)" "$3"
  expect 'CFBundleVersion' "$(plist_value "$1" CFBundleVersion)" "$4"
  evidence 'DTSDKName' "$(plist_value "$1" DTSDKName)"
  evidence 'DTXcode' "$(plist_value "$1" DTXcode)"
  # App Store Connect refuses non-exempt encryption without its documentation code (ITMS-90592).
  local encryption code
  encryption="$(plist_value "$1" ITSAppUsesNonExemptEncryption)"
  code="$(plist_value "$1" ITSEncryptionExportComplianceCode)"
  if [[ "$encryption" == 'true' && -z "$code" ]]; then
    fail 'ITSAppUsesNonExemptEncryption is YES without ITSEncryptionExportComplianceCode (ITMS-90592)'
  else
    evidence 'ITSAppUsesNonExemptEncryption' "${encryption:-absent}"
    evidence 'ITSEncryptionExportComplianceCode' "${code:-absent}"
  fi
}

check_ipa() { # <ipa> <bundle id> <version> <build> <profile uuid>
  local ipa="$1" dir app details authorities embedded
  dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' RETURN
  unzip -q "$ipa" -d "$dir"
  app="$(find "$dir/Payload" -maxdepth 1 -name '*.app' -print -quit)"
  echo '### Exported .ipa'
  [[ -n "$app" ]] || { fail 'the .ipa has no app bundle'; return; }
  codesign --verify --deep --strict "$app" || fail 'codesign --verify failed'
  details="$(codesign -dvv "$app" 2>&1)"
  authorities="$(printf '%s\n' "$details" | sed -n 's/^Authority=//p')"
  while IFS= read -r line; do evidence 'Authority' "$line"; done <<<"$authorities"
  expect 'Authority (leaf)' "$(printf '%s\n' "$authorities" | head -n 1)" \
    "Apple Distribution: $APPLE_EXPECTED_ORG_NAME ($APPLE_TEAM_ID)"
  expect 'TeamIdentifier' "$(printf '%s\n' "$details" | sed -n 's/^TeamIdentifier=//p')" "$APPLE_TEAM_ID"
  deny_check 'codesign Authority' "$authorities"
  embedded="$dir/embedded.plist"
  security cms -D -i "$app/embedded.mobileprovision" -o "$embedded"
  expect 'Embedded profile UUID' "$(plist_value "$embedded" UUID)" "$5"
  check_app "$app/Info.plist" "$2" "$3" "$4"
}

what="${1:-}"
shift || true
case "$what" in
  cert) check_cert "$@" ;;
  profile) check_profile "$@" ;;
  app) echo '### Archived app'; check_app "$@" ;;
  ipa) check_ipa "$@" ;;
  *) echo "usage: $0 cert|profile|app|ipa ..." >&2; exit 2 ;;
esac
echo
exit "$failed"
