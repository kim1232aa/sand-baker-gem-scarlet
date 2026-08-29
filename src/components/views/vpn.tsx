import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, RefreshCw, StopCircle, Gauge } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LiveDot, StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { relayFetch } from "@/lib/relays";
import type { LiveExit } from "@/lib/nodes";
import { socksPort } from "@/lib/nodes";

type StackPayload = {
  ovpnSlots?: LiveExit[];
  slots?: LiveExit[];
  procs?: { ovpn?: boolean };
};

export function VpnView() {
  const [slots, setSlots] = useState<LiveExit[]>([]);
  const [mgrUp, setMgrUp] = useState(false);
  const [country, setCountry] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [probe, setProbe] = useState<Record<string, string>>({});

  const pull = useCallback(async () => {
    try {
      const res = await relayFetch("/api/stack");
      const d = (await res.json()) as StackPayload;
      const list = (d.ovpnSlots ?? d.slots ?? []).filter((s) => s.kind === "openvpn");
      setSlots(list);
      setMgrUp(Boolean(d.procs?.ovpn));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void pull();
    const id = window.setInterval(() => void pull(), 5500);
    return () => window.clearInterval(id);
  }, [pull]);

  const countries = useMemo(
    () => Array.from(new Set(slots.map((s) => s.country))).sort(),
    [slots],
  );

  const filtered = slots.filter((s) => {
    if (country !== "all" && s.country !== country) return false;
    if (stateFilter !== "all" && (s.state || "down") !== stateFilter) return false;
    return true;
  });

  const stats = {
    total: slots.length,
    ready: slots.filter((s) => s.state === "ready").length,
    boot: slots.filter((s) => s.state === "boot").length,
    down: slots.filter((s) => s.state === "down" || !s.state).length,
  };

  async function slotAct(id: string, slotAction: "restart" | "stop") {
    setBusyId(id);
    try {
      const res = await relayFetch("/api/stack", {
        method: "POST",
        body: JSON.stringify({ slotAction, slotId: id, slotKind: "openvpn" }),
      });
      if (!res.ok) {
        toast.error(slotAction === "stop" ? "停用失败" : "重拨失败");
        return;
      }
      toast.success(slotAction === "stop" ? `已停用 ${id}` : `正在重拨 ${id}`);
      await pull();
    } finally {
      setBusyId(null);
    }
  }

  async function doProbe(id: string) {
    setBusyId(id);
    try {
      const res = await relayFetch("/api/stack", {
        method: "POST",
        body: JSON.stringify({ probe: true, slotId: id, slotKind: "openvpn" }),
      });
      const d = (await res.json()) as { probe?: { ok?: boolean; ip?: string; ms?: number; error?: string } };
      const p = d.probe;
      if (p?.ok) {
        const msg = `${p.ip} · ${p.ms}ms`;
        setProbe((m) => ({ ...m, [id]: msg }));
        toast.success(`${id} ${msg}`);
      } else {
        toast.error(p?.error || "探测失败");
      }
      await pull();
    } finally {
      setBusyId(null);
    }
  }

  async function restartMgr() {
    const res = await relayFetch("/api/stack", {
      method: "POST",
      body: JSON.stringify({ action: "restart", target: "ovpn" }),
    });
    if (!res.ok) {
      toast.error("重启 OpenVPN 管理器失败");
      return;
    }
    toast.success("正在重启 OpenVPN 管理器");
    await pull();
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">OpenVPN</p>
          <h1 className="font-display mt-1 text-2xl font-medium tracking-tight">VPN 槽位</h1>
          <p className="mt-1 text-sm text-muted">
            VPNGate TCP · 24 槽 · 本机 SOCKS `127.0.0.1:9171+`。重拨会跳过旧 remote 换 IP；偏好端口空时回退任意 TCP。TH 常无 TCP、RO 常空。
          </p>
        </div>
        <Button variant="secondary" onClick={() => void restartMgr()}>
          <RefreshCw className="size-4" />
          重启管理器
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="管理器" value={mgrUp ? "运行中" : "已停"} hint="ovpn_slots.py" />
        <Stat label="总数" value={String(stats.total)} hint="计划槽位" />
        <Stat label="就绪" value={String(stats.ready)} hint="ready" />
        <Stat label="拨号中" value={String(stats.boot)} hint="boot" />
        <Stat label="停/故障" value={String(stats.down)} hint="down" />
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          className="h-9 rounded-md border border-border bg-bg px-3 text-sm"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        >
          <option value="all">全部国家</option>
          {countries.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="h-9 rounded-md border border-border bg-bg px-3 text-sm"
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
        >
          <option value="all">全部状态</option>
          <option value="ready">ready</option>
          <option value="boot">boot</option>
          <option value="down">down</option>
        </select>
      </div>

      <ul className="space-y-2">
        {filtered.map((s) => {
          const port = socksPort(s);
          const ok = s.state === "ready";
          const url = port ? `socks5://127.0.0.1:${port}` : "";
          return (
            <li
              key={s.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3 lg:flex-row lg:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <LiveDot on={ok} />
                  OpenVPN·{s.country}
                  <span className="font-mono text-xs font-normal text-subtle">{s.id}</span>
                  <Badge variant={ok ? "ok" : "danger"}>{s.state || "down"}</Badge>
                </p>
                <p className="mt-1 font-mono text-xs text-muted">
                  SOCKS {port || "—"} · 偏好端口 {String(s.vpn_port || "any")} · IP {s.egress_ip || "—"}
                  {s.remote ? ` · remote ${s.remote}` : ""}
                  {typeof s.candidates === "number" ? ` · 候选 ${s.candidates}` : ""}
                  {probe[s.id] ? ` · 探测 ${probe[s.id]}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={ok ? "ok" : "down"} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!url}
                  onClick={() => {
                    void navigator.clipboard.writeText(url);
                    toast.success("已复制 SOCKS");
                  }}
                >
                  <Copy className="size-3.5" />
                  复制
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId === s.id}
                  onClick={() => void doProbe(s.id)}
                >
                  <Gauge className="size-3.5" />
                  测速
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === s.id}
                  onClick={() => void slotAct(s.id, "restart")}
                >
                  <RefreshCw className="size-3.5" />
                  重拨
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === s.id}
                  onClick={() => void slotAct(s.id, "stop")}
                >
                  <StopCircle className="size-3.5" />
                  停用
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
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
