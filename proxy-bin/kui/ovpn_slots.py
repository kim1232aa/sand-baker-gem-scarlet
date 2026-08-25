#!/usr/bin/env python3
"""OpenVPN in a netns (host TUN is blocked). VPNGate TCP 443/995 + slirp4netns."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path

BIN = Path(os.environ.get("PROXY_BIN") or Path(__file__).resolve().parents[1])
NAT = BIN / "native"
ROOT = BIN / "ovpn"
STATUS = BIN / "ovpn.json"
LOG = BIN / "ovpn-slots.log"
PID_FILE = BIN / "ovpn-slots.pid"
ENV = {**os.environ, "LD_LIBRARY_PATH": str(NAT / "lib"), "PYTHONPATH": str(BIN)}
UUID = (BIN / "uuid").read_text().strip() if (BIN / "uuid").exists() else "a3f1c8e2-9b47-4d6a-8e21-c5f90b3d7a14"

PLAN = [
    {"id": "ovpn-jp", "country": "JP", "port": 9171, "vpn_port": "443"},
    {"id": "ovpn-jp2", "country": "JP", "port": 9174, "vpn_port": "443"},
    {"id": "ovpn-jp3", "country": "JP", "port": 9175, "vpn_port": "443"},
    {"id": "ovpn-jp4", "country": "JP", "port": 9179, "vpn_port": "443"},
    {"id": "ovpn-kr", "country": "KR", "port": 9172, "vpn_port": "995"},
    {"id": "ovpn-kr2", "country": "KR", "port": 9176, "vpn_port": "995"},
    {"id": "ovpn-kr3", "country": "KR", "port": 9177, "vpn_port": "995"},
    {"id": "ovpn-kr4", "country": "KR", "port": 9178, "vpn_port": "995"},
    {"id": "ovpn-us", "country": "US", "port": 9182, "vpn_port": ""},
    {"id": "ovpn-th", "country": "TH", "port": 9183, "vpn_port": ""},
    {"id": "ovpn-th2", "country": "TH", "port": 9184, "vpn_port": ""},
    {"id": "ovpn-ro", "country": "RO", "port": 9173, "vpn_port": "443"},
]

_NODES: list[dict] = []
_NODES_AT = 0.0
_SKIP: set[str] = set()


def stamp(msg: str) -> None:
    LOG.open("a").write(time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + msg + "\n")


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


def spawn(cmd: list[str], log: Path, extra_env: dict | None = None) -> int:
    env = dict(ENV)
    if extra_env:
        env.update(extra_env)
    log.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(cmd, env=env, stdout=log.open("ab"), stderr=subprocess.STDOUT, start_new_session=True)
    return proc.pid


def nsenter(nspid: int, args: list[str], log: Path | None = None) -> subprocess.Popen:
    cmd = ["nsenter", "-t", str(nspid), "-n", "--"] + args
    if log is None:
        return subprocess.Popen(cmd, env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return subprocess.Popen(cmd, env=ENV, stdout=log.open("ab"), stderr=subprocess.STDOUT, start_new_session=True)


def probe(port: int) -> str:
    r = subprocess.run(
        ["curl", "-fsS", "--max-time", "12", "--socks5-hostname", f"127.0.0.1:{port}", "https://api.ipify.org"],
        capture_output=True,
        text=True,
    )
    ip = (r.stdout or "").strip()
    return ip if r.returncode == 0 and ip else ""


def remote_of(cfg: str) -> str:
    for line in cfg.splitlines():
        if line.startswith("remote "):
            parts = line.split()
            return f"{parts[1]}:{parts[2]}" if len(parts) >= 3 else parts[1]
    return ""


def vpngate_nodes() -> list[dict]:
    global _NODES, _NODES_AT
    if _NODES and time.time() - _NODES_AT < 300:
        return _NODES
    from kui.vpngate import fetch_nodes

    _NODES = fetch_nodes(timeout=25)
    _NODES_AT = time.time()
    return _NODES


def used_remotes() -> set[str]:
    used = set(_SKIP)
    for d in ROOT.iterdir() if ROOT.exists() else []:
        p = d / "client.ovpn"
        if p.exists():
            used.add(remote_of(p.read_text(errors="replace")))
    return used


def pick_profile(slot: dict) -> str:
    want = str(slot.get("vpn_port") or "").strip()
    country = slot["country"]
    used = used_remotes()
    cands = []
    for n in vpngate_nodes():
        proto = port = ""
        for line in n["config"].splitlines():
            if line.startswith("proto "):
                proto = line.split()[1]
            if line.startswith("remote ") and len(line.split()) >= 3:
                port = line.split()[2]
        if n.get("country") != country or not proto.startswith("tcp"):
            continue
        if want and port != want:
            continue
        key = f"{n['ip']}:{port}"
        if key in used:
            continue
        cands.append(n)
    cands.sort(key=lambda n: int(n.get("ping") or 9999))
    if not cands:
        raise RuntimeError(f"no tcp/{want} VPNGate for {country}")
    return cands[0]["config"]


def make_netns(slot_dir: Path) -> int:
    pid = read_pid(slot_dir / "ns.pid")
    if pid_alive(pid):
        return pid
    import ctypes

    child = os.fork()
    if child == 0:
        libc = ctypes.CDLL("libc.so.6")
        if libc.unshare(0x40000000) != 0:
            os._exit(1)
        os.setsid()
        (slot_dir / "ns.pid").write_text(str(os.getpid()) + "\n")
        signal.pause()
        os._exit(0)
    for _ in range(30):
        time.sleep(0.1)
        pid = read_pid(slot_dir / "ns.pid")
        if pid_alive(pid):
            return pid
    return 0


def ensure_slirp(nspid: int, slot_dir: Path) -> None:
    pid = read_pid(slot_dir / "slirp.pid")
    if pid_alive(pid):
        return
    p = spawn(
        [str(NAT / "slirp4netns"), "--configure", "--mtu=65520", "--disable-host-loopback", str(nspid), "tap0"],
        slot_dir / "slirp.log",
    )
    (slot_dir / "slirp.pid").write_text(str(p) + "\n")
    time.sleep(0.8)


def kill_pidfile(path: Path) -> None:
    pid = read_pid(path)
    if pid_alive(pid):
        try:
            os.kill(pid, 15)
        except OSError:
            pass


def ensure_openvpn(nspid: int, slot: dict, slot_dir: Path) -> None:
    pid = read_pid(slot_dir / "openvpn.pid")
    log = slot_dir / "openvpn.log"
    if pid_alive(pid) and log.exists() and "Initialization Sequence Completed" in log.read_text(errors="replace"):
        return
    for _try in range(3):
        cfg = slot_dir / "client.ovpn"
        try:
            cfg.write_text(pick_profile(slot))
        except RuntimeError as e:
            stamp(f"{slot['id']} {e}")
            return
        remote = remote_of(cfg.read_text())
        auth = slot_dir / "auth.txt"
        auth.write_text("vpn\nvpn\n")
        auth.chmod(0o600)
        log.write_text("")
        kill_pidfile(slot_dir / "openvpn.pid")
        proc = nsenter(
            nspid,
            [
                str(NAT / "openvpn"),
                "--config",
                str(cfg),
                "--dev",
                "tun0",
                "--dev-type",
                "tun",
                "--nobind",
                "--route-nopull",
                "--auth-user-pass",
                str(auth),
                "--data-ciphers",
                "AES-128-CBC:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305",
                "--data-ciphers-fallback",
                "AES-128-CBC",
                "--connect-timeout",
                "15",
                "--connect-retry-max",
                "2",
                "--verb",
                "3",
                "--log",
                str(log),
                "--writepid",
                str(slot_dir / "openvpn.pid"),
            ],
            slot_dir / "openvpn-wrap.log",
        )
        (slot_dir / "openvpn-host.pid").write_text(str(proc.pid) + "\n")
        ok = False
        fail = False
        for _ in range(22):
            time.sleep(1)
            text = log.read_text(errors="replace") if log.exists() else ""
            if "Initialization Sequence Completed" in text:
                stamp(f"{slot['id']} openvpn ready {remote}")
                ok = True
                break
            if "AUTH_FAILED" in text or "Exiting due" in text:
                stamp(f"{slot['id']} openvpn fail {remote}")
                fail = True
                break
        if ok:
            return
        _SKIP.add(remote)
        try:
            cfg.unlink()
        except OSError:
            pass
        kill_pidfile(slot_dir / "openvpn.pid")
        if not fail:
            stamp(f"{slot['id']} openvpn timeout {remote}")
            return


def ensure_socks(nspid: int, slot: dict, slot_dir: Path) -> None:
    unix = BIN / "socks" / f"{slot['id']}.unix"
    ns_pid = read_pid(slot_dir / "ns-socks.pid")
    if not pid_alive(ns_pid):
        proc = nsenter(
            nspid,
            ["python3", str(BIN / "kui/ovpn_bridge.py"), "ns-socks", str(unix), "tun0"],
            slot_dir / "ns-socks.log",
        )
        (slot_dir / "ns-socks.pid").write_text(str(proc.pid) + "\n")
    fwd_pid = read_pid(slot_dir / "fwd.pid")
    if not pid_alive(fwd_pid):
        p = spawn(
            ["python3", str(BIN / "kui/ovpn_bridge.py"), "host-fwd", str(slot["port"]), str(unix)],
            slot_dir / "fwd.log",
        )
        (slot_dir / "fwd.pid").write_text(str(p) + "\n")
        time.sleep(0.3)


def sync_xray(plan: list[dict]) -> bool:
    p = BIN / "xray.json"
    cfg = json.loads(p.read_text())
    have = {i.get("tag") for i in cfg.get("inbounds", [])}
    added = False
    for slot in plan:
        tag = f"in-{slot['id']}"
        if tag in have:
            continue
        cfg["inbounds"].append(
            {
                "tag": tag,
                "listen": str(BIN / "socks" / f"in-{slot['id']}.sock"),
                "protocol": "vless",
                "settings": {"clients": [{"id": UUID}], "decryption": "none"},
                "streamSettings": {"network": "ws", "wsSettings": {"path": "/vless"}},
            }
        )
        cfg["outbounds"].append(
            {
                "tag": f"socks-{slot['id']}",
                "protocol": "socks",
                "settings": {"servers": [{"address": "127.0.0.1", "port": slot["port"]}]},
            }
        )
        cfg["routing"]["rules"].append(
            {"type": "field", "inboundTag": [tag], "outboundTag": f"socks-{slot['id']}"}
        )
        added = True
        stamp(f"xray inbound {slot['id']}")
    if added:
        p.write_text(json.dumps(cfg, indent=2) + "\n")
    return added


def adopt_legacy_jp() -> None:
    slot_dir = ROOT / "ovpn-jp"
    slot_dir.mkdir(parents=True, exist_ok=True)
    legacy = Path("/tmp/ovpn-test/ns.pid")
    if not legacy.exists():
        return
    nspid = read_pid(legacy)
    if not pid_alive(nspid):
        return
    (slot_dir / "ns.pid").write_text(str(nspid) + "\n")
    stamp("adopted legacy ovpn-jp netns")


def ready_ips() -> set[str]:
    ips: set[str] = set()
    if STATUS.exists():
        try:
            for s in json.loads(STATUS.read_text()).get("slots", []):
                if s.get("state") == "ready" and s.get("egress_ip"):
                    ips.add(s["egress_ip"])
        except Exception:
            pass
    return ips


def bring_up(slot: dict) -> dict:
    slot_dir = ROOT / slot["id"]
    slot_dir.mkdir(parents=True, exist_ok=True)
    if slot["id"] == "ovpn-jp":
        adopt_legacy_jp()
    ip = probe(slot["port"])
    if ip:
        return {**slot, "state": "ready", "egress_ip": ip, "kind": "openvpn"}
    nspid = make_netns(slot_dir)
    if not nspid:
        return {**slot, "state": "down", "egress_ip": "", "kind": "openvpn"}
    ensure_slirp(nspid, slot_dir)
    ensure_openvpn(nspid, slot, slot_dir)
    ensure_socks(nspid, slot, slot_dir)
    time.sleep(0.5)
    ip = probe(slot["port"])
    if ip and ip in ready_ips():
        stamp(f"{slot['id']} duplicate egress {ip}, skip publish")
        return {**slot, "state": "boot", "egress_ip": "", "kind": "openvpn"}
    return {**slot, "state": "ready" if ip else "boot", "egress_ip": ip, "kind": "openvpn"}


def loop() -> None:
    PID_FILE.write_text(str(os.getpid()) + "\n")
    ROOT.mkdir(parents=True, exist_ok=True)
    (BIN / "socks").mkdir(exist_ok=True)
    stamp("ovpn slots start")
    kr_cfg = ROOT / "ovpn-kr" / "client.ovpn"
    if kr_cfg.exists() and ":443" in remote_of(kr_cfg.read_text(errors="replace")):
        kr_cfg.unlink()
        stamp("dropped ovpn-kr tcp/443 profile, will try 995")
    from kui.xray_sync import ensure as sync_xray

    if sync_xray(PLAN):
        stamp("xray.json ovpn inbounds added")
    while True:
        rows = []
        seen: set[str] = set()
        for slot in PLAN:
            try:
                row = bring_up(slot)
            except Exception as e:
                stamp(f"{slot['id']} error {e}")
                row = {**slot, "state": "down", "egress_ip": "", "kind": "openvpn"}
            if row.get("state") == "ready" and row.get("egress_ip"):
                if row["egress_ip"] in seen:
                    row = {**row, "state": "boot", "egress_ip": ""}
                else:
                    seen.add(row["egress_ip"])
            rows.append(row)
        STATUS.write_text(json.dumps({"updated": int(time.time()), "slots": rows}, ensure_ascii=False, indent=2) + "\n")
        time.sleep(40)


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    loop()
