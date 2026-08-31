#!/usr/bin/env python3
"""OpenVPN in a netns (host TUN is blocked). VPNGate TCP 443/995 + slirp4netns."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path
import re

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
# 48 slots: deepen JP/KR/US + new countries + 3 datacenter-quota slots (allow_datacenter).
PLAN = [
    # JP ×12
    {"id": "ovpn-jp", "country": "JP", "port": 9171, "vpn_port": "443"},
    {"id": "ovpn-jp2", "country": "JP", "port": 9174, "vpn_port": "443"},
    {"id": "ovpn-jp3", "country": "JP", "port": 9175, "vpn_port": ""},
    {"id": "ovpn-jp4", "country": "JP", "port": 9179, "vpn_port": ""},
    {"id": "ovpn-jp5", "country": "JP", "port": 9185, "vpn_port": "443"},
    {"id": "ovpn-jp6", "country": "JP", "port": 9186, "vpn_port": ""},
    {"id": "ovpn-jp7", "country": "JP", "port": 9187, "vpn_port": ""},
    {"id": "ovpn-jp8", "country": "JP", "port": 9188, "vpn_port": ""},
    {"id": "ovpn-jp9", "country": "JP", "port": 9198, "vpn_port": ""},
    {"id": "ovpn-jp10", "country": "JP", "port": 9199, "vpn_port": ""},
    {"id": "ovpn-jp11", "country": "JP", "port": 9200, "vpn_port": ""},
    {"id": "ovpn-jp12", "country": "JP", "port": 9201, "vpn_port": ""},
    # KR ×12
    {"id": "ovpn-kr", "country": "KR", "port": 9172, "vpn_port": "995"},
    {"id": "ovpn-kr2", "country": "KR", "port": 9176, "vpn_port": "995"},
    {"id": "ovpn-kr3", "country": "KR", "port": 9177, "vpn_port": ""},
    {"id": "ovpn-kr4", "country": "KR", "port": 9178, "vpn_port": ""},
    {"id": "ovpn-kr5", "country": "KR", "port": 9189, "vpn_port": "995"},
    {"id": "ovpn-kr6", "country": "KR", "port": 9190, "vpn_port": ""},
    {"id": "ovpn-kr7", "country": "KR", "port": 9191, "vpn_port": ""},
    {"id": "ovpn-kr8", "country": "KR", "port": 9192, "vpn_port": ""},
    {"id": "ovpn-kr9", "country": "KR", "port": 9202, "vpn_port": ""},
    {"id": "ovpn-kr10", "country": "KR", "port": 9203, "vpn_port": ""},
    {"id": "ovpn-kr11", "country": "KR", "port": 9204, "vpn_port": ""},
    {"id": "ovpn-kr12", "country": "KR", "port": 9205, "vpn_port": ""},
    # US ×4 / RU ×3
    {"id": "ovpn-us", "country": "US", "port": 9182, "vpn_port": ""},
    {"id": "ovpn-us2", "country": "US", "port": 9193, "vpn_port": ""},
    {"id": "ovpn-us3", "country": "US", "port": 9206, "vpn_port": ""},
    {"id": "ovpn-us4", "country": "US", "port": 9207, "vpn_port": ""},
    {"id": "ovpn-ru", "country": "RU", "port": 9194, "vpn_port": ""},
    {"id": "ovpn-ru2", "country": "RU", "port": 9195, "vpn_port": ""},
    {"id": "ovpn-ru3", "country": "RU", "port": 9208, "vpn_port": ""},
    # New / deepen coverage
    {"id": "ovpn-de", "country": "DE", "port": 9209, "vpn_port": ""},
    {"id": "ovpn-de2", "country": "DE", "port": 9210, "vpn_port": ""},
    {"id": "ovpn-gb", "country": "GB", "port": 9211, "vpn_port": ""},
    {"id": "ovpn-gb2", "country": "GB", "port": 9212, "vpn_port": ""},
    {"id": "ovpn-fr", "country": "FR", "port": 9213, "vpn_port": ""},
    {"id": "ovpn-fr2", "country": "FR", "port": 9214, "vpn_port": ""},
    {"id": "ovpn-ca", "country": "CA", "port": 9215, "vpn_port": ""},
    {"id": "ovpn-ca2", "country": "CA", "port": 9216, "vpn_port": ""},
    {"id": "ovpn-au", "country": "AU", "port": 9217, "vpn_port": ""},
    {"id": "ovpn-au2", "country": "AU", "port": 9218, "vpn_port": ""},
    {"id": "ovpn-vn", "country": "VN", "port": 9196, "vpn_port": ""},
    {"id": "ovpn-tw", "country": "TW", "port": 9197, "vpn_port": ""},
    {"id": "ovpn-th", "country": "TH", "port": 9183, "vpn_port": ""},
    {"id": "ovpn-ro", "country": "RO", "port": 9173, "vpn_port": ""},
    # Datacenter quota (fixed 3 allow ports) — egress DC allowed; prefer DC entries
    {"id": "ovpn-dc1", "country": "ANY", "port": 9219, "vpn_port": "", "allow_datacenter": True},
    {"id": "ovpn-dc2", "country": "ANY", "port": 9220, "vpn_port": "", "allow_datacenter": True},
    {"id": "ovpn-dc3", "country": "ANY", "port": 9221, "vpn_port": "", "allow_datacenter": True},
]

_NODES_AT = 0.0
_SKIP: set[str] = set()
_POOL = None  # kui.vpngate.NodePool
MAX_FAILURES = 3
COUNTRY_FALLBACK_AFTER = 2
PENALIZE_REDIAL = 3000
PENALIZE_FAIL = 10000
PENALIZE_TIMEOUT = 5000
PENALIZE_COUNTRY_MISMATCH = 20000
PENALIZE_UNKNOWN = 5000
PENALIZE_DATACENTER = 50000
PENALIZE_PROBE_FAIL = 3000


def stamp(msg: str) -> None:
    LOG.open("a").write(time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + msg + "\n")


def node_pool():
    global _POOL
    if _POOL is None:
        from kui.vpngate import NodePool

        _POOL = NodePool()
    return _POOL


NODES_STATUS = BIN / "ovpn-nodes.json"


def dump_nodes_snapshot() -> None:
    """Persist candidate list (sans config) for the admin API / UI."""
    try:
        rows = []
        type_counts: dict[str, int] = {}
        for row in node_pool().list_nodes("ANY"):
            ip = str(row.get("ip") or "")
            full = node_pool().get(ip, "ANY") if ip else None
            proto = port = ""
            if full:
                proto, port = parse_proto_port(full.get("config") or "")
                # Prefer annotated fields from full node when present.
                for key in (
                    "entry_egress_type",
                    "entry_egress_type_label",
                    "entry_isp_org",
                    "entry_geo_country",
                    "entry_city",
                    "entry_is_residential",
                ):
                    if key in full and key not in row:
                        row[key] = full[key]
            et = str(row.get("entry_egress_type") or "")
            if et:
                type_counts[et] = type_counts.get(et, 0) + 1
            rows.append(
                {
                    "ip": ip,
                    "country": row.get("country"),
                    "ping": row.get("ping"),
                    "score": row.get("score"),
                    "port": port,
                    "proto": proto,
                    "remote": f"{ip}:{port}" if ip and port else ip,
                    "entry_egress_type": row.get("entry_egress_type") or "",
                    "entry_egress_type_label": row.get("entry_egress_type_label") or "",
                    "entry_isp_org": row.get("entry_isp_org") or "",
                    "entry_geo_country": row.get("entry_geo_country") or "",
                    "entry_city": row.get("entry_city") or "",
                    "entry_is_residential": bool(row.get("entry_is_residential"))
                    if "entry_is_residential" in row
                    else None,
                }
            )
        NODES_STATUS.write_text(
            json.dumps(
                {
                    "updated": int(time.time()),
                    "counts": node_pool().counts(),
                    "entry_type_counts": type_counts,
                    "nodes": rows,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
    except OSError as e:
        stamp(f"dump nodes failed: {e}")


def _apply_entry_prefilter(tcp_nodes: list[dict]) -> None:
    """Batch-classify VPNGate entry IPs and soft-demote datacenter (heuristic)."""
    from kui.entry_meta import classify_entries, soft_penalty_for

    ips = [str(n.get("ip") or "") for n in tcp_nodes if n.get("ip")]
    if not ips:
        return
    t0 = time.time()
    try:
        metas = classify_entries(ips, max_workers=8, timeout=8)
    except Exception as e:
        stamp(f"entry prefilter classify failed: {e}")
        return
    allow = allow_non_residential()
    soft = {
        ip: soft_penalty_for(str((meta or {}).get("egress_type") or "unverified"), allow_non_residential=allow)
        for ip, meta in metas.items()
    }
    pool = node_pool()
    pool.set_soft_penalties(soft)
    pool.annotate_entries(metas)
    from collections import Counter

    types = Counter(str((m or {}).get("egress_type") or "unverified") for m in metas.values())
    stamp(
        f"entry prefilter n={len(metas)} types={dict(types)} "
        f"allow_non_res={int(allow)} elapsed={time.time() - t0:.1f}s"
    )


def refresh_nodes(force: bool = False) -> list[dict]:
    global _NODES_AT
    if not force and _NODES_AT and time.time() - _NODES_AT < 300 and node_pool().counts():
        return list(node_pool()._nodes.values())  # noqa: SLF001 — mirror kui snapshot access
    from kui.vpngate import fetch_nodes

    nodes = fetch_nodes(timeout=25)
    # Keep TCP-capable profiles only for this userns OpenVPN path.
    tcp_nodes = []
    for n in nodes:
        proto, _port = parse_proto_port(n.get("config") or "")
        if proto.startswith("tcp"):
            tcp_nodes.append(n)
    node_pool().replace(tcp_nodes)
    _apply_entry_prefilter(tcp_nodes)
    _NODES_AT = time.time()
    stamp(f"node pool refresh n={len(tcp_nodes)} countries={node_pool().counts()}")
    dump_nodes_snapshot()
    return tcp_nodes


def read_int(path: Path, default: int = 0) -> int:
    try:
        return int(path.read_text().strip() or default)
    except Exception:
        return default


def write_int(path: Path, value: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(int(value)) + "\n")


def bump_generation(slot_dir: Path) -> int:
    gen = read_int(slot_dir / "GENERATION", 0) + 1
    write_int(slot_dir / "GENERATION", gen)
    return gen


def generation_of(slot_dir: Path) -> int:
    return read_int(slot_dir / "GENERATION", 0)


def failures_of(slot_dir: Path) -> int:
    return read_int(slot_dir / "FAILURES", 0)


def set_failures(slot_dir: Path, n: int) -> None:
    write_int(slot_dir / "FAILURES", max(0, n))


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
    """Record remote so this slot won't reselect it soon. Callers penalize NodePool separately."""
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


