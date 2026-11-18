#!/bin/bash
# smoke.sh — start the entry server, hammer the REST surface with curl, report pass/fail lines.
# Standalone mode: skips the env lifecycle (no MAKEFUN_ENV_URL needed) — the suite's lifecycle
# is exercised by grade-local; this script checks the API surface alone.
set -u
cd "$(dirname "$0")"
node --experimental-strip-types -e "
import('./app.ts').then(({createApp}) => {
  const srv = createApp();
  srv.listen(0, () => console.log('listening on port ' + srv.address().port));
  process.on('SIGTERM', () => { srv.close(); process.exit(0); });
});
" > /tmp/entry.log 2>&1 &
SRV=$!
sleep 0.6
# find the port from the log
PORT=$(grep -o 'listening on port [0-9]*' /tmp/entry.log | grep -o '[0-9]*')
if [ -z "$PORT" ]; then echo "NO PORT; log:"; cat /tmp/entry.log; kill $SRV 2>/dev/null; exit 1; fi
B="http://127.0.0.1:$PORT/api/v3"
H="Authorization: Bearer t"
P=0; F=0
chk() { # chk <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then P=$((P+1)); else F=$((F+1)); echo "FAIL: $1 (want $2 got $3)"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }

chk "healthz" 200 "$(code http://127.0.0.1:$PORT/healthz)"
chk "root" 200 "$(code $B/ -H "$H")"
chk "root no-auth" 401 "$(code $B/)"
chk "meta" 200 "$(code $B/meta -H "$H")"
chk "create repo" 201 "$(code -X POST $B/user/repos -H "$H" -H 'content-type: application/json' -d '{"name":"demo","private":true,"description":"d1"}')"
chk "get repo" 200 "$(code $B/repos/forge-user/demo -H "$H")"
chk "get missing repo" 404 "$(code $B/repos/forge-user/nope -H "$H")"
chk "foreign owner 404" 404 "$(code $B/repos/other/demo -H "$H")"
chk "patch repo" 200 "$(code -X PATCH $B/repos/forge-user/demo -H "$H" -H 'content-type: application/json' -d '{"description":"d2"}')"
D=$(body $B/repos/forge-user/demo -H "$H" | grep -o '"description": "d2"')
chk "patch persisted" 1 "$([ -n "$D" ] && echo 1 || echo 0)"
chk "put contents" 201 "$(code -X PUT "$B/repos/forge-user/demo/contents/a.txt" -H "$H" -H 'content-type: application/json' -d '{"message":"m","content":"aGVsbG8=","branch":"main"}')"
SHA=$(body "$B/repos/forge-user/demo/contents/a.txt" -H "$H" | grep -o '"sha": "[0-9a-f]*"' | head -1 | grep -o '[0-9a-f]\{40\}')
chk "get contents" 200 "$(code "$B/repos/forge-user/demo/contents/a.txt" -H "$H")"
chk "put contents stale sha" 409 "$(code -X PUT "$B/repos/forge-user/demo/contents/a.txt" -H "$H" -H 'content-type: application/json' -d '{"message":"m","content":"Ynll","sha":"0000000000000000000000000000000000000000","branch":"main"}')"
chk "update contents with sha" 200 "$(code -X PUT "$B/repos/forge-user/demo/contents/a.txt" -H "$H" -H 'content-type: application/json' -d "{\"message\":\"m2\",\"content\":\"Ynll\",\"sha\":\"$SHA\",\"branch\":\"main\"}")"
chk "label create" 201 "$(code -X POST $B/repos/forge-user/demo/labels -H "$H" -H 'content-type: application/json' -d '{"name":"bug","color":"ff0000"}')"
chk "issue create" 201 "$(code -X POST $B/repos/forge-user/demo/issues -H "$H" -H 'content-type: application/json' -d '{"title":"t1","body":"b1","labels":["bug"]}')"
chk "issue bad label" 422 "$(code -X POST $B/repos/forge-user/demo/issues -H "$H" -H 'content-type: application/json' -d '{"title":"t","body":"b","labels":["nope"]}')"
chk "issue2 create" 201 "$(code -X POST $B/repos/forge-user/demo/issues -H "$H" -H 'content-type: application/json' -d '{"title":"t2","body":"b2"}')"
chk "issue list open" 200 "$(code "$B/repos/forge-user/demo/issues?state=open" -H "$H")"
chk "issue get one" 200 "$(code $B/repos/forge-user/demo/issues/1 -H "$H")"
chk "issue close" 200 "$(code -X PATCH $B/repos/forge-user/demo/issues/1 -H "$H" -H 'content-type: application/json' -d '{"state":"closed"}')"
chk "issue closed get" 200 "$(code $B/repos/forge-user/demo/issues/1 -H "$H")"
ST=$(body $B/repos/forge-user/demo/issues/1 -H "$H" | grep -o '"state": "closed"')
chk "close persisted" 1 "$([ -n "$ST" ] && echo 1 || echo 0)"
chk "comment create" 201 "$(code -X POST $B/repos/forge-user/demo/issues/2/comments -H "$H" -H 'content-type: application/json' -d '{"body":"hello"}')"
chk "comments list" 200 "$(code $B/repos/forge-user/demo/issues/2/comments -H "$H")"
chk "branch create" 201 "$(code -X POST $B/repos/forge-user/demo/git/refs -H "$H" -H 'content-type: application/json' -d '{"ref":"refs/heads/feat","sha":"'"$(body $B/repos/forge-user/demo/commits -H "$H" | grep -o '"sha": "[0-9a-f]*"' | head -1 | grep -o '[0-9a-f]\{40\}')"'"}')"
chk "branches list" 200 "$(code $B/repos/forge-user/demo/branches -H "$H")"
chk "unknown route" 404 "$(code $B/no-such-route -H "$H")"
chk "malformed body" 400 "$(code -X POST $B/user/repos -H "$H" -H 'content-type: application/json' -d '{"name":')"
chk "request id header" 1 "$(curl -s -D- -o /dev/null $B/repos/forge-user/demo -H "$H" | grep -ci 'x-github-request-id')"
chk "content type json" 1 "$(curl -s -D- -o /dev/null $B/repos/forge-user/demo -H "$H" | grep -ci 'application/json')"
echo "PASS=$P FAIL=$F"
kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
[ $F -eq 0 ]
