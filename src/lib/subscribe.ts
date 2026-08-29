import { STACK_UUID } from "./seed";
import {
  buildClashYaml,
  buildSingbox,
  buildSocksClashYaml,
  buildSocksTxt,
  buildV2rayLinks,
  type LiveExit,
} from "./nodes";

export const SUB_TOKEN = "7e4c91ab2d08f3c6";
export const SUB_PATH = `/sub-${SUB_TOKEN}`;

export function hostFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-host");
  const raw = (forwarded?.split(",")[0] ?? request.headers.get("host") ?? "relay.local").trim();
  return raw;
}

export function publicHostname(hostWithPort: string): string {
  return hostWithPort.replace(/:\d+$/, "");
}

export function clashBody(host: string, exits: LiveExit[] = []): string {
  return buildClashYaml(publicHostname(host), STACK_UUID, SUB_PATH, exits);
}

export function v2rayBody(host: string, exits: LiveExit[] = []): string {
  return buildV2rayLinks(publicHostname(host), STACK_UUID, exits);
}

export function singboxBody(host: string, exits: LiveExit[] = []): string {
  return buildSingbox(publicHostname(host), STACK_UUID, exits);
}

export function socksTxtBody(exits: LiveExit[] = []): string {
  return buildSocksTxt(exits);
}

export function socksClashBody(exits: LiveExit[] = []): string {
  return buildSocksClashYaml(exits);
}

export function clashHeaders(): HeadersInit {
  return {
    "content-type": "text/yaml; charset=utf-8",
    "cache-control": "no-store",
    "profile-update-interval": "24",
    "profile-title": "Relay",
    "subscription-userinfo": "upload=0; download=0; total=107374182400; expire=0",
  };
}

export function socksTxtHeaders(): HeadersInit {
  return {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  };
}

export function socksClashHeaders(): HeadersInit {
  return {
    "content-type": "text/yaml; charset=utf-8",
    "cache-control": "no-store",
    "profile-title": "Relay-SOCKS-Local",
  };
}