def active_entry_ips(excluding: str = "") -> set[str]:
    used: set[str] = set()
    if not ROOT.exists():
        return used
    for d in ROOT.iterdir():
        if not d.is_dir() or d.name == excluding:
            continue
        cfg = d / "client.ovpn"
        if not cfg.exists():
            continue
        remote = remote_of(cfg.read_text(errors="replace"))
        if remote:
            used.add(remote.split(":", 1)[0])
    return used


def list_candidates(
    country: str,
    want_port: str = "",
    excluded: set[str] | None = None,
    *,
    limit: int = 40,
) -> list[dict]:
    refresh_nodes()
    excluded = set(excluded or set())
    # excluded may contain ip or ip:port — normalize to ips + remotes
    excluded_ips = {e.split(":", 1)[0] for e in excluded}
    rows = node_pool().list_nodes(country if country != "ANY" else "ANY")
    out: list[dict] = []
    for row in rows:
        ip = str(row.get("ip") or "")
        if not ip or ip in excluded_ips:
            continue
        full = node_pool().get(ip, country if country not in {"", "ANY"} else "ANY") or node_pool().get(ip, "ANY")
        if not full:
            continue
        proto, port = parse_proto_port(full.get("config") or "")
        if not proto.startswith("tcp"):
            continue
        if want_port and port != want_port:
            continue
        key = f"{ip}:{port}"
        if key in excluded:
            continue
        out.append(
            {
                "ip": ip,
                "country": full.get("country"),
                "ping": full.get("ping"),
                "score": full.get("score"),
                "port": port,
                "proto": proto,
                "remote": key,
                "config": full.get("config"),
                "entry_egress_type": full.get("entry_egress_type") or row.get("entry_egress_type") or "",
                "entry_egress_type_label": full.get("entry_egress_type_label")
                or row.get("entry_egress_type_label")
                or "",
                "entry_isp_org": full.get("entry_isp_org") or row.get("entry_isp_org") or "",
                "entry_geo_country": full.get("entry_geo_country") or row.get("entry_geo_country") or "",
            }
        )
        if len(out) >= limit:
            break
    return out


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


