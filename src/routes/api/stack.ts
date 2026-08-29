import { createFileRoute } from "@tanstack/react-router";
import {
  assertAdminAuth,
  controlProcess,
  controlSlot,
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
          slotAction?: "restart" | "stop";
          slotId?: string;
          slotKind?: SlotKind;
          probe?: boolean;
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

        if (body.probe && body.slotId && body.slotKind) {
          const probe = await probeSlot(body.slotKind, body.slotId);
          return Response.json({ ...stackStatus(), probe });
        }

        if (body.slotAction && body.slotId && body.slotKind) {
          const slot = controlSlot(body.slotKind, body.slotId, body.slotAction);
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
