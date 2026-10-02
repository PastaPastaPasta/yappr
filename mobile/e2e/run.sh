#!/usr/bin/env bash
# Run the Maestro regression suite (ADR-001 E8, EXECUTION M9) on one device.
#
#   mobile/e2e/run.sh --platform ios|android --device <udid|serial> [options]
#
# Options:
#   --variant devnet|testnet|production   the installed app (default devnet)
#   --suite smoke|full     smoke: signed-out flows only, no secrets, no writes (default).
#                          full: smoke, then the signed-in flows; devnet (sakura) only.
#   --metro-port <port>    a dev client: load the bundle from Metro on localhost:<port>
#                          (Metro must run with the same APP_VARIANT). Omit for a release build.
#   --out <dir>            output directory (default mobile/e2e/out/<platform>-<timestamp>)
#   --only <regex>         run only the flows whose file name matches
#
# Full suite inputs (environment; nothing here is ever printed):
#   YAPPR_SAKURA_IDENTITIES  the sakura ops identities.json (the persona pool)
#   E2E_PERSONA              the app's persona, 90-98 (default 97)
#   E2E_PEER_PERSONA         the second persona, driven by the engine in Node (default 96)
#   E2E_KEY_FILE             optional: a file holding E2E_PERSONA's AUTHENTICATION/HIGH key
#   E2E_DM_KEY_FILE          optional: a file holding its ENCRYPTION key
#                            Without them, the keys are written from the pool into a private
#                            temp dir (bin/persona-key from the QA kit when installed, else a
#                            local equivalent) and deleted on exit.
#   E2E_RESPONDER_ADDR       the test-wallet responder (default 127.0.0.1:8789)
#   E2E_PEER_ADDR            the peer harness (default 127.0.0.1:8790)
#   Use a different persona pair and ports per device when running devices in parallel.
#
# Output: junit.xml (all flows), junit/<flow>.xml, summary.md, screenshots/<platform>-<flow>-<name>.png,
# logs/<flow>.log, artifacts/<flow>/ (Maestro's commands, device logs, failure screenshots).
# Keys are scrubbed from everything written there.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

platform="" device="" variant=devnet suite=smoke metro_port="" out="" only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform="$2"; shift ;;
    --device) device="$2"; shift ;;
    --variant) variant="$2"; shift ;;
    --suite) suite="$2"; shift ;;
    --metro-port) metro_port="$2"; shift ;;
    --out) out="$2"; shift ;;
    --only) only="$2"; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "run.sh: $*" >&2; exit 2; }
case "$platform" in ios|android) ;; *) die "--platform ios|android is required" ;; esac
[ -n "$device" ] || die "--device is required"
case "$suite" in smoke|full) ;; *) die "--suite must be smoke or full" ;; esac
case "$variant" in
  devnet) app_id=pr.yap.app.dev; scheme=yappr-dev ;;
  testnet) app_id=pr.yap.app.beta; scheme=yappr-beta ;;
  production) app_id=pr.yap.app; scheme=yappr ;;
  *) die "--variant must be devnet, testnet or production" ;;
esac
# The full suite writes: only ever to sakura, with pool personas.
[ "$suite" = full ] && [ "$variant" != devnet ] && die "the full suite writes, so it runs on the devnet variant (sakura) only"

maestro="${MAESTRO_BIN:-$(command -v maestro || echo "$HOME/.maestro/bin/maestro")}"
[ -x "$maestro" ] || die "maestro not found (install it, or set MAESTRO_BIN)"
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true

out="${out:-$here/out/$platform-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$out"/{junit,screenshots,logs,artifacts}
out="$(cd "$out" && pwd)"
run_id="$(date +%s | tail -c 7)$RANDOM"

# Per-variant read fixtures for the smoke flows (public data only).
case "$variant" in
  devnet) query=sigrid; tag=maestro; profile_id=EoAQ31GmTg9zdPz6qmXmNwicxA1PCmh1vdXtzT179Pv7 ;;
  *) query=dash; tag=dash; profile_id="" ;;