def probe(port: int, timeout: int = 5) -> str:
    """SOCKS egress probe. Keep timeout short — 24 serial slots must not stall the loop."""
    r = subprocess.run(
        [
            "curl",
            "-fsS",
            "--max-time",
            str(max(2, int(timeout))),
            "--socks5-hostname",
            f"127.0.0.1:{port}",
            "https://api.ipify.org",
        ],
        capture_output=True,
        text=True,
    )
    ip = (r.stdout or "").strip()
    return ip if r.returncode == 0 and ip else ""


def teardown_tunnel(slot_dir: Path, *, drop_cfg: bool = False) -> None:
    for name in ("openvpn.pid", "openvpn-host.pid", "fwd.pid", "ns-socks.pid"):
        kill_pidfile(slot_dir / name)
    if drop_cfg:
        try:
            (slot_dir / "client.ovpn").unlink()
        except OSError:
            pass


def openvpn_initialized(slot_dir: Path) -> bool:
    pid = read_pid(slot_dir / "openvpn.pid")
    if not pid_alive(pid):
        return False
    log = slot_dir / "openvpn.log"
    if not log.exists():
        return False
    try:
        return "Initialization Sequence Completed" in log.read_text(errors="replace")
    except OSError:
        return False


def health_fails_of(slot_dir: Path) -> int:
    return read_int(slot_dir / "HEALTH_FAILS", 0)


def set_health_fails(slot_dir: Path, n: int) -> None:
    write_int(slot_dir / "HEALTH_FAILS", max(0, n))


def remote_of(cfg: str) -> str:
    for line in cfg.splitlines():
        if line.startswith("remote "):
            parts = line.split()
            return f"{parts[1]}:{parts[2]}" if len(parts) >= 3 else parts[1]
    return ""


def used_remotes() -> set[str]:
    used = set(_SKIP)
    for d in ROOT.iterdir() if ROOT.exists() else []:
        p = d / "client.ovpn"
        if p.exists():
            used.add(remote_of(p.read_text(errors="replace")))
    return used


def take_preferred_ip(slot_dir: Path) -> str:
    p = slot_dir / "CONNECT"
    if not p.exists():
        return ""
    try:
        ip = p.read_text(errors="replace").strip().split()[0]
    except Exception:
        ip = ""
    try:
        p.unlink()
    except OSError:
        pass
    return ip


def country_fallback_allowed(slot_dir: Path, country: str) -> bool:
    return country not in {"", "ANY"} and failures_of(slot_dir) >= COUNTRY_FALLBACK_AFTER


