// backend/src/auto-repair/playbooks.service.ts
//
// Your own repairs: writing them, testing them on a computer, the Owner's approval, and handing the approved ones to the repair loop.
// A playbook runs automatically only when it is approved AND its scripts still hash to what was approved. Editing it, or changing the stored text
// behind the application's back, takes it out of the loop until it is tested and approved again.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { JobsService } from "../jobs/jobs.service";
import { PrismaService } from "../storage/prisma.service";
import { DIAGNOSE_SCRIPT, REPAIR_SCRIPT } from "./auto-repair.scripts";
import { parseDiagnosis, parseRepair } from "./auto-repair.core";
import {
    MAX_PLAYBOOKS_PER_RUN, applies, cleanPlaybook, composeDiagnose, composeRepair, contentHash, forgetPlaybookIssues, issueOfPlaybook, newPlaybookKey, registerPlaybookIssue, scriptWarnings,
    type PlaybookFields,
} from "./playbooks.core";

export const TEST_KIND = "auto-repair.playbook-test";

type Row = {
    id: string; key: string; title: string; plain: string; signs: string; fix_text: string; if_it_returns: string; categories: string[]; app_words: string[];
    check_service: string | null; check_metric: string | null; detect_script: string; fix_script: string; risk: string; status: string; version: number; content_hash: string;
    approved_hash: string | null; approved_by: string | null; approved_name: string | null; approved_at: Date | null; last_test: any; created_at: Date; updated_at: Date;
};

const SELECT = `SELECT p.id::text AS id, p.key, p.title, p.plain, p.signs, p.fix_text, p.if_it_returns, p.categories, p.app_words, p.check_service, p.check_metric, p.detect_script, p.fix_script,
    p.risk, p.status, p.version, p.content_hash, p.approved_hash, p.approved_by::text AS approved_by, NULLIF(btrim(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS approved_name, p.approved_at, p.last_test, p.created_at, p.updated_at
    FROM public.repair_playbooks p LEFT JOIN public.users u ON u.id = p.approved_by`;

const fieldsOf = (r: Row): PlaybookFields => ({
    title: r.title, plain: r.plain, signs: r.signs, fixText: r.fix_text, ifItReturns: r.if_it_returns, categories: r.categories as PlaybookFields["categories"], appWords: r.app_words,
    checkService: r.check_service, checkMetric: r.check_metric as PlaybookFields["checkMetric"], detectScript: r.detect_script, fixScript: r.fix_script, risk: r.risk as PlaybookFields["risk"],
});

/** The hash of what is stored right now (not the stored hash column, so a changed row is noticed). */
const liveHash = (r: Row) => contentHash(r.key, fieldsOf(r));

@Injectable()
export class PlaybooksService {
    private cache: { at: number; org: string; keys: Set<string> } | null = null;

    constructor(private readonly prisma: PrismaService, private readonly jobs: JobsService) { }

    private shape(r: Row) {
        const f = fieldsOf(r);
        const hash = liveHash(r);
        const approvedNow = r.status === "approved" && r.approved_hash === hash;
        return {
            id: r.id, key: r.key, ...f, status: r.status === "approved" && !approvedNow ? "draft" : r.status, version: r.version,
            approved: approvedNow, approvedBy: r.approved_name, approvedAt: r.approved_at?.toISOString() ?? null,
            warnings: scriptWarnings(r.detect_script, r.fix_script),
            tests: { detect: this.testState(r, "detect", hash), dryrun: r.fix_script ? this.testState(r, "dryrun", hash) : null },
            createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
        };
    }

    private testState(r: Row, mode: "detect" | "dryrun", hash: string) {
        const t = r.last_test?.[mode];
        if (!t) return { state: "not_run" as const };
        return { state: t.hash !== hash ? ("old" as const) : t.ok ? ("passed" as const) : ("failed" as const), at: t.at, output: String(t.output ?? "").slice(0, 4000) };
    }

    async list(orgId: string) {
        const rows = await this.prisma.$queryRawUnsafe<Row[]>(`${SELECT} WHERE p.organization_id = $1::uuid ORDER BY p.created_at DESC`, orgId);
        return { items: rows.map((r) => this.shape(r)) };
    }

