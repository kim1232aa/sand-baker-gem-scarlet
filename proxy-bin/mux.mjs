import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.dirname(fileURLToPath(import.meta.url));
const SOCK_DIR = path.join(BIN, "socks");
const ADMIN = { host: "127.0.0.1", port: 8080 };
const XRAY_PORT = 38080;

function pathname(url = "/") {
  return url.split("?")[0];
}

function isVlessPath(path) {
  return path === "/vless" || path.startsWith("/res-");
}

function destFor(path) {
  const m = /^\/res-([a-z0-9-]+)$/.exec(path);
  if (!m) return { port: XRAY_PORT };
  const sock = `${SOCK_DIR}/in-${m[1]}.sock`;
  if (fs.existsSync(sock)) return { sock };
  return { port: XRAY_PORT };
}

function proxyHttp(req, res) {
  const p = http.request(
    {
      hostname: ADMIN.host,
      port: ADMIN.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  p.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("bad gateway");
  });
  req.pipe(p);
}

function connectUp(dest, onConnect) {
  if (dest.sock) return net.connect(dest.sock, onConnect);
  return net.connect(dest.port, "127.0.0.1", onConnect);
}

function proxyUpgrade(req, socket, head) {
  const dest = destFor(pathname(req.url));
  const up = connectUp(dest, () => {
    const q = (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?")) : "";
    const hdrs = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    up.write(`${req.method} /vless${q} HTTP/1.1\r\n${hdrs}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}

const server = http.createServer((req, res) => {
  const path = pathname(req.url);
  if (isVlessPath(path)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  proxyHttp(req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (isVlessPath(pathname(req.url))) {
    proxyUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

server.listen(38079, "127.0.0.1", () => {
  console.log("mux 127.0.0.1:38079 → xray + admin");
});
