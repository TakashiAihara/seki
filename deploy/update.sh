#!/bin/sh
# Bring the server to origin/main and restart it. Run on the server host as root.
set -eu
cd /opt/seki
git fetch -q origin
git checkout -q --detach origin/main
sh scripts/fetch-pocketbase.sh
systemctl restart seki
# /api/health answers even when the hooks failed to load; an unauthenticated call to a
# seki route answers 401 only when they did.
code=none
i=0
while [ "$i" -lt 30 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/api/seki/leases || true)
  [ "$code" = 401 ] && { echo "seki up at $(git rev-parse --short HEAD)"; exit 0; }
  i=$((i + 1))
  sleep 1
done
echo "seki did not answer on /api/seki/leases after restart (last status: $code)" >&2
exit 1
