#!/bin/bash
# Watchdog: reinstall if binaries missing, restart stack / slot managers if down.
BIN="$(cd "$(dirname "$0")" && pwd)"
HOST_FILE="$BIN/cf-hostname"
LOG="$BIN/supervise.log"
INTERVAL="${SUPERVISE_INTERVAL:-20}"
echo $$ >"$BIN/supervise.pid"

alive() {
  local f="$1"
  [ -f "$f" ] || return 1
  kill -0 "$(cat "$f")" 2>/dev/null
}

probe() {
  curl -sf --max-time 4 -o /dev/null "http://127.0.0.1:38079/vless" || return 1
  local host=""
  [ -s "$HOST_FILE" ] && host=$(tr -d ' \n' <"$HOST_FILE")
  [ -z "$host" ] && return 0
  curl -sf --max-time 8 -o /dev/null "https://${host}/vless"
}

stamp() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" >>"$LOG"
}

ensure_bins() {
  if [ ! -x "$BIN/xray" ] || [ ! -x "$BIN/cloudflared" ] || [ ! -f "$BIN/mux.mjs" ]; then
    stamp "missing binaries, run install.sh"
    bash "$BIN/install.sh" >>"$LOG" 2>&1 || stamp "install.sh failed"
  fi
}

stamp "supervise start bin=$BIN interval=${INTERVAL}s"
while true; do
  ensure_bins
  if ! alive "$BIN/slots.pid"; then
    stamp "slots down, start"
    PYTHONPATH="$BIN" PROXY_BIN="$BIN" python3 "$BIN/kui/slots.py" >>"$BIN/slots.log" 2>&1 &
    echo $! >"$BIN/slots.pid"
  fi
  if ! alive "$BIN/ovpn-slots.pid"; then
    stamp "ovpn slots down, start"
    PYTHONPATH="$BIN" PROXY_BIN="$BIN" python3 "$BIN/kui/ovpn_slots.py" >>"$BIN/ovpn-slots.log" 2>&1 &
    echo $! >"$BIN/ovpn-slots.pid"
  fi
  need=0
  alive "$BIN/xray.pid" || need=1
  alive "$BIN/mux.pid" || need=1
  alive "$BIN/cloudflared.pid" || need=1
  if [ "$need" -eq 1 ]; then
    stamp "process down, restart stack"
    bash "$BIN/start.sh" >>"$LOG" 2>&1 || stamp "start.sh failed"
    sleep 4
  elif ! probe; then
    stamp "probe fail, restart stack"
    bash "$BIN/start.sh" >>"$LOG" 2>&1 || stamp "start.sh failed"
    sleep 4
  fi
  sleep "$INTERVAL"
done
