import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAdminStore } from "@/lib/store";
import { clashYaml } from "@/lib/seed";
import { loadLocalAdminToken, saveLocalAdminToken, relayFetch } from "@/lib/relays";

export function SettingsView() {
  const settings = useAdminStore((s) => s.settings);
  const uuid = useAdminStore((s) => s.uuid);
  const exits = useAdminStore((s) => s.exits);
  const updateSettings = useAdminStore((s) => s.updateSettings);

  const [interval, setIntervalSec] = useState(String(settings.intervalSec));
  const [token, setToken] = useState("");
  const [namedHost, setNamedHost] = useState("");
  const [bound, setBound] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [adminRequired, setAdminRequired] = useState(false);
  const [adminToken, setAdminToken] = useState(loadLocalAdminToken());

  useEffect(() => {
    void relayFetch("/api/stack")
      .then((r) => r.json())
      .then((d: { host?: string; token?: boolean; adminTokenRequired?: boolean }) => {
        if (d.host) {
          setBound(d.host);
          setNamedHost(d.host);
        }
        setHasToken(Boolean(d.token));
        setAdminRequired(Boolean(d.adminTokenRequired));
      })
      .catch(() => {});
  }, []);

  function saveProbe(e: FormEvent) {
    e.preventDefault();
    const n = Number(interval);
    if (!Number.isFinite(n) || n < 3 || n > 600) {
      toast.error("探活间隔需在 3–600 秒");
      return;
    }
    updateSettings({ intervalSec: Math.round(n) });
    toast.success("已保存");
  }

  function downloadClash() {
    const host = bound || settings.publicHost;
    const yaml = clashYaml(host, uuid, exits, settings.subPath);
    const blob = new Blob([yaml], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "relay.yaml";
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("已下载 Clash 订阅");
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8">
      <header>
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">Settings</p>
        <h1 className="font-display mt-1 text-2xl font-medium tracking-tight">设置</h1>
      </header>

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!token.trim() && !namedHost.trim()) {
            toast.error("填 token 或域名");
            return;
          }
          const res = await relayFetch("/api/stack", {
            method: "POST",
            body: JSON.stringify({ token: token.trim() || undefined, host: namedHost.trim() }),
          });
          if (!res.ok) {
            toast.error("写入失败");
            return;
          }
          toast.success("已保存，正在重连隧道");
        }}
        className="space-y-4 rounded-lg border border-border bg-surface p-5"
      >
        <p className="text-sm font-medium">Cloudflare 隧道</p>
        <p className="text-sm text-muted">
          {hasToken ? "已接入命名隧道。" : "粘贴 Cloudflared token。"}当前域名{" "}
          <span className="font-mono text-fg">{bound || "未绑定"}</span>
        </p>
        <div className="space-y-2">
          <Label htmlFor="cf-token">Tunnel token</Label>
          <Input
            id="cf-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? "已保存，留空则不改" : "eyJhIjoi..."}
            className="font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cf-host">隧道域名</Label>
          <Input
            id="cf-host"
            value={namedHost}
            onChange={(e) => setNamedHost(e.target.value)}
            placeholder="groktun.alibb123.ccwu.cc"
            className="font-mono"
          />
        </div>
        <Button type="submit" variant="secondary">
          保存并重连
        </Button>
      </form>

      <form onSubmit={saveProbe} className="space-y-4 rounded-lg border border-border bg-surface p-5">
        <p className="text-sm font-medium">探活</p>
        <div className="space-y-2">
          <Label htmlFor="interval">间隔（秒）</Label>
          <Input
            id="interval"
            type="number"
            min={3}
            max={600}
            value={interval}
            onChange={(e) => setIntervalSec(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm">Keepalive</p>
            <p className="text-xs text-muted">
              打开后会定时探 /vless；失败则拉起 xray / 隧道（对标 gcloud 挠痒，但管的是本机进程）
            </p>
          </div>
          <Switch
            checked={settings.keepalive}
            onCheckedChange={(v) => updateSettings({ keepalive: v })}
          />
        </div>
        <p className="font-mono text-xs text-subtle">UUID {uuid}</p>
        <Button type="submit">保存</Button>
      </form>

      <section className="space-y-3 rounded-lg border border-border bg-surface p-5">
        <p className="text-sm font-medium">管理 API token</p>
        <p className="text-sm text-muted">
          写入 `proxy-bin/admin-token` 后，公网 `/api/stack` 必须带 `x-relay-token`。多机总控也用同一套。
          当前：{adminRequired ? "已启用校验" : "未设置（本机开发放行）"}。
        </p>
        <div className="space-y-2">
          <Label htmlFor="admin-token">token</Label>
          <Input
            id="admin-token"
            className="font-mono"
            type="password"
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            placeholder="随机长串"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const t =
                adminToken.trim() ||
                (typeof crypto !== "undefined" && "randomUUID" in crypto
                  ? crypto.randomUUID().replace(/-/g, "")
                  : Math.random().toString(36).slice(2) + Date.now().toString(36));
              setAdminToken(t);
              void relayFetch("/api/stack", {
                method: "POST",
                body: JSON.stringify({ setAdminToken: t }),
              }).then((res) => {
                if (!res.ok) {
                  toast.error("写入失败");
                  return;
                }
                saveLocalAdminToken(t);
                setAdminRequired(true);
                toast.success("已启用 admin token");
              });
            }}
          >
            生成并启用
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              saveLocalAdminToken(adminToken);
              toast.success("已保存到本机浏览器");
            }}
          >
            仅保存到浏览器
          </Button>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-surface p-5">
        <p className="text-sm font-medium">Clash 订阅</p>
        <p className="text-sm text-muted">按当前隧道域名导出 YAML。</p>
        <Button type="button" variant="secondary" onClick={downloadClash}>
          下载 relay.yaml
        </Button>
      </section>
    </div>
  );
}
