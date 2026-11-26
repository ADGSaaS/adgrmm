// backend/src/demo-mode/demo-gate.middleware.ts
//
// Express middleware that applies the demo rules (see demo-mode.rules.ts) and a per-address limit on requests.
// main.ts installs it only when DEMO_MODE=1.
import type { NextFunction, Request, Response } from "express";
import { DEMO_REFUSAL, judge } from "./demo-mode.rules";
import type { DemoModeService } from "./demo-mode.service";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 900;   // per address per minute, reads and writes together
const MAX_WRITES = 150;     // per address per minute

type Counter = { start: number; all: number; writes: number };

export function createDemoGate(demo: DemoModeService) {
    const seen = new Map<string, Counter>();
    const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of seen) if (now - v.start > WINDOW_MS * 2) seen.delete(k); }, WINDOW_MS);
    sweep.unref?.();

    return function demoGate(req: Request, res: Response, next: NextFunction) {
        const verdict = judge(String(req.method || "GET"), String(req.originalUrl || req.url || ""));
        if (verdict === "pass") {
            if (!String(req.originalUrl || "").startsWith("/api/")) return next();
        }
        if (verdict === "refuse") return void res.status(403).json(DEMO_REFUSAL);

        // Not one address may hog the demo.
        const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
        const now = Date.now();
        let c = seen.get(ip);
        if (!c || now - c.start > WINDOW_MS) { c = { start: now, all: 0, writes: 0 }; seen.set(ip, c); }
        c.all++;
        if (verdict === "write-ok") c.writes++;
        if (c.all > MAX_REQUESTS || c.writes > MAX_WRITES) {
            return void res.status(429).json({ statusCode: 429, message: "Slow down a little: the demo limits how fast one address can go.", demo: true });
        }
        if (verdict === "write-ok") demo.markDirty();
        next();
    };
}
