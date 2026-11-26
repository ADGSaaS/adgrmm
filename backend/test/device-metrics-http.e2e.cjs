#!/usr/bin/env node
// Hardware and performance history (roadmap 1.15) through the real HTTP API: the CPU, memory and disk series built from
// check results, the range buckets, the reasons there may be nothing to draw, the daily availability / disk-free history
// (up to 800 days), and the customer limit. Network traffic and disk activity (agents 1.3.36+) ride along: through the real
// agent ingest route, their series, bucketing, the reasons when empty, that they never alert or show as checks, and that
// an old agent (or a broken counter) never harms the rest of the response.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../adg_g1_e2e JWT_SECRET=... node test/device-metrics-http.e2e.cjs
"use strict";
const crypto = require("node:crypto");
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `DM${Date.now()}`;
    const devs = [];

    const reader = await staffUser("dm-reader", ["devices.read"]);
    const nobody = await staffUser("dm-nobody", ["customers.read"]);
    const limited = await staffUser("dm-limited", ["devices.read"]);
    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A");
    const B = await mkClient("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const mk = async (site, host, withAgent = true, minutes = 0) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,'Windows 11') RETURNING id`, [site, `${tag}-${host}`])).rows[0].id;
        devs.push(id);
        if (withAgent) await q(`INSERT INTO agents (device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,'1.3.28', now() - ($3 || ' minutes')::interval, '{"os":"windows"}')`, [id, uuid(), String(minutes)]);
        return id;
    };
    const dev = await mk(A.site, "main");
    const silent = await mk(A.site, "silent");
    const noAgent = await mk(A.site, "noagent", false);
    const stale = await mk(A.site, "stale");
    const other = await mk(B.site, "other");

    const assign = async (device, key, type, name) =>
        (await q(`INSERT INTO check_assignments (target_type, target_id, dedupe_key, check_type, check_name) VALUES ('device',$1,$2,$3,$4) RETURNING id`, [device, key, type, name])).rows[0].id;
    // One result every 5 minutes for 26 hours, with values that follow the hour so buckets are predictable.
    const run = (assignment, minutesAgo, metrics) =>
        q(`INSERT INTO check_runs (assignment_id, status, started_at, finished_at, metrics, device_id) VALUES ($1,'OK', now() - ($2 || ' minutes')::interval, now() - ($2 || ' minutes')::interval, $3, $4)`, [assignment, String(minutesAgo), JSON.stringify(metrics), "x"]);
    const cpu = await assign(dev, "builtin:cpu", "CPU", "CPU usage");
    const mem = await assign(dev, "builtin:memory", "MEMORY", "Memory usage");
    const dc = await assign(dev, "builtin:disk:c:", "DISK", "Disk free C:");
    const dd = await assign(dev, "builtin:disk:/data", "DISK", "Disk free /data");
    for (let m = 5; m <= 26 * 60; m += 5) {
        await run(cpu, m, { busyPercent: m < 60 ? 80 : 20, thresholds: { warn: 90, crit: 98 } });
        await run(mem, m, { usedPercent: 50, availableGb: 8, totalGb: 16 });
        await run(dc, m, { freePercent: 40, freeGb: 200, totalGb: 500 });
    }
    await run(dd, 10, { freePercent: 70, freeGb: 700, totalGb: 1000 });
    // a text value and a missing value must be ignored, not break the query
    await run(cpu, 7, { busyPercent: "n/a" });
    await run(cpu, 8, {});
    // a device with results older than the range
    const old = await assign(stale, "builtin:cpu", "CPU", "CPU usage");
    await run(old, 3 * 24 * 60, { busyPercent: 10 });
    // another customer's device must not leak into this one
    const oc = await assign(other, "builtin:cpu", "CPU", "CPU usage");
    await run(oc, 5, { busyPercent: 99 });

    const metrics = async (id, range, t = reader) => (await call(`/api/devices/${id}/metrics?range=${range}`, { token: t.token }));

    console.log("CPU, memory, disk");
    await test("1 hour and 12 hours: 5 minute buckets over the newest readings only, and an unknown range is 24 hours", async () => {
        const h1 = await (await metrics(dev, "1h")).json();
        const h12 = await (await metrics(dev, "12h")).json();
        const d1 = await (await metrics(dev, "24h")).json();
        const odd = await (await metrics(dev, "3h")).json();
        assert.equal(h1.range, "1h");
        assert.equal(h12.range, "12h");
        assert.equal(h1.bucketMinutes, 5);
        assert.equal(h12.bucketMinutes, 5);
        assert.ok(h1.cpu.points.length <= 13, `1h points ${h1.cpu.points.length}`);
        assert.ok(h12.cpu.points.length <= 145, `12h points ${h12.cpu.points.length}`);
        assert.ok(h1.cpu.points.length <= h12.cpu.points.length && h12.cpu.points.length <= d1.cpu.points.length);
        assert.equal(Date.parse(h1.to) - Date.parse(h1.from), 3_600_000);
        assert.equal(Date.parse(h12.to) - Date.parse(h12.from), 12 * 3_600_000);
        assert.equal(odd.range, "24h");
    });
    await test("24 hours: 5 minute buckets, CPU average and peak, memory with its total, one disk series per mount", async () => {
        const r = await (await metrics(dev, "24h")).json();
        assert.equal(r.range, "24h");
        assert.equal(r.bucketMinutes, 5);
        assert.equal(r.monitoring.state, "ok");
        assert.ok(r.cpu.points.length >= 250 && r.cpu.points.length <= 290, `points ${r.cpu.points.length}`);
        assert.equal(r.cpu.points[r.cpu.points.length - 1].avg, 80, "the newest hour was busy");
        assert.equal(r.cpu.stats.peak, 80);
        assert.equal(r.cpu.stats.low, 20);
        assert.equal(r.memory.totalGb, 16);
        assert.equal(r.memory.stats.latest, 50);
        assert.deepEqual(r.disks.map((d) => d.mount), ["/data", "c:"]);
        const c = r.disks.find((d) => d.mount === "c:");
        assert.equal(c.totalGb, 500);
        assert.equal(c.stats.latest, 40);
        assert.ok(new Date(r.from) < new Date(r.to));
        assert.equal(r.retentionDays, 14);
        assert.ok(r.cpu.points.every((p, i, a) => i === 0 || p.t > a[i - 1].t), "in time order");
    });

    await test("7 days uses 30 minute buckets and 30 days 2 hour buckets, and says how far back results go", async () => {
        const w = await (await metrics(dev, "7d")).json();
        assert.equal(w.bucketMinutes, 30);
        assert.ok(w.cpu.points.length > 40 && w.cpu.points.length < 70, `${w.cpu.points.length}`);
        const m = await (await metrics(dev, "30d")).json();
        assert.equal(m.bucketMinutes, 120);
        assert.ok(m.cpu.points.length >= 12 && m.cpu.points.length <= 16);
        assert.ok(m.coveredFrom && new Date(m.coveredFrom) > new Date(m.from), "the 30 day graph starts where the results do");
        assert.equal((await (await metrics(dev, "bogus")).json()).range, "24h");
    });

    console.log("nothing to draw");
    await test("each reason is explained: no agent, never reported, stopped", async () => {
        const na = await (await metrics(noAgent, "24h")).json();
        assert.equal(na.monitoring.state, "no-agent");
        assert.match(na.monitoring.problem, /no agent/i);
        assert.equal(na.cpu.points.length, 0);
        const nr = await (await metrics(silent, "24h")).json();
        assert.equal(nr.monitoring.state, "never-reported");
        assert.match(nr.monitoring.problem, /not reported/i);
        const st = await (await metrics(stale, "24h")).json();
        assert.equal(st.monitoring.state, "stopped");
        assert.ok(st.monitoring.lastResultAt);
        assert.equal((await (await metrics(stale, "7d")).json()).monitoring.state, "ok", "the same result is inside 7 days");
    });

    await test("rights and the customer limit", async () => {
        assert.equal((await metrics(dev, "24h", nobody)).status, 403);
        assert.ok([401, 403].includes((await call(`/api/devices/${dev}/metrics`)).status));
        assert.equal((await metrics(other, "24h", limited)).status, 404);
        assert.equal((await metrics(dev, "24h", limited)).status, 200);
        assert.equal((await metrics(uuid(), "24h")).status, 404);
        assert.equal((await metrics("nope", "24h")).status, 404);
        assert.equal((await call(`/api/devices/${other}/daily-history`, { token: limited.token })).status, 404);
        // the other customer's reading never shows in this device's series
        const r = await (await metrics(dev, "24h")).json();
        assert.ok(r.cpu.stats.peak < 99);
    });

    console.log("network traffic and disk activity");
    const token = `io-token-${uuid()}`;
    const mkNew = async (site, host, version = "1.3.36", agentToken = null) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,'Windows 11') RETURNING id`, [site, `${tag}-${host}`])).rows[0].id;
        devs.push(id);
        await q(`INSERT INTO agents (device_id, agent_uuid, version, last_check_in_at, facts, agent_token) VALUES ($1,$2,$3, now(), '{"os":"windows"}', $4)`, [id, uuid(), version, agentToken && crypto.createHash("sha256").update(agentToken).digest("hex")]);
        return id;
    };
    const ioDev = await mkNew(A.site, "io", "1.3.36", token);
    const waiting = await mkNew(A.site, "waiting");
    const broken = await mkNew(A.site, "broken");
    const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
    const post = (body) => call("/api/agent/ingest/check-runs", { method: "POST", body, headers: { authorization: `Bearer ${token}` } });
    const net = (m, rx, tx, extra = {}) => ({ dedupeKey: "builtin:network", checkType: "NETWORK", checkName: "Network traffic", status: "OK", startedAt: ago(m), finishedAt: ago(m), output: "x", metrics: { rxBytesPerSec: rx, txBytesPerSec: tx, intervalSec: 300, adapters: 1, linkMbps: 1000, ...extra } });
    const dio = (m, r, w) => ({ dedupeKey: "builtin:diskio", checkType: "DISKIO", checkName: "Disk activity", status: "OK", startedAt: ago(m), finishedAt: ago(m), output: "x", metrics: { readBytesPerSec: r, writeBytesPerSec: w, intervalSec: 300 } });

    await test("an agent posts the two new check types through the real ingest route and they are accepted", async () => {
        const runs = [];
        for (let m = 5; m <= 120; m += 5) { runs.push(net(m, m < 60 ? 2_000_000 : 1_000_000, m < 60 ? 500_000 : 100_000)); runs.push(dio(m, m < 60 ? 8_000_000 : 4_000_000, m < 60 ? 3_000_000 : 1_000_000)); }
        for (let i = 0; i < runs.length; i += 100) assert.equal((await post({ deviceId: ioDev, runs: runs.slice(i, i + 100) })).status, 201);
    });

    await test("they are informational: stored as OK whatever the agent says, extra metric keys dropped, never an alert", async () => {
        // a hostile or buggy agent claims a failure, a severity and a pile of extra data
        const bad = net(1, 3_000_000, 600_000, { thresholds: { warn: 1, crit: 2 }, blob: "x".repeat(5000), nested: { a: 1 } });
        bad.status = "CRIT"; bad.severity = "CRIT"; bad.output = "Everything is on fire";
        const neg = net(2, -5, 10); neg.status = "TIMEOUT";
        assert.equal((await post({ deviceId: ioDev, runs: [bad, neg] })).status, 201);
        const st = await q(`SELECT cr.status, cr.severity, cr.metrics FROM check_runs cr JOIN check_assignments ca ON ca.id = cr.assignment_id WHERE ca.target_id = $1 AND ca.check_type IN ('NETWORK','DISKIO')`, [ioDev]);
        assert.ok(st.rows.length >= 48);
        assert.ok(st.rows.every((r) => r.status === "OK" && r.severity === null), "every row OK, no severity");
        assert.ok(st.rows.every((r) => !("thresholds" in (r.metrics ?? {})) && !("blob" in (r.metrics ?? {})) && !("nested" in (r.metrics ?? {}))), "only known keys kept");
        assert.equal((await q(`SELECT count(*)::int AS n FROM alerts WHERE device_id = $1`, [ioDev])).rows[0].n, 0, "no alert");
        assert.equal((await q(`SELECT count(*)::int AS n FROM alert_pending ap JOIN check_assignments ca ON ca.dedupe_key = 'check:' || ca.id::text WHERE ca.target_id = $1`, [ioDev]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n, 0);
    });

    await test("they are not listed as checks of the device, but a normal check beside them is", async () => {
        assert.equal((await post({ deviceId: ioDev, runs: [{ dedupeKey: "builtin:cpu", checkType: "CPU", checkName: "CPU usage", status: "OK", metrics: { busyPercent: 5 } }] })).status, 201);
        const checksUser = await staffUser("dm-checks", ["devices.read", "checks.read"]);
        const r = await json(`/api/devices/${ioDev}/checks`, { token: checksUser.token });
        const names = (r.items ?? r).map((c) => c.name);
        assert.ok(names.includes("CPU usage"), JSON.stringify(names));
        assert.ok(!names.some((n) => /network|disk activity/i.test(n)), JSON.stringify(names));
    });

    await test("the series: bytes per second, two lines, 5 minute buckets, stats, link speed", async () => {
        const r = await (await metrics(ioDev, "24h")).json();
        assert.equal(r.network.state, "ok");
        assert.equal(r.network.reason, null);
        assert.equal(r.network.unit, "bytes/s");
        assert.equal(r.network.linkMbps, 1000);
        assert.ok(r.network.points.length >= 24, `${r.network.points.length}`);
        assert.ok(r.network.points.every((p, i, a) => (i === 0 || p.t > a[i - 1].t) && typeof p.rx === "number" && typeof p.tx === "number" && p.rxMax >= p.rx && p.txMax >= p.tx), "ordered, two values, max");
        const old = r.network.points.find((p) => Math.abs(Date.now() - new Date(p.t).getTime() - 100 * 60_000) < 6 * 60_000);
        assert.equal(old.rx, 1_000_000);
        assert.equal(old.tx, 100_000);
        assert.equal(r.network.stats.rx.peak, 3_000_000, "the 3 MB/s reading is the peak; the negative one was ignored");
        assert.ok(r.network.stats.tx.peak === 600_000);
        assert.ok(r.network.stats.rx.average > 1_000_000 && r.network.stats.rx.average < 2_000_000);
        assert.equal(r.network.stats.rx.latest, 3_000_000);
        assert.equal(r.diskIo.state, "ok");
        assert.equal(r.diskIo.points[0].read, 4_000_000);
        assert.equal(r.diskIo.points[0].write, 1_000_000);
        assert.equal(r.diskIo.stats.read.peak, 8_000_000);
        assert.equal(r.diskIo.stats.write.peak, 3_000_000);
        assert.ok(!("linkMbps" in r.diskIo));
        // CPU of this device is unaffected by the IO results
        assert.equal(r.cpu.points.length, 1);
    });

    await test("7 days and 30 days use their own buckets for the new series too", async () => {
        const w = await (await metrics(ioDev, "7d")).json();
        assert.equal(w.bucketMinutes, 30);
        assert.ok(w.network.points.length >= 3 && w.network.points.length <= 6, `${w.network.points.length}`);
        assert.ok(w.network.points.every((p) => p.rx >= 1_000_000 && p.rx <= 3_000_000 && p.rxMax >= p.rx), "bucket averages stay between the samples");
        assert.ok(w.network.points.some((p) => p.rxMax > p.rx), "a 30 minute bucket averages several samples and keeps their peak");
        const m = await (await metrics(ioDev, "30d")).json();
        assert.equal(m.bucketMinutes, 120);
        assert.ok(m.network.points.length >= 1 && m.network.points.length <= 3);
        assert.ok(m.diskIo.points.length >= 1);
    });

    await test("an old agent: empty series with the reason, and the rest of the response is exactly as before", async () => {
        const r = await (await metrics(dev, "24h")).json();
        assert.equal(r.monitoring.state, "ok");
        assert.equal(r.monitoring.problem, null, "no problem banner");
        assert.equal(r.network.state, "needs-agent");
        assert.match(r.network.reason, /needs agent 1\.3\.36 or newer/);
        assert.deepEqual(r.network.points, []);
        assert.equal(r.network.stats, null);
        assert.equal(r.diskIo.state, "needs-agent");
        assert.match(r.diskIo.reason, /needs agent 1\.3\.36 or newer/);
        assert.ok(r.cpu.points.length > 250 && r.memory.points.length > 250 && r.disks.length === 2);
        // an old agent that has never reported at all still gets the old banner and the new empty series, no error
        const nr = await (await metrics(silent, "24h")).json();
        assert.equal(nr.monitoring.state, "never-reported");
        assert.equal(nr.network.state, "needs-agent");
        const na = await (await metrics(noAgent, "24h")).json();
        assert.equal(na.network.state, "no-agent");
        assert.equal(na.diskIo.points.length, 0);
    });

    await test("a new agent that has not made its first measurement yet is told to wait, not to update", async () => {
        const r = await (await metrics(waiting, "24h")).json();
        assert.equal(r.network.state, "waiting");
        assert.match(r.network.reason, /first measurement/i);
        assert.doesNotMatch(r.network.reason, /needs agent/);
        assert.equal(r.monitoring.state, "never-reported", "the existing banner logic only looks at CPU, memory and disk");
    });

    await test("a counter that cannot be read gives a reason, still never an alert, and the other series are fine", async () => {
        const tok2 = `io-token-${uuid()}`;
        await q(`UPDATE agents SET agent_token = $2 WHERE device_id = $1`, [broken, crypto.createHash("sha256").update(tok2).digest("hex")]);
        const res = await call("/api/agent/ingest/check-runs", { method: "POST", headers: { authorization: `Bearer ${tok2}` }, body: { deviceId: broken, runs: [
            { dedupeKey: "builtin:diskio", checkType: "DISKIO", checkName: "Disk activity", status: "UNKNOWN", output: "x", metrics: { reason: "The PhysicalDisk performance counters are not available: category does not exist" } },
            net(1, 100, 50),
        ] } });
        assert.equal(res.status, 201);
        const r = await (await metrics(broken, "24h")).json();
        assert.equal(r.diskIo.state, "unavailable");
        assert.match(r.diskIo.reason, /PhysicalDisk performance counters/);
        assert.equal(r.diskIo.points.length, 0);
        assert.equal(r.network.state, "ok");
        assert.equal((await q(`SELECT count(*)::int AS n FROM alerts WHERE device_id = $1`, [broken])).rows[0].n, 0);
    });

    await test("results that stopped arriving say so", async () => {
        const old2 = await mkNew(A.site, "stopped");
        const a = await assign(old2, "builtin:network", "NETWORK", "Network traffic");
        await run(a, 3 * 24 * 60, { rxBytesPerSec: 10, txBytesPerSec: 20 });
        const day = await (await metrics(old2, "24h")).json();
        assert.equal(day.network.state, "stopped");
        assert.match(day.network.reason, /last result is from/);
        assert.equal((await (await metrics(old2, "7d")).json()).network.state, "ok");
    });

    await test("another customer's traffic never shows, and the customer limit still applies", async () => {
        const oa = await assign(other, "builtin:network", "NETWORK", "Network traffic");
        await run(oa, 5, { rxBytesPerSec: 999_999_999, txBytesPerSec: 999_999_999 });
        const r = await (await metrics(ioDev, "24h", limited)).json();
        assert.ok(r.network.stats.rx.peak < 999_999_999);
        assert.equal((await metrics(other, "24h", limited)).status, 404);
        assert.equal((await metrics(ioDev, "24h", nobody)).status, 403);
    });

    await test("a text or missing value in the new results is ignored, not fatal", async () => {
        const t = await mkNew(A.site, "junk");
        const a = await assign(t, "builtin:network", "NETWORK", "Network traffic");
        await run(a, 5, { rxBytesPerSec: "n/a", txBytesPerSec: 5 });
        await run(a, 6, { rxBytesPerSec: 5 });
        await run(a, 7, { rxBytesPerSec: 7, txBytesPerSec: 9 });
        const r = await (await metrics(t, "24h")).json();
        assert.equal(r.network.points.length, 1);
        assert.equal(r.network.points[0].rx, 7);
        assert.equal(r.network.points[0].tx, 9);
    });

    console.log("daily history");
    await test("availability and disk free per day, up to 800 days", async () => {
        await q(`INSERT INTO device_daily (device_id, day, samples, online_samples, disk_free_pct_min, disk_total_bytes, disk_free_bytes, business_samples, business_online_samples)
                 SELECT $1, (now() AT TIME ZONE 'utc')::date - g, 96, CASE WHEN g % 10 = 0 THEN 48 ELSE 96 END, 30 + (g % 5), 500 * 1073741824::bigint, 200 * 1073741824::bigint, 40, CASE WHEN g % 10 = 0 THEN 20 ELSE 40 END
                   FROM generate_series(0, 799) g`, [dev]);
        const d = await (await call(`/api/devices/${dev}/daily-history?days=800`, { token: reader.token })).json();
        assert.equal(d.days, 800);
        assert.equal(d.keptDays, 800);
        assert.equal(d.items.length, 800);
        assert.ok(d.items[0].day < d.items[d.items.length - 1].day, "oldest first");
        const today = d.items[d.items.length - 1];
        assert.equal(today.availability, 50, "today is a multiple of ten days ago");
        assert.equal(today.businessAvailability, 50);
        assert.equal(today.diskFreeGb, 200);
        assert.equal(today.diskTotalGb, 500);
        assert.equal(today.diskFreePctMin, 30);
        assert.equal(d.items[d.items.length - 2].availability, 100);
        const small = await (await call(`/api/devices/${dev}/daily-history?days=30`, { token: reader.token })).json();
        assert.equal(small.items.length, 30);
        assert.equal((await (await call(`/api/devices/${dev}/daily-history?days=5000`, { token: reader.token })).json()).days, 800);
        assert.equal((await (await call(`/api/devices/${dev}/daily-history`, { token: reader.token })).json()).days, 90);
        assert.equal((await (await call(`/api/devices/${silent}/daily-history`, { token: reader.token })).json()).items.length, 0);
    });

    await q(`DELETE FROM check_assignments WHERE target_id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM device_daily WHERE device_id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM agents WHERE device_id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM user_client_access WHERE user_id = ANY($1::uuid[])`, [made.users]);
    await cleanup();
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
