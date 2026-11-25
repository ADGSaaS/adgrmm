// backend/src/devices/devices.service.ts
import { AssetsService } from "../assets/assets.service";
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import type { AccessScope } from "../reports/client-access.service";

export type Device = {
  /**
   * ✅ Stable row id returned by backend:
   * Always public.devices.id (uuid), even for agent-sourced rows.
   */
  id: string;

  /** Always the underlying public.devices.id (uuid). */
  deviceId?: string | null;

  hostname: string;
  os: string;
  arch?: string | null;
  lastSeen: string | null;
  status: "online" | "offline";

  deletionStatus?: "pending" | null;

  /** Labels on this device (Policies > Tags). */
  tags?: { id: string; name: string; color: string | null }[];

  clientId?: string | null;
  siteId?: string | null;

  client?: string | null;
  site?: string | null;

  user?: string | null;
  version?: string | null;
  primaryIp?: string | null;

  /** Optional UUID for the underlying agent (if backend provides it). */
  agentUuid?: string | null;

  /** ✅ raw agent facts (jsonb) when present (agent-sourced rows) */
  facts?: Record<string, any> | null;

  /** Agent update ring in effect: the device's own, else its customer's default, else stable (staged rollout). */
  updateRing?: "pilot" | "stable";
  /** The ring set on the device itself; null means it follows its customer's default. */
  updateRingOwn?: "pilot" | "stable" | null;
};

