import { useEffect, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QrCode } from "@/components/qr-code";
import { LiveDot, StatusBadge } from "@/components/status-badge";
import { useAdminStore } from "@/lib/store";
import { formatTime, vlessLink } from "@/lib/seed";
import { SUB_PATH } from "@/lib/subscribe";
import { LatencySpark } from "@/components/views/latency-spark";

const PIPE = [
  { k: "client", l: "客户端", s: "Clash / v2rayN" },
  { k: "cf", l: "Cloudflare", s: "命名隧道 · 域名优选" },
  { k: "in", l: "本机入站", s: "VLESS + WS /vless" },
  { k: "exit", l: "出站", s: "本机 / Tor 电路" },
];

export function Overview() {
  const exits = useAdminStore((s) => s.exits);
  const currentExitId = useAdminStore((s) => s.currentExitId);
  const current = exits.find((e) => e.id === currentExitId);
  const settings = useAdminStore((s) => s.settings);
  const uuid = useAdminStore((s) => s.uuid);
  const lastProbeAt = useAdminStore((s) => s.lastProbeAt);
  const lastLatency = useAdminStore((s) => s.lastLatency);
  const logs = useAdminStore((s) => s.logs);
  const busy = useAdminStore((s) => s.failoverBusy);
  const hydrated = useAdminStore((s) => s.hydrated);
  const [confirm, setConfirm] = useState(false);
  const [tunnelHost, setTunnelHost] = useState("");
  const [live, setLive] = useState(false);
  const nodeHost = tunnelHost || settings.publicHost;
  const link = vlessLink(nodeHost, uuid);
  const clashUrl = nodeHost ? `https://${nodeHost}${SUB_PATH}` : "";
  const [pub, setPub] = useState({ total: 0, front: 0, exit: 0 });
  const [keep, setKeep] = useState({ on: false, at: "" });

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const res = await fetch("/api/stack", { cache: "no-store" });
        const d = (await res.json()) as {
          host?: string;
          live?: boolean;
          counts?: { total: number; front: number; exit: number };
          procs?: { supervise?: boolean };
          heartbeat?: { at?: string };
        };
        if (cancelled) return;
        if (d.host) setTunnelHost(d.host);
        setLive(Boolean(d.live));
        if (d.counts) setPub(d.counts);
        setKeep({ on: Boolean(d.procs?.supervise), at: d.heartbeat?.at ?? "" });
      } catch {
        if (!cancelled) setLive(false);
      }
    }
    void pull();
    const id = window.setInterval(() => void pull(), 6000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">Overview</p>
          <h1 className="font-display mt-1 text-2xl font-medium tracking-tight text-balance">
            当前状态
          </h1>
        </div>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => setConfirm(true)}
        >
          <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
          切换出站
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="当前出站" value={current?.label ?? "直连"} hint={current?.kind ?? "direct"} />
        <Stat
          label="最近探活"
          value={lastLatency != null ? `${lastLatency} ms` : "—"}
          hint={lastProbeAt && hydrated ? formatTime(lastProbeAt) : ""}
        />
        <Stat
          label="订阅节点"
          value={String(pub.total)}
          hint={`CF ${pub.front} · 出口 ${pub.exit}`}
        />
        <Stat
          label="保活"
          value={keep.on ? "运行中" : "已停"}
          hint={keep.at ? formatTime(Date.parse(keep.at)) : "本机 20s 巡检"}
        />
      </div>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">数据路径</p>
        <ol className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {PIPE.map((n, i) => (
            <li key={n.k} className="relative rounded-md border border-border bg-bg px-3 py-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                {i === 1 || i === 2 ? <LiveDot on={live && !busy} /> : null}
                {n.l}
              </p>
              <p className="mt-1 text-xs text-muted">{n.s}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-subtle">
          Clash → Cloudflare 隧道 → 本机 xray。选 CF 入口时出口是这台机；选 Tor·XX 才是对应国家 IP。订阅只发已经拨通的电路。
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium tracking-widest text-subtle uppercase">VLESS 链接</p>
            <Badge variant="live">{nodeHost}</Badge>
          </div>
          <CopyRow value={link} label="VLESS 链接" muted />
          <p className="mt-3 text-xs text-muted">Clash / 订阅</p>
          <CopyRow value={clashUrl} label="Clash 订阅" />
          <p className="mt-3 text-xs text-muted">v2ray / 通用订阅</p>
          <CopyRow value={clashUrl ? `${clashUrl}/links` : ""} label="v2ray 订阅" muted />
          <LatencySpark />
        </section>

        <section className="flex flex-col items-center justify-center rounded-lg border border-border bg-surface p-4">
          <QrCode value={clashUrl || link} />
          <p className="mt-3 text-xs text-subtle">扫码导入</p>
        </section>
      </div>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">当前出站</p>
          {current ? <StatusBadge status={current.status} /> : <StatusBadge status={live ? "ok" : "down"} />}
        </div>
        {current ? (
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-subtle">名称</dt>
              <dd className="font-mono">{current.label}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">类型</dt>
              <dd className="font-mono">{current.kind}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted">没有激活出站。</p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">最近日志</p>
        <pre className="mt-3 max-h-48 overflow-auto font-mono text-xs leading-relaxed text-muted">
          {logs.slice(-8).map((l) => `${formatTime(l.t)}  ${l.text}`).join("\n")}
        </pre>
      </section>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重启数据面？</AlertDialogTitle>
            <AlertDialogDescription>
              会拉起 xray 与 Cloudflare 隧道。UUID 和订阅不变。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void fetch("/api/stack", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ restart: true }),
                });
                toast.success("正在重启隧道");
              }}
            >
              执行
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CopyRow({ value, label, muted }: { value: string; label: string; muted?: boolean }) {
  return (
    <div className="mt-3 flex items-start gap-2">
      <code
        className={`block min-w-0 flex-1 overflow-x-auto rounded-sm bg-bg px-3 py-2 font-mono text-xs leading-relaxed break-all ${muted ? "text-muted" : "text-fg"}`}
      >
        {value || "—"}
      </code>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-label={`复制 ${label}`}
        disabled={!value}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast.success(`已复制 ${label}`);
        }}
      >
        <Copy className="size-4" />
      </Button>
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
