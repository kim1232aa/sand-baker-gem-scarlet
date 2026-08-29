import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { AppShell } from "@/components/app-shell";
import { WatchdogEngine } from "@/components/watchdog-engine";
import { ExitsView } from "@/components/views/exits";
import { LogsView } from "@/components/views/logs";
import { Overview } from "@/components/views/overview";
import { SettingsView } from "@/components/views/settings";
import { TorView } from "@/components/views/tor";
import { VpnView } from "@/components/views/vpn";
import { SocksView } from "@/components/views/socks";
import { RelaysView } from "@/components/views/relays";
import { useAdminStore } from "@/lib/store";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const view = useAdminStore((s) => s.view);

  useEffect(() => {
    void (async () => {
      await useAdminStore.persist.rehydrate();
      const store = useAdminStore.getState();
      if (store.settings.publicHost === "relay.local") {
        store.updateSettings({ publicHost: "groktun.alibb123.ccwu.cc" });
      }
      if (!store.watchdogStartedAt) {
        useAdminStore.setState({ watchdogStartedAt: Date.now() });
      }
      store.setHydrated();
    })();
  }, []);

  return (
    <>
      <WatchdogEngine />
      <AppShell>
        {view === "overview" ? <Overview /> : null}
        {view === "relays" ? <RelaysView /> : null}
        {view === "tor" ? <TorView /> : null}
        {view === "vpn" ? <VpnView /> : null}
        {view === "socks" ? <SocksView /> : null}
        {view === "exits" ? <ExitsView /> : null}
        {view === "logs" ? <LogsView /> : null}
        {view === "settings" ? <SettingsView /> : null}
      </AppShell>
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{ className: "font-sans text-sm" }}
      />
    </>
  );
}