    private async row(orgId: string, id: string): Promise<Row> {
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException("That repair does not exist.");
        const rows = await this.prisma.$queryRawUnsafe<Row[]>(`${SELECT} WHERE p.id = $1::uuid AND p.organization_id = $2::uuid`, id, orgId);
        if (!rows[0]) throw new NotFoundException("That repair does not exist.");
        return rows[0];
    }

    async get(orgId: string, id: string) { return this.shape(await this.row(orgId, id)); }

    private async snapshot(r: Row, userId: string | null, note: string) {
        await this.prisma.$executeRaw`INSERT INTO public.repair_playbook_versions (playbook_id, version, content_hash, snapshot, saved_by, note) VALUES (${r.id}::uuid, ${r.version}, ${liveHash(r)}, ${JSON.stringify({ key: r.key, ...fieldsOf(r) })}::jsonb, ${userId}::uuid, ${note})`;
    }

    async create(orgId: string, userId: string | null, input: Record<string, unknown>) {
        const f = cleanPlaybook(input);
        const key = newPlaybookKey();
        const hash = contentHash(key, f);
        const made = await this.prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO public.repair_playbooks (organization_id, key, title, plain, signs, fix_text, if_it_returns, categories, app_words, check_service, check_metric, detect_script, fix_script, risk, content_hash, created_by)
            VALUES (${orgId}::uuid, ${key}, ${f.title}, ${f.plain}, ${f.signs}, ${f.fixText}, ${f.ifItReturns}, ${f.categories}::text[], ${f.appWords}::text[], ${f.checkService}, ${f.checkMetric}, ${f.detectScript}, ${f.fixScript}, ${f.risk}, ${hash}, ${userId}::uuid) RETURNING id::text AS id`;
        const row = await this.row(orgId, made[0].id);
        await this.snapshot(row, userId, "Created");
        return this.shape(row);
    }

    /** Editing sends it back to draft: its tests and its approval were for the old scripts. */
    async update(orgId: string, id: string, userId: string | null, input: Record<string, unknown>) {
        const row = await this.row(orgId, id);
        const f = cleanPlaybook({ ...fieldsOf(row), ...input });
        const hash = contentHash(row.key, f);
        const changed = hash !== liveHash(row);
        await this.prisma.$executeRaw`UPDATE public.repair_playbooks SET title = ${f.title}, plain = ${f.plain}, signs = ${f.signs}, fix_text = ${f.fixText}, if_it_returns = ${f.ifItReturns}, categories = ${f.categories}::text[], app_words = ${f.appWords}::text[],
            check_service = ${f.checkService}, check_metric = ${f.checkMetric}, detect_script = ${f.detectScript}, fix_script = ${f.fixScript}, risk = ${f.risk}, content_hash = ${hash}, updated_at = now(),
            version = version + ${changed ? 1 : 0}, status = CASE WHEN ${changed} THEN 'draft' ELSE status END WHERE id = ${id}::uuid`;
        this.cache = null;
        const after = await this.row(orgId, id);
        if (changed) await this.snapshot(after, userId, "Edited: back to draft, needs testing and approval again");
        return this.shape(after);
    }

    async remove(orgId: string, id: string) {
        await this.row(orgId, id);
        await this.prisma.$executeRaw`DELETE FROM public.repair_playbooks WHERE id = ${id}::uuid`;
        this.cache = null;
        return { ok: true };
    }

    async versions(orgId: string, id: string) {
        await this.row(orgId, id);
        const rows = await this.prisma.$queryRaw<Array<{ version: number; content_hash: string; saved_at: Date; note: string | null; who: string | null }>>`
            SELECT v.version, v.content_hash, v.saved_at, v.note, NULLIF(btrim(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS who FROM public.repair_playbook_versions v LEFT JOIN public.users u ON u.id = v.saved_by WHERE v.playbook_id = ${id}::uuid ORDER BY v.id DESC LIMIT 50`;
        return { items: rows.map((v) => ({ version: v.version, hash: v.content_hash.slice(0, 12), savedAt: v.saved_at.toISOString(), note: v.note, by: v.who })) };
    }

    /* ------------------------------ testing on a computer ------------------------------ */

    /**
     * Runs the detection (read only) or the repair in dry-run mode on one computer, exactly as the repair loop would run it (inside the same fixed script).
     * A dry run sets ADG_DRYRUN=1: a repair script that is written to honour it changes nothing. Returns the job to follow.
     */
    async startTest(orgId: string, id: string, deviceId: string, mode: "detect" | "dryrun") {
        const row = await this.row(orgId, id);
        if (mode === "dryrun" && !row.fix_script) throw new BadRequestException("This repair has no repair script to try.");
        const dev = await this.prisma.$queryRaw<Array<{ agent_id: string; os: string | null; name: string | null }>>`SELECT a.id::text AS agent_id, a.facts->>'os' AS os, d.operating_system AS name FROM public.devices d JOIN public.agents a ON a.device_id = d.id LEFT JOIN public.sites s ON s.id = d.site_id LEFT JOIN public.clients c ON c.id = s.client_id WHERE d.id = ${deviceId}::uuid AND (c.organization_id = ${orgId}::uuid OR c.id IS NULL) LIMIT 1`;
        if (!dev[0] || !/windows/i.test(`${dev[0].os ?? ""} ${dev[0].name ?? ""}`)) throw new BadRequestException("Choose a Windows computer that has an agent.");
        const item = { key: row.key, detectScript: row.detect_script, fixScript: row.fix_script };
        const job = mode === "detect"
            ? await this.jobs.createRunScriptJob({ agentId: dev[0].agent_id, language: "powershell", scriptText: composeDiagnose(DIAGNOSE_SCRIPT, [item]), env: { ADG_TOOL: TEST_KIND, ADG_CHECKS: "", ADG_APP: "" }, timeoutSec: 180 })
            : await this.jobs.createRunScriptJob({ agentId: dev[0].agent_id, language: "powershell", scriptText: composeRepair(REPAIR_SCRIPT, [item]), env: { ADG_TOOL: TEST_KIND, ADG_FIX: row.key, ADG_DRYRUN: "1" }, timeoutSec: 300 });
        return { jobId: job.id, mode, hash: liveHash(row) };
    }

    /** Where a test stands. When it has finished, the result is kept with the hash of the scripts it tried, so a later edit makes it old. */
    async testResult(orgId: string, id: string, jobId: string, mode: "detect" | "dryrun") {
        const row = await this.row(orgId, id);
        const j = await this.jobs.getJobWithResult(jobId).catch(() => null);
        if (!j || (j.parsed_payload as any)?.env?.ADG_TOOL !== TEST_KIND) throw new NotFoundException("That test does not exist.");
        if (!["succeeded", "failed", "timeout"].includes(j.status)) return { state: "running" as const };
        const out = String(j.stdout ?? ""), err = String(j.stderr ?? "");
        // a draft is not known to the loop yet: make its own problem readable for this one check of what it printed
        registerPlaybookIssue(row.key, issueOfPlaybook(row.key, { title: row.title, plain: row.plain, signs: row.signs, fixText: row.fix_text, ifItReturns: row.if_it_returns, fixScript: row.fix_script, risk: row.risk as PlaybookFields["risk"] }));
        let ok = false; let summary = "";
        if (mode === "detect") {
            const d = parseDiagnosis(out);
            const error = /(^|\n)INFO [a-z0-9_-]*c-[0-9a-f]{8}_error\|/.test(out);
            ok = j.status === "succeeded" && d.complete && !error;
            summary = !d.complete ? "The script did not finish." : error ? "The detection script stopped with an error." : d.issues.some((i) => i.id === row.key) ? "It found the problem on this computer." : "It ran and did not find the problem on this computer (that is fine if the problem is not there right now).";
        } else {
            const lines = parseRepair(out);
            ok = j.status === "succeeded" && lines.some((l) => l.id === row.key && l.ok);
            summary = ok ? "The dry run ran and said it would work." : lines.some((l) => l.id === row.key) ? "The dry run ran but said it would not work." : "The repair did not say whether it worked.";
        }
        const test = { hash: liveHash(row), ok, at: new Date().toISOString(), output: [summary, out.trim(), err.trim() ? `Errors: ${err.trim()}` : ""].filter(Boolean).join("\n\n").slice(0, 6000) };
        await this.prisma.$executeRaw`UPDATE public.repair_playbooks SET last_test = jsonb_set(last_test, ARRAY[${mode}], ${JSON.stringify(test)}::jsonb), updated_at = now() WHERE id = ${id}::uuid`;
        return { state: ok ? ("passed" as const) : ("failed" as const), summary, output: test.output };
    }

    /* ------------------------------ approval ------------------------------ */

    /** The Owner approves exactly these scripts, once they have been tried on a computer. */
    async approve(orgId: string, id: string, userId: string | null) {
        const row = await this.row(orgId, id);
        const hash = liveHash(row);
        const need = (mode: "detect" | "dryrun") => row.last_test?.[mode]?.hash === hash && row.last_test?.[mode]?.ok === true;
        if (!need("detect")) throw new ConflictException("Try the detection script on a computer first (and it must run without an error), then approve.");
        if (row.fix_script && !need("dryrun")) throw new ConflictException("Try the repair script as a dry run on a computer first, then approve.");
        await this.prisma.$executeRaw`UPDATE public.repair_playbooks SET status = 'approved', approved_hash = ${hash}, approved_by = ${userId}::uuid, approved_at = now(), content_hash = ${hash}, updated_at = now() WHERE id = ${id}::uuid`;
        this.cache = null;
        await this.snapshot(await this.row(orgId, id), userId, "Approved");
        return this.get(orgId, id);
    }

    async setEnabled(orgId: string, id: string, enabled: boolean) {
        const row = await this.row(orgId, id);
        if (enabled) {
            if (row.approved_hash !== liveHash(row)) throw new ConflictException("These scripts are not the ones that were approved. Test and approve them again.");
            await this.prisma.$executeRaw`UPDATE public.repair_playbooks SET status = 'approved', updated_at = now() WHERE id = ${id}::uuid`;
        } else {
            await this.prisma.$executeRaw`UPDATE public.repair_playbooks SET status = 'disabled', updated_at = now() WHERE id = ${id}::uuid`;
        }
        this.cache = null;
        return this.get(orgId, id);
    }

    /* ------------------------------ for the repair loop ------------------------------ */

    /** The playbooks that may run now for this ticket or failed check: approved, still the approved scripts, and in scope. At most 10. */
    async matching(orgId: string, ctx: { category?: string | null; app?: string | null; checkService?: string | null; checkMetric?: string | null }) {
        const rows = await this.prisma.$queryRawUnsafe<Row[]>(`${SELECT} WHERE p.organization_id = $1::uuid AND p.status = 'approved' ORDER BY p.created_at`, orgId);
        const ok = rows.filter((r) => r.approved_hash === liveHash(r) && applies(fieldsOf(r), ctx)).slice(0, MAX_PLAYBOOKS_PER_RUN);
        return ok.map((r) => ({ key: r.key, title: r.title, risk: r.risk, detectScript: r.detect_script, fixScript: r.fix_script, approvedBy: r.approved_name, approvedAt: r.approved_at }));
    }

    /** Teaches the loop the words of the approved playbooks (so what they print is accepted, and replies and KB articles can name the problem). Cheap: cached for a short time. */
    async register(orgId: string) {
        if (this.cache && this.cache.org === orgId && Date.now() - this.cache.at < 15_000) return;
        const rows = await this.prisma.$queryRawUnsafe<Row[]>(`${SELECT} WHERE p.organization_id = $1::uuid AND p.status = 'approved'`, orgId);
        const keep = new Set<string>();
        for (const r of rows) {
            if (r.approved_hash !== liveHash(r)) continue;
            registerPlaybookIssue(r.key, issueOfPlaybook(r.key, { title: r.title, plain: r.plain, signs: r.signs, fixText: r.fix_text, ifItReturns: r.if_it_returns, fixScript: r.fix_script, risk: r.risk as PlaybookFields["risk"] }));
            keep.add(r.key);
        }
        forgetPlaybookIssues(keep);
        this.cache = { at: Date.now(), org: orgId, keys: keep };
    }

    /** By key: the scripts of playbooks a run included, for the repair and the confirming checks (still only if they are approved and unchanged). */
    async byKeys(orgId: string, keys: string[]) {
        if (!keys.length) return [];
        const rows = await this.prisma.$queryRawUnsafe<Row[]>(`${SELECT} WHERE p.organization_id = $1::uuid AND p.key = ANY($2::text[]) AND p.status = 'approved'`, orgId, keys);
        return rows.filter((r) => r.approved_hash === liveHash(r)).map((r) => ({ key: r.key, title: r.title, risk: r.risk, detectScript: r.detect_script, fixScript: r.fix_script, approvedBy: r.approved_name, approvedAt: r.approved_at }));
    }
}
