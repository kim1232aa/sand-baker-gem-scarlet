#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
cd "$ROOT"
BIN="$ROOT/proxy-bin"

if ! curl -sf -o /dev/null --max-time 1 http://127.0.0.1:38079/vless; then
  bash "$BIN/start.sh" >>/tmp/sand-baker-proxy-startup.log 2>&1
fi
if [ -f "$BIN/supervise.pid" ] && kill -0 "$(cat "$BIN/supervise.pid")" 2>/dev/null; then
  :
else
  bash "$BIN/supervise.sh" >>"$BIN/supervise.log" 2>&1 &
  echo $! >"$BIN/supervise.pid"
fi
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/sand-baker-app-startup.log 2>&1 &
