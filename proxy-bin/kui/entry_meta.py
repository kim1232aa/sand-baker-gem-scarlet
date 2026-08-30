"""Batch-classify VPNGate *entry* IPs (pre-dial heuristic; entry ≠ egress)."""
from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

BIN = Path(os.environ.get("PROXY_BIN") or Path(__file__).resolve().parents[1])
CACHE_PATH = BIN / "entry-ip-meta.json"
CACHE_TTL_SEC = 6 * 3600

# Soft demotion only — dial-failure penalties stay separate and additive.
SOFT_RESIDENTIAL = 0
SOFT_ENTERPRISE = 8000
SOFT_DATACENTER = 25000
SOFT_DATACENTER_ALLOW = 5000  # when ALLOW_NON_RESIDENTIAL
SOFT_UNVERIFIED = 3000

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
    raw = detail.get("raw") if isinstance(detail.get("raw"), dict) else {}
    geo = raw.get("geo") if isinstance(raw.get("geo"), dict) else {}
    cc = str(geo.get("country_code") or geo.get("countryCode") or "").strip().upper()
    city = str(geo.get("city") or "").strip()
    if not re.fullmatch(r"[A-Z]{2}", cc):
        cc = str(raw.get("countryCode") or raw.get("country_code") or "").strip().upper()
        if not city:
            city = str(raw.get("city") or "").strip()
    if not re.fullmatch(r"[A-Z]{2}", cc):
        cc = ""
    return cc, city


def _public(meta: dict[str, Any]) -> dict[str, Any]:
    egress_type = _normalize_type(str(meta.get("egress_type") or ""))
    return {
        "egress_type": egress_type,
        "egress_type_label": str(meta.get("egress_type_label") or _TYPE_LABELS.get(egress_type, "未验证IP")),
        "is_residential": bool(meta.get("is_residential"))
        if "is_residential" in meta
        else egress_type == "residential",
        "isp_org": str(meta.get("isp_org") or ""),
        "geo_country": str(meta.get("geo_country") or "").upper(),
        "city": str(meta.get("city") or ""),
        "source": str(meta.get("source") or ""),
        "checked_at": int(meta.get("checked_at") or 0),
    }


def load_cache() -> dict[str, dict[str, Any]]:
    if not CACHE_PATH.exists():
        return {}
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for ip, meta in entries.items():
        if isinstance(meta, dict) and ip:
            out[str(ip)] = meta
    return out


def save_cache(entries: dict[str, dict[str, Any]]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Keep cache bounded: drop very old entries (> 7d) when rewriting.
    cutoff = int(time.time()) - 7 * 24 * 3600
    trimmed = {
        ip: meta
        for ip, meta in entries.items()
        if isinstance(meta, dict) and int(meta.get("checked_at") or 0) >= cutoff
    }
    payload = {"updated": int(time.time()), "entries": trimmed}
    tmp = CACHE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(CACHE_PATH)


def classify_one(ip: str, *, timeout: int = 8) -> dict[str, Any]:
    """Classify a single entry IP; never raises."""
    ip = str(ip or "").strip()
    empty = {
        "egress_type": "unverified",
        "egress_type_label": "未验证IP",
        "is_residential": False,
        "isp_org": "",
        "geo_country": "",
        "city": "",
        "source": "",
        "checked_at": int(time.time()),
        "ip": ip,
    }
    if not ip:
        return empty
    try:
        from kui.vpngate import check_residential

        _ok, detail = check_residential(ip, timeout=timeout)
    except Exception as exc:
        return {**empty, "source": "error", "error": str(exc)[:200]}
    if not isinstance(detail, dict):
        detail = {}
    egress_type = _normalize_type(str(detail.get("egress_type") or ""))
    if egress_type == "unverified":
        ippure = detail.get("ippure") if isinstance(detail.get("ippure"), dict) else {}
        nested = _normalize_type(str(ippure.get("egress_type") or ""))
        if nested in {"residential", "datacenter", "enterprise"}:
            egress_type = nested
            detail = {
                **detail,
                **{k: ippure.get(k) for k in ("egress_type_label", "organization") if ippure.get(k)},
            }
    geo_country, city = _geo_from_detail(detail)
    is_res = bool(detail.get("is_residential")) if "is_residential" in detail else egress_type == "residential"
    label = str(detail.get("egress_type_label") or "").strip() or _TYPE_LABELS.get(egress_type, "未验证IP")
    return {
        "egress_type": egress_type,
        "egress_type_label": label,
        "is_residential": is_res,
        "isp_org": _isp_org_from_detail(detail),
        "geo_country": geo_country,
        "city": city,
        "source": str(detail.get("source") or "testisp"),
        "checked_at": int(time.time()),
        "ip": ip,
    }


def soft_penalty_for(egress_type: str, *, allow_non_residential: bool = False) -> int:
    t = _normalize_type(egress_type)
    if t == "residential":
        return SOFT_RESIDENTIAL
    if t == "enterprise":
        return SOFT_ENTERPRISE
    if t == "datacenter":
        return SOFT_DATACENTER_ALLOW if allow_non_residential else SOFT_DATACENTER
    return SOFT_UNVERIFIED


def classify_entries(
    ips: list[str],
    *,
    max_workers: int = 8,
    timeout: int = 8,
    force: bool = False,
) -> dict[str, dict[str, Any]]:
    """
    Return public meta keyed by IP for the given entry IPs.
    Uses disk cache (TTL 6h); concurrently classifies misses.
    """
    wanted = [str(ip).strip() for ip in ips if str(ip or "").strip()]
    wanted = list(dict.fromkeys(wanted))  # preserve order, unique
    cache = load_cache()
    now = int(time.time())
    results: dict[str, dict[str, Any]] = {}
    todo: list[str] = []

    for ip in wanted:
        cached = cache.get(ip)
        if (
            not force
            and isinstance(cached, dict)
            and _normalize_type(str(cached.get("egress_type") or ""))
            and int(cached.get("checked_at") or 0) + CACHE_TTL_SEC > now
        ):
            results[ip] = _public(cached)
        else:
            todo.append(ip)

    if todo:
        workers = max(1, min(max_workers, len(todo)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(classify_one, ip, timeout=timeout): ip for ip in todo}
            for fut in as_completed(futs):
                ip = futs[fut]
                try:
                    meta = fut.result()
                except Exception as exc:
                    meta = {
                        "egress_type": "unverified",
                        "egress_type_label": "未验证IP",
                        "is_residential": False,
                        "isp_org": "",
                        "geo_country": "",
                        "city": "",
                        "source": "error",
                        "checked_at": int(time.time()),
                        "ip": ip,
                        "error": str(exc)[:200],
                    }
                cache[ip] = meta
                results[ip] = _public(meta)
        try:
            save_cache(cache)
        except OSError:
            pass

    return results
