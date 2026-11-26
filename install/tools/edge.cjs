#!/usr/bin/env node
"use strict";
// The one door into a ADG RMM install: everything the browser asks for goes to the web app, and WebSocket
// connections (remote console, agents) go straight to the API. Put HTTPS (Caddy) or your own reverse proxy in
// front of this single port and nothing else needs routing rules.
//
//   EDGE_PORT      port to listen on (default 8080)
//   EDGE_HOST      address to listen on (default 127.0.0.1)
//   WEB_UPSTREAM   the web app (default http://127.0.0.1:3000)
//   API_UPSTREAM   the API (default http://127.0.0.1:3001)
//   EDGE_PROTO     https or http: what the outside world uses, when no proxy in front says (default http)

const http = require("node:http");
const net = require("node:net");

const PORT = Number(process.env.EDGE_PORT || 8080);
const HOST = process.env.EDGE_HOST || "127.0.0.1";
const WEB = new URL(process.env.WEB_UPSTREAM || "http://127.0.0.1:3000");
const API = new URL(process.env.API_UPSTREAM || "http://127.0.0.1:3001");
const PROTO = process.env.EDGE_PROTO === "https" ? "https" : "http";

/** The headers the upstream needs to know who is really asking and how. The original Host is kept, because the portal is chosen by it. */
function forwarded(req) {
    const headers = { ...req.headers };
    const ip = req.socket.remoteAddress || "";
    const chain = String(req.headers["x-forwarded-for"] || "").trim();
    headers["x-forwarded-for"] = chain ? `${chain}, ${ip}` : ip;
    headers["x-forwarded-proto"] = String(req.headers["x-forwarded-proto"] || PROTO).split(",")[0].trim();
    headers["x-forwarded-host"] = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    return headers;
}

function bad(res, status, text) {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
}

const server = http.createServer((req, res) => {
    const up = http.request(
        { host: WEB.hostname, port: WEB.port || 80, method: req.method, path: req.url, headers: forwarded(req) },
        (r) => {
            res.writeHead(r.statusCode || 502, r.headers);
            r.pipe(res);
        }
    );
    up.setTimeout(10 * 60_000, () => up.destroy(new Error("timeout")));
    up.on("error", () => bad(res, 502, "ADG RMM is starting or the web app is not answering. Try again in a moment."));
    req.on("aborted", () => up.destroy());
    req.pipe(up);
});

// WebSockets: to the API, with the upgrade request passed through untouched.
server.on("upgrade", (req, socket, head) => {
    const out = net.connect(Number(API.port || 80), API.hostname, () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        const h = forwarded(req);
        for (const [k, v] of Object.entries(h)) {
            for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
        }
        out.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head && head.length) out.write(head);
        socket.pipe(out);
        out.pipe(socket);
    });
    const close = () => {
        socket.destroy();
        out.destroy();
    };
    out.on("error", close);
    socket.on("error", close);
    socket.on("close", close);
    out.on("close", close);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(PORT, HOST, () => console.log(`edge listening on ${HOST}:${PORT} -> web ${WEB.origin}, websockets ${API.origin}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
