import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LiveDot } from "@/components/status-badge";
import { relayFetch } from "@/lib/relays";
import type { CheckAttempt, LiveExit } from "@/lib/nodes";
import { exitLabel, socksPort } from "@/lib/nodes";

type StackPayload = {
  torSlots?: LiveExit[];
  ovpnSlots?: LiveExit[];
  slots?: LiveExit[];
  procs?: { slots?: boolean; ovpn?: boolean };
};

type ProbePayload = {
  ok?: boolean;
  ip?: string;
  ms?: number;
  error?: string;
  egress_type?: string;
  isp_org?: string;
  geo_country?: string;
  city?: string;
  targets?: {
    base_ok?: boolean;
    custom_ok?: boolean;
    accepted?: boolean;
    attempts?: CheckAttempt[];
  };
};

function typeOf(s: LiveExit): string {
  return String(s.egress_type || s.check_result?.residential?.egress_type || "unverified").toLowerCase();
}

function targetsSummary(s: LiveExit, live?: ProbePayload): string {
  const t = live?.targets || s.check_result?.targets;
  if (!t || (!t.attempts?.length && t.accepted == null && t.base_ok == null)) return "—";
  const attempts = t.attempts || [];
  if (attempts.length) {
    const ok = attempts.filter((a) => a.accepted).length;
    return `${ok}/${attempts.length}${t.accepted ? " ✓" : ""}`;
  }
  if (t.accepted) return "通过";
  if (t.base_ok === false) return "base失败";
  if (t.custom_ok === false) return "custom失败";
  return "未测";
}

function geoHint(s: LiveExit): string {
  const geo = String(s.geo_country || s.check_result?.residential?.geo_country || "").toUpperCase();
  const target = String(s.target_country || s.country || "").toUpperCase();
  const city = String(s.city || s.check_result?.residential?.city || "");
  if (!geo && !target) return "—";
  if (geo && target && geo !== target && target !== "ANY") {
    return `${geo}${city ? `/${city}` : ""} ≠ ${target}`;
  }
  return `${geo || "?"}${city ? `/${city}` : ""}${target && target !== "ANY" ? ` · 目标 ${target}` : ""}`;
}

