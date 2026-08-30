"""Cache TestISP / ip-api / ippure classification for exit IPs (kui-aligned)."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

# Keep cache across manager restarts; invalidate when egress IP changes.
META_NAME = "EGRESS_META"
CACHE_TTL_SEC = 6 * 3600

_TYPE_LABELS = {
    "residential": "住宅IP",
    "datacenter": "机房IP",
    "enterprise": "企业/混合网络IP",
    "unverified": "未验证IP",
}


def _normalize_type(raw: str | None) -> str:
    t = str(raw or "").strip().lower()
    if t in {"residential", "datacenter", "enterprise", "unverified"}:
        return t
    if t in {"unknown", ""}:
        return "unverified"
    return "unverified"


def _type_label(egress_type: str, detail: dict[str, Any] | None = None) -> str:
    if detail:
        explicit = str(detail.get("egress_type_label") or "").strip()
        if explicit:
            return explicit
    return _TYPE_LABELS.get(egress_type, "未验证IP")


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


def _geo_from_detail(detail: dict[str, Any]) -> tuple[str, str]:
    """Return (country_code, city) from TestISP / ip-api shaped detail."""
    raw = detail.get("raw") if isinstance(detail.get("raw"), dict) else {}
    geo = raw.get("geo") if isinstance(raw.get("geo"), dict) else {}
    cc = str(geo.get("country_code") or geo.get("countryCode") or "").strip().upper()
    city = str(geo.get("city") or "").strip()
    if not re.fullmatch(r"[A-Z]{2}", cc):
        # ip-api fallback shape stored directly in raw
        cc = str(raw.get("countryCode") or raw.get("country_code") or "").strip().upper()
        if not city:
            city = str(raw.get("city") or "").strip()
    if not re.fullmatch(r"[A-Z]{2}", cc):
        cc = ""
    return cc, city


def _raw_flag(detail: dict[str, Any]) -> str:
    raw = detail.get("raw") if isinstance(detail.get("raw"), dict) else {}
    isp = raw.get("isp") if isinstance(raw.get("isp"), dict) else {}
    return str(isp.get("flag") or "").strip().lower()


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
    """Return enriched classification for an egress IP."""
    ip = str(ip or "").strip()
    empty = {
        "egress_type": "unverified",
        "egress_type_label": "未验证IP",
        "is_residential": False,
        "isp_org": "",
        "geo_country": "",
        "city": "",
        "raw_flag": "",
        "source": "",
        "ip": ip,
        "checked_at": int(time.time()),
    }
    if not ip:
        return empty
    try:
        from kui.vpngate import check_residential

        ok, detail = check_residential(ip, timeout=timeout)
    except Exception as exc:
        return {**empty, "source": "error", "error": str(exc)[:200]}
    if not isinstance(detail, dict):
        detail = {}
    egress_type = _normalize_type(str(detail.get("egress_type") or ""))
    # Prefer explicit datacenter/residential from nested ippure if top-level unknown.
    if egress_type == "unverified":
        ippure = detail.get("ippure") if isinstance(detail.get("ippure"), dict) else {}
        nested = _normalize_type(str(ippure.get("egress_type") or ""))
        if nested in {"residential", "datacenter", "enterprise"}:
            egress_type = nested
            detail = {**detail, **{k: ippure.get(k) for k in ("egress_type_label", "organization") if ippure.get(k)}}
    geo_country, city = _geo_from_detail(detail)
    is_res = bool(detail.get("is_residential")) if "is_residential" in detail else egress_type == "residential"
    if ok and egress_type == "residential":
        is_res = True
    return {
        "egress_type": egress_type,
        "egress_type_label": _type_label(egress_type, detail),
        "is_residential": is_res,
        "isp_org": _isp_org_from_detail(detail),
        "geo_country": geo_country,
        "city": city,
        "raw_flag": _raw_flag(detail),
        "source": str(detail.get("source") or "testisp"),
        "checked_at": int(time.time()),
        "ip": ip,
    }


def _public_meta(meta: dict[str, Any], *, cached: bool = False) -> dict[str, Any]:
    egress_type = _normalize_type(str(meta.get("egress_type") or ""))
    out = {
        "egress_type": egress_type,
        "egress_type_label": str(meta.get("egress_type_label") or _type_label(egress_type)),
        "is_residential": bool(meta.get("is_residential")) if "is_residential" in meta else egress_type == "residential",
        "isp_org": str(meta.get("isp_org") or ""),
        "geo_country": str(meta.get("geo_country") or "").upper(),
        "city": str(meta.get("city") or ""),
        "raw_flag": str(meta.get("raw_flag") or ""),
        "source": str(meta.get("source") or ""),
        "checked_at": int(meta.get("checked_at") or 0),
        "ip": str(meta.get("ip") or ""),
    }
    if cached:
        out["cached"] = True
    return out


def meta_for_ip(slot_dir: Path, ip: str, *, force: bool = False, timeout: int = 8) -> dict[str, Any]:
    """Cached classify: reuse EGRESS_META when same IP and fresh."""
    ip = str(ip or "").strip()
    if not ip:
        clear_meta(slot_dir)
        return _public_meta({"egress_type": "unverified", "isp_org": "", "source": ""})
    cached = load_meta(slot_dir)
    now = int(time.time())
    cached_geo = str((cached or {}).get("geo_country") or "").strip().upper()
    # Treat missing geo as stale so country gates / friendly names can fill in.
    if (
        not force
        and cached
        and cached.get("ip") == ip
        and _normalize_type(str(cached.get("egress_type") or ""))
        and re.fullmatch(r"[A-Z]{2}", cached_geo)
        and int(cached.get("checked_at") or 0) + CACHE_TTL_SEC > now
    ):
        return _public_meta(cached, cached=True)
    meta = classify_egress(ip, timeout=timeout)
    save_meta(slot_dir, meta)
    return _public_meta(meta)


def attach_meta(row: dict[str, Any], slot_dir: Path, *, timeout: int = 8) -> dict[str, Any]:
    """Attach classification fields onto a status row when ready + has IP."""
    ip = str(row.get("egress_ip") or "").strip()
    if row.get("state") != "ready" or not ip:
        return {
            **row,
            "egress_type": row.get("egress_type") or "unverified",
            "egress_type_label": row.get("egress_type_label") or "未验证IP",
            "isp_org": row.get("isp_org") or "",
            "geo_country": row.get("geo_country") or "",
            "city": row.get("city") or "",
        }
    meta = meta_for_ip(slot_dir, ip, timeout=timeout)
    return {
        **row,
        "egress_type": meta.get("egress_type") or "unverified",
        "egress_type_label": meta.get("egress_type_label") or "未验证IP",
        "isp_org": meta.get("isp_org") or "",
        "geo_country": meta.get("geo_country") or "",
        "city": meta.get("city") or "",
        "is_residential": bool(meta.get("is_residential")),
    }


def residential_summary(meta: dict[str, Any]) -> dict[str, Any]:
    """Compact residential block for check_result."""
    egress_type = _normalize_type(str(meta.get("egress_type") or ""))
    return {
        "egress_type": egress_type,
        "egress_type_label": str(meta.get("egress_type_label") or _type_label(egress_type)),
        "is_residential": bool(meta.get("is_residential")) if "is_residential" in meta else egress_type == "residential",
        "isp_org": str(meta.get("isp_org") or ""),
        "geo_country": str(meta.get("geo_country") or "").upper(),
        "city": str(meta.get("city") or ""),
        "source": str(meta.get("source") or ""),
    }