def select_node(
    slot: dict,
    slot_dir: Path,
    *,
    preferred_ip: str = "",
    allow_fallback: bool | None = None,
) -> dict:
    """Pick a VPNGate TCP node via NodePool (kui-local-multi-exit aligned)."""
    refresh_nodes()
    country = slot["country"]
    want = str(slot.get("vpn_port") or "").strip()
    if allow_fallback is None:
        allow_fallback = country_fallback_allowed(slot_dir, country)

    # Exclude other slots' entry IPs + this slot's recent SKIP remotes.
    excluded_ips = active_entry_ips(excluding=slot["id"]) | {r.split(":", 1)[0] for r in load_slot_skips(slot_dir)}
    excluded_ips |= {r.split(":", 1)[0] for r in used_remotes() if ":" in r or r}
    # Soft process-level skips
    excluded_ips |= {r.split(":", 1)[0] for r in _SKIP}

    def _tcp_ok(node: dict | None) -> dict | None:
        if not node:
            return None
        proto, _port = parse_proto_port(node.get("config") or "")
        return node if proto.startswith("tcp") else None

    def _match_port(node: dict | None) -> dict | None:
        node = _tcp_ok(node)
        if not node:
            return None
        if not want:
            return node
        _proto, port = parse_proto_port(node.get("config") or "")
        return node if port == want else None

    prefer_dc_entry = bool(slot.get("allow_datacenter"))

    def _is_softether(ip: str) -> bool:
        # VPNGate relay farm; almost never completes a useful residential egress dial.
        return ip.startswith("219.100.37.")

    def _select(cc: str, *, require_want: bool) -> dict | None:
        # Walk NodePool order (already ping+penalty sorted) instead of refetching.
        # Datacenter-quota slots: annotated DC entries first, but keep pool order
        # within each group so dial/soft penalties still sink bad SoftEther hosts.
        rows = node_pool().list_nodes(cc if cc != "ANY" else "ANY")
        if prefer_dc_entry:
            dc_rows = [r for r in rows if str(r.get("entry_egress_type") or "").lower() == "datacenter"]
            other_rows = [r for r in rows if str(r.get("entry_egress_type") or "").lower() != "datacenter"]
            # SoftEther last even inside DC prefer — they dial-fail constantly.
            dc_rows = [r for r in dc_rows if not _is_softether(str(r.get("ip") or ""))] + [
                r for r in dc_rows if _is_softether(str(r.get("ip") or ""))
            ]
            rows = dc_rows + other_rows
        for row in rows:
            ip = str(row.get("ip") or "")
            if not ip or ip in excluded_ips:
                continue
            # Residential slots: never burn dial budget on SoftEther 443 farm.
            if not prefer_dc_entry and _is_softether(ip):
                continue
            full = node_pool().get(ip, cc if cc != "ANY" else "ANY") or node_pool().get(ip, "ANY")
            if require_want:
                full = _match_port(full)
            else:
                full = _tcp_ok(full)
            if full:
                return full
        return None

    node = None
    fallback = False
    if preferred_ip:
        node = _match_port(node_pool().get(preferred_ip, country)) or _match_port(
            node_pool().get(preferred_ip, "ANY")
        )
        if node is None:
            # Preferred IP may be wrong country / wrong port — still honour exact IP if TCP.
            node = _tcp_ok(node_pool().get(preferred_ip, "ANY"))
        if node and node["ip"] in excluded_ips:
            node = None
        if node is None:
            stamp(f"{slot['id']} preferred {preferred_ip} unavailable, auto select")

    if node is None:
        node = _select(country, require_want=bool(want))
        if node is None and want:
            stamp(f"{slot['id']} no tcp/{want} for {country}, fallback any tcp")
            node = _select(country, require_want=False)
        # kui: empty target pool always may cross-country; else after failure streak.
        if node is None and country != "ANY":
            # Prefer other countries first (kui excludes target country).
            # Cross-country only when streak allows OR target country truly empty.
            target_empty = _select(country, require_want=False) is None
            if allow_fallback or target_empty:
                alt = None
                for row in node_pool().list_nodes("ANY"):
                    ip = str(row.get("ip") or "")
                    if not ip or ip in excluded_ips or row.get("country") == country:
                        continue
                    full = _tcp_ok(node_pool().get(ip, "ANY"))
                    if full:
                        alt = full
                        break
                if alt:
                    node = alt
                    fallback = True
                    stamp(
                        f"{slot['id']} country_fallback "
                        f"{'empty-pool' if target_empty else 'after-failures'} -> {alt.get('country')}"
                    )

    if node is None:
        # Force refresh once then retry without soft skips / without slot skip history.
        refresh_nodes(force=True)
        excluded_ips = active_entry_ips(excluding=slot["id"])
        node = node_pool().select(country, excluded_ips)
        node = _tcp_ok(node)
        if node is None and country != "ANY":
            node = _tcp_ok(node_pool().select("ANY", excluded_ips))
            if node and node.get("country") != country:
                fallback = True

    if not node:
        raise RuntimeError(f"no tcp VPNGate for {country} (want={want or 'any'}); distribution={node_pool().counts()}")

    proto, port = parse_proto_port(node.get("config") or "")
    remote = f"{node['ip']}:{port}" if port else node["ip"]
    meta = {
        "ip": node["ip"],
        "country": node.get("country"),
        "ping": node.get("ping"),
        "score": node.get("score"),
        "port": port,
        "proto": proto,
        "remote": remote,
        "config": node["config"],
        "country_fallback": bool(fallback),
        "target_country": country if fallback else "",
    }
    stamp(
        f"{slot['id']} pick {remote} ping={meta.get('ping')} "
        f"cc={meta.get('country')} fallback={int(fallback)} failures={failures_of(slot_dir)}"
    )
    return meta


