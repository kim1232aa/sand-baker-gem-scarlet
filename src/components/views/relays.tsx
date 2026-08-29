import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LiveDot } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  loadRelays,
  saveRelays,
  normalizeBaseUrl,
  newRelayId,
  relayFetch,
  loadLocalAdminToken,
  saveLocalAdminToken,
  type RelayNode,
} from "@/lib/relays";

type CardStatus = {
  id: string;
  live?: boolean;
  host?: string;
  torReady?: number;
  ovpnReady?: number;
  ms?: number;
  error?: string;
  procs?: Record<string, boolean>;
};

export function RelaysView() {
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [localToken, setLocalToken] = useState("");
  const [cards, setCards] = useState<Record<string, CardStatus>>({});
  const [scope, setScope] = useState<string>("local");

  useEffect(() => {
    setNodes(loadRelays());
    setLocalToken(loadLocalAdminToken());
  }, []);

  const persist = (next: RelayNode[]) => {
    setNodes(next);
    saveRelays(next);
  };

  const refresh = useCallback(async () => {
    const next: Record<string, CardStatus> = {};
    // local
    {
      const started = Date.now();
      try {
        const res = await relayFetch("/api/stack", { adminToken: loadLocalAdminToken() });
        const d = (await res.json()) as {
          live?: boolean;
          host?: string;
          torSlots?: { state?: string }[];
          ovpnSlots?: { state?: string }[];
          slots?: { state?: string; kind?: string }[];
          procs?: Record<string, boolean>;
          error?: string;
        };
        if (!res.ok) {
          next.local = { id: "local", error: d.error || `HTTP ${res.status}`, ms: Date.now() - started };
        } else {
          const tor = d.torSlots ?? (d.slots ?? []).filter((s) => s.kind !== "openvpn");
          const ovpn = d.ovpnSlots ?? (d.slots ?? []).filter((s) => s.kind === "openvpn");
          next.local = {
            id: "local",
            live: Boolean(d.live),
            host: d.host,
            torReady: tor.filter((s) => s.state === "ready").length,
            ovpnReady: ovpn.filter((s) => s.state === "ready").length,
            ms: Date.now() - started,
            procs: d.procs,
          };
        }
      } catch (e) {
        next.local = { id: "local", error: e instanceof Error ? e.message : String(e) };
      }
    }
    for (const n of loadRelays().filter((x) => x.enabled)) {
      const started = Date.now();
      try {
        const res = await relayFetch("/api/stack", { baseUrl: n.baseUrl, adminToken: n.adminToken });
        const d = (await res.json()) as {
          live?: boolean;
          host?: string;
          torSlots?: { state?: string }[];
          ovpnSlots?: { state?: string }[];
          slots?: { state?: string; kind?: string }[];
          procs?: Record<string, boolean>;
          error?: string;
        };
        if (!res.ok) {
          next[n.id] = { id: n.id, error: d.error || `HTTP ${res.status}`, ms: Date.now() - started };
        } else {
          const tor = d.torSlots ?? (d.slots ?? []).filter((s) => s.kind !== "openvpn");
          const ovpn = d.ovpnSlots ?? (d.slots ?? []).filter((s) => s.kind === "openvpn");
          next[n.id] = {
            id: n.id,
            live: Boolean(d.live),
            host: d.host,
            torReady: tor.filter((s) => s.state === "ready").length,
            ovpnReady: ovpn.filter((s) => s.state === "ready").length,
            ms: Date.now() - started,
            procs: d.procs,
          };
        }
      } catch (e) {
        next[n.id] = { id: n.id, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
      }
    }
    setCards(next);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(id);
  }, [refresh, nodes]);

  function addNode() {
    const url = normalizeBaseUrl(baseUrl);
    if (!name.trim() || !url) {
      toast.error("填写名称和 CF 域名");
      return;
    }
    const row: RelayNode = {
      id: newRelayId(),
      name: name.trim(),
      baseUrl: url,
      adminToken: token.trim(),
      enabled: true,
    };
    persist([...nodes, row]);
    setName("");
    setBaseUrl("");
    setToken("");
    toast.success("已添加中继");
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">Relays</p>
          <h1 className="font-display mt-1 text-2xl font-medium tracking-tight">多中继总控</h1>
          <p className="mt-1 text-sm text-muted">
            经对方 Cloudflare 域名聚合 `GET/POST /api/stack`，请求头 `x-relay-token`。不推送配置、不改对方 CF token。
          </p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()}>
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </header>

      <section className="space-y-3 rounded-lg border border-border bg-surface p-4 sm:p-5">
        <p className="text-sm font-medium">本机 API token（写入浏览器，用于本机控制）</p>
        <div className="flex flex-wrap gap-2">
          <Input
            className="max-w-md font-mono"
            type="password"
            value={localToken}
            onChange={(e) => setLocalToken(e.target.value)}
            placeholder="与 proxy-bin/admin-token 一致"
          />
          <Button
            type="button"
            onClick={() => {
              saveLocalAdminToken(localToken);
              toast.success("已保存本机 token");
            }}
          >
            保存
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <p className="text-sm font-medium">添加远程中继</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="机房B" />
          </div>
          <div className="space-y-2">
            <Label>CF 域名 / URL</Label>
            <Input
              className="font-mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://peer.example.com"
            />
          </div>
          <div className="space-y-2">
            <Label>admin token</Label>
            <Input
              className="font-mono"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="对方 admin-token"
            />
          </div>
        </div>
        <Button className="mt-3" type="button" onClick={addNode}>
          <Plus className="size-4" />
          添加
        </Button>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={scope === "local" ? "secondary" : "outline"} onClick={() => setScope("local")}>
          本机
        </Button>
        <Button size="sm" variant={scope === "all" ? "secondary" : "outline"} onClick={() => setScope("all")}>
          全部汇总
        </Button>
        {nodes.map((n) => (
          <Button
            key={n.id}
            size="sm"
            variant={scope === n.id ? "secondary" : "outline"}
            onClick={() => setScope(n.id)}
          >
            {n.name}
          </Button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(scope === "all" || scope === "local"
          ? [{ id: "local", name: "本机", baseUrl: "(local)", adminToken: "", enabled: true }]
          : []
        )
          .concat(scope === "all" ? nodes : nodes.filter((n) => n.id === scope))
          .map((n) => {
            const st = n.id === "local" ? cards.local : cards[n.id];
            return (
              <article key={n.id} className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <LiveDot on={Boolean(st?.live)} />
                      {n.name}
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-subtle">{n.baseUrl}</p>
                  </div>
                  {n.id !== "local" ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`删除 ${n.name}`}
                      onClick={() => {
                        persist(nodes.filter((x) => x.id !== n.id));
                        toast.success("已删除");
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
                {st?.error ? (
                  <p className="mt-3 text-sm text-danger">{st.error}</p>
                ) : (
                  <dl className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs text-muted">
                    <div>
                      <dt className="text-subtle">host</dt>
                      <dd>{st?.host || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-subtle">延迟</dt>
                      <dd>{st?.ms != null ? `${st.ms} ms` : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-subtle">Tor ready</dt>
                      <dd>{st?.torReady ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-subtle">OVPN ready</dt>
                      <dd>{st?.ovpnReady ?? "—"}</dd>
                    </div>
                  </dl>
                )}
                {st?.procs ? (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {Object.entries(st.procs).map(([k, v]) => (
                      <Badge key={k} variant={v ? "ok" : "danger"}>
                        {k}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
      </div>
    </div>
  );
}
