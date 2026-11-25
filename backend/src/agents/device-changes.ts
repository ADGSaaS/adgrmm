// backend/src/agents/device-changes.ts
//
// Works out what changed on a device between two reports from its agent, for the change log: software that was
// installed, removed or updated, and changes to the hardware or the operating system. Pure functions, so they can be
// tested without a database.

export type Change = { kind: "software_added" | "software_removed" | "software_updated" | "hardware" | "os"; summary: string; before?: unknown; after?: unknown };
export type SoftwareLine = { name: string; version: string | null };

/** The most changes recorded from a single report, so a device that reinstalls everything does not flood the log. */
export const MAX_CHANGES_PER_REPORT = 100;

const key = (s: SoftwareLine) => s.name.trim().toLowerCase();
const label = (s: SoftwareLine) => (s.version ? `${s.name} ${s.version}` : s.name);

export function diffSoftware(before: SoftwareLine[], after: SoftwareLine[]): Change[] {
    // Several entries can share a name (32-bit and 64-bit builds), so compare by name and version together.
    const prev = new Map<string, SoftwareLine[]>();
    for (const s of before) prev.set(key(s), [...(prev.get(key(s)) ?? []), s]);
    const next = new Map<string, SoftwareLine[]>();
    for (const s of after) next.set(key(s), [...(next.get(key(s)) ?? []), s]);

    const changes: Change[] = [];
    for (const [name, now] of next) {
        const was = prev.get(name);
        if (!was) {
            for (const s of now) changes.push({ kind: "software_added", summary: `Installed ${label(s)}`, after: s });
            continue;
        }
        const wasVersions = new Set(was.map((s) => s.version ?? ""));
        const nowVersions = new Set(now.map((s) => s.version ?? ""));
        const added = now.filter((s) => !wasVersions.has(s.version ?? ""));
        const removed = was.filter((s) => !nowVersions.has(s.version ?? ""));
        if (added.length && removed.length) {
            changes.push({ kind: "software_updated", summary: `Updated ${now[0].name} from ${removed[0].version ?? "an unknown version"} to ${added[0].version ?? "an unknown version"}`, before: removed[0], after: added[0] });
        } else {
            for (const s of added) changes.push({ kind: "software_added", summary: `Installed ${label(s)}`, after: s });
            for (const s of removed) changes.push({ kind: "software_removed", summary: `Removed ${label(s)}`, before: s });
        }
    }
    for (const [name, was] of prev) if (!next.has(name)) for (const s of was) changes.push({ kind: "software_removed", summary: `Removed ${label(s)}`, before: s });
    return changes;
}

const rec = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const GB = 1024 ** 3;
const gb = (bytes: number) => `${Math.round((bytes / GB) * 10) / 10} GB`;

/** Compares the device blobs the agent sends (hardware, disks, operating system). */
export function diffDevice(before: unknown, after: unknown): Change[] {
    const a = rec(before);
    const b = rec(after);
    if (!Object.keys(a).length || !Object.keys(b).length) return [];
    const changes: Change[] = [];

    const ha = rec(a.hardware);
    const hb = rec(b.hardware);
    const ramA = Number(ha.ramBytes);
    const ramB = Number(hb.ramBytes);
    if (ramA > 0 && ramB > 0 && Math.abs(ramA - ramB) > 0.25 * GB) changes.push({ kind: "hardware", summary: `Memory changed from ${gb(ramA)} to ${gb(ramB)}`, before: { ramBytes: ramA }, after: { ramBytes: ramB } });
    for (const [field, noun] of [["cpu", "Processor"], ["model", "Model"]] as const) {
        const x = typeof ha[field] === "string" ? ha[field].trim() : "";
        const y = typeof hb[field] === "string" ? hb[field].trim() : "";
        if (x && y && x !== y) changes.push({ kind: "hardware", summary: `${noun} changed from ${x} to ${y}`, before: { [field]: x }, after: { [field]: y } });
    }

    const disks = (v: unknown) => new Map((Array.isArray(v) ? v : []).map((d: any) => [String(d?.mount ?? d?.name ?? ""), Number(d?.totalBytes)] as const).filter(([m, t]) => m && Number.isFinite(t) && t > 0));
    const da = disks(a.disks);
    const db = disks(b.disks);
    if (da.size && db.size) {
        for (const [mount, total] of db) {
            const was = da.get(mount);
            if (was === undefined) changes.push({ kind: "hardware", summary: `Drive ${mount} added (${gb(total)})`, after: { mount, totalBytes: total } });
            else if (Math.abs(was - total) > 0.05 * was) changes.push({ kind: "hardware", summary: `Drive ${mount} size changed from ${gb(was)} to ${gb(total)}`, before: { mount, totalBytes: was }, after: { mount, totalBytes: total } });
        }
        for (const [mount, total] of da) if (!db.has(mount)) changes.push({ kind: "hardware", summary: `Drive ${mount} removed (${gb(total)})`, before: { mount, totalBytes: total } });
    }

    const oa = rec(a.os);
    const ob = rec(b.os);
    const nameA = typeof oa.name === "string" ? oa.name.trim() : "";
    const nameB = typeof ob.name === "string" ? ob.name.trim() : "";
    const verA = String(oa.displayVersion ?? oa.version ?? "").trim();
    const verB = String(ob.displayVersion ?? ob.version ?? "").trim();
    if (nameA && nameB && nameA !== nameB) changes.push({ kind: "os", summary: `Operating system changed from ${nameA} to ${nameB}`, before: { name: nameA }, after: { name: nameB } });
    else if (verA && verB && verA !== verB) changes.push({ kind: "os", summary: `${nameB || "Windows"} updated from ${verA} to ${verB}`, before: { version: verA }, after: { version: verB } });
    return changes;
}
