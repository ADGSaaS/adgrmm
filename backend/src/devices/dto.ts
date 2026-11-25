// src/devices/dto.ts
import { Transform } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";
import { DEVICE_SORT_KEYS, type DeviceSortKey } from "./devices.service";

export class ListDevicesQuery {
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(200)
    @Transform(({ value }) => (value != null ? parseInt(value, 10) : 25))
    pageSize = 25;

    @IsOptional()
    @IsString()
    cursor?: string | null;

    /** ?offset=<n>: start at this row (instead of at the cursor) */
    @IsOptional()
    @IsInt()
    @Min(0)
    @Transform(({ value }) => (value != null && value !== "" ? parseInt(value, 10) : undefined))
    offset?: number;

    /** ?sort=hostname|status|os|client|site|user|version|lastSeen&dir=asc|desc */
    @IsOptional()
    @IsEnum(DEVICE_SORT_KEYS, { message: `sort must be one of ${DEVICE_SORT_KEYS.join(", ")}` })
    sort?: DeviceSortKey;

    @IsOptional()
    @IsEnum(["asc", "desc"], { message: "dir must be 'asc' or 'desc'" })
    dir?: "asc" | "desc";

    /** ?total=1: also say how many devices match in all */
    @IsOptional()
    @Transform(({ value }) => value === "1" || value === "true" || value === true)
    total?: boolean;

    @IsOptional()
    @IsString()
    q?: string;

    @IsOptional()
    @IsEnum(["online", "offline"], { message: "status must be 'online' or 'offline'" })
    status?: "online" | "offline";

    /** allow multiple ?os=windows&os=linux */
    @IsOptional()
    @Transform(({ value }) => {
        const arr = Array.isArray(value) ? value : value != null ? [value] : [];
        return arr.map((v: string) => String(v).toLowerCase()).filter(Boolean);
    })
    os?: string[];

    /** ?clientId=<id>: only this customer's devices */
    @IsOptional()
    @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: "clientId must be a customer id" })
    clientId?: string;

    /** ?tag=<id>&tag=<id>: devices carrying any of these tags */
    @IsOptional()
    @Transform(({ value }) => {
        const arr = Array.isArray(value) ? value : value != null ? [value] : [];
        return arr.map((v: string) => String(v)).filter((v: string) => /^[0-9a-f-]{36}$/i.test(v));
    })
    tag?: string[];

    /** ?siteId=<id>: only this site's devices */
    @IsOptional()
    @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: "siteId must be a site id" })
    siteId?: string;

    /** ?platform=windows|other: Windows devices, or every device that is not Windows */
    @IsOptional()
    @IsEnum(["windows", "other"], { message: "platform must be 'windows' or 'other'" })
    platform?: "windows" | "other";

    /**
     * ?place=<json>&place=<json>: customers (or a customer's sites) by name, each {"c":"Acme"} or {"c":"Acme","s":"Head office"};
     * devices in any of them. An em dash for c or s means no customer or no site.
     */
    @IsOptional()
    @Transform(({ value }) => {
        const arr = Array.isArray(value) ? value : value != null ? [value] : [];
        const out: { client: string; site?: string }[] = [];
        for (const v of arr.slice(0, 200)) {
            // Both the global and the controller's validation pipe run this, so an already parsed place passes through.
            if (v && typeof v === "object" && typeof v.client === "string") {
                out.push(v.site === undefined ? { client: v.client } : { client: v.client, site: String(v.site) });
                continue;
            }
            try {
                const p = JSON.parse(String(v));
                if (typeof p?.c === "string" && p.c.trim() && (p.s === undefined || typeof p.s === "string")) {
                    out.push({ client: p.c.trim(), ...(p.s === undefined ? {} : { site: String(p.s).trim() }) });
                }
            } catch { /* not a place */ }
        }
        return out;
    })
    place?: { client: string; site?: string }[];
}
