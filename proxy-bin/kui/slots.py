#!/usr/bin/env python3
"""One Tor process per country. Only ready circuits are published."""
from __future__ import annotations

import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BIN = Path(os.environ.get("PROXY_BIN") or Path(__file__).resolve().parents[1])
NAT = BIN / "native"
TOR_ROOT = BIN / "tor"
STATUS = BIN / "slots.json"
LOG = BIN / "slots.log"
PID_FILE = BIN / "slots.pid"

PLAN = [
    {"id": "jp", "country": "JP", "port": 9051, "exit": "{jp}", "strict": False},
    {"id": "us", "country": "US", "port": 9052, "exit": "{us}", "strict": False},
    {"id": "us2", "country": "US", "port": 9063, "exit": "{us}", "strict": False},
    {"id": "de", "country": "DE", "port": 9053, "exit": "{de}", "strict": False},
    {"id": "de2", "country": "DE", "port": 9065, "exit": "{de}", "strict": False},
    {"id": "nl", "country": "NL", "port": 9054, "exit": "{nl}", "strict": False},
    {"id": "kr", "country": "KR", "port": 9055, "exit": "{kr}", "strict": False},
    {"id": "sg", "country": "SG", "port": 9056, "exit": "{sg}", "strict": False},
    {"id": "au", "country": "AU", "port": 9057, "exit": "{au}", "strict": False},
    {"id": "ca", "country": "CA", "port": 9058, "exit": "{ca}", "strict": False},
    {"id": "ca2", "country": "CA", "port": 9074, "exit": "{ca}", "strict": False},
    {"id": "fr", "country": "FR", "port": 9059, "exit": "{fr}", "strict": False},
    {"id": "fr2", "country": "FR", "port": 9066, "exit": "{fr}", "strict": False},
    {"id": "gb", "country": "GB", "port": 9060, "exit": "{gb}", "strict": False},
    {"id": "gb2", "country": "GB", "port": 9064, "exit": "{gb}", "strict": False},
    {"id": "se", "country": "SE", "port": 9061, "exit": "{se}", "strict": False},
    {"id": "ch", "country": "CH", "port": 9062, "exit": "{ch}", "strict": False},
    {"id": "ru", "country": "RU", "port": 9067, "exit": "{ru}", "strict": False},
    {"id": "ru2", "country": "RU", "port": 9068, "exit": "{ru}", "strict": False},
    {"id": "vn", "country": "VN", "port": 9069, "exit": "{vn}", "strict": False},
    {"id": "th", "country": "TH", "port": 9070, "exit": "{th}", "strict": False},
    {"id": "it", "country": "IT", "port": 9071, "exit": "{it}", "strict": False},
    {"id": "es", "country": "ES", "port": 9072, "exit": "{es}", "strict": False},
    {"id": "pl", "country": "PL", "port": 9073, "exit": "{pl}", "strict": False},
]

ENV = {**os.environ, "LD_LIBRARY_PATH": str(NAT / "lib")}


def stamp(msg: str) -> None:
    LOG.open("a").write(time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + msg + "\n")


def tor_bin() -> str:
    return str(NAT / "tor")


def write_status(slots: list[dict]) -> None:
    STATUS.write_text(json.dumps({"updated": int(time.time()), "slots": slots}, ensure_ascii=False, indent=2) + "\n")


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def read_pid(path: Path) -> int:
    try:
        return int(path.read_text().strip())
    except Exception:
        return 0


def unix_socks(slot: dict) -> Path:
    return TOR_ROOT / slot["id"] / "socks.sock"


def write_torrc(slot: dict) -> Path:
    data = TOR_ROOT / slot["id"]
    data.mkdir(parents=True, exist_ok=True)
    (data / "data").mkdir(exist_ok=True)
    sock = unix_socks(slot)
    try:
        sock.unlink()
    except FileNotFoundError:
        pass
    rc = data / "torrc"
    rc.write_text(
        "\n".join(
            [
                f"SocksPort unix:{sock} WorldWritable",
                f"DataDirectory {data / 'data'}",
                f"GeoIPFile {NAT / 'geoip'}",
                f"GeoIPv6File {NAT / 'geoip6'}",
                f"Log notice file {data / 'notice.log'}",
                f"PidFile {data / 'tor.pid'}",
                "AvoidDiskWrites 1",
                "ClientOnly 1",
                f"ExitNodes {slot['exit']}",
                f"StrictNodes {1 if slot['strict'] else 0}",
                "",
            ]
        )
    )
    return rc


