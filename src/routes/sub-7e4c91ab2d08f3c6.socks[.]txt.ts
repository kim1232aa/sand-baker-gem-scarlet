import { createFileRoute } from "@tanstack/react-router";
import { socksTxtBody, socksTxtHeaders } from "@/lib/subscribe";
import { liveExitSlots } from "@/lib/tunnel.server";

export const Route = createFileRoute("/sub-7e4c91ab2d08f3c6/socks.txt")({
  server: {
    handlers: {
      GET: () => new Response(socksTxtBody(liveExitSlots()), { headers: socksTxtHeaders() }),
    },
  },
});
