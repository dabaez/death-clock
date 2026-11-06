#!/usr/bin/env bash
# Publishes the Death Clock to the droplet. deploy.yml runs this, and so can
# you from your own machine:
#
#   DEPLOY_TARGET=deathclock-deploy scripts/ship.sh           # upload; the droplet builds it
#   DEPLOY_TARGET=deathclock-deploy scripts/ship.sh rollback  # previous release goes live
#   DEPLOY_TARGET=deathclock-deploy scripts/ship.sh releases  # list releases, * is live
#   DEPLOY_TARGET=deathclock-deploy scripts/ship.sh backup    # back up the database now
#
# DEPLOY_TARGET is deathclock@<droplet> or a Host alias from ~/.ssh/config. On
# the droplet the key can only run receive-site (dabaez/droplet-infra), which
# builds the upload with deploy/build and restarts
# deploy/systemd/deathclock.service.
set -euo pipefail

TARGET="${DEPLOY_TARGET:?set DEPLOY_TARGET, e.g. deathclock@<droplet> or an ssh config alias}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

remote() {
  ssh -o BatchMode=yes "$TARGET" "$@"
}

case "${1:-}" in
"") ;;
rollback | releases)
  remote "$1"
  exit
  ;;
activate)
  remote activate "${2:?usage: ship.sh activate <release-id>}"
  exit
  ;;
backup)
  remote start deathclock-backup.service
  exit
  ;;
*)
  echo "usage: ship.sh [rollback | releases | activate <release-id> | backup]" >&2
  exit 1
  ;;
esac

# A release is a commit: refuse rather than silently leave uncommitted
# changes out.
if [ -n "$(git status --porcelain)" ]; then
  echo "uncommitted changes; commit or stash them before shipping:" >&2
  git status --short >&2
  exit 1
fi

id="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
echo "--- shipping $id to $TARGET (the droplet builds it)"
# receive-site builds source shipped under app/ (deploy/build).
git archive --format=tar.gz --prefix=app/ HEAD | remote deploy "$id"