def pick_profile(slot: dict, slot_dir: Path | None = None) -> str:
    slot_dir = slot_dir or (ROOT / slot["id"])
    preferred = take_preferred_ip(slot_dir)
    return select_node(slot, slot_dir, preferred_ip=preferred)["config"]


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


def ensure_openvpn(nspid: int, slot: dict, slot_dir: Path, *, start_gen: int | None = None) -> dict:
    """Dial OpenVPN inside the netns. Returns meta about last attempt.

    Always starts a fresh dial. Callers must not invoke this for healthy SOCKS slots;
    stale "Initialization Sequence Completed" banners are never treated as success alone.
    """
    last_meta: dict = {"ok": False, "remote": "", "reused": False}
    preferred = take_preferred_ip(slot_dir)
    log = slot_dir / "openvpn.log"
    # Drop any leftover tunnel before first try.
    kill_pidfile(slot_dir / "openvpn.pid")
    kill_pidfile(slot_dir / "openvpn-host.pid")
    for _try in range(5):
        if start_gen is not None and generation_of(slot_dir) != start_gen:
            stamp(f"{slot['id']} generation changed during dial, abort")
            last_meta["stale"] = True
            return last_meta
        cfg = slot_dir / "client.ovpn"
        try:
            # Only consume preferred IP on the first attempt of this dial cycle.
            meta = select_node(
                slot,
                slot_dir,
                preferred_ip=preferred if _try == 0 else "",
            )
            cfg.write_text(meta["config"])
        except RuntimeError as e:
            stamp(f"{slot['id']} {e}")
            last_meta["error"] = str(e)
            return last_meta
        remote = meta.get("remote") or remote_of(cfg.read_text())
        last_meta = {**meta, "ok": False, "reused": False}
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
        timed_out = True
        for _ in range(22):
            if start_gen is not None and generation_of(slot_dir) != start_gen:
                stamp(f"{slot['id']} generation changed mid-wait, abort")
                kill_pidfile(slot_dir / "openvpn.pid")
                kill_pidfile(slot_dir / "openvpn-host.pid")
                last_meta["stale"] = True
                return last_meta
            time.sleep(1)
            text = log.read_text(errors="replace") if log.exists() else ""
            if "Initialization Sequence Completed" in text:
                stamp(f"{slot['id']} openvpn ready {remote}")
                ok = True
                timed_out = False
                break
            if "AUTH_FAILED" in text or "Exiting due" in text:
                stamp(f"{slot['id']} openvpn fail {remote}")
                timed_out = False
                break
        if ok:
            set_failures(slot_dir, 0)
            last_meta["ok"] = True
            # Persist fallback markers for status UI.
            if meta.get("country_fallback"):
                (slot_dir / "COUNTRY_FALLBACK").write_text(
                    f"{meta.get('country')}|{meta.get('target_country')}\n"
                )
            else:
                try:
                    (slot_dir / "COUNTRY_FALLBACK").unlink()
                except OSError:
                    pass
            return last_meta
        # Timeout or auth fail: penalize + remember remote and try next candidate.
        amount = PENALIZE_TIMEOUT if timed_out else PENALIZE_FAIL
        ip = str(meta.get("ip") or remote.split(":", 1)[0])
        if ip:
            node_pool().penalize(ip, amount)
        remember_skip(slot_dir, remote)
        stamp(f"{slot['id']} openvpn try={_try + 1}/5 skip {remote} penalize={amount}")
        try:
            cfg.unlink()
        except OSError:
            pass
        kill_pidfile(slot_dir / "openvpn.pid")
        kill_pidfile(slot_dir / "openvpn-host.pid")
    # Exhausted retries in this dial cycle → bump consecutive failure streak.
    fails = failures_of(slot_dir) + 1
    set_failures(slot_dir, fails)
    last_meta["failures"] = fails
    if fails >= MAX_FAILURES:
        (slot_dir / "DISABLED").write_text(
            f"auto-disabled after {fails} consecutive dial failures\n"
        )
        stamp(f"{slot['id']} DISABLED after {fails} failures")
        last_meta["disabled"] = True
    return last_meta


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


def heal_socks(slot: dict, slot_dir: Path) -> str:
    """Kill+restart host-fwd/ns-socks while OpenVPN stays up. Returns probe IP or ""."""
    nspid = read_pid(slot_dir / "ns.pid")
    if not pid_alive(nspid):
        # Do not create a fresh netns under a still-running OpenVPN in the old ns.
        return ""
    # Zombie bridges often keep PIDs alive while unix/tun is wedged — always recreate.
    kill_pidfile(slot_dir / "fwd.pid")
    kill_pidfile(slot_dir / "ns-socks.pid")
    unix = BIN / "socks" / f"{slot['id']}.unix"
    try:
        if unix.exists() or unix.is_symlink():
            unix.unlink()
    except OSError:
        pass
    time.sleep(0.2)
    ensure_socks(nspid, slot, slot_dir)
    time.sleep(0.5)
    return probe(slot["port"], timeout=4)


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
    excluded = active_entry_ips(excluding=slot["id"]) | {r.split(":", 1)[0] for r in load_slot_skips(slot_dir)}
    n = len(list_candidates(slot["country"], want, excluded))
    if n == 0 and want:
        n = len(list_candidates(slot["country"], "", excluded))
    if n == 0 and country_fallback_allowed(slot_dir, slot["country"]):
        n = len(list_candidates("ANY", "", excluded))
    return n


