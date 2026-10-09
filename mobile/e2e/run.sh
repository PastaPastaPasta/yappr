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
#   E2E_PEER_PERSONA         the second persona, driven by the engine in Node (default 98)
#   E2E_KEY_FILE             optional: a file holding E2E_PERSONA's AUTHENTICATION/HIGH key
#   E2E_DM_KEY_FILE          optional: a file holding its ENCRYPTION key
#                            Without them, the keys are written from the pool into a private
#                            temp dir ($QA_ROOT/bin/persona-key from the QA kit when QA_ROOT is
#                            set, else a local equivalent) and deleted on exit.
#   E2E_RESPONDER_ADDR       the test-wallet responder (default 127.0.0.1:8789; refused if taken)
#   E2E_PEER_ADDR            the peer harness (default 127.0.0.1:8790)
#   E2E_BRIDGE_ADDR          the QR bridge, which reads the wallet QR off this device (default 127.0.0.1:8791)
#   E2E_STOP_TIMEOUT         seconds the services get to stop, the peer to delete its posts (default 300)
#   Use a different persona pair and ports per device when running devices in parallel.
#   The keys reach Maestro as MAESTRO_SIGN_IN_KEY_1..4 / MAESTRO_DM_KEY_1..4 environment
#   variables, never on a command line, and are scrubbed from everything written (also
#   from what Maestro keeps under ~/.maestro/tests), as are every key the pool holds for both
#   personas (the peer and the responder hold those).
#
# Interrupts (Ctrl-C, CI cancels: SIGINT/SIGTERM) stop Maestro and the services at once and
# scrub everything. Only a run whose scrub finished leaves <out>/scrubbed: upload nothing
# from a run without it, and never *.raw.log.
#
# Output: junit.xml (all flows), junit/<flow>.xml, summary.md, screenshots/<platform>-<flow>-<name>.png,
# logs/<flow>.log, artifacts/<flow>/ (Maestro's commands, device logs, failure screenshots).
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
    -h|--help) sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
# Each flow starts Maestro's driver again. On a loaded host the iOS XCTest driver can take
# longer than Maestro's 120 s default to come up (the previous flow's xcodebuild is often
# still collecting simulator diagnostics), which fails the flow before its first step.
export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-300000}"

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

# --- Cleanup: Maestro, services, redaction ------------------------------------------------------
# A private dir for this run: key files, the Maestro output pipe, the scrub marker (0700).
tmp="$(mktemp -d)"; chmod 700 "$tmp"
marker="$tmp/started"; touch "$marker"
rm -f "$out/scrubbed"
pids=() secrets=() art="" maestro_pid="" redact_pid=""

