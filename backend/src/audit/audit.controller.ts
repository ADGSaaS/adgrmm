// backend/src/audit/audit.controller.ts
import { Controller, Get, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { AuditQueryDto } from "./audit.dto";
import { AuditService } from "./audit.service";
import { csvRow } from "./audit.util";

// A sanity limit on one file. Narrowing the dates reaches anything beyond it.
const EXPORT_MAX_ROWS = 200_000;

const CSV_COLUMNS = [
    "time",
    "actor_email",
    "actor_user_id",
    "action",
    "category",
    "outcome",
    "target_type",
    "target_id",
    "target_label",
    "ip",
    "user_agent",
    "details",
];

@Controller("/api/admin/audit-events")
export class AuditController {
    constructor(private readonly audit: AuditService) { }

    @Get()
    @RequirePerm("audit.read")
    list(@Query() query: AuditQueryDto) {
        return this.audit.list(query);
    }

    @Get("export")
    @RequirePerm("audit.read")
    async export(@Query() query: AuditQueryDto, @Req() req: Request, @Res() res: Response) {
        const rows = this.audit.exportRows(query, EXPORT_MAX_ROWS);
        // Pulled before any output so a bad filter still gets a normal error response.
        const first = await rows.next();

        const user = (req as any).user;
        void this.audit.record({
            action: "audit.export",
            category: "audit",
            outcome: "success",
            actorUserId: user?.id,
            actorEmail: user?.email,
            req,
            details: {
                category: query.category,
                actor: query.actor,
                action: query.action,
                target: query.target,
                outcome: query.outcome,
                from: query.from,
                to: query.to,
                q: query.q,
            },
        });

        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="audit-log-${stamp}.csv"`);
        res.setHeader("Cache-Control", "no-store");

        const write = async (line: string) => {
            if (!res.write(line)) await new Promise((resolve) => res.once("drain", resolve));
        };

        try {
            // The byte order mark is what makes Excel read the file as UTF-8.
            await write(`﻿${csvRow(CSV_COLUMNS)}`);
            let next = first;
            while (!next.done && !res.destroyed) {
                const r = next.value;
                await write(
                    csvRow([
                        r.created_at,
                        r.actor_email,
                        r.actor_user_id,
                        r.action,
                        r.category,
                        r.outcome,
                        r.target_type,
                        r.target_id,
                        r.target_label,
                        r.ip,
                        r.user_agent,
                        r.details,
                    ]),
                );
                next = await rows.next();
            }
            res.end();
        } catch {
            // Headers are gone by now, so cutting the connection is the only way to show it failed.
            res.destroy();
        }
    }
}
