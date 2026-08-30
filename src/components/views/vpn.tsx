import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, RefreshCw, StopCircle, Gauge, Link2, ListTree } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LiveDot, StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { relayFetch } from "@/lib/relays";
import type { LiveExit, OvpnCandidate } from "@/lib/nodes";
import { exitLabel, socksPort } from "@/lib/nodes";

type StackPayload = {
  ovpnSlots?: LiveExit[];
  slots?: LiveExit[];
  procs?: { ovpn?: boolean };
  ovpnNodeCounts?: Record<string, number>;
  ovpnNodesUpdated?: number;
  nodes?: OvpnCandidate[];
};

export function VpnView() {
  const [slots, setSlots] = useState<LiveExit[]>([]);
  const [mgrUp, setMgrUp] = useState(false);
  const [country, setCountry] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [probe, setProbe] = useState<Record<string, string>>({});
  const [nodeCounts, setNodeCounts] = useState<Record<string, number>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<OvpnCandidate[]>([]);
  const [candBusy, setCandBusy] = useState(false);

  const pull = useCallback(async () => {
    try {
      const res = await relayFetch("/api/stack");
      const d = (await res.json()) as StackPayload;
      const list = (d.ovpnSlots ?? d.slots ?? []).filter((s) => s.kind === "openvpn");
      setSlots(list);
      setMgrUp(Boolean(d.procs?.ovpn));
      if (d.ovpnNodeCounts) setNodeCounts(d.ovpnNodeCounts);
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
    offline: slots.filter((s) => !s.disabled && s.state !== "ready").length,
  };

  const poolHint = useMemo(() => {
    const entries = Object.entries(nodeCounts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return "节点池未刷新";
    return entries.map(([cc, n]) => `${cc}:${n}`).join(" · ");
  }, [nodeCounts]);

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

  async function batchRedialOffline() {
    setBusyId("__batch__");
    try {
      const res = await relayFetch("/api/stack", {
        method: "POST",
        body: JSON.stringify({ batchRedialOffline: true }),
      });
      const d = (await res.json()) as { batch?: { count?: number; ids?: string[] } };
      const n = d.batch?.count ?? 0;
      if (!res.ok) {
        toast.error("批量重拨失败");
        return;
      }
      toast.success(n ? `已对 ${n} 个离线槽位发起重拨` : "没有需要重拨的离线槽位");
      await pull();
    } finally {
      setBusyId(null);
    }
  }

  async function openPicker(slot: LiveExit) {
    setPickerFor(slot.id);
    setCandBusy(true);
    try {
      const res = await relayFetch(`/api/stack?nodes=1&country=${encodeURIComponent(slot.country || "ANY")}`);
      const d = (await res.json()) as StackPayload;
      setCandidates(d.nodes ?? []);
      if (d.ovpnNodeCounts) setNodeCounts(d.ovpnNodeCounts);
    } catch {
      toast.error("加载候选节点失败");
      setCandidates([]);
    } finally {
      setCandBusy(false);
    }
  }

  async function connectNode(slotId: string, nodeIp: string) {
    setBusyId(slotId);
    try {
      const res = await relayFetch("/api/stack", {
        method: "POST",
        body: JSON.stringify({
          slotAction: "connect",
          slotId,
          slotKind: "openvpn",
          nodeIp,
        }),
      });
      if (!res.ok) {
        toast.error("指定节点连接失败");
        return;
      }
      toast.success(`${slotId} 正在连接 ${nodeIp}`);
      setPickerFor(null);
      await pull();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">OpenVPN</p>
          <h1 className="font-display mt-1 text-2xl font-medium tracking-tight">VPN 槽位</h1>
          <p className="mt-1 text-sm text-muted">
            对齐 kui-local-multi-exit：NodePool 惩罚、跨槽 IP 互斥、连续失败国家回退 / 自动停用、候选手动连接、批量重拨离线。
            本机 SOCKS `127.0.0.1:9171+`。
          </p>
          <p className="mt-1 font-mono text-[11px] text-subtle">{poolHint}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busyId === "__batch__" || stats.offline === 0}
            onClick={() => void batchRedialOffline()}
          >
            <ListTree className="size-4" />
            批量重拨离线 ({stats.offline})
          </Button>
          <Button variant="secondary" onClick={() => void restartMgr()}>
            <RefreshCw className="size-4" />
            重启管理器
          </Button>
        </div>
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
          const picking = pickerFor === s.id;
          return (
            <li
              key={s.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <LiveDot on={ok} />
                    {exitLabel(s)}
                    <span className="font-mono text-xs font-normal text-subtle">{s.id}</span>
                    <Badge variant={ok ? "ok" : "danger"}>{s.disabled ? "disabled" : s.state || "down"}</Badge>
                    {s.country_fallback ? <Badge variant="warn">国家回退</Badge> : null}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted">
                    SOCKS {port || "—"} · 偏好端口 {String(s.vpn_port || "any")} · IP {s.egress_ip || "—"}
                    {s.remote ? ` · remote ${s.remote}` : ""}
                    {typeof s.candidates === "number" ? ` · 候选 ${s.candidates}` : ""}
                    {typeof s.failures === "number" && s.failures > 0 ? ` · 失败 ${s.failures}` : ""}
                    {typeof s.generation === "number" ? ` · gen ${s.generation}` : ""}
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
                    variant="outline"
                    disabled={busyId === s.id}
                    onClick={() => void (picking ? setPickerFor(null) : openPicker(s))}
                  >
                    <Link2 className="size-3.5" />
                    {picking ? "收起候选" : "选节点"}
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
              </div>

              {picking ? (
                <div className="rounded-md border border-border bg-bg/60 p-3">
                  <p className="mb-2 text-xs text-muted">
                    候选（{s.country}，按 ping+惩罚排序）
                    {candBusy ? " · 加载中…" : ` · ${candidates.length} 条`}
                  </p>
                  {candidates.length === 0 && !candBusy ? (
                    <p className="text-xs text-subtle">暂无候选；等节点池刷新或换国家槽位。</p>
                  ) : (
                    <ul className="max-h-48 space-y-1 overflow-auto">
                      {candidates.slice(0, 30).map((n) => (
                        <li
                          key={`${n.ip}:${n.port || ""}`}
                          className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-surface"
                        >
                          <span className="font-mono text-muted">
                            {n.ip}:{n.port || "?"} · {n.country || "?"} · ping {n.ping ?? "—"} · score{" "}
                            {n.score ?? "—"}
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busyId === s.id || !n.ip}
                            onClick={() => void connectNode(s.id, String(n.ip))}
                          >
                            连接
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
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
