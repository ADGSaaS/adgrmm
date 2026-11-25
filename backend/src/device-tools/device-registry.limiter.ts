// backend/src/device-tools/device-registry.limiter.ts
//
// How often registry changes may be made: at most 30 a minute per person and 10 a minute per device (a sliding window kept in
// memory, like the sign-in limiter in auth-rate-limiter.service.ts: the backend is one process). Every attempt counts, also a
// refused one, so a script cannot probe the blocklist without limit. Undo counts like any other change.
import { HttpException, HttpStatus, Injectable } from "@nestjs/common";

export const WRITES_PER_USER_PER_MINUTE = 30;
export const WRITES_PER_DEVICE_PER_MINUTE = 10;
const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 20_000;

export type LimitVerdict = { ok: true } | { ok: false; scope: "user" | "device"; retryAfterSec: number; first: boolean };

/** Timestamps of the last window per key. */
export class SlidingWindow {
    private readonly hits = new Map<string, number[]>();
    private readonly blocked = new Map<string, number>();
    constructor(readonly max: number, readonly windowMs: number = WINDOW_MS, private readonly now: () => number = Date.now) { }

    private recent(key: string): number[] {
        const t = this.now();
        const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
        if (list.length) this.hits.set(key, list);
        else this.hits.delete(key);
        return list;
    }

    /** How many seconds until one more attempt is allowed, or 0 when it is allowed now. */
    wait(key: string): number {
        const list = this.recent(key);
        if (list.length < this.max) return 0;
        return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
    }

    add(key: string): void {
        if (this.hits.size >= MAX_TRACKED_KEYS) this.hits.clear();
        const list = this.recent(key);
        list.push(this.now());
        this.hits.set(key, list);
    }

    /** True the first time a key is refused in a window (so the audit trail gets one row for a burst, not thousands). */
    firstBlock(key: string): boolean {
        const t = this.now();
        if (this.blocked.size >= MAX_TRACKED_KEYS) this.blocked.clear();
        const last = this.blocked.get(key) ?? 0;
        if (t - last < this.windowMs) return false;
        this.blocked.set(key, t);
        return true;
    }
}

@Injectable()
export class RegistryWriteLimiter {
    private users = new SlidingWindow(WRITES_PER_USER_PER_MINUTE);
    private devices = new SlidingWindow(WRITES_PER_DEVICE_PER_MINUTE);

    /** A limiter with another clock or other limits (tests). */
    static custom(now: () => number, perUser = WRITES_PER_USER_PER_MINUTE, perDevice = WRITES_PER_DEVICE_PER_MINUTE): RegistryWriteLimiter {
        const l = new RegistryWriteLimiter();
        l.users = new SlidingWindow(perUser, WINDOW_MS, now);
        l.devices = new SlidingWindow(perDevice, WINDOW_MS, now);
        return l;
    }

    /** Counts one attempt, or says why it is not allowed (nothing is counted then). */
    check(userId: string, deviceId: string): LimitVerdict {
        const uw = this.users.wait(userId);
        const dw = this.devices.wait(deviceId);
        if (uw > 0 || dw > 0) {
            const scope = uw >= dw ? "user" : "device";
            return { ok: false, scope, retryAfterSec: Math.max(uw, dw), first: scope === "user" ? this.users.firstBlock(userId) : this.devices.firstBlock(deviceId) };
        }
        this.users.add(userId);
        this.devices.add(deviceId);
        return { ok: true };
    }

    /** Throws the 429 when the attempt is over the limit. `onFirst` is told once per burst (to write one audit row). */
    take(userId: string, deviceId: string, onFirst?: (v: Extract<LimitVerdict, { ok: false }>) => void): void {
        const v = this.check(userId, deviceId);
        if (v.ok) return;
        if (v.first) onFirst?.(v);
        const who = v.scope === "user" ? `You have made ${this.users.max} registry changes in the last minute, the most that is allowed.` : `${this.devices.max} registry changes were made on this device in the last minute, the most that is allowed.`;
        throw new HttpException({ statusCode: 429, code: "rate_limited", message: `${who} Wait ${v.retryAfterSec} second${v.retryAfterSec === 1 ? "" : "s"} and try again.`, retryAfterSec: v.retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
    }
}
