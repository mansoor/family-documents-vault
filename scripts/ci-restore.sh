#!/bin/sh
# The README's restore, start to finish, against a running stack with a
# household in it: back up, run the drill, lose the database, restore it
# the way the README says, and sign back in. CI runs it after the
# end-to-end tests.
#
# It DELETES the stack's database volume. Point it at a throwaway stack
# only, never at a vault you use:
#
#   COMPOSE="docker compose -p scratch" PROJECT=scratch BASE=http://localhost:8099 \
#     sh scripts/ci-restore.sh
set -eu
COMPOSE=${COMPOSE:-docker compose}
PROJECT=${PROJECT:-fdv}
BASE=${BASE:-http://localhost:8080}
EMAIL=${FDV_E2E_EMAIL:-e2e-owner@example.test}
PASSWORD=${FDV_E2E_PASSWORD:-correct horse battery staple}

field() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }
titles() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).items.map((d)=>d.title).sort().join("|")))'; }
sign_in() {
  curl -sf -X POST "$BASE/api/v1/auth/password" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | field access_token
}
documents() { curl -sf "$BASE/api/v1/documents" -H "authorization: Bearer $1" | titles; }
worker_cli() { $COMPOSE exec -T worker node apps/worker/dist/cli.mjs "$@"; }

echo "== the family's vault, before"
token=$(sign_in)
curl -sf -X POST "$BASE/api/v1/documents" -H "authorization: Bearer $token" \
  -H 'content-type: application/json' -d '{"title":"Kept through a restore"}' > /dev/null
before=$(documents "$token")
echo "documents: $before"

echo "== a backup, and the drill"
worker_cli backup-now
$COMPOSE exec -T worker sh scripts/restore-drill.sh

echo "== a restore never goes over a vault that is running"
set +e
worker_cli restore-backup latest
code=$?
set -e
[ "$code" -eq 3 ] || { echo "expected the restore to refuse (exit 3), got $code"; exit 1; }

echo "== the database is lost"
$COMPOSE down
docker volume rm "${PROJECT}_db-data"

echo "== restored, as the README says"
$COMPOSE up -d --wait postgres
$COMPOSE run --rm --no-deps -T worker node apps/worker/dist/cli.mjs restore-backup latest
$COMPOSE up -d --wait

echo "== everybody signs in again, and everything is there"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/documents" -H "authorization: Bearer $token")
[ "$code" = "401" ] || { echo "a session from before the restore still works ($code)"; exit 1; }
token=$(sign_in)
after=$(documents "$token")
echo "documents: $after"
[ "$after" = "$before" ] || { echo "the documents differ after the restore"; exit 1; }
curl -sf "$BASE/api/v1/capabilities" | grep -q '"setup_required":false'
echo "restore OK"
