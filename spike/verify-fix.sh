#!/usr/bin/env bash
# Verify the ws.rs lag-teardown fix: run the freshly-built server on :3002 with a
# throwaway DB, then the 60Hz stream that previously froze the watcher at ~98.
set -uo pipefail
BIN=/Users/janis/Desktop/Abracadabra/abracadabra-rs/target/debug/abracadabra
SPIKE=/Users/janis/Desktop/Abracadabra/abracadabra-plugin-terminal/spike
URL=http://127.0.0.1:3002
rm -f /tmp/abra-fixtest.db /tmp/abra-fixtest.db-wal /tmp/abra-fixtest.db-shm

cd /Users/janis/Desktop/Abracadabra/abracadabra-rs
ABRA_SERVER_BIND=127.0.0.1:3002 ABRA_SERVER_DB_PATH=/tmp/abra-fixtest.db \
  RUST_LOG=warn "$BIN" > /tmp/abra-fixtest.log 2>&1 &
SRV=$!
echo "[verify] server pid=$SRV on :3002, waiting for ready..."
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" $URL/info 2>/dev/null)
  [ "$code" = "200" ] && { echo "[verify] ready"; break; }
  sleep 0.5
done

cd "$SPIKE"
DOC=$(uuidgen)
echo "[verify] 60Hz stream (frame=16), 14s host / 13s watch — was frozen at ~98 pre-fix"
node host.mjs --url=$URL --doc=$DOC --rate=500000 --seconds=14 --frame=16 > /tmp/fix-host.log 2>&1 &
HP=$!
sleep 1.5
node watch.mjs --url=$URL --doc=$DOC --seconds=13 2>&1 | grep -E "recv chunks|seqMax per|input round-trip"
wait $HP 2>/dev/null
echo "host: $(grep DONE /tmp/fix-host.log)"

kill $SRV 2>/dev/null
echo "[verify] test server stopped"
