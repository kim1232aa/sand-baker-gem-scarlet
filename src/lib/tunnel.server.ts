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

  // restart / redial
  try {
    unlinkSync(disabled);
  } catch {
    /* ignore */
  }
  // Clear auto-failure streak on manual redial / enable.
  try {
    unlinkSync(join(dir, "FAILURES"));
  } catch {
    /* ignore */
  }
  if (kind === "tor") {
    killPidFile(join(dir, "tor.pid"));
  } else {
    // Remember current remote so pick_profile won't reselect the same node,
    // then force a full datapath tear-down (SOCKS may still answer otherwise).
    // ovpn_slots also penalizes entry IP on FORCE_REDIAL (kui redial_slot).
    const cfg = join(dir, "client.ovpn");
    try {
      if (existsSync(cfg)) {
        const text = readFileSync(cfg, "utf8");
        const remoteLine = text.split("\n").find((l) => l.startsWith("remote "));
        if (remoteLine) {
          const parts = remoteLine.trim().split(/\s+/);
          const remote = parts.length >= 3 ? `${parts[1]}:${parts[2]}` : parts[1] || "";
          if (remote) {
            const skipFile = join(dir, "SKIP_REMOTES");
            let prev: string[] = [];
            try {
              if (existsSync(skipFile)) {
                prev = readFileSync(skipFile, "utf8")
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l && !l.startsWith("#") && l !== remote);
              }
            } catch {
              prev = [];
            }
            prev.push(remote);
            writeFileSync(skipFile, prev.slice(-12).join("\n") + "\n");
            // Let ovpn_slots NodePool.penalize on FORCE_REDIAL even after cfg is removed.
            writeFileSync(join(dir, "REDIAL_ENTRY"), `${remote.split(":")[0] || remote}\n`);
          }
        }
        unlinkSync(cfg);
      }
    } catch {
      /* ignore */
    }
    writeFileSync(join(dir, "FORCE_REDIAL"), `${new Date().toISOString()}\n`);
    killPidFile(join(dir, "openvpn.pid"));
    killPidFile(join(dir, "openvpn-host.pid"));
    killPidFile(join(dir, "fwd.pid"));
    killPidFile(join(dir, "ns-socks.pid"));
  }
  return { ok: true, kind, id, slotAction };
}

/** Manual connect: write preferred node IP (kui connect_slot). */
export function connectOvpnSlot(id: string, nodeIp: string) {
  const ip = String(nodeIp || "").trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return { ok: false, error: "invalid node_ip", id };
  }
  const dir = slotDir("openvpn", id);
  mkdirSync(dir, { recursive: true });
  try {
    unlinkSync(join(dir, "DISABLED"));
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(join(dir, "FAILURES"));
  } catch {
    /* ignore */
  }
  writeFileSync(join(dir, "CONNECT"), `${ip}\n`);
  // Drop current tunnel so manager picks CONNECT on next loop.
  try {
    unlinkSync(join(dir, "client.ovpn"));
  } catch {
    /* ignore */
  }
  killPidFile(join(dir, "openvpn.pid"));
  killPidFile(join(dir, "openvpn-host.pid"));
  killPidFile(join(dir, "fwd.pid"));
  killPidFile(join(dir, "ns-socks.pid"));
  return { ok: true, id, nodeIp: ip, slotAction: "connect" as const };
}

/** Batch redial slots that are enabled but not ready (kui offline batch). */
export function batchRedialOfflineOvpn() {
  const slots = liveExitSlots().filter((s) => s.kind === "openvpn");
  const targets = slots.filter((s) => !s.disabled && s.state !== "ready");
  const results = targets.map((s) => controlSlot("openvpn", s.id, "restart"));
  return { ok: true, count: results.length, ids: targets.map((s) => s.id), results };
}

export function listOvpnNodes(country = "ANY") {
  const file = join(BIN, "ovpn-nodes.json");
  let updated = 0;
  let counts: Record<string, number> = {};
  let nodes: Array<Record<string, unknown>> = [];
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        updated?: number;
        counts?: Record<string, number>;
        nodes?: Array<Record<string, unknown>>;
      };
      updated = Number(parsed.updated || 0);
      counts = parsed.counts || {};
      nodes = parsed.nodes || [];
    }
  } catch {
    /* ignore */
  }
  const cc = (country || "ANY").toUpperCase();
  const filtered =
    cc === "ANY" || cc === "ALL" || cc === ""
      ? nodes
      : nodes.filter((n) => String(n.country || "").toUpperCase() === cc);
  return { updated, counts, country: cc, nodes: filtered };
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
    // Multi-URL connectivity set (kui STREAM_URLS via SOCKS).
    const urls = [
      "https://www.gstatic.com/generate_204",
      "https://www.google.com/",
      "https://chatgpt.com",
      "https://cn.tradingview.com",
      "https://claude.ai",
    ];
    const attempts: {
      url: string;
      code: string;
      accepted: boolean;
      classification: string;
      elapsed_ms: number;
    }[] = [];
    for (const url of urls) {
      const t0 = Date.now();
      try {
        const { stdout: codeOut } = await execFileAsync(
          "curl",
          [
            "-o",
            "/dev/null",
            "-s",
            "-w",
            "%{http_code}",
            "-A",
            "Mozilla/5.0",
            "-m",
            "8",
            "--location",
            "--max-redirs",
            "20",
            "--socks5-hostname",
            `127.0.0.1:${port}`,
            url,
          ],
          { timeout: 12000 },
        );
        const code = String(codeOut || "").trim();
        const is204 = url.includes("generate_204");
        const n = Number(code);
        const accepted = is204
          ? code === "204"
          : Number.isFinite(n) && ((n >= 200 && n < 300) || (n >= 400 && n < 500 && n !== 407));
        attempts.push({
          url,
          code,
          accepted,
          classification: accepted ? "explicit_response" : "unexpected_status",
          elapsed_ms: Date.now() - t0,
        });
      } catch (err) {
        attempts.push({
          url,
          code: "000",
          accepted: false,
          classification: "timeout",
          elapsed_ms: Date.now() - t0,
        });
      }
    }
    const base_ok = Boolean(attempts[0]?.accepted);
    const custom_ok = attempts.slice(1).length > 0 && attempts.slice(1).every((a) => a.accepted);
    return {
      ok: Boolean(ip),
      id,
      kind,
      port,
      ip,
      ms: Date.now() - started,
      targets: { base_ok, custom_ok, accepted: base_ok && custom_ok, attempts },
      egress_type: row?.egress_type,
      isp_org: row?.isp_org,
      geo_country: row?.geo_country,
      city: row?.city,
    };
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
  const ovpnNodes = listOvpnNodes("ANY");
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
    ovpnNodeCounts: ovpnNodes.counts,
    ovpnNodesUpdated: ovpnNodes.updated,
    counts: counts(h, slots),
    socks: {
      localPlainUrl: `${SUB_PATH}/socks.txt`,
      localClashUrl: `${SUB_PATH}/socks.yaml`,
      remoteNote: "SOCKS 仅本机 127.0.0.1；远程请用 VLESS 订阅 /res-*",
    },
    logs: [...tailFile(join(BIN, "supervise.log"), 12), ...tailFile(join(BIN, "cf.log"), 8)].slice(-20),
  };
}
