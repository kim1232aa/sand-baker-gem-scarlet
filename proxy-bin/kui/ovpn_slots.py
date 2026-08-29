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

# vpn_port is a preference; pick_profile falls back to any TCP if that port is empty.
# Prefer JP/KR (VPNGate TCP 多); TH 常只有 UDP、RO 常空，保留少量试探槽。
PLAN = [
    # JP ×8
    {"id": "ovpn-jp", "country": "JP", "port": 9171, "vpn_port": "443"},
    {"id": "ovpn-jp2", "country": "JP", "port": 9174, "vpn_port": "443"},
    {"id": "ovpn-jp3", "country": "JP", "port": 9175, "vpn_port": ""},
    {"id": "ovpn-jp4", "country": "JP", "port": 9179, "vpn_port": ""},
    {"id": "ovpn-jp5", "country": "JP", "port": 9185, "vpn_port": "443"},
    {"id": "ovpn-jp6", "country": "JP", "port": 9186, "vpn_port": ""},
    {"id": "ovpn-jp7", "country": "JP", "port": 9187, "vpn_port": ""},
    {"id": "ovpn-jp8", "country": "JP", "port": 9188, "vpn_port": ""},
    # KR ×8
    {"id": "ovpn-kr", "country": "KR", "port": 9172, "vpn_port": "995"},
    {"id": "ovpn-kr2", "country": "KR", "port": 9176, "vpn_port": "995"},
    {"id": "ovpn-kr3", "country": "KR", "port": 9177, "vpn_port": ""},
    {"id": "ovpn-kr4", "country": "KR", "port": 9178, "vpn_port": ""},
    {"id": "ovpn-kr5", "country": "KR", "port": 9189, "vpn_port": "995"},
    {"id": "ovpn-kr6", "country": "KR", "port": 9190, "vpn_port": ""},
    {"id": "ovpn-kr7", "country": "KR", "port": 9191, "vpn_port": ""},
    {"id": "ovpn-kr8", "country": "KR", "port": 9192, "vpn_port": ""},
    # US / RU / VN / others
    {"id": "ovpn-us", "country": "US", "port": 9182, "vpn_port": ""},
    {"id": "ovpn-us2", "country": "US", "port": 9193, "vpn_port": ""},
    {"id": "ovpn-ru", "country": "RU", "port": 9194, "vpn_port": ""},
    {"id": "ovpn-ru2", "country": "RU", "port": 9195, "vpn_port": ""},
    {"id": "ovpn-vn", "country": "VN", "port": 9196, "vpn_port": ""},
    {"id": "ovpn-tw", "country": "TW", "port": 9197, "vpn_port": ""},
    {"id": "ovpn-th", "country": "TH", "port": 9183, "vpn_port": ""},
    {"id": "ovpn-ro", "country": "RO", "port": 9173, "vpn_port": ""},
]

_NODES: list[dict] = []
_NODES_AT = 0.0
_SKIP: set[str] = set()


def stamp(msg: str) -> None:
    LOG.open("a").write(time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + msg + "\n")


def refresh_nodes(force: bool = False) -> list[dict]:
    global _NODES, _NODES_AT
    if force:
        _NODES = []
        _NODES_AT = 0.0
    return vpngate_nodes()


