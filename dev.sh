#!/usr/bin/env bash
set -e
PORT=${1:-8080}
URL="http://localhost:$PORT"
python3 build.sh
echo "DonnerSang — $URL"
python3 -m http.server "$PORT" --bind 127.0.0.1 &
PID=$!
sleep 0.3
xdg-open "$URL" 2>/dev/null || open "$URL" 2>/dev/null || echo "Ouvrez $URL dans votre navigateur"
wait $PID