def slot_status_extra(slot: dict, slot_dir: Path, remote: str = "") -> dict:
    fallback = ""
    target = ""
    fb = slot_dir / "COUNTRY_FALLBACK"
    if fb.exists():
        try:
            parts = fb.read_text(errors="replace").strip().split("|", 1)
            fallback = parts[0]
            target = parts[1] if len(parts) > 1 else slot["country"]
        except OSError:
            pass
    return {
        "remote": remote,
        "candidates": candidate_count(slot, slot_dir),
        "generation": generation_of(slot_dir),
        "failures": failures_of(slot_dir),
        "country_fallback": bool(fallback),
        "fallback_country": fallback or "",
        "target_country": target or "",
        "allow_datacenter": bool(slot.get("allow_datacenter")),
    }


def with_egress_meta(row: dict, slot_dir: Path) -> dict:
    """Attach kui-style egress_type / isp_org (TestISP → ip-api → ippure)."""
    from kui.egress_meta import attach_meta

    return attach_meta(row, slot_dir, timeout=8)


def allow_non_residential() -> bool:
    """Default false (stricter than kui compose). Env can reopen datacenter publishes."""
    for key in ("ALLOW_NON_RESIDENTIAL", "KUI_ALLOW_NON_RESIDENTIAL"):
        val = str(os.environ.get(key, "")).strip().lower()
        if val in {"1", "true", "yes", "on"}:
            return True
    return False


def _entry_from_remote(remote: str) -> str:
    remote = str(remote or "").strip()
    return remote.split(":", 1)[0] if remote else ""


def reject_ready(
    slot: dict,
    slot_dir: Path,
    *,
    remote: str,
    reason: str,
    penalty: int,
    meta: dict | None = None,
    targets: dict | None = None,
) -> dict:
    """Penalize entry, drop tunnel profile, publish boot with check_result reject."""
    import time as _time

    from kui.egress_meta import residential_summary

    entry = _entry_from_remote(remote)
    if remote:
        remember_skip(slot_dir, remote)
    if entry:
        node_pool().penalize(entry, penalty)
    teardown_tunnel(slot_dir, drop_cfg=True)
    stamp(f"{slot['id']} reject ready reason={reason} penalize={entry or '-'} amount={penalty}")
    check_result = {
        "residential": residential_summary(meta or {}),
        "targets": targets or {},
        "reject_reason": reason,
        "checked_at": int(_time.time()),
    }
    return {
        **slot,
        "state": "boot",
        "egress_ip": "",
        "kind": "openvpn",
        "egress_type": (meta or {}).get("egress_type") or "unverified",
        "egress_type_label": (meta or {}).get("egress_type_label") or "未验证IP",
        "isp_org": (meta or {}).get("isp_org") or "",
        "geo_country": (meta or {}).get("geo_country") or "",
        "city": (meta or {}).get("city") or "",
        "reject_reason": reason,
        "check_result": check_result,
        **slot_status_extra(slot, slot_dir),
    }


