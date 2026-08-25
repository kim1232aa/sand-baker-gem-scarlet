"""Ensure xray.json has a VLESS unix inbound + SOCKS outbound per slot."""
from __future__ import annotations

import json
from pathlib import Path

BIN = Path(__file__).resolve().parents[1]
UUID_FILE = BIN / "uuid"
DEFAULT_UUID = "a3f1c8e2-9b47-4d6a-8e21-c5f90b3d7a14"


def uuid() -> str:
    if UUID_FILE.exists():
        return UUID_FILE.read_text().strip() or DEFAULT_UUID
    return DEFAULT_UUID


def ensure(slots: list[dict]) -> bool:
    p = BIN / "xray.json"
    cfg = json.loads(p.read_text())
    have = {i.get("tag") for i in cfg.get("inbounds", [])}
    added = False
    uid = uuid()
    for slot in slots:
        tag = f"in-{slot['id']}"
        if tag in have:
            continue
        cfg["inbounds"].append(
            {
                "tag": tag,
                "listen": str(BIN / "socks" / f"in-{slot['id']}.sock"),
                "protocol": "vless",
                "settings": {"clients": [{"id": uid}], "decryption": "none"},
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
        cfg.setdefault("routing", {}).setdefault("rules", []).append(
            {"type": "field", "inboundTag": [tag], "outboundTag": f"socks-{slot['id']}"}
        )
        added = True
    if added:
        p.write_text(json.dumps(cfg, indent=2) + "\n")
    return added