esac

dev_client_url="" metro_url=""
if [ -n "$metro_port" ]; then
  metro_url="http://localhost:$metro_port"
  dev_client_url="$scheme://expo-development-client/?url=http%3A%2F%2Flocalhost%3A$metro_port"
  curl -sf --max-time 5 "http://localhost:$metro_port/status" | grep -q running || die "no Metro on localhost:$metro_port"
  if [ "$platform" = android ]; then
    adb="${ANDROID_HOME:+$ANDROID_HOME/platform-tools/}adb"
    "$adb" -s "$device" reverse "tcp:$metro_port" "tcp:$metro_port" >/dev/null || die "adb reverse failed"
  fi
fi

env_args=(-e "APP_ID=$app_id" -e "SCHEME=$scheme" -e "DEV_CLIENT_URL=$dev_client_url" -e "METRO_URL=$metro_url" -e "RUN=$run_id"
  -e "QUERY=$query" -e "TAG=$tag" -e "PROFILE_ID=$profile_id")

# --- Full suite: personas, keys, responder and peer ---------------------------------------------
tmp="" pids=() secrets=()
cleanup() {
  for pid in "${pids[@]+"${pids[@]}"}"; do kill "$pid" 2>/dev/null; done
  for pid in "${pids[@]+"${pids[@]}"}"; do wait "$pid" 2>/dev/null; done
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$suite" = full ]; then
  pool="${YAPPR_SAKURA_IDENTITIES:-}"
  [ -f "$pool" ] || die "YAPPR_SAKURA_IDENTITIES must name the sakura identities.json"
  persona="${E2E_PERSONA:-97}" peer_persona="${E2E_PEER_PERSONA:-96}"
  for p in "$persona" "$peer_persona"; do
    case "$p" in 9[0-8]) ;; *) die "personas must be 90-98 (99 holds proof posts and is never written with)" ;; esac
  done
  [ "$persona" != "$peer_persona" ] || die "E2E_PERSONA and E2E_PEER_PERSONA must differ"
  tmp="$(mktemp -d)"; chmod 700 "$tmp"

  # Public metadata only: identity ids and handles.
  meta() { node -e '
    const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).identities.find(x => x.personaIdx === Number(process.argv[2]));
    if (!p) { console.error(`persona ${process.argv[2]} is not in the pool`); process.exit(1); }
    console.log(`${p.identityId} ${(p.handle || "").replace(/\.dash$/, "")}`);' "$pool" "$1"; }
  read -r self_id _ <<<"$(meta "$persona")" || die "persona $persona not found"
  read -r peer_id peer_handle <<<"$(meta "$peer_persona")" || die "persona $peer_persona not found"

  # The keys: from the given files, else written from the pool (never printed).
  write_key() { # <persona> <auth|encryption> <file>
    local kit="${QA_ROOT:-/Users/pasta/workspace/yappr-mobile-qa}/bin/persona-key"
    if [ -x "$kit" ]; then
      "$kit" "$1" "$3" --purpose "$2" >/dev/null
    else
      (umask 077; node -e '
        const [file, idx, purpose, out] = process.argv.slice(1);
        const p = JSON.parse(require("fs").readFileSync(file, "utf8")).identities.find(x => x.personaIdx === Number(idx));
        const want = { auth: ["authentication", "high"], encryption: ["encryption", "medium"] }[purpose];
        const k = p && p.identityKeys.find(x => x.purpose.toLowerCase() === want[0] && x.securityLevel.toLowerCase() === want[1]);
        if (!k || !/^[0-9a-f]{64}$/i.test(k.privateKeyHex)) { console.error(`persona ${idx} has no ${want.join("/")} key`); process.exit(1); }
        require("fs").writeFileSync(out, k.privateKeyHex.toLowerCase(), { mode: 0o600 });' "$pool" "$1" "$2" "$3")
    fi
  }
  key_file="${E2E_KEY_FILE:-$tmp/auth}" dm_key_file="${E2E_DM_KEY_FILE:-$tmp/encryption}"
  [ -n "${E2E_KEY_FILE:-}" ] || write_key "$persona" auth "$key_file" || die "could not write the auth key"
  [ -n "${E2E_DM_KEY_FILE:-}" ] || write_key "$persona" encryption "$dm_key_file" || die "could not write the encryption key"
  auth_key="$(tr -d '\n\r ' <"$key_file")" dm_key="$(tr -d '\n\r ' <"$dm_key_file")"
  [ ${#auth_key} -ge 52 ] && [ ${#dm_key} -ge 52 ] || die "the key files must hold a WIF or 64-hex key"
  # Redacted from all output: each key, and the 16-character parts the flows type it in.
  secrets=("$auth_key" "$dm_key")
  for k in "$auth_key" "$dm_key"; do secrets+=("${k:0:16}" "${k:16:16}" "${k:32:16}"); done

  responder_addr="${E2E_RESPONDER_ADDR:-127.0.0.1:8789}" peer_addr="${E2E_PEER_ADDR:-127.0.0.1:8790}"
  wait_up() { # <url> <seconds> <name> <log>
    local i
    for ((i = 0; i < $2; i += 2)); do
      curl -sf --max-time 2 "$1" | grep -q '"ready":true\|"ok":true' && return 0
      sleep 2
    done
    echo "run.sh: $3 did not come up; see $4" >&2; return 1
  }
  if ! curl -sf --max-time 2 "http://$responder_addr/health" >/dev/null; then
    YAPPR_SAKURA_IDENTITIES="$pool" node "$repo/mobile/tools/test-wallet-responder.mjs" --serve "$responder_addr" \
      >"$out/logs/responder.log" 2>&1 &
    pids+=($!)
    wait_up "http://$responder_addr/health" 120 responder "$out/logs/responder.log" || exit 1
  fi
  (cd "$repo" && YAPPR_SAKURA_IDENTITIES="$pool" E2E_PEER_PERSONA="$peer_persona" E2E_PEER_ADDR="$peer_addr" \
    exec node_modules/.bin/vite-node --config mobile/engine/vitest.config.ts mobile/engine/harness/e2e-peer.ts) \
    >"$out/logs/peer.raw.log" 2>&1 &
  pids+=($!)
  wait_up "http://$peer_addr/health" 300 "peer (persona $peer_persona)" "$out/logs/peer.raw.log" || exit 1

  env_args+=(-e "SIGN_IN_KEY=$auth_key" -e "DM_KEY=$dm_key" -e "PERSONA=$persona" -e "SELF_ID=$self_id"
    -e "PEER_ID=$peer_id" -e "PEER_HANDLE=$peer_handle" -e "PEER_URL=http://$peer_addr" -e "RESPONDER_URL=http://$responder_addr")
fi

# Replace every key with [REDACTED] in a stream (keys come from the environment, never argv).
redact() { SECRETS="$(printf '%s\n' "${secrets[@]+"${secrets[@]}"}")" perl -pe '
  BEGIN { @s = grep { length } split /\n/, $ENV{SECRETS}; }
  for my $k (@s) { s/\Q$k\E/[REDACTED]/g }'; }
redact_tree() { # scrub text files in place; drop anything that still matches (binary)
  [ ${#secrets[@]} -gt 0 ] || return 0
  local f
  while IFS= read -r -d '' f; do
    if LC_ALL=C grep -Iq . "$f" 2>/dev/null; then redact <"$f" >"$f.tmp" && mv "$f.tmp" "$f"; fi
  done < <(find "$1" -type f -print0)
  for k in "${secrets[@]}"; do grep -rlF -- "$k" "$1" 2>/dev/null | while IFS= read -r f; do rm -f "$f"; done; done
}

# --- Flows -------------------------------------------------------------------------------------
flows=("$here"/flows/smoke/*.yaml)
[ "$suite" = full ] && flows+=("$here"/flows/full/*.yaml)

pass=0 fail=0 first=1 failed_names=()
echo "Maestro $suite suite: $platform $device, $variant, run $run_id -> $out"
for flow in "${flows[@]}"; do
  name="$(basename "$flow" .yaml)"
  [ -n "$only" ] && ! [[ "$name" =~ $only ]] && continue
  art="$out/artifacts/$name"
  reinstall=(--no-reinstall-driver); [ $first = 1 ] && reinstall=(); first=0
  start=$(date +%s)
  "$maestro" --device "$device" test "${reinstall[@]+"${reinstall[@]}"}" --format junit --output "$out/junit/$name.xml" \
    --test-output-dir "$art" "${env_args[@]}" "$flow" 2>&1 | redact >"$out/logs/$name.log"
  status=${PIPESTATUS[0]}
  secs=$(( $(date +%s) - start ))
  redact_tree "$art"; redact_tree "$out/junit"
  # Screenshots the flow took, plus Maestro's failure screenshot.
  while IFS= read -r -d '' shot; do
    cp "$shot" "$out/screenshots/$platform-$name-$(basename "$shot")"
  done < <(find "$art" -name '*.png' \( -path '*takeScreenshot*' -o -path '*screenshots*' \) -print0)
  if [ "$status" = 0 ]; then pass=$((pass + 1)); echo "  PASS $name (${secs}s)"
  else fail=$((fail + 1)); failed_names+=("$name"); echo "  FAIL $name (${secs}s): $(grep -m1 -E 'FAILED|Error' "$out/logs/$name.log" | cut -c1-160)"; fi
done
# Stop the responder and the peer (which deletes what it posted) before reading their logs.
cleanup; pids=()
[ -f "$out/logs/peer.raw.log" ] && grep '^\[e2e-peer\]' "$out/logs/peer.raw.log" >"$out/logs/peer.log"
rm -f "$out/logs/peer.raw.log"
redact_tree "$out/logs"

# One JUnit report for the run, and a summary.
python3 - "$out" "$platform" "$suite" <<'PY'
import glob, os, sys
import xml.etree.ElementTree as ET
out, platform, suite = sys.argv[1:4]
root = ET.Element('testsuites', name=f'yappr-mobile-{suite}-{platform}')
rows = []
for path in sorted(glob.glob(os.path.join(out, 'junit', '*.xml'))):
    try:
        tree = ET.parse(path).getroot()
    except ET.ParseError:
        continue
    for ts in ([tree] if tree.tag == 'testsuite' else tree.findall('testsuite')):
        ts.set('name', f'{platform}/{os.path.basename(path)[:-4]}')
        root.append(ts)
        for tc in ts.findall('testcase'):
            failed = tc.find('failure') is not None or tc.find('error') is not None
            rows.append((os.path.basename(path)[:-4], 'FAIL' if failed else 'PASS', tc.get('time', '')))
ET.ElementTree(root).write(os.path.join(out, 'junit.xml'), encoding='utf-8', xml_declaration=True)
with open(os.path.join(out, 'summary.md'), 'w') as f:
    passed = sum(1 for r in rows if r[1] == 'PASS')
    f.write(f'# Maestro {suite} suite, {platform}: {passed}/{len(rows)} passed\n\n| Flow | Result | Seconds |\n| --- | --- | --- |\n')
    for name, result, secs in rows:
        f.write(f'| {name} | {result} | {secs} |\n')
PY
echo "Result: $pass passed, $fail failed${failed_names[*]:+ (${failed_names[*]})}. Report: $out/summary.md"
[ "$fail" = 0 ]
