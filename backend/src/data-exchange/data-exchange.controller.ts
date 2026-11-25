// backend/src/data-exchange/data-exchange.controller.ts
import { BadRequestException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, PayloadTooLargeException, Post, Query, Req, Res, UnsupportedMediaTypeException } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuditService } from "../audit/audit.service";
import { RequirePerm } from "../auth/require-perm.decorator";
import { csvRow } from "../audit/audit.util";
import { FlagsService } from "../flags/flags.service";
import { ClientAccessService } from "../reports/client-access.service";
import { EXPORT_KINDS, EXPORT_PERMISSION, ExportService, parseRange, type ExportKind } from "./export.service";
import { IMPORT_KINDS, ImportService, MAX_IMPORT_BYTES, TEMPLATES, type ImportKind, type OnExisting } from "./import.service";

/** Reads a CSV body, refusing anything larger than the limit before it is held in memory. */
async function readCsv(req: Request): Promise<string> {
    const type = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!type.startsWith("text/csv") && !type.startsWith("text/plain")) throw new UnsupportedMediaTypeException("Send the file as text/csv.");
    if (Number(req.headers["content-length"] ?? 0) > MAX_IMPORT_BYTES) throw new PayloadTooLargeException("That file is larger than 5 MB. Split it into smaller files.");
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_IMPORT_BYTES) {
                reject(new PayloadTooLargeException("That file is larger than 5 MB. Split it into smaller files."));
                req.unpipe();
                req.resume();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

/** Export and import of customers, sites, contacts and more as CSV. Each export needs the right to read what it holds. */
@Controller("api/admin/data")
export class DataExchangeController {
    constructor(
        private readonly exporter: ExportService,
        private readonly importer: ImportService,
        private readonly access: ClientAccessService,
        private readonly flags: FlagsService,
        private readonly audit: AuditService,
    ) { }

    private who(req: Request) {
        const u = (req as any).user ?? {};
        return { id: u.id ? String(u.id) : null, email: u.email ? String(u.email) : null };
    }

    @Get("export/:kind")
    @RequirePerm("admin.access")
    async export(@Req() req: Request, @Res() res: Response, @Param("kind") kind: string, @Query("from") from?: string, @Query("to") to?: string) {
        if (!(EXPORT_KINDS as readonly string[]).includes(kind)) throw new NotFoundException("There is no such export.");
        const k = kind as ExportKind;
        const held: Set<string> | undefined = (req as any).effectivePermissions;
        if (!held?.has(EXPORT_PERMISSION[k])) throw new ForbiddenException("Insufficient permissions");
        const me = this.who(req);
        const orgId = await this.flags.orgOf((req as any).user);
        const scope = await this.access.scopeFor(me.id);
        const clients = await this.access.visibleClientsFor(me.id);
        const stream = this.exporter.open(k, { orgId, clients, devices: scope, from: parseRange(from, "from", false), to: parseRange(to, "to", true) });
        // The first page is read before any output, so a failure still gets a normal error response.
        const first = await stream.rows.next();

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${stream.filename}"`);
        res.setHeader("Cache-Control", "no-store");
        const write = async (line: string) => {
            if (!res.write(line)) await new Promise((resolve) => res.once("drain", resolve));
        };
        let count = 0;
        try {
            // The byte order mark is what makes Excel read the file as UTF-8.
            await write(`﻿${csvRow(stream.columns)}`);
            let next = first;
            while (!next.done && !res.destroyed) {
                await write(csvRow(next.value));
                count++;
                next = await stream.rows.next();
            }
            res.end();
        } catch {
            // Headers are gone by now, so cutting the connection is the only way to show it failed.
            res.destroy();
        } finally {
            void this.audit.record({ action: "data.export", category: "settings", outcome: res.writableEnded ? "success" : "failure", actorUserId: me.id, actorEmail: me.email, req, targetType: "export", targetId: k, details: { kind: k, rows: count, from, to, limitedToCustomers: clients ? clients.length : null } });
        }
    }

    /** A header row and one example row, so a file can be made in a spreadsheet. */
    @Get("import/:kind/template")
    @RequirePerm("customers.write")
    template(@Param("kind") kind: string, @Res() res: Response) {
        if (!(IMPORT_KINDS as readonly string[]).includes(kind)) throw new NotFoundException("There is no such import.");
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${kind}-import-template.csv"`);
        res.setHeader("Cache-Control", "no-store");
        res.send(`﻿${TEMPLATES[kind as ImportKind].map(csvRow).join("")}`);
    }

    /** mode=preview writes nothing. mode=apply does what the preview said. existing=skip leaves records that are already there alone. */
    @Post("import/:kind")
    @HttpCode(200)
    @RequirePerm("customers.write")
    async import(@Req() req: Request, @Param("kind") kind: string, @Query("mode") mode?: string, @Query("existing") existing?: string) {
        if (!(IMPORT_KINDS as readonly string[]).includes(kind)) throw new NotFoundException("There is no such import.");
        if (mode !== "preview" && mode !== "apply") throw new BadRequestException("mode must be preview or apply.");
        if (existing !== undefined && existing !== "skip" && existing !== "update") throw new BadRequestException("existing must be skip or update.");
        const onExisting: OnExisting = existing === "update" ? "update" : "skip";
        const me = this.who(req);
        const text = await readCsv(req);
        const orgId = await this.flags.orgOf((req as any).user);
        const allowed = await this.access.visibleClientsFor(me.id);
        let report;
        try {
            report = await this.importer.run(kind as ImportKind, text, { orgId, apply: mode === "apply", onExisting, allowed });
        } catch (e) {
            void this.audit.record({ action: `data.import.${mode}`, category: "settings", outcome: "failure", actorUserId: me.id, actorEmail: me.email, req, targetType: "import", targetId: kind, details: { kind, onExisting } });
            throw e;
        }
        void this.audit.record({ action: `data.import.${mode}`, category: "settings", outcome: "success", actorUserId: me.id, actorEmail: me.email, req, targetType: "import", targetId: kind, details: { kind, onExisting, ...report.summary } });
        return report;
    }
}
