#!/bin/sh
# Bring the server to origin/main and restart it. Run on the server host as root.
set -eu
cd /opt/seki
git fetch -q origin
git checkout -q --detach origin/main
sh scripts/fetch-pocketbase.sh
systemctl restart seki
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8090/api/health && { echo "seki up at $(git rev-parse --short HEAD)"; exit 0; }; sleep 1; done
echo "seki did not answer /api/health after restart" >&2; exit 1