def gate_ready_exit(slot: dict, slot_dir: Path, ip: str, remote: str) -> dict | None:
    """Country mismatch → residential → SOCKS probe set. None = pass; else boot reject row."""
    import re
    import time as _time

    from kui.egress_meta import meta_for_ip, residential_summary
    from kui.vpngate import probe_targets_socks

    meta = meta_for_ip(slot_dir, ip, force=False, timeout=8)
    extra = slot_status_extra(slot, slot_dir, remote)
    target_cc = str(slot.get("country") or "").upper()
    geo_cc = str(meta.get("geo_country") or "").upper()
    fallback = bool(extra.get("country_fallback"))

    if (
        not fallback
        and target_cc
        and target_cc not in {"ANY", "XX"}
        and re.fullmatch(r"[A-Z]{2}", geo_cc)
        and geo_cc != target_cc
    ):
        return reject_ready(
            slot,
            slot_dir,
            remote=remote,
            reason="country_mismatch",
            penalty=PENALIZE_COUNTRY_MISMATCH,
            meta=meta,
        )

    egress_type = str(meta.get("egress_type") or "unverified").lower()
    slot_allow_dc = bool(slot.get("allow_datacenter"))
    if egress_type == "residential":
        pass
    elif egress_type == "enterprise":
        # Enterprise/mixed egress is publishable; entry soft-penalty still demotes them at pick time.
        pass
    elif egress_type == "datacenter" and (slot_allow_dc or allow_non_residential()):
        via = "slot-allow_datacenter" if slot_allow_dc else "ALLOW_NON_RESIDENTIAL"
        stamp(f"{slot['id']} allow datacenter via {via} ip={ip}")
    else:
        reason = "datacenter" if egress_type == "datacenter" else "unknown_type"
        penalty = PENALIZE_DATACENTER if egress_type == "datacenter" else PENALIZE_UNKNOWN
        return reject_ready(
            slot,
            slot_dir,
            remote=remote,
            reason=reason,
            penalty=penalty,
            meta=meta,
        )

    targets = probe_targets_socks("127.0.0.1", int(slot["port"]), timeout=8)
    if not targets.get("accepted"):
        return reject_ready(
            slot,
            slot_dir,
            remote=remote,
            reason="probe_fail",
            penalty=PENALIZE_PROBE_FAIL,
            meta=meta,
            targets=targets,
        )

    check_result = {
        "residential": residential_summary(meta),
        "targets": targets,
        "reject_reason": "",
        "checked_at": int(_time.time()),
    }
    try:
        (slot_dir / "CHECK_RESULT").write_text(
            json.dumps(check_result, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    except OSError:
        pass
    return None


def load_check_result(slot_dir: Path) -> dict:
    path = slot_dir / "CHECK_RESULT"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def publish_ready(slot: dict, slot_dir: Path, ip: str, remote: str) -> dict:
    """Run gates; on pass attach meta + check_result and publish ready."""
    rejected = gate_ready_exit(slot, slot_dir, ip, remote)
    if rejected is not None:
        return rejected
    check_result = load_check_result(slot_dir)
    residential = check_result.get("residential") if isinstance(check_result.get("residential"), dict) else {}
    row = {
        **slot,
        "state": "ready",
        "egress_ip": ip,
        "kind": "openvpn",
        "egress_type": residential.get("egress_type") or "unverified",
        "egress_type_label": residential.get("egress_type_label") or "未验证IP",
        "isp_org": residential.get("isp_org") or "",
        "geo_country": residential.get("geo_country") or "",
        "city": residential.get("city") or "",
        "is_residential": bool(residential.get("is_residential")),
        "reject_reason": "",
        "check_result": check_result,
        **slot_status_extra(slot, slot_dir, remote),
    }
    return row


def begin_redial(slot: dict, slot_dir: Path, *, reason: str) -> None:
    """Penalize current entry, bump generation, tear down tunnel (kui health/redial)."""
    entry_ip = ""
    remote = ""
    cfg = slot_dir / "client.ovpn"
    if cfg.exists():
        remote = remote_of(cfg.read_text(errors="replace"))
        entry_ip = remote.split(":", 1)[0] if remote else ""
        try:
            cfg.unlink()
        except OSError:
            pass
    mark = slot_dir / "REDIAL_ENTRY"
    if mark.exists():
        try:
            entry_ip = entry_ip or mark.read_text(errors="replace").strip().split()[0]
        except OSError:
            pass
        try:
            mark.unlink()
        except OSError:
            pass
    if entry_ip:
        node_pool().penalize(entry_ip, PENALIZE_REDIAL)
        if remote:
            remember_skip(slot_dir, remote)
        else:
            remember_skip(slot_dir, entry_ip)
    bump_generation(slot_dir)
    set_health_fails(slot_dir, 0)
    teardown_tunnel(slot_dir, drop_cfg=False)
    stamp(f"{slot['id']} auto-redial gen={generation_of(slot_dir)} reason={reason} penalize={entry_ip or '-'}")


def bring_up(slot: dict) -> dict:
    slot_dir = ROOT / slot["id"]
    slot_dir.mkdir(parents=True, exist_ok=True)

    def finish(row: dict) -> dict:
        return with_egress_meta(row, slot_dir)

    if (slot_dir / "DISABLED").exists():
        teardown_tunnel(slot_dir)
        return finish({
            **slot,
            "state": "down",
            "egress_ip": "",
            "kind": "openvpn",
            "disabled": True,
            **slot_status_extra(slot, slot_dir),
        })
    force = (slot_dir / "FORCE_REDIAL").exists()
    if force:
        try:
            (slot_dir / "FORCE_REDIAL").unlink()
        except OSError:
            pass
        begin_redial(slot, slot_dir, reason="force")
        try:
            refresh_nodes(force=False)
        except Exception as e:
            stamp(f"{slot['id']} node refresh on redial: {e}")
    # Manual connect preferred IP keeps generation bump if CONNECT present without FORCE.
    if (slot_dir / "CONNECT").exists() and not force:
        bump_generation(slot_dir)
        teardown_tunnel(slot_dir)
        stamp(f"{slot['id']} manual connect pending")
        force = True
    if slot["id"] == "ovpn-jp":
        adopt_legacy_jp()
    start_gen = generation_of(slot_dir)

    # Fast health path: if SOCKS still works, re-validate gates then publish ready.
    if not force:
        ip = probe(slot["port"], timeout=4)
        # OpenVPN up but SOCKS probe failed → always recreate bridge first.
        # Zombie fwd/ns-socks often keep PIDs alive; don't burn the tunnel yet.
        if not ip and openvpn_initialized(slot_dir):
            stamp(f"{slot['id']} socks probe miss while openvpn up, heal bridge")
            ip = heal_socks(slot, slot_dir)
            if ip:
                stamp(f"{slot['id']} socks healed ip={ip}")
        if ip:
            set_health_fails(slot_dir, 0)
            set_failures(slot_dir, 0)
            cfg = slot_dir / "client.ovpn"
            remote = remote_of(cfg.read_text(errors="replace")) if cfg.exists() else ""
            # Reuse cached CHECK_RESULT when same IP already gated this generation.
            cached = load_check_result(slot_dir)
            cached_ip = ""
            if isinstance(cached.get("residential"), dict):
                # Prefer EGRESS_META ip
                from kui.egress_meta import load_meta

                meta_cached = load_meta(slot_dir) or {}
                cached_ip = str(meta_cached.get("ip") or "")
            residential = cached.get("residential") if isinstance(cached.get("residential"), dict) else {}
            cached_geo = str(residential.get("geo_country") or "").strip().upper()
            cache_ok = (
                cached
                and cached.get("reject_reason") in (None, "")
                and cached_ip == ip
                and cached.get("targets", {}).get("accepted")
                and bool(re.fullmatch(r"[A-Z]{2}", cached_geo))
            )
            if cache_ok:
                return finish({
                    **slot,
                    "state": "ready",
                    "egress_ip": ip,
                    "kind": "openvpn",
                    "egress_type": residential.get("egress_type") or "unverified",
                    "egress_type_label": residential.get("egress_type_label") or "未验证IP",
                    "isp_org": residential.get("isp_org") or "",
                    "geo_country": residential.get("geo_country") or "",
                    "city": residential.get("city") or "",
                    "is_residential": bool(residential.get("is_residential")),
                    "reject_reason": "",
                    "check_result": cached,
                    **slot_status_extra(slot, slot_dir, remote),
                })
            return finish(publish_ready(slot, slot_dir, ip, remote))
        # Probe failed. If openvpn still claims initialized, count health fails then auto-redial.
        if openvpn_initialized(slot_dir):
            hf = health_fails_of(slot_dir) + 1
            set_health_fails(slot_dir, hf)
            stamp(f"{slot['id']} health-fail {hf}/2 (socks dead, openvpn still up)")
            if hf < 2:
                cfg = slot_dir / "client.ovpn"
                remote = remote_of(cfg.read_text(errors="replace")) if cfg.exists() else ""
                return finish({
                    **slot,
                    "state": "boot",
                    "egress_ip": "",
                    "kind": "openvpn",
                    **slot_status_extra(slot, slot_dir, remote),
                })
            begin_redial(slot, slot_dir, reason="health-socks")
            force = True
            start_gen = generation_of(slot_dir)
        else:
            # Process gone / never initialized — tear residual and redial.
            if read_pid(slot_dir / "openvpn.pid") or (slot_dir / "client.ovpn").exists():
                begin_redial(slot, slot_dir, reason="openvpn-dead")
                force = True
                start_gen = generation_of(slot_dir)

    nspid = make_netns(slot_dir)
    if not nspid:
        return finish({
            **slot,
            "state": "down",
            "egress_ip": "",
            "kind": "openvpn",
            **slot_status_extra(slot, slot_dir),
        })
    ensure_slirp(nspid, slot_dir)
    # Always dial fresh when we reached here (healthy path returned earlier).
    teardown_tunnel(slot_dir, drop_cfg=False)
    dial = ensure_openvpn(nspid, slot, slot_dir, start_gen=start_gen)
    if dial.get("disabled"):
        return finish({
            **slot,
            "state": "down",
            "egress_ip": "",
            "kind": "openvpn",
            "disabled": True,
            **slot_status_extra(slot, slot_dir, dial.get("remote") or ""),
        })
    if dial.get("stale"):
        return finish({
            **slot,
            "state": "boot",
            "egress_ip": "",
            "kind": "openvpn",
            **slot_status_extra(slot, slot_dir),
        })
    ensure_socks(nspid, slot, slot_dir)
    time.sleep(0.5)
    ip = probe(slot["port"], timeout=6)
    cfg = slot_dir / "client.ovpn"
    remote = remote_of(cfg.read_text(errors="replace")) if cfg.exists() else dial.get("remote") or ""
    if ip and ip in ready_ips():
        stamp(f"{slot['id']} duplicate egress {ip}, skip publish")
        remember_skip(slot_dir, remote)
        entry = remote.split(":", 1)[0] if remote else ""
        if entry:
            node_pool().penalize(entry, PENALIZE_FAIL)
        teardown_tunnel(slot_dir, drop_cfg=True)
        return finish({
            **slot,
            "state": "boot",
            "egress_ip": "",
            "kind": "openvpn",
            **slot_status_extra(slot, slot_dir),
        })
    if ip:
        set_failures(slot_dir, 0)
        set_health_fails(slot_dir, 0)
        return finish(publish_ready(slot, slot_dir, ip, remote))
    if dial.get("ok"):
        # OpenVPN said ready but SOCKS still dead — count as health fail and retry next loop.
        hf = health_fails_of(slot_dir) + 1
        set_health_fails(slot_dir, hf)
        stamp(f"{slot['id']} post-dial socks fail health={hf}")
        if hf >= 2:
            begin_redial(slot, slot_dir, reason="post-dial-socks")
    return finish({
        **slot,
        "state": "boot",
        "egress_ip": "",
        "kind": "openvpn",
        **slot_status_extra(slot, slot_dir, remote),
    })


def loop() -> None:
    PID_FILE.write_text(str(os.getpid()) + "\n")
    ROOT.mkdir(parents=True, exist_ok=True)
    (BIN / "socks").mkdir(exist_ok=True)
    stamp("ovpn slots start")
    # Manager restart must not inherit half-consumed HEALTH_FAILS → instant 2/2 redial storm.
    cleared = 0
    for slot in PLAN:
        sd = ROOT / slot["id"]
        if not sd.exists():
            continue
        if health_fails_of(sd) > 0:
            set_health_fails(sd, 0)
            cleared += 1
    if cleared:
        stamp(f"cleared HEALTH_FAILS on {cleared} slots after restart")
    try:
        refresh_nodes(force=True)
    except Exception as e:
        stamp(f"initial node refresh failed: {e}")
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
        # Faster loop when many slots are still booting / recovering.
        bootish = sum(1 for r in rows if r.get("state") != "ready" and not r.get("disabled"))
        time.sleep(8 if bootish else 20)


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    loop()
