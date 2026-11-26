// backend/src/demo-mode/demo-gate.middleware.ts
//
// Express middleware that applies the demo rules (see demo-mode.rules.ts) and a per-address limit on requests.
// main.ts installs it only when DEMO_MODE=1.
import type { NextFunction, Request, Response } from "express";
import { DEMO_REFUSAL, decide } from "./demo-mode.rules";
import { runFixture, type FixtureReply } from "./demo-fixtures";
import type { DemoModeService } from "./demo-mode.service";

// Reads the (small) JSON body of a request that is answered from a sample. Nest has not parsed it yet at this point.
const jsonBody = require("express").json({ limit: "16kb" }) as (req: Request, res: Response, cb: (err?: unknown) => void) => void;

function sendFixture(res: Response, r: FixtureReply) {
    res.status(r.status ?? 200);
    for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
    if (typeof r.body === "string") res.type(r.contentType ?? "text/plain").send(r.body);
    else res.json(r.body);
}

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 900;   // per address per minute, reads and writes together
const MAX_WRITES = 150;     // per address per minute

type Counter = { start: number; all: number; writes: number };

export function createDemoGate(demo: DemoModeService) {
    const seen = new Map<string, Counter>();
    const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of seen) if (now - v.start > WINDOW_MS * 2) seen.delete(k); }, WINDOW_MS);
    sweep.unref?.();

    return function demoGate(req: Request, res: Response, next: NextFunction) {
        const url = String(req.originalUrl || req.url || "");
        const d = decide(String(req.method || "GET"), url);
        const verdict = d.kind;
        if (verdict === "pass") {
            if (!url.startsWith("/api/")) return next();
        }
        if (verdict === "refuse") return void res.status(403).json(DEMO_REFUSAL);

        // Not one address may hog the demo.
        const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
        const now = Date.now();
        let c = seen.get(ip);
        if (!c || now - c.start > WINDOW_MS) { c = { start: now, all: 0, writes: 0 }; seen.set(ip, c); }
        c.all++;
        if (verdict === "write-ok" || (d.kind === "fixture" && d.method !== "GET")) c.writes++;
        if (c.all > MAX_REQUESTS || c.writes > MAX_WRITES) {
            return void res.status(429).json({ statusCode: 429, message: "Slow down a little: the demo limits how fast one address can go.", demo: true });
        }
        if (d.kind === "fixture") {
            // A sample answer: no real controller, service, file or setting is touched.
            const send = (body: unknown) => sendFixture(res, runFixture(d.hit, d.method, d.path, body));
            if (!d.hit.route.needsBody) return send(undefined);
            return void jsonBody(req, res, (err) => (err ? void res.status(400).json({ statusCode: 400, message: "That request could not be read.", demo: true }) : send((req as any).body)));
        }
        if (verdict === "write-ok") demo.markDirty();
        next();
    };
}
