export type RelayNode = {
  id: string;
  name: string;
  baseUrl: string;
  adminToken: string;
  enabled: boolean;
};

export const RELAYS_KEY = "relay-nodes-v1";
export const LOCAL_ADMIN_TOKEN_KEY = "relay-admin-token";

export function loadRelays(): RelayNode[] {
  try {
    const raw = localStorage.getItem(RELAYS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RelayNode[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRelays(nodes: RelayNode[]) {
  localStorage.setItem(RELAYS_KEY, JSON.stringify(nodes));
}

export function loadLocalAdminToken(): string {
  try {
    return localStorage.getItem(LOCAL_ADMIN_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function saveLocalAdminToken(token: string) {
  localStorage.setItem(LOCAL_ADMIN_TOKEN_KEY, token.trim());
}

export function normalizeBaseUrl(url: string): string {
  const t = url.trim().replace(/\/+$/, "");
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

export async function relayFetch(
  path: string,
  init: RequestInit & { baseUrl?: string; adminToken?: string } = {},
): Promise<Response> {
  const { baseUrl, adminToken, headers, ...rest } = init;
  const token = (adminToken ?? loadLocalAdminToken()).trim();
  const h = new Headers(headers);
  if (token) h.set("x-relay-token", token);
  if (rest.body && !h.has("content-type")) h.set("content-type", "application/json");
  const root = baseUrl ? normalizeBaseUrl(baseUrl) : "";
  const url = root ? `${root}${path.startsWith("/") ? path : `/${path}`}` : path;
  return fetch(url, { ...rest, headers: h, cache: "no-store" });
}

export function newRelayId(): string {
  return `r-${Math.random().toString(36).slice(2, 10)}`;
}
