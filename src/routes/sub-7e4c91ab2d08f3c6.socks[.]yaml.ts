import { createFileRoute } from "@tanstack/react-router";
import { socksClashBody, socksClashHeaders } from "@/lib/subscribe";
import { liveExitSlots } from "@/lib/tunnel.server";

export const Route = createFileRoute("/sub-7e4c91ab2d08f3c6/socks.yaml")({
  server: {
    handlers: {
      GET: () => new Response(socksClashBody(liveExitSlots()), { headers: socksClashHeaders() }),
    },
  },
});
