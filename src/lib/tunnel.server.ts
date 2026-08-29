import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { counts, socksPort, type LiveExit } from "./nodes";
import { SUB_PATH } from "./subscribe";

const BIN = process.env.PROXY_BIN || join(process.cwd(), "proxy-bin");
const HOST_FILE = join(BIN, "cf-hostname");
const TOKEN_FILE = join(BIN, "cf-tunnel-token");
const ADMIN_TOKEN_FILE = join(BIN, "admin-token");

export type ProcName = "xray" | "mux" | "cloudflared" | "supervise" | "slots" | "ovpn" | "stack";
export type SlotKind = "tor" | "openvpn";

function pidAlive(file: string): boolean {
  try {
    if (!existsSync(file)) return false;
    const pid = Number(readFileSync(file, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file: string): number {
  try {
    if (!existsSync(file)) return 0;
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function killPidFile(file: string, sig: NodeJS.Signals = "SIGTERM") {
  const pid = readPid(file);
  if (!pid) return false;
  try {
    process.kill(pid, sig);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
  return true;
}

function tailFile(file: string, max = 24): string[] {
  try {
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-max);
  } catch {
    return [];
  }
}

export function tunnelHostname(): string | null {
  try {
    if (!existsSync(HOST_FILE)) return null;
    const host = readFileSync(HOST_FILE, "utf8").trim();
    return host || null;
  } catch {
    return null;
  }
}

export function hasTunnelToken(): boolean {
  try {
    return existsSync(TOKEN_FILE) && readFileSync(TOKEN_FILE, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

export function readAdminToken(): string | null {
  try {
    if (!existsSync(ADMIN_TOKEN_FILE)) return null;
    const t = readFileSync(ADMIN_TOKEN_FILE, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

export function writeAdminToken(token: string) {
  writeFileSync(ADMIN_TOKEN_FILE, token.trim() + "\n", { mode: 0o600 });
}

/** If admin-token file exists, require matching x-relay-token (or body.adminToken). */
export function assertAdminAuth(request: Request, bodyToken?: string): Response | null {
  const expected = readAdminToken();
  if (!expected) return null;
  const header = request.headers.get("x-relay-token")?.trim() || "";
  const ok = header === expected || (typeof bodyToken === "string" && bodyToken.trim() === expected);
  if (ok) return null;
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export function writeTunnelAuth(token?: string, host?: string) {
  if (typeof token === "string") {
    writeFileSync(TOKEN_FILE, token.trim() + "\n");
  }
  if (typeof host === "string" && host.trim()) {
    const h = host.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    writeFileSync(HOST_FILE, h + "\n");
  }
}

export function restartStack() {
  spawn("bash", [join(BIN, "start.sh")], {
    detached: true,
    stdio: "ignore",
    cwd: BIN,
  }).unref();
}

function spawnDetached(cmd: string, args: string[], logFile: string) {
  const fd = openSync(logFile, "a");
  spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      PROXY_BIN: BIN,
      PYTHONPATH: BIN,
      LD_LIBRARY_PATH: join(BIN, "native", "lib"),
    },
    cwd: BIN,
  }).unref();
}

export function controlProcess(target: ProcName, action: "start" | "stop" | "restart") {
  if (target === "stack") {
    if (action === "stop") {
      for (const name of ["cloudflared", "mux", "xray", "slots", "ovpn", "supervise"] as const) {
        controlProcess(name, "stop");
      }
      return { ok: true, target, action };
    }
    restartStack();
    return { ok: true, target, action: "restart" };
  }

  const pidFile =
    target === "slots"
      ? join(BIN, "slots.pid")
      : target === "ovpn"
        ? join(BIN, "ovpn-slots.pid")
        : join(BIN, `${target}.pid`);

  if (action === "stop" || action === "restart") {
    killPidFile(pidFile);
    if (target === "mux") {
      // mux may be orphaned without pid sync
      try {
        spawn("pkill", ["-f", `node ${BIN}/mux.mjs`], { stdio: "ignore" }).unref();
      } catch {
        /* ignore */
      }
    }
  }

  if (action === "start" || action === "restart") {
    if (target === "xray") {
      spawnDetached(join(BIN, "xray"), ["run", "-c", join(BIN, "xray.json")], join(BIN, "xray.log"));
      // pid written by start.sh normally — best-effort capture after short delay is skipped; supervise will heal
    } else if (target === "mux") {
      spawnDetached("node", [join(BIN, "mux.mjs")], join(BIN, "mux.log"));
    } else if (target === "cloudflared") {
      if (existsSync(TOKEN_FILE) && readFileSync(TOKEN_FILE, "utf8").trim()) {
        const token = readFileSync(TOKEN_FILE, "utf8").trim();
        spawnDetached(join(BIN, "cloudflared"), ["tunnel", "--protocol", "http2", "--no-autoupdate", "run", "--token", token], join(BIN, "cf.log"));
      } else {
        spawnDetached(join(BIN, "cloudflared"), ["tunnel", "--protocol", "http2", "--no-autoupdate", "--url", "http://127.0.0.1:38079"], join(BIN, "cf.log"));
      }
    } else if (target === "supervise") {
      spawnDetached("bash", [join(BIN, "supervise.sh")], join(BIN, "supervise.log"));
    } else if (target === "slots") {
      spawnDetached("python3", [join(BIN, "kui", "slots.py")], join(BIN, "slots.log"));
    } else if (target === "ovpn") {
      spawnDetached("python3", [join(BIN, "kui", "ovpn_slots.py")], join(BIN, "ovpn-slots.log"));
    }
    // For binaries started without writing pid here, fall back to full start.sh for xray/mux/cf
    if (target === "xray" || target === "mux" || target === "cloudflared") {
      // ensure pid files via start.sh fragment
      restartStack();
    }
  }

  return { ok: true, target, action };
}

function slotDir(kind: SlotKind, id: string) {
  return kind === "tor" ? join(BIN, "tor", id) : join(BIN, "ovpn", id);
}

export function controlSlot(kind: SlotKind, id: string, slotAction: "restart" | "stop") {
  const dir = slotDir(kind, id);
  mkdirSync(dir, { recursive: true });
  const disabled = join(dir, "DISABLED");

  if (slotAction === "stop") {
    writeFileSync(disabled, `${new Date().toISOString()}\n`);
    if (kind === "tor") {
      killPidFile(join(dir, "tor.pid"));
    } else {
      killPidFile(join(dir, "openvpn.pid"));
      killPidFile(join(dir, "openvpn-host.pid"));
      killPidFile(join(dir, "fwd.pid"));
      killPidFile(join(dir, "ns-socks.pid"));
      killPidFile(join(dir, "slirp.pid"));
      killPidFile(join(dir, "ns.pid"), "SIGTERM");
    }
    return { ok: true, kind, id, slotAction };
  }

  // restart
  try {
    unlinkSync(disabled);
  } catch {
    /* ignore */
  }
  if (kind === "tor") {
    killPidFile(join(dir, "tor.pid"));
  } else {
    killPidFile(join(dir, "openvpn.pid"));
    killPidFile(join(dir, "openvpn-host.pid"));
    try {
      unlinkSync(join(dir, "client.ovpn"));
    } catch {
      /* ignore */
    }
  }
  return { ok: true, kind, id, slotAction };
}

export async function probeSlot(kind: SlotKind, id: string) {
  const slots = liveExitSlots();
  const row = slots.find((s) => s.id === id && (s.kind || "tor") === kind);
  const port = row ? socksPort(row) : 0;
  if (!port) return { ok: false, error: "no port", id, kind };
  const started = Date.now();
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      "curl",
      ["-fsS", "--max-time", "12", "--socks5-hostname", `127.0.0.1:${port}`, "https://api.ipify.org"],
      { timeout: 15000 },
    );
    const ip = String(stdout || "").trim();
    return { ok: Boolean(ip), id, kind, port, ip, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, id, kind, port, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

async function httpOk(url: string, ms: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { method: "GET", signal: ac.signal, cache: "no-store" });
    return res.ok || res.status === 426 || res.status === 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let tickleFails = 0;

export async function tickleStack() {
  const host = tunnelHostname();
  const local = await httpOk("http://127.0.0.1:38079/vless", 4000);
  const tunnel = host ? await httpOk(`https://${host}/vless`, 8000) : false;
  const bad = !local || Boolean(host && !tunnel);
  tickleFails = bad ? tickleFails + 1 : 0;
  const restarted = tickleFails >= 3;
  if (restarted) tickleFails = 0;
  const row = {
    at: new Date().toISOString(),
    local,
    tunnel,
    host,
    restarted,
  };
  try {
    writeFileSync(join(BIN, "heartbeat.json"), JSON.stringify(row) + "\n");
  } catch {
    /* ignore */
  }
  try {
    const line = `${row.at} tickle local=${local} tunnel=${tunnel} host=${host || "-"} restarted=${restarted}\n`;
    writeFileSync(join(BIN, "supervise.log"), line, { flag: "a" });
  } catch {
    /* ignore */
  }
  if (restarted) restartStack();
  return row;
}

function normalizeSlot(raw: LiveExit): LiveExit {
  const kind = raw.kind === "openvpn" ? "openvpn" : "tor";
  const port = socksPort(raw);
  return {
    ...raw,
    kind,
    socks: port || raw.socks,
    state: raw.state || "down",
  };
}

export function liveExitSlots(): LiveExit[] {
  const rows: LiveExit[] = [];
  for (const file of [join(BIN, "slots.json"), join(BIN, "ovpn.json")]) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { slots?: LiveExit[] };
      for (const s of parsed.slots ?? []) rows.push(normalizeSlot(s));
    } catch {
      /* ignore */
    }
  }
  return rows;
}

export function stackStatus() {
  const host = tunnelHostname();
  const procs = {
    xray: pidAlive(join(BIN, "xray.pid")),
    mux: pidAlive(join(BIN, "mux.pid")),
    cloudflared: pidAlive(join(BIN, "cloudflared.pid")),
    supervise: pidAlive(join(BIN, "supervise.pid")),
    slots: pidAlive(join(BIN, "slots.pid")),
    ovpn: pidAlive(join(BIN, "ovpn-slots.pid")),
  };
  let heartbeat: { at?: string; local?: boolean; tunnel?: boolean } | null = null;
  try {
    if (existsSync(join(BIN, "heartbeat.json"))) {
      heartbeat = JSON.parse(readFileSync(join(BIN, "heartbeat.json"), "utf8")) as {
        at?: string;
        local?: boolean;
        tunnel?: boolean;
      };
    }
  } catch {
    heartbeat = null;
  }
  const live = procs.xray && procs.mux && procs.cloudflared;
  const slots = liveExitSlots();
  const torSlots = slots.filter((s) => s.kind !== "openvpn");
  const ovpnSlots = slots.filter((s) => s.kind === "openvpn");
  const h = host || "relay.local";
  return {
    host,
    token: hasTunnelToken(),
    adminTokenRequired: Boolean(readAdminToken()),
    uuid: "a3f1c8e2-9b47-4d6a-8e21-c5f90b3d7a14",
    procs,
    live,
    heartbeat,
    egress: "this-host",
    slots,
    torSlots,
    ovpnSlots,
    counts: counts(h, slots),
    socks: {
      localPlainUrl: `${SUB_PATH}/socks.txt`,
      localClashUrl: `${SUB_PATH}/socks.yaml`,
      remoteNote: "SOCKS 仅本机 127.0.0.1；远程请用 VLESS 订阅 /res-*",
    },
    logs: [...tailFile(join(BIN, "supervise.log"), 12), ...tailFile(join(BIN, "cf.log"), 8)].slice(-20),
  };
}
