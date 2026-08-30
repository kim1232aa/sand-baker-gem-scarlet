"""Cache TestISP / ip-api / ippure classification for exit IPs (kui-aligned)."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

# Keep cache across manager restarts; invalidate when egress IP changes.
META_NAME = "EGRESS_META"
CACHE_TTL_SEC = 6 * 3600


def _normalize_type(raw: str | None) -> str:
    t = str(raw or "").strip().lower()
    if t in {"residential", "datacenter", "enterprise", "unverified"}:
        return t
    if t in {"unknown", ""}:
        return "unverified"
    return "unverified"


def _isp_org_from_detail(detail: dict[str, Any]) -> str:
    raw = detail.get("raw")
    if isinstance(raw, dict):
        isp = raw.get("isp")
        if isinstance(isp, dict):
            org = str(isp.get("org") or "").strip()
            if org:
                return org
        org = str(raw.get("org") or raw.get("isp") or raw.get("asname") or "").strip()
        if org:
            return org
    org = str(detail.get("organization") or "").strip()
    if org:
        return org
    ippure = detail.get("ippure")
    if isinstance(ippure, dict):
        return str(ippure.get("organization") or "").strip()
    return ""


def load_meta(slot_dir: Path) -> dict[str, Any] | None:
    path = slot_dir / META_NAME
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def save_meta(slot_dir: Path, meta: dict[str, Any]) -> None:
    slot_dir.mkdir(parents=True, exist_ok=True)
    path = slot_dir / META_NAME
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def clear_meta(slot_dir: Path) -> None:
    path = slot_dir / META_NAME
    try:
        path.unlink()
    except OSError:
        pass


def classify_egress(ip: str, *, timeout: int = 8) -> dict[str, Any]:
    """Return {egress_type, isp_org, source} for an egress IP."""
    ip = str(ip or "").strip()
    if not ip:
        return {"egress_type": "unverified", "isp_org": "", "source": ""}
    try:
        from kui.vpngate import check_residential

        _ok, detail = check_residential(ip, timeout=timeout)
    except Exception as exc:
        return {
            "egress_type": "unverified",
            "isp_org": "",
            "source": "error",
            "error": str(exc)[:200],
        }
    if not isinstance(detail, dict):
        detail = {}
    egress_type = _normalize_type(str(detail.get("egress_type") or ""))
    # Prefer explicit datacenter/residential from nested ippure if top-level unknown.
    if egress_type == "unverified":
        ippure = detail.get("ippure") if isinstance(detail.get("ippure"), dict) else {}
        nested = _normalize_type(str(ippure.get("egress_type") or ""))
        if nested in {"residential", "datacenter", "enterprise"}:
            egress_type = nested
    return {
        "egress_type": egress_type,
        "isp_org": _isp_org_from_detail(detail),
        "source": str(detail.get("source") or "testisp"),
        "checked_at": int(time.time()),
        "ip": ip,
    }


def meta_for_ip(slot_dir: Path, ip: str, *, force: bool = False, timeout: int = 8) -> dict[str, Any]:
    """Cached classify: reuse EGRESS_META when same IP and fresh."""
    ip = str(ip or "").strip()
    if not ip:
        clear_meta(slot_dir)
        return {"egress_type": "unverified", "isp_org": "", "source": ""}
    cached = load_meta(slot_dir)
    now = int(time.time())
    if (
        not force
        and cached
        and cached.get("ip") == ip
        and _normalize_type(str(cached.get("egress_type") or ""))
        and int(cached.get("checked_at") or 0) + CACHE_TTL_SEC > now
    ):
        return {
            "egress_type": _normalize_type(str(cached.get("egress_type"))),
            "isp_org": str(cached.get("isp_org") or ""),
            "source": str(cached.get("source") or ""),
            "checked_at": int(cached.get("checked_at") or 0),
            "ip": ip,
            "cached": True,
        }
    meta = classify_egress(ip, timeout=timeout)
    save_meta(slot_dir, meta)
    return meta


def attach_meta(row: dict[str, Any], slot_dir: Path, *, timeout: int = 8) -> dict[str, Any]:
    """Attach egress_type / isp_org onto a status row when ready + has IP."""
    ip = str(row.get("egress_ip") or "").strip()
    if row.get("state") != "ready" or not ip:
        return {
            **row,
            "egress_type": row.get("egress_type") or "unverified",
            "isp_org": row.get("isp_org") or "",
        }
    meta = meta_for_ip(slot_dir, ip, timeout=timeout)
    return {
        **row,
        "egress_type": meta.get("egress_type") or "unverified",
        "isp_org": meta.get("isp_org") or "",
    }
