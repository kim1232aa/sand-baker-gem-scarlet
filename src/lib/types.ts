export type ExitStatus = "ok" | "down";
export type ExitKind = "direct" | "socks5" | "http";
export type ViewId =
  | "overview"
  | "relays"
  | "tor"
  | "vpn"
  | "socks"
  | "health"
  | "exits"
  | "logs"
  | "settings";

export interface Exit {
  id: string;
  label: string;
  url: string;
  status: ExitStatus;
  kind: ExitKind;
}

export interface LogLine {
  t: number;
  text: string;
}

export interface Settings {
  publicHost: string;
  intervalSec: number;
  keepalive: boolean;
  subPath: string;
}

export interface Session {
  issuedAt: number;
}

export const DIRECT_ID = "direct";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_MS = 5 * 60 * 1000;
export const PROXY_SCHEMES = ["http://", "https://", "socks5://"] as const;
export const DEFAULT_PASSWORD = "admin";
export const STORAGE_KEY = "relay-node-v5";
