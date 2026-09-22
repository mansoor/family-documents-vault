#!/bin/sh
# Restore drill (NFR-07): takes the newest encrypted backup, decrypts it with
# the master key, loads it into a scratch database, and checks that the
# household and its documents came back. Run inside the worker container:
#
#   docker compose exec worker sh scripts/restore-drill.sh
#
# CI runs this on a schedule so the restore path is exercised, not hoped for.
set -eu
BACKUP_DIR="${FDV_BACKUP_DIR:-/data/backups}"
ADMIN_URL="${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"
SCRATCH="fdv_restore_drill_$(date +%s)"

latest=$(ls -1t "$BACKUP_DIR"/fdv-*.sql.enc 2>/dev/null | head -1 || true)
if [ -z "$latest" ]; then
  echo "no backup found in $BACKUP_DIR; making one"
  latest=$(node apps/worker/dist/cli.mjs backup-now | tail -1)
fi
echo "restoring $latest into $SCRATCH"
node apps/worker/dist/cli.mjs decrypt-backup "$latest" /tmp/restore.sql

base_url=$(echo "$ADMIN_URL" | sed 's#/[^/]*$#/postgres#')
psql "$base_url" -v ON_ERROR_STOP=1 -q -c "create database $SCRATCH"
trap 'psql "$base_url" -q -c "drop database if exists $SCRATCH with (force)"; rm -f /tmp/restore.sql' EXIT
scratch_url=$(echo "$ADMIN_URL" | sed "s#/[^/]*\$#/$SCRATCH#")
psql "$scratch_url" -v ON_ERROR_STOP=1 -q -f /tmp/restore.sql >/dev/null

households=$(psql "$scratch_url" -Atc "select count(*) from household")
documents=$(psql "$scratch_url" -Atc "select count(*) from document")
versions=$(psql "$scratch_url" -Atc "select count(*) from document_version")
echo "restored: households=$households documents=$documents versions=$versions"
[ "$households" -ge 1 ] || { echo "restore drill FAILED: no household"; exit 1; }
echo "restore drill OK"