def stop_tor(slot: dict) -> None:
    data = TOR_ROOT / slot["id"]
    pid = read_pid(data / "tor.pid")
    if pid_alive(pid):
        try:
            os.kill(pid, 15)
        except OSError:
            pass
        for _ in range(20):
            time.sleep(0.05)
            if not pid_alive(pid):
                break
        if pid_alive(pid):
            try:
                os.kill(pid, 9)
            except OSError:
                pass
    try:
        unix_socks(slot).unlink()
    except FileNotFoundError:
        pass
    try:
        (data / "tor.pid").unlink()
    except FileNotFoundError:
        pass


def disabled(slot: dict) -> bool:
    return (TOR_ROOT / slot["id"] / "DISABLED").exists()


def start_tor(slot: dict) -> None:
    data = TOR_ROOT / slot["id"]
    if disabled(slot):
        return
    pid = read_pid(data / "tor.pid")
    if pid_alive(pid):
        return
    rc = write_torrc(slot)
    log = (data / "notice.log").open("ab")
    proc = subprocess.Popen(
        [tor_bin(), "-f", str(rc)],
        env=ENV,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(30):
        time.sleep(0.1)
        if read_pid(data / "tor.pid"):
            break
    stamp(f"tor {slot['id']} pid={read_pid(data / 'tor.pid') or proc.pid} socks=unix:{unix_socks(slot).name}")


def bootstrapped(slot: dict) -> bool:
    log = TOR_ROOT / slot["id"] / "notice.log"
    try:
        return "Bootstrapped 100" in log.read_text(errors="replace")
    except OSError:
        return False


def probe_socks(port: int) -> str:
    try:
        out = subprocess.run(
            [
                "curl",
                "-fsS",
                "--max-time",
                "12",
                "--socks5-hostname",
                f"127.0.0.1:{port}",
                "https://api.ipify.org",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        ip = (out.stdout or "").strip()
        return ip if out.returncode == 0 and ip else ""
    except Exception:
        return ""


def snapshot() -> list[dict]:
    from kui.egress_meta import attach_meta

    def one(slot: dict) -> dict:
        slot_dir = TOR_ROOT / slot["id"]
        if disabled(slot):
            row = {
                "id": slot["id"],
                "country": slot["country"],
                "socks": slot["port"],
                "state": "down",
                "egress_ip": "",
                "pid": 0,
                "kind": "tor",
                "disabled": True,
                "egress_type": "unverified",
                "isp_org": "",
            }
            stamp(f"slot {slot['id']} state=down disabled")
            return row
        pid = read_pid(slot_dir / "tor.pid")
        ready = pid_alive(pid) and bootstrapped(slot)
        ip = probe_socks(slot["port"]) if ready else ""
        row = {
            "id": slot["id"],
            "country": slot["country"],
            "socks": slot["port"],
            "state": "ready" if ip else ("boot" if pid_alive(pid) else "down"),
            "egress_ip": ip,
            "pid": pid if pid_alive(pid) else 0,
            "kind": "tor",
        }
        # TestISP/ip-api classify once per egress IP (cached under tor/<id>/EGRESS_META).
        row = attach_meta(row, slot_dir, timeout=8)
        stamp(
            f"slot {slot['id']} state={row['state']} ip={ip or '-'} "
            f"type={row.get('egress_type') or '-'} isp={row.get('isp_org') or '-'}"
        )
        return row

    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(one, PLAN))
    seen: set[str] = set()
    out: list[dict] = []
    for r in rows:
        ip = r.get("egress_ip") or ""
        if ip and ip in seen:
            out.append({**r, "state": "boot", "egress_ip": "", "egress_type": "unverified", "isp_org": ""})
        else:
            if ip:
                seen.add(ip)
            out.append(r)
    return out


def loop() -> None:
    PID_FILE.write_text(str(os.getpid()) + "\n")
    stamp("slots start")
    from kui.xray_sync import ensure as sync_xray
    from kui.socks_gate import start as start_gate

    if sync_xray(PLAN):
        stamp("xray.json tor inbounds added")
    for slot in PLAN:
        stop_tor(slot)
    time.sleep(0.4)
    for slot in PLAN:
        start_tor(slot)
    start_gate(PLAN, TOR_ROOT)
    stamp("socks gate on 127.0.0.1 (SOCKS5 only, HTTP closed)")
    while True:
        for slot in PLAN:
            if disabled(slot):
                stop_tor(slot)
            else:
                start_tor(slot)
        write_status(snapshot())
        time.sleep(45)


if __name__ == "__main__":
    TOR_ROOT.mkdir(parents=True, exist_ok=True)
    loop()
