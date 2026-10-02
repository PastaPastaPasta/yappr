#!/bin/sh
# Upload PR screenshots to the orphan `mobile/evidence` branch.
# usage: upload-evidence.sh <evidence-id> <src-dir>
#   Copies *.png (resized to 700px; files named *side-by-side* to 1600px) and *.md/*.txt
#   into <evidence-id>/ on the branch, commits and pushes (serialized with a lock).
# Prints the raw URL prefix to use in PR bodies:
#   https://raw.githubusercontent.com/PastaPastaPasta/yappr/mobile/evidence/<evidence-id>/<file>
# Run with dangerouslyDisableSandbox: true.
set -eu
ID="$1"; SRC="$2"
REPO=/tmp/claude/yappr-mobile/evidence-repo
LOCK=/tmp/claude/yappr-mobile/evidence.lock
i=0
until mkdir "$LOCK" 2>/dev/null; do i=$((i+1)); [ $i -gt 120 ] && { echo "lock timeout" >&2; exit 1; }; sleep 2; done
trap 'rmdir "$LOCK"' EXIT
cd "$REPO"
timeout 90 git pull -q --rebase origin mobile/evidence || true
mkdir -p "$ID"
for f in "$SRC"/*.png; do
  [ -e "$f" ] || continue
  b=$(basename "$f")
  case "$b" in *side-by-side*) sips -Z 1600 "$f" --out "$ID/$b" >/dev/null ;; *) sips -Z 700 "$f" --out "$ID/$b" >/dev/null ;; esac
done
for f in "$SRC"/*.md "$SRC"/*.txt; do [ -e "$f" ] && cp "$f" "$ID/"; done
git add "$ID"
git commit -q -m "chore: evidence for $ID

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" || true
n=0
until timeout 120 git push -q origin mobile/evidence; do n=$((n+1)); [ $n -gt 3 ] && exit 1; timeout 90 git pull -q --rebase origin mobile/evidence; done
echo "https://raw.githubusercontent.com/PastaPastaPasta/yappr/mobile/evidence/$ID/"
