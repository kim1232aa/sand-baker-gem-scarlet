import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { LiveDot, StatusBadge } from "@/components/status-badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DIRECT_ID } from "@/lib/types";
import { useAdminStore } from "@/lib/store";
import { maskUrl } from "@/lib/seed";

export function ExitsView() {
  const exits = useAdminStore((s) => s.exits);
  const currentExitId = useAdminStore((s) => s.currentExitId);
  const addExit = useAdminStore((s) => s.addExit);
  const deleteExit = useAdminStore((s) => s.deleteExit);
  const toggleExit = useAdminStore((s) => s.toggleExit);
  const selectExit = useAdminStore((s) => s.selectExit);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [live, setLive] = useState(false);
  const [host, setHost] = useState("");
  const [slotMap, setSlotMap] = useState<
    Record<string, { state: string; egress_ip: string; country: string; kind?: string }>
  >({});
  const setView = useAdminStore((s) => s.setView);

  useEffect(() => {
    void fetch("/api/stack")
      .then((r) => r.json())
      .then(
        (d: {
          live?: boolean;
          host?: string;
          slots?: { id: string; state: string; egress_ip: string; country: string; kind?: string }[];
        }) => {
          setLive(Boolean(d.live));
          if (d.host) setHost(d.host);
          const map: Record<string, { state: string; egress_ip: string; country: string; kind?: string }> = {};
          for (const s of d.slots ?? []) map[s.id] = s;
          setSlotMap(map);
        },
      )
      .catch(() => {});
  }, []);

  function onAdd(e: FormEvent) {
    e.preventDefault();
    const result = addExit(label, url);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setLabel("");
    setUrl("");
    toast.success("已加入出站池");
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header>
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">Proxy pool</p>
        <h1 className="font-display mt-1 text-2xl font-medium tracking-tight">代理池</h1>
        <p className="mt-1 text-sm text-muted">
          真实 Tor / OpenVPN 出口请到专用页管理。这里保留手动 socks5/http 池，以及出口摘要。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setView("tor")}>
            Tor 管理
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setView("vpn")}>
            VPN 管理
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setView("socks")}>
            SOCKS 订阅
          </Button>
        </div>
      </header>

      <form
        onSubmit={onAdd}
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-end"
      >
        <div className="flex-1 space-y-2">
          <Label htmlFor="exit-label">标签</Label>
          <Input
            id="exit-label"
            placeholder="HK-2"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="flex-[2] space-y-2">
          <Label htmlFor="exit-url">URL</Label>
          <Input
            id="exit-url"
            placeholder="socks5://user:pass@host:port"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="font-mono"
          />
        </div>
        <Button type="submit">添加出站</Button>
      </form>

      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={() => setReveal((v) => !v)}>
          {reveal ? "隐藏密钥" : "显示密钥"}
        </Button>
      </div>

      <p className="text-xs font-medium tracking-widest text-subtle uppercase">代理池</p>
      <ul className="space-y-2">
        {exits.map((e) => {
          const active = e.id === currentExitId;
          return (
            <li
              key={e.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <LiveDot on={active && e.status === "ok"} />
                  {e.label}
                  <span className="font-mono text-xs font-normal text-subtle">{e.kind}</span>
                  {active ? <span className="text-xs font-normal text-live">当前</span> : null}
                </p>
                <p className="mt-1 truncate font-mono text-xs text-muted">
                  {e.kind === "direct" ? "本机直出" : reveal ? e.url : maskUrl(e.url)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={e.status} />
                {e.id !== DIRECT_ID ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => toggleExit(e.id)}>
                    {e.status === "ok" ? "标记故障" : "恢复"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  disabled={active || e.status !== "ok"}
                  onClick={() => {
                    selectExit(e.id);
                    toast.success(`已切到 ${e.label}`);
                  }}
                >
                  {active ? "使用中" : "切到这条"}
                </Button>
                {e.id !== DIRECT_ID ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除 ${e.label}`}
                    onClick={() => setPending(e.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-xs font-medium tracking-widest text-subtle uppercase">
        真实出口摘要 · {Object.values(slotMap).filter((s) => s.state === "ready").length} 条已通
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(slotMap)
          .filter(([, st]) => st.state === "ready")
          .map(([id, st]) => {
            const ok = st.state === "ready";
            const kind = st.kind === "openvpn" ? "OpenVPN" : "Tor";
            return (
              <article key={id} className="rounded-lg border border-border bg-surface p-4">
                <p className="flex items-center justify-between gap-2 text-sm font-medium">
                  <span className="flex items-center gap-2">
                    <LiveDot on={ok} />
                    {kind}·{st.country}
                  </span>
                  <StatusBadge status={ok ? "ok" : "down"} />
                </p>
                <dl className="mt-3 space-y-1 font-mono text-xs text-muted">
                  <div className="flex justify-between gap-2">
                    <dt>path</dt>
                    <dd>/res-{id}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>出口 IP</dt>
                    <dd>{st.egress_ip || st.state}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>类型</dt>
                    <dd>{kind}</dd>
                  </div>
                </dl>
              </article>
            );
          })}
      </div>

      <p className="text-xs font-medium tracking-widest text-subtle uppercase">订阅规则</p>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {[
          ["🚀 节点选择", "select · 总入口"],
          ["⚡ CF入口", "url-test · Cloudflare 域名优选（出口仍是本机）"],
          ["🌍 真实出口", "select · Tor + OpenVPN 已通电路"],
          ["🧅 Tor", "select · Tor 国家出口"],
          ["🔑 OpenVPN", "select · OpenVPN/VPNGate 出口"],
          ["🧠 Claude", "anthropic / claude.ai"],
          ["🤖 ChatGPT", "openai / chatgpt.com"],
          ["🔵 Google·Gemini", "gemini / aistudio"],
          ["🇨🇳 中国流量", "GEOSITE,cn + GEOIP,CN → DIRECT"],
          ["🌐 其他流量", "MATCH → 节点选择"],
        ].map(([n, h]) => (
          <li key={n} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium">{n}</p>
            <p className="font-mono text-xs text-muted">{h}</p>
          </li>
        ))}
      </ul>
      {host ? <p className="font-mono text-xs text-subtle">host {host}</p> : null}

      <AlertDialog open={!!pending} onOpenChange={(v) => !v && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条出站？</AlertDialogTitle>
            <AlertDialogDescription>若正在使用，会退回直连。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger/20 text-danger hover:bg-danger/30"
              onClick={() => {
                if (pending) {
                  const result = deleteExit(pending);
                  if (!result.ok) toast.error(result.error);
                  else toast.success("已删除出站");
                }
                setPending(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