def load_slot_skips(slot_dir: Path) -> set[str]:
    skips: set[str] = set()
    p = slot_dir / "SKIP_REMOTES"
    if not p.exists():
        return skips
    try:
        for line in p.read_text(errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                skips.add(line)
    except OSError:
        pass
    return skips


def remember_skip(slot_dir: Path, remote: str, keep: int = 12) -> None:
    if not remote:
        return
    _SKIP.add(remote)
    prev = [r for r in load_slot_skips(slot_dir) if r != remote]
    prev.append(remote)
    slot_dir.mkdir(parents=True, exist_ok=True)
    (slot_dir / "SKIP_REMOTES").write_text("\n".join(prev[-keep:]) + "\n")


def parse_proto_port(cfg: str) -> tuple[str, str]:
    proto = port = ""
    for line in cfg.splitlines():
        if line.startswith("proto "):
            proto = line.split()[1]
        if line.startswith("remote ") and len(line.split()) >= 3:
            port = line.split()[2]
    return proto, port


def list_candidates(country: str, want_port: str = "", excluded: set[str] | None = None) -> list[dict]:
    excluded = excluded or set()
    cands: list[dict] = []
    for n in vpngate_nodes():
        if n.get("country") != country:
            continue
        proto, port = parse_proto_port(n["config"])
        if not proto.startswith("tcp"):
            continue
        if want_port and port != want_port:
            continue
        key = f"{n['ip']}:{port}"
        if key in excluded:
            continue
        cands.append({**n, "_remote": key, "_port": port, "_proto": proto})
    cands.sort(key=lambda n: int(n.get("ping") or 9999))
    return cands


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
    # Host forbids CAP_SYS_ADMIN netns; slots run in user+net ns (mapped root).
    # Plain `nsenter -n` / `nsenter -U -n` fails; --preserve-credentials -U -n works.
    cmd = ["nsenter", "--preserve-credentials", "-t", str(nspid), "-U", "-n", "--"] + args
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


def pick_profile(slot: dict, slot_dir: Path | None = None) -> str:
    want = str(slot.get("vpn_port") or "").strip()
    country = slot["country"]
    slot_dir = slot_dir or (ROOT / slot["id"])
    excluded = used_remotes() | load_slot_skips(slot_dir)
    # Prefer configured port; if empty pool, fall back to any TCP for that country.
    cands = list_candidates(country, want, excluded)
    if not cands and want:
        stamp(f"{slot['id']} no tcp/{want} left for {country}, fallback any tcp")
        cands = list_candidates(country, "", excluded)
    if not cands:
        # Last resort: refresh list and retry once without soft process skips.
        refresh_nodes(force=True)
        excluded = used_remotes() | load_slot_skips(slot_dir)
        cands = list_candidates(country, want, excluded) or list_candidates(country, "", excluded)
    if not cands:
        # Absolute last: ignore SKIP_REMOTES history (still avoid other slots' remotes).
        excluded = used_remotes()
        cands = list_candidates(country, "", excluded)
    if not cands:
        raise RuntimeError(f"no tcp VPNGate for {country} (want={want or 'any'})")
    chosen = cands[0]
    stamp(f"{slot['id']} pick {chosen.get('_remote')} ping={chosen.get('ping')} pool={len(cands)}")
    return chosen["config"]


def make_netns(slot_dir: Path) -> int:
    pid = read_pid(slot_dir / "ns.pid")
    if pid_alive(pid):
        return pid
    # Unprivileged hosts block CLONE_NEWNET alone; user+net with root mapping works.
    ns_log = slot_dir / "ns.log"
    holder = [
        "unshare",
        "--user",
        "--map-root-user",
        "--net",
        "bash",
        "-c",
        f'echo $$ > "{slot_dir / "ns.pid"}"; exec sleep infinity',
    ]
    spawn(holder, ns_log)
    for _ in range(50):
        time.sleep(0.1)
        pid = read_pid(slot_dir / "ns.pid")
        if pid_alive(pid):
            stamp(f"{slot_dir.name} user+net ns pid={pid}")
            return pid
    stamp(f"{slot_dir.name} make_netns failed")
    return 0


def ensure_slirp(nspid: int, slot_dir: Path) -> None:
    pid = read_pid(slot_dir / "slirp.pid")
    if pid_alive(pid):
        return
    slirp = NAT / "slirp4netns"
    # Prefer project binary (with LD_LIBRARY_PATH); fall back to system if present.
    cmd = [str(slirp) if slirp.exists() else "slirp4netns", "--configure", "--mtu=65520", "--disable-host-loopback", str(nspid), "tap0"]
    p = spawn(cmd, slot_dir / "slirp.log")
    (slot_dir / "slirp.pid").write_text(str(p) + "\n")
    time.sleep(1.2)
    if not pid_alive(p):
        stamp(f"{slot_dir.name} slirp died; see slirp.log")


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
    for _try in range(5):
        cfg = slot_dir / "client.ovpn"
        try:
            cfg.write_text(pick_profile(slot, slot_dir))
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
        for _ in range(22):
            time.sleep(1)
            text = log.read_text(errors="replace") if log.exists() else ""
            if "Initialization Sequence Completed" in text:
                stamp(f"{slot['id']} openvpn ready {remote}")
                ok = True
                break
            if "AUTH_FAILED" in text or "Exiting due" in text:
                stamp(f"{slot['id']} openvpn fail {remote}")
                break
        if ok:
            return
        # Timeout or auth fail: remember remote and try next candidate.
        remember_skip(slot_dir, remote)
        stamp(f"{slot['id']} openvpn try={_try + 1}/5 skip {remote}")
        try:
            cfg.unlink()
        except OSError:
            pass
        kill_pidfile(slot_dir / "openvpn.pid")
        kill_pidfile(slot_dir / "openvpn-host.pid")


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


def candidate_count(slot: dict, slot_dir: Path) -> int:
    want = str(slot.get("vpn_port") or "").strip()
    excluded = used_remotes() | load_slot_skips(slot_dir)
    n = len(list_candidates(slot["country"], want, excluded))
    if n == 0 and want:
        n = len(list_candidates(slot["country"], "", excluded))
    return n


def bring_up(slot: dict) -> dict:
    slot_dir = ROOT / slot["id"]
    slot_dir.mkdir(parents=True, exist_ok=True)
    if (slot_dir / "DISABLED").exists():
        for name in ("openvpn.pid", "openvpn-host.pid", "fwd.pid", "ns-socks.pid"):
            kill_pidfile(slot_dir / name)
        return {
            **slot,
            "state": "down",
            "egress_ip": "",
            "kind": "openvpn",
            "disabled": True,
            "remote": "",
            "candidates": candidate_count(slot, slot_dir),
        }
    force = (slot_dir / "FORCE_REDIAL").exists()
    if force:
        try:
            (slot_dir / "FORCE_REDIAL").unlink()
        except OSError:
            pass
        refresh_nodes(force=True)
        # Tear down datapath so probe cannot short-circuit on stale SOCKS.
        for name in ("openvpn.pid", "openvpn-host.pid", "fwd.pid", "ns-socks.pid"):
            kill_pidfile(slot_dir / name)
        stamp(f"{slot['id']} force redial")
    if slot["id"] == "ovpn-jp":
        adopt_legacy_jp()
    ip = "" if force else probe(slot["port"])
    if ip:
        cfg = slot_dir / "client.ovpn"
        remote = remote_of(cfg.read_text(errors="replace")) if cfg.exists() else ""
        return {
            **slot,
            "state": "ready",
            "egress_ip": ip,
            "kind": "openvpn",
            "remote": remote,
            "candidates": candidate_count(slot, slot_dir),
        }
    nspid = make_netns(slot_dir)
    if not nspid:
        return {
            **slot,
            "state": "down",
            "egress_ip": "",
            "kind": "openvpn",
            "remote": "",
            "candidates": candidate_count(slot, slot_dir),
        }
    ensure_slirp(nspid, slot_dir)
    ensure_openvpn(nspid, slot, slot_dir)
    ensure_socks(nspid, slot, slot_dir)
    time.sleep(0.5)
    ip = probe(slot["port"])
    cfg = slot_dir / "client.ovpn"
    remote = remote_of(cfg.read_text(errors="replace")) if cfg.exists() else ""
    if ip and ip in ready_ips():
        stamp(f"{slot['id']} duplicate egress {ip}, skip publish")
        remember_skip(slot_dir, remote)
        try:
            cfg.unlink()
        except OSError:
            pass
        kill_pidfile(slot_dir / "openvpn.pid")
        kill_pidfile(slot_dir / "openvpn-host.pid")
        return {
            **slot,
            "state": "boot",
            "egress_ip": "",
            "kind": "openvpn",
            "remote": "",
            "candidates": candidate_count(slot, slot_dir),
        }
    return {
        **slot,
        "state": "ready" if ip else "boot",
        "egress_ip": ip,
        "kind": "openvpn",
        "remote": remote,
        "candidates": candidate_count(slot, slot_dir),
    }


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
        rows: list[dict] = []
        seen: set[str] = set()
        # Seed with previous status so UI keeps showing later slots while we work front ones.
        prev_by_id: dict[str, dict] = {}
        if STATUS.exists():
            try:
                for s in json.loads(STATUS.read_text()).get("slots", []):
                    if s.get("id"):
                        prev_by_id[s["id"]] = s
            except Exception:
                prev_by_id = {}
        for slot in PLAN:
            try:
                row = bring_up(slot)
            except Exception as e:
                stamp(f"{slot['id']} error {e}")
                row = {**slot, "state": "down", "egress_ip": "", "kind": "openvpn", "remote": "", "candidates": 0}
            if row.get("state") == "ready" and row.get("egress_ip"):
                if row["egress_ip"] in seen:
                    row = {**row, "state": "boot", "egress_ip": "", "remote": row.get("remote") or ""}
                else:
                    seen.add(row["egress_ip"])
            rows.append(row)
            # Publish partial progress: processed rows + untouched previous/planned stubs.
            done = {r["id"] for r in rows}
            partial = list(rows)
            for s in PLAN:
                if s["id"] in done:
                    continue
                old = prev_by_id.get(s["id"])
                if old:
                    partial.append(old)
                else:
                    partial.append({**s, "state": "boot", "egress_ip": "", "kind": "openvpn", "remote": "", "candidates": 0})
            STATUS.write_text(
                json.dumps({"updated": int(time.time()), "slots": partial}, ensure_ascii=False, indent=2) + "\n"
            )
        time.sleep(20)


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    loop()
