export type SubNode = {
  name: string;
  server: string;
  path: string;
  group: "front" | "exit";
  country?: string;
  egressIp?: string;
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

export function readySocksSlots(exits: LiveExit[]): LiveExit[] {
  return exits.filter((s) => s.state === "ready" && socksPort(s) > 0);
}

export function buildSocksTxt(exits: LiveExit[]): string {
  return readySocksSlots(exits)
    .map((s) => {
      const port = socksPort(s);
      const kind = s.kind === "openvpn" ? "OpenVPN" : "Tor";
      const ip = s.egress_ip || "unknown";
      return `socks5://127.0.0.1:${port}#${kind}-${s.country}-${ip}`;
    })
    .join("\n") + (readySocksSlots(exits).length ? "\n" : "");
}

export function buildSocksClashYaml(exits: LiveExit[]): string {
  const ready = readySocksSlots(exits);
  const proxies = ready.map((s) => {
    const port = socksPort(s);
    const kind = s.kind === "openvpn" ? "OpenVPN" : "Tor";
    const name = `${kind}·${s.country} ${s.egress_ip || s.id}`;
    return [
      `  - name: ${JSON.stringify(name)}`,
      `    type: socks5`,
      `    server: 127.0.0.1`,
      `    port: ${port}`,
      `    udp: true`,
    ].join("\n");
  });
  const names = ready.map((s) => {
    const kind = s.kind === "openvpn" ? "OpenVPN" : "Tor";
    return JSON.stringify(`${kind}·${s.country} ${s.egress_ip || s.id}`);
  });
  const tor = ready.filter((s) => s.kind !== "openvpn");
  const ovpn = ready.filter((s) => s.kind === "openvpn");
  const groups = [
    `  - name: SOCKS出口`,
    `    type: select`,
    `    proxies: [${names.join(", ") || '"DIRECT"'}]`,
  ];
  if (tor.length) {
    groups.push(
      `  - name: SOCKS·Tor`,
      `    type: select`,
      `    proxies: [${tor
        .map((s) => JSON.stringify(`Tor·${s.country} ${s.egress_ip || s.id}`))
        .join(", ")}]`,
    );
  }
  if (ovpn.length) {
    groups.push(
      `  - name: SOCKS·OpenVPN`,
      `    type: select`,
      `    proxies: [${ovpn
        .map((s) => JSON.stringify(`OpenVPN·${s.country} ${s.egress_ip || s.id}`))
        .join(", ")}]`,
    );
  }
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
    `  - MATCH,SOCKS出口`,
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

const CLAUDE = ["claude.ai", "claudeusercontent.com", "anthropic.com", "claude.com"];
const CHATGPT = ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "ai.com"];
const GEMINI = ["google.com", "googleapis.com", "googleusercontent.com", "gstatic.com", "gemini.google.com", "aistudio.google.com", "deepmind.com"];

function frontNodes(host: string): SubNode[] {
  return [
    { name: "CF·本机", server: host, path: "/vless", group: "front" },
    ...CF_FRONTS.map((e) => ({
      name: e.name,
      server: e.server,
      path: "/vless",
      group: "front" as const,
    })),
  ];
}

function exitNodes(host: string, exits: LiveExit[]): SubNode[] {
  return exits
    .filter((s) => s.state === "ready" && s.egress_ip)
    .map((s) => ({
      name: `${s.kind === "openvpn" ? "OpenVPN" : "Tor"}·${s.country} ${s.egress_ip}`,
      server: host,
      path: `/res-${s.id}`,
      group: "exit" as const,
      country: s.country,
      egressIp: s.egress_ip,
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
    `  - name: ${JSON.stringify(node.name)}`,
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

function names(nodes: SubNode[]): string {
  return nodes.map((n) => JSON.stringify(n.name)).join(", ");
}

export function buildClashYaml(host: string, uuid: string, subPath: string, exits: LiveExit[] = []): string {
  const nodes = catalog(host, exits);
  const fronts = nodes.filter((n) => n.group === "front");
  const outs = nodes.filter((n) => n.group === "exit");
  const ovpn = outs.filter((n) => n.name.startsWith("OpenVPN"));
  const tor = outs.filter((n) => n.name.startsWith("Tor"));
  const extraGroups: string[] = [];
  if (tor.length) extraGroups.push("🧅 Tor");
  if (ovpn.length) extraGroups.push("🔑 OpenVPN");
  const selectProxies = ["⚡ CF入口", ...extraGroups, "DIRECT", ...nodes.map((n) => JSON.stringify(n.name))];
  const groups = [
    `  - name: 🚀 节点选择`,
    `    type: select`,
    `    proxies: [${selectProxies.join(", ")}]`,
    `  - name: ⚡ CF入口`,
    `    type: url-test`,
    `    url: http://www.gstatic.com/generate_204`,
    `    interval: 300`,
    `    tolerance: 150`,
    `    proxies: [${names(fronts)}]`,
  ];
  if (outs.length) {
    groups.push(
      `  - name: 🌍 真实出口`,
      `    type: select`,
      `    proxies: [${[...extraGroups, ...outs.map((n) => JSON.stringify(n.name))].join(", ")}]`,
    );
  }
  if (tor.length) {
    groups.push(`  - name: 🧅 Tor`, `    type: select`, `    proxies: [${names(tor)}]`);
  }
  if (ovpn.length) {
    groups.push(`  - name: 🔑 OpenVPN`, `    type: select`, `    proxies: [${names(ovpn)}]`);
  }
  const appProxies = ["🚀 节点选择", ...extraGroups, "⚡ CF入口", "DIRECT"].join(", ");
  groups.push(
    `  - name: 🧠 Claude`,
    `    type: select`,
    `    proxies: [${appProxies}]`,
    `  - name: 🤖 ChatGPT`,
    `    type: select`,
    `    proxies: [${appProxies}]`,
    `  - name: 🔵 Google·Gemini`,
    `    type: select`,
    `    proxies: [🚀 节点选择, ⚡ CF入口, DIRECT]`,
    `  - name: 🇨🇳 中国流量`,
    `    type: select`,
    `    proxies: [DIRECT, 🚀 节点选择]`,
  );
  const rules = [
    ...CLAUDE.map((d) => `  - DOMAIN-SUFFIX,${d},🧠 Claude`),
    ...CHATGPT.map((d) => `  - DOMAIN-SUFFIX,${d},🤖 ChatGPT`),
    ...GEMINI.map((d) => `  - DOMAIN-SUFFIX,${d},🔵 Google·Gemini`),
    `  - GEOSITE,cn,🇨🇳 中国流量`,
    `  - GEOIP,CN,🇨🇳 中国流量`,
    `  - GEOIP,PRIVATE,DIRECT`,
    `  - MATCH,🚀 节点选择`,
  ];
  return [
    `mixed-port: 7890`,
    `allow-lan: false`,
    `mode: rule`,
    `log-level: info`,
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
