import { createFileRoute } from "@tanstack/react-router";
import {
  assertAdminAuth,
  batchRedialOfflineOvpn,
  connectOvpnSlot,
  controlProcess,
  controlSlot,
  listOvpnNodes,
  probeSlot,
  restartStack,
  stackStatus,
  tickleStack,
  writeAdminToken,
  writeTunnelAuth,
  type ProcName,
  type SlotKind,
} from "@/lib/tunnel.server";

export const Route = createFileRoute("/api/stack")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const denied = assertAdminAuth(request);
        if (denied) return denied;
        const url = new URL(request.url);
        if (url.searchParams.get("nodes") === "1" || url.searchParams.get("ovpnNodes") === "1") {
          const country = url.searchParams.get("country") || "ANY";
          return Response.json({ ok: true, ...listOvpnNodes(country), ...stackStatus() });
        }
        return Response.json(stackStatus());
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          token?: string;
          host?: string;
          restart?: boolean;
          tickle?: boolean;
          adminToken?: string;
          setAdminToken?: string;
          action?: "start" | "stop" | "restart";
          target?: ProcName;
          slotAction?: "restart" | "stop" | "connect";
          slotId?: string;
          slotKind?: SlotKind;
          probe?: boolean;
          nodeIp?: string;
          batchRedialOffline?: boolean;
          listNodes?: boolean;
          country?: string;
        };

        const denied = assertAdminAuth(request, body.adminToken);
        if (denied) return denied;

        if (typeof body.setAdminToken === "string" && body.setAdminToken.trim()) {
          writeAdminToken(body.setAdminToken.trim());
          return Response.json({ ok: true, ...stackStatus() });
        }

        if (body.tickle) {
          const tickle = await tickleStack();
          return Response.json({ ...stackStatus(), tickle });
        }

        if (body.listNodes) {
          return Response.json({
            ok: true,
            ...listOvpnNodes(body.country || "ANY"),
            ...stackStatus(),
          });
        }

        if (body.batchRedialOffline) {
          const batch = batchRedialOfflineOvpn();
          return Response.json({ ok: true, batch, ...stackStatus() });
        }

        if (body.probe && body.slotId && body.slotKind) {
          const probe = await probeSlot(body.slotKind, body.slotId);
          return Response.json({ ...stackStatus(), probe });
        }

        if (body.slotAction === "connect" && body.slotId && body.nodeIp) {
          const slot = connectOvpnSlot(body.slotId, body.nodeIp);
          return Response.json({ ok: slot.ok, slot, ...stackStatus() }, { status: slot.ok ? 200 : 400 });
        }

        if (body.slotAction && body.slotId && body.slotKind) {
          const slot = controlSlot(body.slotKind, body.slotId, body.slotAction as "restart" | "stop");
          return Response.json({ ok: true, slot, ...stackStatus() });
        }

        if (body.action && body.target) {
          const proc = controlProcess(body.target, body.action);
          return Response.json({ ok: true, proc, ...stackStatus() });
        }

        if (body.token || body.host) writeTunnelAuth(body.token, body.host);
        if (body.restart || body.token || body.host) restartStack();
        return Response.json({ ok: true, ...stackStatus() });
      },
    },
  },
});
