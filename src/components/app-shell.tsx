import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Cable,
  Globe2,
  LayoutDashboard,
  Menu,
  Network,
  ScrollText,
  Settings2,
  Shield,
  Waypoints,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Mark } from "@/components/mark";
import { LiveDot } from "@/components/status-badge";
import { useAdminStore } from "@/lib/store";
import type { ViewId } from "@/lib/types";
import { cn } from "@/lib/cn";
import { relayFetch } from "@/lib/relays";

const NAV: { id: ViewId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "relays", label: "中继", icon: Network },
  { id: "tor", label: "Tor", icon: Shield },
  { id: "vpn", label: "VPN", icon: Globe2 },
  { id: "socks", label: "SOCKS", icon: Cable },
  { id: "exits", label: "代理池", icon: Waypoints },
  { id: "logs", label: "日志", icon: ScrollText },
  { id: "settings", label: "设置", icon: Settings2 },
];

export function AppShell({ children }: { children: ReactNode }) {
  const view = useAdminStore((s) => s.view);
  const setView = useAdminStore((s) => s.setView);
  const busy = useAdminStore((s) => s.failoverBusy);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const res = await relayFetch("/api/stack");
        const d = (await res.json()) as { host?: string; live?: boolean };
        if (cancelled) return;
        if (d.host) setHost(d.host);
        setLive(Boolean(d.live));
      } catch {
        if (!cancelled) setLive(false);
      }
    }
    void pull();
    const id = window.setInterval(() => void pull(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        const Icon = item.icon;
        const active = view === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setView(item.id);
              setOpen(false);
            }}
            className={cn(
              "flex h-11 items-center gap-3 rounded-sm px-3 text-sm transition-colors duration-150",
              active ? "bg-elevated text-fg" : "text-muted hover:bg-elevated/60 hover:text-fg",
            )}
          >
            <Icon className="size-4" strokeWidth={1.75} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh bg-bg text-fg">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface p-4 md:flex">
        <div className="mb-6 flex items-center gap-3 px-1">
          <Mark />
          <div>
            <p className="font-display text-sm font-medium tracking-tight">中继控制台</p>
            <p className="text-xs text-subtle">本机节点</p>
          </div>
        </div>
        {nav}
        <div className="mt-auto pt-6">
          <div className="rounded-md border border-border bg-bg px-3 py-2">
            <p className="flex items-center gap-2 text-xs text-muted">
              <LiveDot on={live && !busy} />
              {busy ? "正在轮换" : live ? "节点运行中" : "节点离线"}
            </p>
            <p className="mt-1 truncate font-mono text-xs text-subtle">{host || "—"}</p>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-border px-4 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="打开菜单">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetTitle className="mb-4 flex items-center gap-2">
                <Mark />
                中继控制台
              </SheetTitle>
              {nav}
            </SheetContent>
          </Sheet>
          <p className="font-display text-sm font-medium">中继控制台</p>
          <span className="ml-auto flex items-center gap-2 text-xs text-muted">
            <LiveDot on={live && !busy} />
            <Activity className="size-3.5" />
          </span>
        </header>
        <main className="flex-1 overflow-x-hidden px-4 py-5 sm:px-6 sm:py-6">{children}</main>
      </div>
    </div>
  );
}