# Wait up to <seconds> for <pid>s to exit, then SIGKILL what is left. bash 3.2 has no wait -t.
await_exit() { # <seconds> <pid>...
  local limit=$(( $1 * 2 )) i pid alive; shift
  for ((i = 0; i < limit; i++)); do
    alive=0
    for pid in "$@"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ $alive = 0 ] && break
    sleep 0.5
  done
  for pid in "$@"; do
    if kill -0 "$pid" 2>/dev/null; then echo "run.sh: process $pid did not stop in time; killing it" >&2; kill -KILL "$pid" 2>/dev/null; fi
    wait "$pid" 2>/dev/null
  done
  return 0
}
# Maestro (and what it started: the iOS driver's xcodebuild, adb) first, then its log writer.
stop_maestro() {
  if [ -n "$maestro_pid" ]; then
    pkill -TERM -P "$maestro_pid" 2>/dev/null; kill -TERM "$maestro_pid" 2>/dev/null
    await_exit 5 "$maestro_pid"
  fi
  [ -n "$redact_pid" ] && await_exit 5 "$redact_pid"
  maestro_pid="" redact_pid=""
}
# The responder, the peer (which deletes what it posted) and the bridge, in E2E_STOP_TIMEOUT.
stop_services() {
  [ ${#pids[@]} -gt 0 ] || return 0
  local pid
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null; done
  await_exit "${E2E_STOP_TIMEOUT:-300}" "${pids[@]}"
  pids=()
}

# Replace every key, and every part a flow types, with [REDACTED] in a stream. The keys reach
# perl through its environment, never its argv.
secrets_env() { printf '%s\n' "${secrets[@]+"${secrets[@]}"}"; }
redact() { SECRETS="$(secrets_env)" perl -pe '
  BEGIN { @s = sort { length($b) <=> length($a) } grep { length } split /\n/, $ENV{SECRETS}; }
  for my $k (@s) { s/\Q$k\E/[REDACTED]/g }'; }
redact_tree() { # scrub text files in place; delete anything that still holds a key (binary files)
  [ ${#secrets[@]} -gt 0 ] && [ -e "$1" ] || return 0
  local f
  while IFS= read -r -d '' f; do
    if LC_ALL=C grep -Iq . "$f" 2>/dev/null; then redact <"$f" >"$f.tmp" && mv "$f.tmp" "$f"; fi
  done < <(find "$1" -type f -print0)
  # File names on stdin, keys in the environment: neither on a command line.
  find "$1" -type f -print0 | SECRETS="$(secrets_env)" perl -0ne '
    BEGIN { @s = grep { length } split /\n/, $ENV{SECRETS}; $/ = "\0"; }
    chomp; my $f = $_; open(my $h, "<:raw", $f) or next; local $/; my $c = <$h>; close $h;
    for my $k (@s) { if (index($c, $k) >= 0) { unlink $f; last } }'
}
# Maestro also logs every typed value under ~/.maestro/tests: scrub what this run wrote there.
scrub_maestro_home() {
  [ -n "$marker" ] && [ -d "$HOME/.maestro/tests" ] || return 0
  local d
  while IFS= read -r -d '' d; do redact_tree "$d"; done \
    < <(find "$HOME/.maestro/tests" -mindepth 1 -maxdepth 1 -type d -newer "$marker" -print0)
}
# On iOS every maestro call leaves a ~225 MB copy of its XCTest runner in $TMPDIR and never removes
# it; a few runs fill the disk. Remove the copies made since the last snapshot (not another run's).
maestro_tmp_dirs() {
  find "${TMPDIR:-/tmp}" -mindepth 1 -maxdepth 1 -type d -name 'maestro_xctestrunner_xcodebuild_output*' 2>/dev/null | sort
}
maestro_tmp_before=""
prune_maestro_tmp() {
  local d
  comm -13 <(printf '%s\n' "$maestro_tmp_before") <(maestro_tmp_dirs) | while IFS= read -r d; do
    [ -n "$d" ] && rm -rf "$d"
  done
}
# On every exit (Ctrl-C and CI cancels included). Signals are held off meanwhile, so a second
# one can't cut the scrub short. What Maestro wrote is scrubbed first (a CI cancel kills the
# job about 10 s after its SIGINT); the services may take longer (the peer deletes its posts).
# <out>/scrubbed marks a run whose output is safe to read.
finish() {
  trap '' INT TERM
  stop_maestro
  [ -n "$art" ] && redact_tree "$art"
  scrub_maestro_home; redact_tree "$out/junit"; prune_maestro_tmp
  # The flows' logs now; the services' only once they stopped (a scrub replaces the file,
  # and a service still writing would keep writing to the old one).
  local f
  for f in "$out"/logs/*.log; do
    case "${f##*/}" in responder.log | qr-bridge.log | peer.raw.log) ;; *) redact_tree "$f" ;; esac
  done
  stop_services
  if [ -f "$out/logs/peer.raw.log" ]; then
    grep '^\[e2e-peer\]' "$out/logs/peer.raw.log" >"$out/logs/peer.log"
    rm -f "$out/logs/peer.raw.log"
  fi
  redact_tree "$out/logs"
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
  tmp="" marker=""
  : >"$out/scrubbed"
  trap 'exit 130' INT; trap 'exit 143' TERM
}
trap finish EXIT
trap 'exit 130' INT; trap 'exit 143' TERM

if [ "$suite" = full ]; then
  pool="${YAPPR_SAKURA_IDENTITIES:-}"
  [ -f "$pool" ] || die "YAPPR_SAKURA_IDENTITIES must name the sakura identities.json"
  # 97 and 98 by default: the engine's write suite uses 92-96 (mobile/engine/test/contract/write/slots.json).
  persona="${E2E_PERSONA:-97}" peer_persona="${E2E_PEER_PERSONA:-98}"
  for p in "$persona" "$peer_persona"; do
    case "$p" in 9[0-8]) ;; *) die "personas must be 90-98 (99 holds proof posts and is never written with)" ;; esac
  done
  [ "$persona" != "$peer_persona" ] || die "E2E_PERSONA and E2E_PEER_PERSONA must differ"
  # Every key the pool holds for both personas, in each form a log could show: redacted too
  # (the peer and the responder hold them). Through a pipe, never argv.
  while IFS= read -r value; do [ -n "$value" ] && secrets+=("$value"); done \
    < <(node "$here/host/persona-secrets.mjs" "$pool" "$persona" "$peer_persona")
  [ ${#secrets[@]} -gt 0 ] || die "no keys for personas $persona and $peer_persona in the pool"

  # Public metadata only: identity ids and handles.
  meta() { node -e '
    const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).identities.find(x => x.personaIdx === Number(process.argv[2]));
    if (!p || !p.identityId || !p.handle) { console.error(`persona ${process.argv[2]} is not in the pool`); process.exit(1); }
    console.log(`${p.identityId} ${p.handle.replace(/\.dash$/, "")}`);' "$pool" "$1"; }
  read -r self_id self_handle <<<"$(meta "$persona")"
  read -r peer_id peer_handle <<<"$(meta "$peer_persona")"
  [ -n "${self_handle:-}" ] || die "persona $persona is not in the pool"
  [ -n "${peer_handle:-}" ] || die "persona $peer_persona is not in the pool"

  # The keys: from the given files, else written from the pool (never printed).
  write_key() { # <persona> <auth|encryption> <file>
    local kit="${QA_ROOT:+$QA_ROOT/bin/persona-key}"
    if [ -n "$kit" ] && [ -x "$kit" ]; then
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

  responder_addr="${E2E_RESPONDER_ADDR:-127.0.0.1:8789}" peer_addr="${E2E_PEER_ADDR:-127.0.0.1:8790}"
  wait_up() { # <url> <seconds> <name> <log> <pid>
    local i
    for ((i = 0; i < $2; i += 2)); do
      curl -sf --max-time 2 "$1" | grep -q '"ready":true\|"ok":true' && return 0
      kill -0 "$5" 2>/dev/null || { echo "run.sh: $3 exited; see $4" >&2; return 1; }
      sleep 2
    done
    echo "run.sh: $3 did not come up; see $4" >&2; return 1
  }
  # Each run starts (and stops) its own responder: one already on the port is refused, never
  # reused, so a run never stops a responder it didn't start (another run's, a QA one).
  curl -s --max-time 2 "http://$responder_addr/health" >/dev/null && die "something already listens on $responder_addr (E2E_RESPONDER_ADDR)"
  YAPPR_SAKURA_IDENTITIES="$pool" node "$repo/mobile/tools/test-wallet-responder.mjs" --serve "$responder_addr" \
    >"$out/logs/responder.log" 2>&1 &
  pids+=($!)
  wait_up "http://$responder_addr/health" 120 responder "$out/logs/responder.log" "$!" || exit 1
  # The peer is signed in as a persona: never reuse one (it could be another persona's).
  curl -s --max-time 2 "http://$peer_addr/health" >/dev/null && die "something already listens on $peer_addr (E2E_PEER_ADDR)"
  (cd "$repo" && YAPPR_SAKURA_IDENTITIES="$pool" E2E_PEER_PERSONA="$peer_persona" E2E_PEER_ADDR="$peer_addr" \
    exec node_modules/.bin/vite-node --config mobile/engine/vitest.config.ts mobile/engine/harness/e2e-peer.ts) \
    >"$out/logs/peer.raw.log" 2>&1 &
  pids+=($!)
  wait_up "http://$peer_addr/health" 420 "peer (persona $peer_persona)" "$out/logs/peer.raw.log" "$!" || exit 1
  curl -sf --max-time 2 "http://$peer_addr/health" | grep -q "\"identityId\":\"$peer_id\"" || die "the peer on $peer_addr is not persona $peer_persona"

  # Release builds show the wallet link only as a QR code: the bridge reads it off this
  # device's screen (macOS: Core Image) and hands it to the responder. Bound to this
  # device, so never reused.
  bridge_addr="${E2E_BRIDGE_ADDR:-127.0.0.1:8791}"
  curl -s --max-time 2 "http://$bridge_addr/health" >/dev/null && die "something already listens on $bridge_addr (E2E_BRIDGE_ADDR)"
  node "$here/host/qr-bridge.mjs" --platform "$platform" --device "$device" --listen "$bridge_addr" \
    --responder "http://$responder_addr" >"$out/logs/qr-bridge.log" 2>&1 &
  pids+=($!)
  wait_up "http://$bridge_addr/health" 300 "QR bridge" "$out/logs/qr-bridge.log" "$!" || exit 1

  # Each key goes to Maestro in four parts (iOS can drop characters from one long input
  # into a secure field), through MAESTRO_* variables, which Maestro reads from its
  # environment: never on a command line. Exported only now, so the services don't inherit them.
  for k in SIGN_IN_KEY:"$key_file" DM_KEY:"$dm_key_file"; do
    value="$(tr -d '\n\r ' <"${k#*:}")"
    [ ${#value} -ge 52 ] || die "${k%%:*}: the key file must hold a WIF or a 64-hex key"
    part=$(( (${#value} + 3) / 4 ))
    secrets+=("$value")
    for i in 1 2 3 4; do
      chunk="${value:$(( (i - 1) * part )):$part}"
      secrets+=("$chunk")
      export "MAESTRO_${k%%:*}_$i=$chunk"
    done
  done
  unset value chunk

  env_args+=(-e "PERSONA=$persona" -e "SELF_ID=$self_id" -e "SELF_HANDLE=$self_handle"
    -e "PEER_ID=$peer_id" -e "PEER_HANDLE=$peer_handle" -e "PEER_URL=http://$peer_addr" -e "BRIDGE_URL=http://$bridge_addr")
fi

# --- Flows -------------------------------------------------------------------------------------
flows=()
for flow in "$here"/flows/smoke/*.yaml; do flows+=("$flow"); done
if [ "$suite" = full ]; then for flow in "$here"/flows/full/*.yaml; do flows+=("$flow"); done; fi
if [ -n "$only" ]; then
  picked=()
  for flow in "${flows[@]}"; do [[ "$(basename "$flow" .yaml)" =~ $only ]] && picked+=("$flow"); done
  [ ${#picked[@]} -gt 0 ] || die "--only '$only' matches no flow"
  flows=("${picked[@]}")
fi

# Maestro runs in the background and its output reaches the log through a pipe and redact, so
# an INT or TERM is handled at once (bash holds a trap until a foreground command ends).
fifo="$tmp/maestro.out"; mkfifo "$fifo"
pass=0 fail=0 first=1 failed_names=()
: >"$out/status.txt"
echo "Maestro $suite suite: $platform $device, $variant, run $run_id -> $out"
for flow in "${flows[@]}"; do
  name="$(basename "$flow" .yaml)"
  art="$out/artifacts/$name"
  reinstall=(--no-reinstall-driver); [ $first = 1 ] && reinstall=(); first=0
  start=$(date +%s)
  maestro_tmp_before="$(maestro_tmp_dirs)"
  redact <"$fifo" >"$out/logs/$name.log" &
  redact_pid=$!
  "$maestro" --device "$device" test "${reinstall[@]+"${reinstall[@]}"}" --format junit --output "$out/junit/$name.xml" \
    --test-output-dir "$art" --debug-output "$art/debug" "${env_args[@]}" "$flow" >"$fifo" 2>&1 &
  maestro_pid=$!
  wait "$maestro_pid"; status=$?
  wait "$redact_pid"
  maestro_pid="" redact_pid=""
  secs=$(( $(date +%s) - start ))
  redact_tree "$art"; redact_tree "$out/junit"; scrub_maestro_home; prune_maestro_tmp
  # Screenshots the flow took, plus Maestro's failure screenshot.
  while IFS= read -r -d '' shot; do
    cp "$shot" "$out/screenshots/$platform-$name-$(basename "$shot")"
  done < <(find "$art" -name '*.png' \( -path '*takeScreenshot*' -o -path '*screenshots*' \) -print0)
  if [ "$status" = 0 ]; then
    pass=$((pass + 1)); echo "$name PASS $secs" >>"$out/status.txt"; echo "  PASS $name (${secs}s)"
  else
    fail=$((fail + 1)); failed_names+=("$name"); echo "$name FAIL $secs" >>"$out/status.txt"
    echo "  FAIL $name (${secs}s): $(grep -m1 -E '\[Failed\]|FAILED|Error' "$out/logs/$name.log" | cut -c1-200)"
  fi
done
art=""
# Stop the responder and the peer (which deletes what it posted) before reading their logs.
finish

# One JUnit report for the run, and a summary. The flow statuses are the truth: a flow whose
# JUnit file is missing or unreadable is reported as failed.
python3 - "$out" "$platform" "$suite" <<'PY'
import os, sys
import xml.etree.ElementTree as ET
out, platform, suite = sys.argv[1:4]
root = ET.Element('testsuites', name=f'yappr-mobile-{suite}-{platform}')
rows = []
with open(os.path.join(out, 'status.txt')) as status:
    for line in status:
        name, result, secs = line.split()
        rows.append((name, result, secs))
        suites = []
        try:
            tree = ET.parse(os.path.join(out, 'junit', f'{name}.xml')).getroot()
            suites = [tree] if tree.tag == 'testsuite' else tree.findall('testsuite')
        except (OSError, ET.ParseError):
            pass
        if not suites:
            ts = ET.Element('testsuite', name=name, tests='1', failures='1' if result == 'FAIL' else '0')
            tc = ET.SubElement(ts, 'testcase', name=name, time=secs)
            if result == 'FAIL':
                ET.SubElement(tc, 'failure', message='The flow failed and left no JUnit report; see logs/' + name + '.log')
            suites = [ts]
        for ts in suites:
            ts.set('name', f'{platform}/{name}')
            root.append(ts)
ET.ElementTree(root).write(os.path.join(out, 'junit.xml'), encoding='utf-8', xml_declaration=True)
with open(os.path.join(out, 'summary.md'), 'w') as f:
    passed = sum(1 for r in rows if r[1] == 'PASS')
    f.write(f'# Maestro {suite} suite, {platform}: {passed}/{len(rows)} passed\n\n| Flow | Result | Seconds |\n| --- | --- | --- |\n')
    for name, result, secs in rows:
        f.write(f'| {name} | {result} | {secs} |\n')
PY
echo "Result: $pass passed, $fail failed${failed_names[*]:+ (${failed_names[*]})}. Report: $out/summary.md"
[ "$fail" = 0 ]
