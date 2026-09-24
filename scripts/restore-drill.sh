#!/bin/sh
# Restore drill (NFR-07): restores the newest encrypted backup (or the one
# named) into a scratch database, checks it the way the vault will read it —
# as the application role, through row-level security — and drops it again.
# Run inside the worker container:
#
#   docker compose exec worker sh scripts/restore-drill.sh
#
# CI runs it against a backup of the end-to-end stack on every push.
set -eu
exec node apps/worker/dist/cli.mjs restore-drill "$@"