export function HealthView() {
  const [slots, setSlots] = useState<LiveExit[]>([]);
  const [mgr, setMgr] = useState({ tor: false, ovpn: false });
  const [kindFilter, setKindFilter] = useState<"all" | "openvpn" | "tor">("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [liveProbe, setLiveProbe] = useState<Record<string, ProbePayload>>({});

  const pull = useCallback(async () => {
    try {
      const res = await relayFetch("/api/stack");
      const d = (await res.json()) as StackPayload;
      const list = [
        ...(d.ovpnSlots ?? []).filter((s) => s.kind === "openvpn"),
        ...(d.torSlots ?? []).filter((s) => (s.kind || "tor") !== "openvpn"),
      ];
      // Fallback if API only returns merged slots.
      if (!list.length && d.slots?.length) {
        setSlots(d.slots);
      } else {
        setSlots(list);
      }
      setMgr({ tor: Boolean(d.procs?.slots), ovpn: Boolean(d.procs?.ovpn) });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void pull();
    const id = window.setInterval(() => void pull(), 6000);
    return () => window.clearInterval(id);
  }, [pull]);

  const filtered = useMemo(() => {
    return slots.filter((s) => {
      const kind = s.kind === "openvpn" ? "openvpn" : "tor";
      if (kindFilter !== "all" && kind !== kindFilter) return false;
      if (typeFilter !== "all" && typeOf(s) !== typeFilter) return false;
      return true;
    });
  }, [slots, kindFilter, typeFilter]);

  const stats = useMemo(() => {
    const ready = slots.filter((s) => s.state === "ready");
    const byType = (t: string) => ready.filter((s) => typeOf(s) === t).length;
    const rejectCounts: Record<string, number> = {};
    for (const s of slots) {
      const reason = String(s.reject_reason || s.check_result?.reject_reason || "").trim();
      if (!reason) continue;
      rejectCounts[reason] = (rejectCounts[reason] || 0) + 1;
    }
    const fallback = slots.filter((s) => s.country_fallback).length;
    const probeFail = slots.filter((s) => {
      const t = s.check_result?.targets;
      return t && t.accepted === false;
    }).length;
    return {
      total: slots.length,
      ready: ready.length,
      residential: byType("residential"),
      datacenter: byType("datacenter"),
      enterprise: byType("enterprise"),
      unverified: byType("unverified"),
      fallback,
      probeFail,
      rejectCounts,
    };
  }, [slots]);

  async function doProbe(s: LiveExit) {
    const kind = s.kind === "openvpn" ? "openvpn" : "tor";
    setBusyId(s.id);
    try {
      const res = await relayFetch("/api/stack", {
        method: "POST",
        body: JSON.stringify({ probe: true, slotId: s.id, slotKind: kind }),
      });
      const d = (await res.json()) as { probe?: ProbePayload };
      const p = d.probe || {};
      setLiveProbe((m) => ({ ...m, [s.id]: p }));
      if (p.ok) {
        const t = p.targets;
        const extra = t?.attempts?.length
          ? ` · 连通 ${t.attempts.filter((a) => a.accepted).length}/${t.attempts.length}`
          : "";
        toast.success(`${s.id} ${p.ip || "?"} · ${p.ms ?? "?"}ms${extra}`);
      } else {
        toast.error(p.error || "探测失败");
      }
      await pull();
    } finally {
      setBusyId(null);
    }
  }

  const rejectHint = Object.entries(stats.rejectCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join(" · ");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">Health</p>
          <h1 className="font-display mt-1 text-2xl font-medium tracking-tight">健康巡检</h1>
          <p className="mt-1 text-sm text-muted">
            住宅/机房分类、国家校验、连通探测摘要。OpenVPN 硬过滤；Tor 仅观测。行内「复测」走 SOCKS 多 URL。
          </p>
        </div>
        <Button variant="secondary" onClick={() => void pull()}>
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="就绪" value={String(stats.ready)} hint={`共 ${stats.total}`} />
        <Stat label="住宅" value={String(stats.residential)} hint="residential" />
        <Stat label="机房" value={String(stats.datacenter)} hint="datacenter" />
        <Stat label="未验证" value={String(stats.unverified)} hint={`企业 ${stats.enterprise}`} />
        <Stat label="国家回退" value={String(stats.fallback)} hint="country_fallback" />
        <Stat label="连通失败" value={String(stats.probeFail)} hint={rejectHint || "无拒绝记录"} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Tor 管理器 {mgr.tor ? "运行中" : "已停"}</span>
        <span>·</span>
        <span>VPN 管理器 {mgr.ovpn ? "运行中" : "已停"}</span>
        {rejectHint ? (
          <>
            <span>·</span>
            <span className="font-mono text-subtle">拒绝 {rejectHint}</span>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          className="h-9 rounded-md border border-border bg-bg px-3 text-sm"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as "all" | "openvpn" | "tor")}
        >
          <option value="all">全部类型</option>
          <option value="openvpn">OpenVPN</option>
          <option value="tor">Tor</option>
        </select>
        <select
          className="h-9 rounded-md border border-border bg-bg px-3 text-sm"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="all">全部出口类型</option>
          <option value="residential">住宅</option>
          <option value="datacenter">机房</option>
          <option value="enterprise">企业</option>
          <option value="unverified">未验证</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[880px] text-left text-sm">
          <thead className="border-b border-border bg-surface text-xs text-subtle">
            <tr>
              <th className="px-3 py-2 font-medium">槽位</th>
              <th className="px-3 py-2 font-medium">长名</th>
              <th className="px-3 py-2 font-medium">类型</th>
              <th className="px-3 py-2 font-medium">ISP</th>
              <th className="px-3 py-2 font-medium">Geo / 目标</th>
              <th className="px-3 py-2 font-medium">连通</th>
              <th className="px-3 py-2 font-medium">失败/代</th>
              <th className="px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const ok = s.state === "ready";
              const kind = s.kind === "openvpn" ? "VPN" : "Tor";
              const et = typeOf(s);
              const live = liveProbe[s.id];
              const reject = String(s.reject_reason || s.check_result?.reject_reason || "").trim();
              const isp = String(s.isp_org || s.check_result?.residential?.isp_org || "—");
              return (
                <tr key={`${kind}-${s.id}`} className="border-b border-border/70 last:border-0">
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center gap-2">
                      <LiveDot on={ok} />
                      <span className="font-mono text-xs">{s.id}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant={ok ? "ok" : "danger"}>{s.disabled ? "disabled" : s.state || "down"}</Badge>
                      <Badge variant="default">{kind}</Badge>
                      {s.country_fallback ? <Badge variant="warn">回退</Badge> : null}
                      {reject ? <Badge variant="danger">{reject}</Badge> : null}
                    </div>
                  </td>
                  <td className="max-w-[280px] px-3 py-2 align-top text-xs text-muted">
                    <span className="line-clamp-2 break-all">{exitLabel(s)}</span>
                    <p className="mt-1 font-mono text-[11px] text-subtle">
                      SOCKS {socksPort(s) || "—"} · {s.egress_ip || "—"}
                    </p>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Badge
                      variant={
                        et === "residential" ? "ok" : et === "datacenter" ? "warn" : et === "enterprise" ? "default" : "danger"
                      }
                    >
                      {et}
                    </Badge>
                  </td>
                  <td className="max-w-[140px] truncate px-3 py-2 align-top font-mono text-xs text-muted" title={isp}>
                    {isp}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-muted">{geoHint(s)}</td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-muted">
                    {targetsSummary(s, live)}
                    {live?.targets?.attempts?.length ? (
                      <ul className="mt-1 space-y-0.5 text-[10px] text-subtle">
                        {live.targets.attempts.map((a) => (
                          <li key={`${s.id}-${a.url}`}>
                            {a.accepted ? "✓" : "✗"} {String(a.url || "").replace(/^https?:\/\//, "").slice(0, 28)} ·{" "}
                            {a.code || "?"}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-muted">
                    f{s.failures ?? 0} / g{s.generation ?? 0}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Button size="sm" variant="outline" disabled={busyId === s.id || !socksPort(s)} onClick={() => void doProbe(s)}>
                      <Gauge className="size-3.5" />
                      复测
                    </Button>
                  </td>
                </tr>
              );
            })}
            {!filtered.length ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-subtle">
                  暂无槽位数据
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-xs text-subtle">{label}</p>
      <p className="mt-1 font-display text-lg font-medium tracking-tight tabular-nums">{value}</p>
      <p className="truncate text-xs text-muted">{hint}</p>
    </div>
  );
}
