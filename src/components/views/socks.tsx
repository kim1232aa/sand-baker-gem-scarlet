import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QrCode } from "@/components/qr-code";
import { LiveDot } from "@/components/status-badge";
import { relayFetch } from "@/lib/relays";
import { SUB_PATH } from "@/lib/subscribe";
import type { LiveExit } from "@/lib/nodes";
import { socksPort, readySocksSlots, buildSocksTxt } from "@/lib/nodes";

export function SocksView() {
  const [slots, setSlots] = useState<LiveExit[]>([]);
  const [host, setHost] = useState("");
  const [note, setNote] = useState("SOCKS 仅本机 127.0.0.1；远程请用 VLESS 订阅 /res-*");
  const [preview, setPreview] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const res = await relayFetch("/api/stack");
        const d = (await res.json()) as {
          host?: string;
          slots?: LiveExit[];
          socks?: { remoteNote?: string; localPlainUrl?: string; localClashUrl?: string };
        };
        if (cancelled) return;
        if (d.host) setHost(d.host);
        const list = d.slots ?? [];
        setSlots(list);
        if (d.socks?.remoteNote) setNote(d.socks.remoteNote);
        setPreview(buildSocksTxt(list));
      } catch {
        /* ignore */
      }
    }
    void pull();
    const id = window.setInterval(() => void pull(), 6000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const ready = readySocksSlots(slots);
  const plainPath = `${SUB_PATH}/socks.txt`;
  const clashPath = `${SUB_PATH}/socks.yaml`;
  const plainLocal = `http://127.0.0.1:8080${plainPath}`;
  const clashLocal = `http://127.0.0.1:8080${clashPath}`;
  const plainPublic = host ? `https://${host}${plainPath}` : "";
  const clashPublic = host ? `https://${host}${clashPath}` : "";

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header>
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">SOCKS</p>
        <h1 className="font-display mt-1 text-2xl font-medium tracking-tight">SOCKS 订阅</h1>
        <p className="mt-1 text-sm text-muted">{note}</p>
      </header>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-muted">
        Cloudflare 隧道只反代 HTTP → mux，<strong className="text-fg">不能</strong>把原生 SOCKS TCP 暴露到公网。
        本机用下面的 `127.0.0.1` 订阅；远程请继续用 VLESS `/res-*`。
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">本机订阅</p>
          <p className="mt-3 text-xs text-muted">纯文本 socks5://</p>
          <CopyRow value={plainLocal} label="本机 socks.txt" />
          <p className="mt-3 text-xs text-muted">Clash socks5 YAML</p>
          <CopyRow value={clashLocal} label="本机 socks.yaml" />
          {plainPublic ? (
            <>
              <p className="mt-3 text-xs text-muted">经 CF 拉列表（内容仍是 127.0.0.1，仅本机可用）</p>
              <CopyRow value={plainPublic} label="公网 socks.txt" muted />
              <CopyRow value={clashPublic} label="公网 socks.yaml" muted />
            </>
          ) : null}
        </section>
        <section className="flex flex-col items-center justify-center rounded-lg border border-border bg-surface p-4">
          <QrCode value={plainLocal} />
          <p className="mt-3 text-xs text-subtle">扫码（本机）</p>
        </section>
      </div>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">
            就绪节点 · {ready.length}
          </p>
          <Badge variant="live">仅 ready</Badge>
        </div>
        <ul className="mt-3 space-y-2">
          {ready.map((s) => {
            const port = socksPort(s);
            const kind = s.kind === "openvpn" ? "OpenVPN" : "Tor";
            return (
              <li key={s.id} className="flex items-center justify-between gap-2 font-mono text-xs">
                <span className="flex items-center gap-2 text-sm text-fg">
                  <LiveDot on />
                  {kind}·{s.country} {s.egress_ip || s.id}
                </span>
                <span className="text-muted">127.0.0.1:{port}</span>
              </li>
            );
          })}
          {!ready.length ? <li className="text-sm text-muted">暂无 ready SOCKS</li> : null}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">预览 · socks.txt</p>
          <Button
            size="sm"
            variant="outline"
            disabled={!preview.trim()}
            onClick={() => {
              void navigator.clipboard.writeText(preview);
              toast.success("已复制预览");
            }}
          >
            <Copy className="size-3.5" />
            复制全文
          </Button>
        </div>
        <pre className="mt-3 max-h-64 overflow-auto rounded-sm bg-bg p-3 font-mono text-xs text-muted">
          {preview || "(空)"}
        </pre>
      </section>
    </div>
  );
}

function CopyRow({ value, label, muted }: { value: string; label: string; muted?: boolean }) {
  return (
    <div className="mt-2 flex items-start gap-2">
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