function decodeCursor(cur?: string | null) {
  if (!cur) return 0;
  try {
    const n = parseInt(Buffer.from(cur, "base64url").toString("utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
function encodeCursor(n: number) {
  return Buffer.from(String(n), "utf8").toString("base64url");
}

const toIso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

function toDevice(r: any): Device {
  return {
    id: r.id, // ✅ stable = devices.id
    deviceId: r.device_id ?? null,

    hostname: r.hostname,
    os: r.os,
    arch: r.arch ?? null,
    lastSeen: toIso(r.last_seen),
    status: r.status as "online" | "offline",

    deletionStatus: (r.deletion_status ?? null) as "pending" | null,

    clientId: r.client_id ?? null,
    siteId: r.site_id ?? null,

    client: r.client ?? null,
    site: r.site ?? null,

    user: r.user ?? null,
    version: r.version ?? null,
    primaryIp: r.primary_ip ?? null,
    agentUuid: r.agent_uuid ?? null,

    facts: r.facts ?? null,

    updateRing: r.update_ring === "pilot" ? "pilot" : "stable",
    updateRingOwn: r.update_ring_own === "pilot" || r.update_ring_own === "stable" ? r.update_ring_own : null,
  };
}

// Device rows come from a union over agents and devices with COALESCE and JSON-derived columns,
// filtered and sorted on those computed values in the database collation, so Prisma cannot express them.
const AGENT_ROW_COLUMNS = Prisma.sql`
  -- ✅ stable id for UI routing: ALWAYS the underlying devices.id
  a.device_id::text AS id,
  a.device_id::text AS device_id,

  COALESCE(a.hostname, d.hostname, a.device_id::text, 'unknown') AS hostname,

  COALESCE(NULLIF(a.facts->>'os', ''), NULLIF(d.operating_system, ''), 'unknown') AS os,
  COALESCE(NULLIF(a.facts->>'arch', ''), d.architecture, NULL) AS arch,

  COALESCE(a.last_check_in_at, d.last_seen_at) AS last_seen,

  CASE
    WHEN a.last_check_in_at IS NOT NULL
     AND a.last_check_in_at > NOW() - INTERVAL '5 minutes'
    THEN 'online'
    ELSE 'offline'
  END AS status,

  c.id::text AS client_id,
  s.id::text AS site_id,
  c.name::text AS client,
  s.name::text AS site,

  dr.status::text AS deletion_status,

  COALESCE(
    NULLIF(a.facts->>'user', ''),
    NULLIF(a.facts->>'logged_in_user', ''),
    NULL
  ) AS "user",

  NULLIF(a.version, '') AS version,
  NULLIF(a.facts->>'primary_ip', '') AS primary_ip,

  COALESCE(NULLIF(a.agent_uuid, ''), a.id::text) AS agent_uuid,

  a.facts AS facts,

  COALESCE(d.update_ring, c.default_update_ring, 'stable') AS update_ring,
  d.update_ring AS update_ring_own
  FROM public.agents a
  LEFT JOIN public.devices d ON d.id = a.device_id
  LEFT JOIN public.sites   s ON s.id = d.site_id
  LEFT JOIN public.clients c ON c.id = s.client_id
  LEFT JOIN public.device_deletion_requests dr
    ON dr.device_id = d.id AND dr.status = 'pending'
`;

const DEVICE_ROW_COLUMNS = Prisma.sql`
  d.id::text            AS id,
  d.id::text            AS device_id,
  d.hostname            AS hostname,
  COALESCE(NULLIF(d.operating_system, ''), 'unknown') AS os,
  d.architecture        AS arch,
  d.last_seen_at        AS last_seen,
  CASE WHEN d.last_seen_at > NOW() - INTERVAL '5 minutes' THEN 'online' ELSE 'offline' END AS status,

  c.id::text            AS client_id,
  s.id::text            AS site_id,
  c.name::text          AS client,
  s.name::text          AS site,

  dr.status::text       AS deletion_status,

  NULL::text            AS "user",
  NULL::text            AS version,
  NULL::text            AS primary_ip,
  NULL::text            AS agent_uuid,

  NULL::jsonb           AS facts,

  COALESCE(d.update_ring, c.default_update_ring, 'stable') AS update_ring,
  d.update_ring         AS update_ring_own
  FROM public.devices d
  LEFT JOIN public.sites   s ON s.id = d.site_id
  LEFT JOIN public.clients c ON c.id = s.client_id
  LEFT JOIN public.device_deletion_requests dr
    ON dr.device_id = d.id AND dr.status = 'pending'
`;

const OUTPUT_COLUMNS = Prisma.sql`
  id, device_id, hostname, os, arch, last_seen, status, client_id, site_id,
  client, site, deletion_status, "user", version, primary_ip, agent_uuid, facts, update_ring, update_ring_own
`;

/** The name the screens give a device that has no customer or no site (an em dash). */
const NONE = "—";

/** What the device list and the counts can be narrowed by. Every part is optional and they combine with AND. */
export type DeviceFilter = {
  /** Host name, customer, site or tag name contains this text. */
  q?: string;
  status?: "online" | "offline";
  /** Exact operating system names (lower case). */
  os?: string[];
  /** Windows, or anything that is not Windows. */
  platform?: "windows" | "other";
  /** Only devices carrying any of these tags (ids). */
  tagIds?: string[];
  /** Only this customer's devices (an id). */
  clientId?: string;
  /** Only this site's devices (an id). */
  siteId?: string;
  /** Customers, or customer and site, by name; a device matching any one is kept. A name of an em dash means no customer (or no site). */
  places?: { client: string; site?: string }[];
  /** What a limited person may see: whole customers, sites, tags. Null means everything. */
  scope?: AccessScope | null;
};

export const DEVICE_SORT_KEYS = ["hostname", "status", "os", "client", "site", "user", "version", "lastSeen"] as const;
export type DeviceSortKey = (typeof DEVICE_SORT_KEYS)[number];
const SORT_COLUMN: Record<DeviceSortKey, Prisma.Sql> = {
  hostname: Prisma.sql`hostname`,
  status: Prisma.sql`status`,
  os: Prisma.sql`os`,
  client: Prisma.sql`client`,
  site: Prisma.sql`site`,
  user: Prisma.sql`"user"`,
  version: Prisma.sql`version`,
  lastSeen: Prisma.sql`last_seen`,
};

export type DeviceBucket = { total: number; online: number; offline: number; withAlerts: number };
export type DeviceCounts = DeviceBucket & {
  /** By operating system. Anything that is not Windows, Linux or macOS is under "other". */
  byOs: Record<"windows" | "linux" | "macos" | "other", DeviceBucket>;
  /** Customers with their sites. Devices in no customer are one entry with a null id and name. */
  clients: Array<{ id: string | null; name: string | null; sites: Array<{ id: string | null; name: string | null } & DeviceBucket> } & DeviceBucket>;
};

const emptyBucket = (): DeviceBucket => ({ total: 0, online: 0, offline: 0, withAlerts: 0 });
function addTo(b: DeviceBucket, n: number, online: boolean, alerts: number) {
  b.total += n;
  if (online) b.online += n;
  else b.offline += n;
  b.withAlerts += alerts;
}

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly assets?: AssetsService) { }

  /** The WHERE clause (over the all_devs columns) for a filter. Empty when nothing narrows the list. */
  private whereOf(f: DeviceFilter): Prisma.Sql {
    const where: Prisma.Sql[] = [];
    if (f.q && f.q.trim()) {
      const like = `%${f.q.trim()}%`;
      where.push(Prisma.sql`(hostname ILIKE ${like} OR client ILIKE ${like} OR site ILIKE ${like} OR id IN (SELECT dt.device_id::text FROM public.device_tags dt JOIN public.tag_defs td ON td.id = dt.tag_id WHERE td.name ILIKE ${like}))`);
    }
    if (f.tagIds?.length) {
      where.push(Prisma.sql`id IN (SELECT dt.device_id::text FROM public.device_tags dt WHERE dt.tag_id::text = ANY(${f.tagIds}::text[]))`);
    }
    if (f.status) where.push(Prisma.sql`status = ${f.status}`);
    if (f.clientId) where.push(Prisma.sql`client_id = ${f.clientId}`);
    if (f.siteId) where.push(Prisma.sql`site_id = ${f.siteId}`);
    if (f.places?.length) {
      const one = (p: { client: string; site?: string }) => {
        const c = p.client === NONE ? Prisma.sql`client IS NULL` : Prisma.sql`btrim(client) = ${p.client}`;
        if (p.site === undefined) return Prisma.sql`(${c})`;
        const s = p.site === NONE ? Prisma.sql`site IS NULL` : Prisma.sql`btrim(site) = ${p.site}`;
        return Prisma.sql`(${c} AND ${s})`;
      };
      where.push(Prisma.sql`(${Prisma.join(f.places.map(one), " OR ")})`);
    }
    if (f.scope) {
      const s = f.scope;
      where.push(Prisma.sql`(
        client_id = ANY(${s.clients}::text[])
        OR site_id = ANY(${s.sites}::text[])
        OR id IN (SELECT dt.device_id::text FROM public.device_tags dt WHERE dt.tag_id::text = ANY(${s.tags}::text[]))
      )`);
    }
    if (f.os && f.os.length) {
      where.push(Prisma.sql`lower(os) = ANY(${f.os.map((o) => String(o).toLowerCase())}::text[])`);
    }
    if (f.platform === "windows") where.push(Prisma.sql`lower(os) LIKE '%windows%'`);
    else if (f.platform === "other") where.push(Prisma.sql`lower(os) NOT LIKE '%windows%'`);
    return where.length ? Prisma.sql`WHERE ${Prisma.join(where, " AND ")}` : Prisma.empty;
  }

  async list(
    opts: DeviceFilter & {
      pageSize: number;
      cursor?: string | null;
      /** Start at this row instead of at the cursor. */
      offset?: number;
      sort?: DeviceSortKey;
      dir?: "asc" | "desc";
      /** Also count every device the filter matches (not only this page). */
      withTotal?: boolean;
    }
  ): Promise<{ items: Device[]; nextCursor: string | null; total?: number }> {
    const { pageSize, cursor } = opts;
    const offset = opts.offset ?? decodeCursor(cursor);
    const whereSql = this.whereOf(opts);
    // Rows with ties (same host name) must come back in the same order on every page, so the id breaks them.
    const order = opts.sort
      ? Prisma.sql`ORDER BY ${SORT_COLUMN[opts.sort]} ${opts.dir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`} NULLS LAST, id ASC`
      : Prisma.sql`ORDER BY hostname ASC, id ASC`;

    const rows = await this.prisma.$queryRaw<any[]>`
      WITH all_devs AS (
        SELECT ${AGENT_ROW_COLUMNS}
        UNION ALL
        SELECT ${DEVICE_ROW_COLUMNS}
        WHERE NOT EXISTS (
          SELECT 1 FROM public.agents a
          WHERE a.device_id = d.id
        )
      )
      SELECT ${OUTPUT_COLUMNS}
      FROM all_devs
      ${whereSql}
      ${order}
      LIMIT ${Prisma.raw(String(pageSize + 1))} OFFSET ${Prisma.raw(String(offset))}
    `;
    const hasNext = rows.length > pageSize;

    let total: number | undefined;
    if (opts.withTotal) {
      const [{ n }] = await this.prisma.$queryRaw<Array<{ n: number }>>`
        WITH all_devs AS (
          SELECT ${AGENT_ROW_COLUMNS}
          UNION ALL
          SELECT ${DEVICE_ROW_COLUMNS}
          WHERE NOT EXISTS (
            SELECT 1 FROM public.agents a
            WHERE a.device_id = d.id
          )
        )
        SELECT count(*)::int AS n FROM all_devs ${whereSql}
      `;
      total = n;
    }

    const page = rows.slice(0, pageSize).map(toDevice);
    if (page.length) {
      const tagRows = await this.prisma.device_tags.findMany({
        where: { device_id: { in: page.map((d) => d.id) } },
        select: { device_id: true, tag_defs: { select: { id: true, name: true, color: true } } },
      });
      const byDevice = new Map<string, { id: string; name: string; color: string | null }[]>();
      for (const t of tagRows) byDevice.set(t.device_id, [...(byDevice.get(t.device_id) ?? []), t.tag_defs]);
      for (const d of page) d.tags = (byDevice.get(d.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    }

    return {
      items: page,
      nextCursor: hasNext ? encodeCursor(offset + pageSize) : null,
      ...(total !== undefined ? { total } : {}),
    };
  }

  /**
   * Which devices a filter matches, as ids and host names, up to `limit` of them (and how many match in all). This is what
   * "select all N matching" in the device list needs: the bulk actions take at most 500 devices at a time.
   */
  async ids(opts: DeviceFilter & { limit: number; sort?: DeviceSortKey; dir?: "asc" | "desc" }): Promise<{ items: Array<{ id: string; hostname: string }>; total: number }> {
    const whereSql = this.whereOf(opts);
    const order = opts.sort
      ? Prisma.sql`ORDER BY ${SORT_COLUMN[opts.sort]} ${opts.dir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`} NULLS LAST, id ASC`
      : Prisma.sql`ORDER BY hostname ASC, id ASC`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; hostname: string; n: number }>>`
      WITH all_devs AS (
        SELECT ${AGENT_ROW_COLUMNS}
        UNION ALL
        SELECT ${DEVICE_ROW_COLUMNS}
        WHERE NOT EXISTS (
          SELECT 1 FROM public.agents a
          WHERE a.device_id = d.id
        )
      )
      SELECT id, hostname, (count(*) OVER ())::int AS n
      FROM all_devs
      ${whereSql}
      ${order}
      LIMIT ${Prisma.raw(String(Math.min(Math.max(Math.floor(opts.limit) || 1, 1), 500)))}
    `;
    if (rows.length) return { items: rows.map((r) => ({ id: r.id, hostname: r.hostname })), total: rows[0].n };
    return { items: [], total: 0 };
  }

  /**
   * How many devices there are, online and offline (by the rule the device list uses), and how many have an open alert that
   * is not silenced: in all, by operating system, and by customer and site. Counted in the database, so no device is left out.
   */
  async counts(opts: DeviceFilter): Promise<DeviceCounts> {
    const whereSql = this.whereOf(opts);
    const rows = await this.prisma.$queryRaw<
      Array<{ bucket: "windows" | "linux" | "macos" | "other"; status: string; client_id: string | null; client: string | null; site_id: string | null; site: string | null; n: number; alerts: number }>
    >`
      WITH all_devs AS (
        SELECT ${AGENT_ROW_COLUMNS}
        UNION ALL
        SELECT ${DEVICE_ROW_COLUMNS}
        WHERE NOT EXISTS (
          SELECT 1 FROM public.agents a
          WHERE a.device_id = d.id
        )
      )
      SELECT bucket, status, client_id, client, site_id, site,
             count(*)::int AS n,
             count(*) FILTER (WHERE has_alert)::int AS alerts
      FROM (
        SELECT status, client_id, client, site_id, site,
               CASE lower(os) WHEN 'windows' THEN 'windows' WHEN 'linux' THEN 'linux' WHEN 'macos' THEN 'macos' ELSE 'other' END AS bucket,
               (id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.alerts al
                  WHERE al.device_id = all_devs.id::uuid AND al.state = 'OPEN' AND (al.silenced_until IS NULL OR al.silenced_until < NOW())
               )) AS has_alert
        FROM all_devs
        ${whereSql}
      ) x
      GROUP BY bucket, status, client_id, client, site_id, site
    `;

    const out: DeviceCounts = {
      ...emptyBucket(),
      byOs: { windows: emptyBucket(), linux: emptyBucket(), macos: emptyBucket(), other: emptyBucket() },
      clients: [],
    };
    const clients = new Map<string, DeviceCounts["clients"][number]>();
    for (const r of rows) {
      const online = r.status === "online";
      addTo(out, r.n, online, r.alerts);
      addTo(out.byOs[r.bucket], r.n, online, r.alerts);
      const ck = r.client_id ?? "";
      let c = clients.get(ck);
      if (!c) {
        c = { id: r.client_id, name: r.client, ...emptyBucket(), sites: [] };
        clients.set(ck, c);
        out.clients.push(c);
      }
      addTo(c, r.n, online, r.alerts);
      let s = c.sites.find((x) => x.id === r.site_id);
      if (!s) {
        s = { id: r.site_id, name: r.site, ...emptyBucket() };
        c.sites.push(s);
      }
      addTo(s, r.n, online, r.alerts);
    }
    const byName = (a: { name: string | null }, b: { name: string | null }) => (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" });
    out.clients.sort(byName);
    for (const c of out.clients) c.sites.sort(byName);
    return out;
  }

  async getOne(id: string): Promise<Device | null> {
    const rows = await this.prisma.$queryRaw<any[]>`
      WITH matched AS (
        SELECT 0 AS pref, ${AGENT_ROW_COLUMNS}
        WHERE a.id::text = ${id} OR a.device_id::text = ${id}
        UNION ALL
        SELECT 1 AS pref, ${DEVICE_ROW_COLUMNS}
        WHERE d.id::text = ${id}
      )
      SELECT ${OUTPUT_COLUMNS}
      FROM matched
      ORDER BY pref ASC
      LIMIT 1
    `;
    return rows[0] ? toDevice(rows[0]) : null;
  }

  /**
   * Asks for a device to be removed. The reason is required, so whoever approves it knows why, and the person can ask for a
   * ticket to be opened for the approval.
   */
  async requestDeviceDeletion(
    deviceOrAgentId: string,
    requestedByUserId: string | null,
    input: { reason?: unknown; createTicket?: unknown } = {}
  ) {
    const deviceId = await this.resolveDeviceRowId(String(deviceOrAgentId ?? "").trim());
    if (!deviceId) throw new NotFoundException("Device not found");

    const reason = String(input?.reason ?? "").trim();
    if (reason.length < 3) throw new BadRequestException("Say why this device should be removed (at least a few words).");
    if (reason.length > 500) throw new BadRequestException("The reason is too long (500 characters at most).");
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(reason)) throw new BadRequestException("The reason has characters that are not allowed.");

    let ticketId: string | null = null;
    if (input?.createTicket === true) {
      const dev = await this.prisma.devices.findUnique({
        where: { id: deviceId },
        select: { hostname: true, alias: true, sites: { select: { name: true, clients: { select: { name: true, organization_id: true } } } } },
      });
      const org = dev?.sites?.clients?.organization_id;
      if (!org) throw new BadRequestException("This device is not in a customer yet, so there is no organisation to open a ticket in.");
      const who = requestedByUserId
        ? await this.prisma.users.findUnique({ where: { id: requestedByUserId }, select: { first_name: true, last_name: true, email: true } })
        : null;
      const whoName = who ? [who.first_name, who.last_name].filter(Boolean).join(" ") || String(who.email) : "Someone";
      const name = dev?.alias || dev?.hostname || deviceId;
      for (let attempt = 0; attempt < 3 && !ticketId; attempt++) {
        try {
          const [{ n }] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COALESCE(MAX(ticket_number), 0) + 1 AS n FROM public.tickets WHERE organization_id = ${org}::uuid`;
          const t = await this.prisma.tickets.create({
            data: {
              organization_id: org,
              ticket_number: n,
              device_id: deviceId,
              subject: `Approve removal of ${name}`,
              description: `${whoName} asked for ${name}${dev?.sites ? ` (${dev.sites.clients.name} / ${dev.sites.name})` : ""} to be removed.\n\nReason: ${reason}`,
              status: "open",
              priority: "normal",
            },
            select: { id: true },
          });
          ticketId = t.id;
        } catch (e: any) {
          if (e?.code !== "P2002") throw e; // another ticket took that number a moment ago: try the next
        }
      }
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.device_deletion_requests.createMany({
        data: [{ id: randomUUID(), device_id: deviceId, status: "pending", requested_by_user_id: requestedByUserId, reason, ticket_id: ticketId, requested_at: now }],
        skipDuplicates: true,
      }),
      // A device asked about again (an earlier request completed or is being repeated) carries the newest reason.
      this.prisma.device_deletion_requests.updateMany({
        where: { device_id: deviceId },
        data: { status: "pending", reason, ticket_id: ticketId, requested_by_user_id: requestedByUserId, requested_at: now, approved_by_user_id: null, approved_at: null, completed_at: null },
      }),
    ]);

    return { deviceId, status: "pending" as const, ticketId };
  }

  /** What an approver needs to see: who asked, when, why, and the ticket if one was opened. */
  async getDeletionRequest(deviceOrAgentId: string) {
    const deviceId = await this.resolveDeviceRowId(String(deviceOrAgentId ?? "").trim());
    if (!deviceId) throw new NotFoundException("Device not found");
    const r = await this.prisma.device_deletion_requests.findUnique({ where: { device_id: deviceId } });
    if (!r || r.status !== "pending") return { request: null };
    const who = r.requested_by_user_id
      ? await this.prisma.users.findUnique({ where: { id: r.requested_by_user_id }, select: { first_name: true, last_name: true, email: true } })
      : null;
    return {
      request: {
        status: "pending" as const,
        reason: r.reason ?? null,
        requestedAt: r.requested_at.toISOString(),
        requestedBy: who ? [who.first_name, who.last_name].filter(Boolean).join(" ") || String(who.email) : null,
        ticketId: r.ticket_id ?? null,
      },
    };
  }

  async approveAndDeleteDevice(deviceOrAgentId: string, approvedByUserId: string | null) {
    const rawId = String(deviceOrAgentId ?? "").trim();
    const deviceId = await this.resolveDeviceRowId(rawId);
    if (!deviceId) throw new NotFoundException("Device not found");

    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.device_deletion_requests.createMany({
        data: [{ id: randomUUID(), device_id: deviceId, status: "pending", requested_by_user_id: null, requested_at: now }],
        skipDuplicates: true,
      }),
      this.prisma.device_deletion_requests.updateMany({
        where: { device_id: deviceId, status: "pending" },
        data: { approved_by_user_id: approvedByUserId, approved_at: now },
      }),
      this.prisma.agent_software.deleteMany({ where: { agents: { device_id: deviceId } } }),
      // jobs.agent_id has ON DELETE CASCADE; deleting the agent removes canonical jobs automatically.
      this.prisma.agents.deleteMany({ where: { device_id: deviceId } }),
      this.prisma.devices.deleteMany({ where: { id: deviceId } }),
      this.prisma.device_deletion_requests.updateMany({
        where: { device_id: deviceId },
        data: { status: "completed", completed_at: now },
      }),
    ]);

    return { deleted: true, deviceId };
  }

  /**
   * ✅ Works whether caller provides:
   * - agents.id
   * - devices.id
   */
  async listSoftware(
    id: string
  ): Promise<
    Array<{
      id: string;
      name: string;
      version: string;
      publisher?: string | null;
      installDate?: string | null;
      scope: "machine" | "user";
      user: string | null;
      installedBy: string | null;
    }>
  > {
    const agentId = await this.resolveAgentRowId(String(id ?? "").trim());
    if (!agentId) return [];

    // Prisma cannot order by lower(name) or COALESCE(version), and the order must follow the database collation.
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        s.id::text            AS id,
        s.name,
        s.version,
        s.publisher,
        s.install_date        AS install_date,
        s.scope               AS scope,
        s.installed_user      AS installed_user,
        s.installed_by        AS installed_by
      FROM public.agent_software s
      WHERE s.agent_id = ${agentId}::uuid
      ORDER BY lower(s.name) ASC, COALESCE(s.version,'') ASC
    `;

    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      version: r.version ?? "",
      publisher: r.publisher ?? null,
      installDate: r.install_date ?? null,
      scope: r.scope === "user" ? "user" : "machine",
      user: r.installed_user ?? null,
      installedBy: r.installed_by ?? null,
    }));
  }

  /**
   * Moves a device to another site, which may belong to another customer.
   * Accepts a devices.id or an agents.id. Whoever calls this has already been checked for access to both ends.
   *
   * What follows the device: its alerts, tickets, policies and reports all read the site it is in, so they move with
   * it. Its asset record is re-filed under the new customer, and an install token still waiting for it at the old
   * customer is cancelled so nothing can pull it back. The move is written to the device's history.
   */
  async moveToSite(deviceOrAgentId: string, targetSiteId: string): Promise<Device> {
    const rawId = String(deviceOrAgentId ?? "").trim();
    const siteId = String(targetSiteId ?? "").trim();

    if (!rawId) throw new BadRequestException("id is required");
    if (!siteId) throw new BadRequestException("siteId is required");

    const deviceId = await this.resolveDeviceRowId(rawId);
    if (!deviceId) throw new NotFoundException("Device not found");
    if (!isCanonicalUuid(siteId)) throw new NotFoundException("Target site not found");

    const current = await this.prisma.devices.findUnique({
      where: { id: deviceId },
      select: { id: true, hostname: true, site_id: true, sites: { select: { id: true, name: true, client_id: true, clients: { select: { name: true, organization_id: true } } } } },
    });
    if (!current) throw new NotFoundException("Device not found");

    const target = await this.prisma.sites.findUnique({
      where: { id: siteId },
      select: { id: true, name: true, client_id: true, clients: { select: { name: true, organization_id: true } } },
    });
    if (!target) throw new NotFoundException("Target site not found");

    if (current.sites && current.sites.clients.organization_id !== target.clients.organization_id) {
      throw new BadRequestException("A device cannot be moved to a site in another organization.");
    }
    if (current.site_id === siteId) throw new BadRequestException("The device is already at that site.");

    // A site holds one device per host name.
    const clash = await this.prisma.devices.findFirst({ where: { site_id: siteId, hostname: current.hostname, id: { not: deviceId } }, select: { id: true } });
    const clashMessage = `${target.clients.name} / ${target.name} already has a device named ${current.hostname}. Rename one of them first.`;
    if (clash) throw new ConflictException(clashMessage);

    const from = current.sites ? { client: current.sites.clients.name, clientId: current.sites.client_id, site: current.sites.name, siteId: current.sites.id } : null;
    const to = { client: target.clients.name, clientId: target.client_id, site: target.name, siteId: target.id };
    const now = new Date();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.devices.update({ where: { id: deviceId }, data: { site_id: siteId, updated_at: now } });
        if (from?.clientId !== to.clientId) {
          // the asset goes with the device; whoever owns assets does it (the built-in one, or nothing when another system owns them)
          if (this.assets) await this.assets.moveToCustomer(tx, deviceId, to.clientId, now);
          else await tx.assets.updateMany({ where: { device_id: deviceId }, data: { client_id: to.clientId, updated_at: now } });
        }
        // A token made for this device at its old customer must not bring it back.
        await tx.endpoint_enrollments.updateMany({ where: { device_id: deviceId, used_at: null, expires_at: { gt: now } }, data: { expires_at: now, updated_at: now } });
        await tx.device_changes.create({
          data: {
            device_id: deviceId,
            kind: "moved",
            summary: from ? `Moved from ${from.client} / ${from.site} to ${to.client} / ${to.site}` : `Placed at ${to.client} / ${to.site}`,
            before: from as Prisma.InputJsonValue,
            after: to as Prisma.InputJsonValue,
          },
        });
      });
    } catch (e: any) {
      // Another device took the name between the check and the move.
      if (e?.code === "P2002") throw new ConflictException(clashMessage);
      throw e;
    }

    const updated = (await this.getOne(rawId)) || (await this.getOne(deviceId));
    if (!updated) throw new NotFoundException("Device not found after update");
    return updated;
  }

  private async resolveDeviceRowId(deviceOrAgentId: string): Promise<string | null> {
    if (!isCanonicalUuid(deviceOrAgentId)) return null;

    const device = await this.prisma.devices.findUnique({
      where: { id: deviceOrAgentId },
      select: { id: true },
    });
    if (device) return device.id;

    const agent = await this.prisma.agents.findUnique({
      where: { id: deviceOrAgentId },
      select: { device_id: true },
    });
    return agent?.device_id ?? null;
  }

  /**
   * ✅ Resolve agents.id from either:
   * - agents.id
   * - devices.id (agents.device_id)
   */
  private async resolveAgentRowId(deviceOrAgentId: string): Promise<string | null> {
    const raw = String(deviceOrAgentId ?? "").trim();
    if (!isCanonicalUuid(raw)) return null;

    const agent = await this.prisma.agents.findUnique({ where: { id: raw }, select: { id: true } });
    if (agent) return agent.id;

    const byDevice = await this.prisma.agents.findUnique({
      where: { device_id: raw },
      select: { id: true },
    });
    return byDevice?.id ?? null;
  }
}
