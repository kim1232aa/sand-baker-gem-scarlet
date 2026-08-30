export type SubNode = {
  name: string;
  server: string;
  path: string;
  group: "front" | "exit";
  country?: string;
  egressIp?: string;
  kind?: "openvpn" | "tor" | "front";
};

export type LiveExit = {
  id: string;
  country: string;
  state?: string;
  egress_ip?: string;
  socks?: number;
  /** OpenVPN local SOCKS port (normalized into socks by API). */
  port?: number;
  vpn_port?: string | number;
  pid?: number;
  kind?: string;
  /** Current OpenVPN remote host:port when known. */
  remote?: string;
  /** Remaining VPNGate TCP candidates after skips. */
  candidates?: number;
  disabled?: boolean;
  /** kui-aligned redial metadata */
  generation?: number;
  failures?: number;
  country_fallback?: boolean;
  fallback_country?: string;
  target_country?: string;
  /** Optional TestISP-style fields (future); default 未验证 / VPNGate|Tor */
  egress_type?: "residential" | "datacenter" | "enterprise" | "unverified";
  isp_org?: string;
};

export type OvpnCandidate = {
  ip: string;
  country?: string;
  ping?: number;
  score?: number;
  port?: string;
  proto?: string;
  remote?: string;
};

export function socksPort(slot: LiveExit): number {
  const n = Number(slot.socks ?? slot.port ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Short slot tag: ovpn-jp2 -> jp2, us2 -> us2 */
export function exitSlotTag(slot: Pick<LiveExit, "id">): string {
  return String(slot.id || "")
    .replace(/^ovpn-/i, "")
    .toLowerCase() || "x";
}

/** kui `_slot_label_country`: JP or FI-FB-US when country_fallback. */
export function exitCountryLabel(slot: LiveExit): string {
  const target = String(slot.target_country || slot.country || "").toUpperCase();
  if (slot.country_fallback) {
    const actual = String(slot.fallback_country || slot.country || "").toUpperCase();
    if (actual && target && actual !== target && actual !== "XX" && target !== "ANY") {
      return `${actual}-FB-${target}`;
    }
  }
  if (target && target !== "ANY" && target !== "XX") return target;
  return String(slot.country || "XX").toUpperCase() || "XX";
}

const ISP_SHORT: Record<string, string> = {
  "sony network communications": "SonyNURO",
  "so-net": "So-net",
  kddi: "KDDI",
  "arteria networks": "ARTERIA",
  "korea telecom": "KT",
  "triple t": "TripleT",
  ntt: "NTT",
  "asahi net": "ASAHI",
  softbank: "SoftBank",
  biglobe: "BIGLOBE",
  ocn: "OCN",
  plala: "Plala",
  rakuten: "Rakuten",
  "k-opti": "K-Opti",
  "j:com": "JCOM",
  nifty: "Nifty",
};

function shortIsp(raw: string | undefined, kind: string | undefined): string {
  const text = String(raw || "").trim();
  if (text) {
    const low = text.toLowerCase();
    for (const [key, short] of Object.entries(ISP_SHORT)) {
      if (low.includes(key)) return short;
    }
    for (const tok of text.replace(/,/g, " ").split(/\s+/)) {
      const t = tok.toLowerCase();
      if (!["inc", "inc.", "corporation", "corp", "co", "co.", "ltd", "ltd.", "llc", "the"].includes(t)) {
        return tok.slice(0, 12);
      }
    }
  }
  return kind === "openvpn" ? "VPNGate" : "Tor";
}

function egressKindLabel(slot: LiveExit): string {
  const t = String(slot.egress_type || "unverified").toLowerCase();
  if (t === "residential") return "住宅";
  if (t === "datacenter") return "机房";
  if (t === "enterprise") return "企业";
  // unknown / unverified / missing
  return "未验证";
}

/**
 * kui `_exit_clash_name`: `{CC}{类型}·{ISP}·{slotId}` (no egress IP in name).
 * Examples:
 *   JP未验证·VPNGate·ovpn-jp2
 *   FI-FB-US未验证·VPNGate·ovpn-us2
 *   DE未验证·Tor·de
 */
export function exitLabel(slot: LiveExit): string {
  const country = exitCountryLabel(slot);
  const kind = egressKindLabel(slot);
  const isp = shortIsp(slot.isp_org, slot.kind);
  const id = String(slot.id || "x");
  return `${country}${kind}·${isp}·${id}`;
}

export function readySocksSlots(exits: LiveExit[]): LiveExit[] {
  return exits.filter((s) => s.state === "ready" && socksPort(s) > 0);
}

export function buildSocksTxt(exits: LiveExit[]): string {
  return (
    readySocksSlots(exits)
      .map((s) => {
        const port = socksPort(s);
        return `socks5://127.0.0.1:${port}#${exitLabel(s).replace(/·/g, "-")}`;
      })
      .join("\n") + (readySocksSlots(exits).length ? "\n" : "")
  );
}

function q(name: string): string {
  return JSON.stringify(name);
}

function lst(items: string[]): string {
  const clean = items.filter(Boolean);
  return clean.length ? clean.map((n) => `      - ${q(n)}`).join("\n") : `      - ${q("DIRECT")}`;
}

export function buildSocksClashYaml(exits: LiveExit[]): string {
  const ready = readySocksSlots(exits);
  const proxies = ready.map((s) => {
    const port = socksPort(s);
    const name = exitLabel(s);
    return [
      `  - name: ${q(name)}`,
      `    type: socks5`,
      `    server: 127.0.0.1`,
      `    port: ${port}`,
      `    udp: true`,
    ].join("\n");
  });
  const names = ready.map((s) => exitLabel(s));
  const pure = ready.filter(
    (s) => !s.egress_type || s.egress_type === "residential" || s.egress_type === "unverified",
  );
  const pureNames = pure.map((s) => exitLabel(s));
  const groups = [
    `  - name: "🚀 节点选择"`,
    `    type: select`,
    `    proxies:`,
    lst(["⚡ 自动选择", "🏠 住宅自动", ...names, "DIRECT"]),
    `  - name: "⚡ 自动选择"`,
    `    type: url-test`,
    `    url: "http://www.gstatic.com/generate_204"`,
    `    interval: 300`,
    `    tolerance: 100`,
    `    proxies:`,
    lst(names.length ? names : ["DIRECT"]),
    `  - name: "🏠 住宅自动"`,
    `    type: url-test`,
    `    url: "http://www.gstatic.com/generate_204"`,
    `    interval: 300`,
    `    tolerance: 150`,
    `    proxies:`,
    lst(pureNames.length ? pureNames : names.length ? names : ["DIRECT"]),
    `  - name: "🌐 其他流量"`,
    `    type: select`,
    `    proxies:`,
    lst(["🚀 节点选择", "⚡ 自动选择", "🏠 住宅自动", "DIRECT"]),
  ];
  return [
    `mixed-port: 7890`,
    `allow-lan: false`,
    `mode: rule`,
    `log-level: info`,
    `proxies:`,
    ...(proxies.length ? proxies : [`  - name: "DIRECT-PLACEHOLDER"`, `    type: direct`]),
    `proxy-groups:`,
    ...groups,
    `rules:`,
    `  - MATCH,🌐 其他流量`,
    ``,
  ].join("\n");
}

export const CF_FRONTS: { server: string; name: string }[] = [
  { server: "cf.090227.xyz", name: "CF优选·090227" },
  { server: "bestcf.030101.xyz", name: "CF优选·移动" },
  { server: "saas.sin.fan", name: "CF优选·MIYU" },
  { server: "www.visa.cn", name: "伪装·VISA" },
  { server: "www.visa.com", name: "伪装·VISA·COM" },
  { server: "www.visa.com.hk", name: "伪装·VISA·HK" },
  { server: "time.is", name: "伪装·TimeIs" },
  { server: "cloudflare.com", name: "CF·cloudflare.com" },
  { server: "www.cloudflare.com", name: "CF·www" },
  { server: "cdnjs.cloudflare.com", name: "CF·cdnjs" },
  { server: "cloudflare-dns.com", name: "CF·dns" },
  { server: "dash.cloudflare.com", name: "CF·dash" },
];

const CLAUDE_RULES = [
  "DOMAIN-SUFFIX,anthropic.com",
  "DOMAIN-SUFFIX,claude.ai",
  "DOMAIN-SUFFIX,claude.com",
  "DOMAIN-SUFFIX,clau.de",
  "DOMAIN-SUFFIX,claudeusercontent.com",
  "DOMAIN-SUFFIX,modelcontextprotocol.io",
  "DOMAIN,anthropic.com.cdn.cloudflare.net",
  "DOMAIN-KEYWORD,claude",
  "DOMAIN-KEYWORD,anthropic",
];

const CHATGPT_RULES = [
  "DOMAIN-SUFFIX,openai.com",
  "DOMAIN-SUFFIX,chatgpt.com",
  "DOMAIN-SUFFIX,oaistatic.com",
  "DOMAIN-SUFFIX,oaiusercontent.com",
  "DOMAIN-SUFFIX,openai.org",
  "DOMAIN-SUFFIX,sora.com",
  "DOMAIN-KEYWORD,openai",
  "DOMAIN-KEYWORD,chatgpt",
  "DOMAIN-SUFFIX,grok.com",
  "DOMAIN-SUFFIX,x.ai",
  "DOMAIN-SUFFIX,perplexity.ai",
  "DOMAIN-SUFFIX,poe.com",
  "DOMAIN-SUFFIX,cursor.sh",
  "DOMAIN-SUFFIX,openrouter.ai",
  "DOMAIN-SUFFIX,huggingface.co",
  "DOMAIN-SUFFIX,character.ai",
  "DOMAIN-SUFFIX,midjourney.com",
  "DOMAIN-SUFFIX,mistral.ai",
  "DOMAIN-SUFFIX,groq.com",
  "DOMAIN-SUFFIX,githubcopilot.com",
  "DOMAIN-SUFFIX,copilot.microsoft.com",
];

const GEMINI_RULES = [
  "DOMAIN-SUFFIX,aistudio.google.com",
  "DOMAIN-SUFFIX,makersuite.google.com",
  "DOMAIN-SUFFIX,generativelanguage.googleapis.com",
  "DOMAIN-SUFFIX,cloudcode-pa.googleapis.com",
  "DOMAIN-SUFFIX,ai.google.dev",
  "DOMAIN-SUFFIX,gemini.google.com",
  "DOMAIN-SUFFIX,vertexai.googleapis.com",
  "DOMAIN-SUFFIX,aiplatform.googleapis.com",
  "DOMAIN-SUFFIX,googleapis.com",
];

const LOCAL_DIRECT_RULES = [
  "DOMAIN-SUFFIX,local,DIRECT",
  "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
  "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
  "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
  "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
  "IP-CIDR,100.64.0.0/10,DIRECT,no-resolve",
  "IP-CIDR,198.18.0.0/15,DIRECT,no-resolve",
];

function frontNodes(host: string): SubNode[] {
  return [
    { name: "CF·本机", server: host, path: "/vless", group: "front", kind: "front" },
    ...CF_FRONTS.map((e) => ({
      name: e.name,
      server: e.server,
      path: "/vless",
      group: "front" as const,
      kind: "front" as const,
    })),
  ];
}

function exitNodes(host: string, exits: LiveExit[]): SubNode[] {
  return exits
    .filter((s) => s.state === "ready" && s.egress_ip)
    .map((s) => ({
      name: exitLabel(s),
      server: host,
      path: `/res-${s.id}`,
      group: "exit" as const,
      country: s.country,
      egressIp: s.egress_ip,
      kind: (s.kind === "openvpn" ? "openvpn" : "tor") as "openvpn" | "tor",
    }));
}

export function catalog(host: string, exits: LiveExit[] = []): SubNode[] {
  return [...frontNodes(host), ...exitNodes(host, exits)];
}

export function vlessLinkFor(host: string, uuid: string, node: SubNode): string {
  const qs = new URLSearchParams({
    encryption: "none",
    security: "tls",
    sni: host,
    fp: "chrome",
    type: "ws",
    host,
    path: node.path,
  });
  return `vless://${uuid}@${node.server}:443?${qs.toString()}#${encodeURIComponent(node.name)}`;
}

function proxyLine(uuid: string, host: string, node: SubNode): string {
  return [
    `  - name: ${q(node.name)}`,
    `    type: vless`,
    `    server: ${node.server}`,
    `    port: 443`,
    `    uuid: ${uuid}`,
    `    network: ws`,
    `    tls: true`,
    `    udp: true`,
    `    servername: ${host}`,
    `    client-fingerprint: chrome`,
    `    ws-opts:`,
    `      path: ${node.path}`,
    `      headers:`,
    `        Host: ${host}`,
  ].join("\n");
}

export function buildClashYaml(host: string, uuid: string, subPath: string, exits: LiveExit[] = []): string {
  const nodes = catalog(host, exits);
  const fronts = nodes.filter((n) => n.group === "front");
  const outs = nodes.filter((n) => n.group === "exit");
  const frontNames = fronts.map((n) => n.name);
  const exitNames = outs.map((n) => n.name);
  // kui: residential + unverified go into 🏠 住宅自动; we have no TestISP yet → all exits
  // kui: residential + unverified → 🏠 住宅自动; datacenter stays in ⚡ only
  const pureNames = outs
    .filter((n) => {
      const slot = exits.find((s) => exitLabel(s) === n.name);
      const t = String(slot?.egress_type || "unverified").toLowerCase();
      return t === "residential" || t === "unverified" || t === "unknown" || !slot?.egress_type;
    })
    .map((n) => n.name);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const groups: string[] = [
    `  - name: "🚀 节点选择"`,
    `    type: select`,
    `    proxies:`,
    lst(["⚡ 自动选择", "🏠 住宅自动", "⚡ CF入口", ...exitNames, ...frontNames, "DIRECT"]),
    `  - name: "⚡ 自动选择"`,
    `    type: url-test`,
    `    url: "http://www.gstatic.com/generate_204"`,
    `    interval: 300`,
    `    tolerance: 100`,
    `    proxies:`,
    lst(exitNames.length ? exitNames : frontNames.length ? frontNames : ["DIRECT"]),
    `  - name: "🏠 住宅自动"`,
    `    type: url-test`,
    `    url: "http://www.gstatic.com/generate_204"`,
    `    interval: 300`,
    `    tolerance: 150`,
    `    proxies:`,
    lst(pureNames.length ? pureNames : ["🚀 节点选择"]),
    `  - name: "⚡ CF入口"`,
    `    type: url-test`,
    `    url: "http://www.gstatic.com/generate_204"`,
    `    interval: 300`,
    `    tolerance: 150`,
    `    proxies:`,
    lst(frontNames.length ? frontNames : ["DIRECT"]),
  ];

  for (const grp of ["🧠 Claude", "🤖 ChatGPT", "🔵 Google·Gemini"]) {
    groups.push(
      `  - name: ${q(grp)}`,
      `    type: select`,
      `    proxies:`,
      lst(["🏠 住宅自动", "🚀 节点选择", "⚡ 自动选择", ...pureNames]),
    );
  }
  groups.push(
    `  - name: "🌐 其他流量"`,
    `    type: select`,
    `    proxies:`,
    lst(["🚀 节点选择", "⚡ 自动选择", "🏠 住宅自动", "⚡ CF入口", "DIRECT"]),
    `  - name: "🇨🇳 中国流量"`,
    `    type: select`,
    `    proxies:`,
    lst(["DIRECT", "🚀 节点选择"]),
  );

  const rules = [
    ...CHATGPT_RULES.map((r) => `  - ${r},🤖 ChatGPT`),
    ...CLAUDE_RULES.map((r) => `  - ${r},🧠 Claude`),
    ...GEMINI_RULES.map((r) => `  - ${r},🔵 Google·Gemini`),
    ...LOCAL_DIRECT_RULES.map((r) => `  - ${r}`),
    `  - GEOSITE,CN,🇨🇳 中国流量`,
    `  - GEOIP,CN,🇨🇳 中国流量,no-resolve`,
    `  - MATCH,🌐 其他流量`,
  ];

  return [
    `# sand-baker subscription — generated ${now} (kui-aligned)`,
    `# ${exitNames.length} exit + ${frontNames.length} CF front`,
    `mixed-port: 7890`,
    `allow-lan: false`,
    `mode: rule`,
    `log-level: warning`,
    `external-controller: 127.0.0.1:9090`,
    `dns:`,
    `  enable: true`,
    `  ipv6: false`,
    `  enhanced-mode: fake-ip`,
    `  nameserver:`,
    `    - 1.1.1.1`,
    `    - 8.8.8.8`,
    `proxies:`,
    ...nodes.map((n) => proxyLine(uuid, host, n)),
    `proxy-groups:`,
    ...groups,
    `rules:`,
    ...rules,
    `# subscription ${subPath}`,
    ``,
  ].join("\n");
}

export function buildV2rayLinks(host: string, uuid: string, exits: LiveExit[] = []): string {
  const lines = catalog(host, exits)
    .map((n) => vlessLinkFor(host, uuid, n))
    .join("\n");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(lines + "\n", "utf8").toString("base64") + "\n";
  }
  return btoa(lines + "\n") + "\n";
}

export function buildSingbox(host: string, uuid: string, exits: LiveExit[] = []): string {
  const nodes = catalog(host, exits);
  const tags = nodes.map((n) => n.name);
  const outbounds = nodes.map((n) => ({
    type: "vless",
    tag: n.name,
    server: n.server,
    server_port: 443,
    uuid,
    tls: {
      enabled: true,
      servername: host,
      utls: { enabled: true, fingerprint: "chrome" },
    },
    transport: { type: "ws", path: n.path, headers: { Host: host } },
  }));
  const cfg = {
    log: { level: "warn", timestamp: true },
    inbounds: [
      {
        type: "mixed",
        tag: "socks-in",
        listen: "127.0.0.1",
        listen_port: 1080,
        users: [{ username: "gcs", password: uuid }],
      },
    ],
    outbounds: [
      { type: "selector", tag: "proxy", outbounds: ["auto", ...tags], default: "auto" },
      {
        type: "urltest",
        tag: "auto",
        outbounds: tags,
        url: "http://www.gstatic.com/generate_204",
        interval: "5m",
        tolerance: 150,
      },
      ...outbounds,
      { type: "direct", tag: "direct" },
    ],
  };
  return JSON.stringify(cfg, null, 2) + "\n";
}

export function counts(host = "relay.local", exits: LiveExit[] = []) {
  const nodes = catalog(host, exits);
  return {
    total: nodes.length,
    front: nodes.filter((n) => n.group === "front").length,
    exit: nodes.filter((n) => n.group === "exit").length,
  };
}
