#!/bin/bash
set -euo pipefail

# Configuration from environment
REPO_URL="${REPO_URL:-https://github.com/PastaPastaPasta/yappr.git}"
BRANCH="${BRANCH:-master}"
BUILD_DIR_REL="${BUILD_DIR_REL:-out}"
IPNS_KEY="${IPNS_KEY:-yappr-latest}"
POLL_SECONDS="${POLL_SECONDS:-300}"
IPFS_API="${IPFS_API:-/dns/ipfs/tcp/5001}"

WORKDIR="${WORKDIR:-/work}"
REPO_DIR="$WORKDIR/repo"
LAST_COMMIT_FILE="$WORKDIR/.last_commit"

log() {
  echo "[$(date -Iseconds)] $*"
}

wait_for_ipfs() {
  local max_attempts=30
  local attempt=0
  log "Waiting for IPFS daemon (max ${max_attempts} attempts)..."
  until ipfs --api="$IPFS_API" id >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then
      log "ERROR: IPFS daemon not ready after ${max_attempts} attempts (API: $IPFS_API)"
      exit 1
    fi
    sleep 2
  done
  log "IPFS daemon is ready"
}

ensure_ipns_key() {
  log "Checking for IPNS key: $IPNS_KEY"
  # key list outputs one key name per line
  if ! ipfs --api="$IPFS_API" key list | grep -Fxq "$IPNS_KEY"; then
    log "Creating IPNS key: $IPNS_KEY"
    ipfs --api="$IPFS_API" key gen "$IPNS_KEY"
  fi
  # key list -l outputs "<ID> <name>" per line, match name in second column
  IPNS_ID=$(ipfs --api="$IPFS_API" key list -l | awk -v key="$IPNS_KEY" '$2 == key {print $1}')
  log "IPNS key ID: $IPNS_ID"
}

clone_or_pull() {
  if [ -d "$REPO_DIR/.git" ]; then
    log "Pulling latest changes..."
    cd "$REPO_DIR"
    git fetch origin "$BRANCH"
    git reset --hard "origin/$BRANCH"
  else
    log "Cloning repository..."
    mkdir -p "$WORKDIR"
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
  fi
}

get_current_commit() {
  cd "$REPO_DIR"
  git rev-parse HEAD
}

get_last_built_commit() {
  if [ -f "$LAST_COMMIT_FILE" ]; then
    cat "$LAST_COMMIT_FILE"
  else
    echo ""
  fi
}

save_commit() {
  echo "$1" > "$LAST_COMMIT_FILE"
}

build_project() {
  log "Installing dependencies..."
  cd "$REPO_DIR"
  npm ci --loglevel=warn

  log "Building project..."
  npm run build --loglevel=warn

  if [ ! -d "$REPO_DIR/$BUILD_DIR_REL" ]; then
    log "ERROR: Build directory $BUILD_DIR_REL not found!"
    return 1
  fi

  log "Build complete"
}

publish_to_ipfs() {
  local build_dir="$REPO_DIR/$BUILD_DIR_REL"

  log "Adding to IPFS..."
  CID=$(ipfs --api="$IPFS_API" add -r -Q --cid-version=1 "$build_dir")
  log "Added with CID: $CID"

  log "Pinning CID..."
  ipfs --api="$IPFS_API" pin add "$CID" >/dev/null

  log "Publishing to IPNS..."
  ipfs --api="$IPFS_API" name publish --key="$IPNS_KEY" "/ipfs/$CID" >/dev/null

  log ""
  log "=========================================="
  log "Published!"
  log "=========================================="
  log "Latest CID : /ipfs/$CID"
  log "Latest IPNS: /ipns/$IPNS_ID"
  log ""
  log "Access via public gateway:"
  log "  https://ipfs.io/ipfs/$CID/"
  log "  https://dweb.link/ipfs/$CID/"
  log "=========================================="
  log ""
}

main() {
  log "Starting Yappr IPFS Publisher"
  log "Repository: $REPO_URL"
  log "Branch: $BRANCH"
  log "Poll interval: ${POLL_SECONDS}s"

  wait_for_ipfs
  ensure_ipns_key

  while true; do
    clone_or_pull

    CURRENT_COMMIT=$(get_current_commit)
    LAST_COMMIT=$(get_last_built_commit)

    if [ "$CURRENT_COMMIT" != "$LAST_COMMIT" ]; then
      log "New commit detected: $CURRENT_COMMIT"
      log "Previous commit: ${LAST_COMMIT:-<none>}"

      if build_project; then
        publish_to_ipfs
        save_commit "$CURRENT_COMMIT"
      else
        log "Build failed, will retry next poll"
      fi
    else
      log "No new commits (at $CURRENT_COMMIT)"
    fi

    log "Sleeping for ${POLL_SECONDS}s..."
    sleep "$POLL_SECONDS"
  done
}

main
