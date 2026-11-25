import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { PortalAuthService } from "./portal-auth.service";
import { PortalSettingsService } from "./portal-settings.service";
import { validEmail } from "./portal.util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PortalAccountView = {
    id: string;
    clientId: string;
    clientName: string;
    contactId: string | null;
    email: string;
    name: string;
    role: "user" | "manager";
    status: "invited" | "active" | "disabled";
    lastLoginAt: Date | null;
    createdAt: Date;
};

/** Who may sign in to the portal, managed by the support team from the customer's page. */
@Injectable()
export class PortalAccountsService {
    constructor(private readonly prisma: PrismaService, private readonly auth: PortalAuthService, private readonly settings: PortalSettingsService) { }

    private view(r: any): PortalAccountView {
        return {
            id: r.id, clientId: r.client_id, clientName: r.client_name, contactId: r.contact_id ?? null, email: r.email, name: r.name,
            role: r.role === "manager" ? "manager" : "user", status: r.status, lastLoginAt: r.last_login_at ?? null, createdAt: r.created_at,
        };
    }

    /** `allowed` is the list of customers this staff member is limited to, or null for all of them. */
    async list(allowed: string[] | null, clientId?: string): Promise<PortalAccountView[]> {
        if (clientId && !UUID.test(clientId)) throw new BadRequestException("Not a customer id.");
        if (clientId && allowed && !allowed.includes(clientId)) return [];
        const rows = await this.prisma.$queryRaw<any[]>`
            SELECT a.id::text AS id, a.client_id::text AS client_id, c.name AS client_name, a.contact_id::text AS contact_id, a.email::text AS email, a.name, a.role, a.status, a.last_login_at, a.created_at
              FROM portal_accounts a JOIN clients c ON c.id = a.client_id
             WHERE (${clientId ?? null}::uuid IS NULL OR a.client_id = ${clientId ?? null}::uuid)
               AND (${allowed === null}::boolean OR a.client_id = ANY(${allowed ?? []}::uuid[]))
             ORDER BY lower(c.name), lower(a.name)
             LIMIT 2000`;
        return rows.map((r) => this.view(r));
    }

    private async require(id: string, allowed: string[] | null) {
        if (!UUID.test(id)) throw new NotFoundException("That person was not found.");
        const a = await this.prisma.portal_accounts.findUnique({ where: { id } });
        if (!a || (allowed && !allowed.includes(a.client_id))) throw new NotFoundException("That person was not found.");
        return a;
    }

    async create(
        actorUserId: string | null,
        allowed: string[] | null,
        input: { clientId?: string; contactId?: string | null; email?: unknown; name?: unknown; role?: unknown; sendInvite?: boolean },
        orgId: string,
    ): Promise<{ account: PortalAccountView; invite: { sent: boolean; message?: string } | null }> {
        const clientId = String(input.clientId ?? "");
        if (!UUID.test(clientId)) throw new BadRequestException("Pick a customer.");
        if (allowed && !allowed.includes(clientId)) throw new NotFoundException("Customer not found.");
        const client = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: orgId, archived_at: null }, select: { id: true } });
        if (!client) throw new NotFoundException("Customer not found.");

        const email = validEmail(input.email);
        if (!email) throw new BadRequestException("Enter a valid email address.");
        const name = String(input.name ?? "").trim();
        if (!name) throw new BadRequestException("Enter the person's name.");
        if (name.length > 120) throw new BadRequestException("Keep the name under 120 characters.");
        const role = input.role === "manager" ? "manager" : "user";

        let contactId: string | null = null;
        if (input.contactId) {
            const c = await this.prisma.customer_contacts.findFirst({ where: { id: String(input.contactId), client_id: clientId }, select: { id: true } });
            if (!c) throw new BadRequestException("That contact does not belong to this customer.");
            contactId = c.id;
        }

        const existing = await this.prisma.portal_accounts.findUnique({ where: { email }, select: { client_id: true } });
        if (existing) throw new ConflictException(existing.client_id === clientId ? "This person already has portal access." : "That email already has portal access for another customer.");

        const row = await this.prisma.portal_accounts.create({
            data: { organization_id: orgId, client_id: clientId, contact_id: contactId, email, name, role, status: "invited", created_by: actorUserId },
        });
        const invite = input.sendInvite === false ? null : await this.auth.sendInvite(row.id).catch((e) => ({ sent: false, message: e?.message ?? "Could not send the invitation." }));
        const [full] = await this.list(allowed, clientId).then((l) => l.filter((a) => a.id === row.id));
        return { account: full, invite };
    }

    async update(id: string, allowed: string[] | null, input: { name?: unknown; role?: unknown; status?: unknown }): Promise<PortalAccountView> {
        const a = await this.require(id, allowed);
        const data: Record<string, unknown> = { updated_at: new Date() };
        if (input.name !== undefined) {
            const name = String(input.name ?? "").trim();
            if (!name || name.length > 120) throw new BadRequestException("Enter the person's name (up to 120 characters).");
            data.name = name;
        }
        if (input.role !== undefined) {
            if (input.role !== "user" && input.role !== "manager") throw new BadRequestException("The role is either user or manager.");
            data.role = input.role;
        }
        let revoke = false;
        if (input.status !== undefined) {
            if (input.status === "disabled") {
                data.status = "disabled";
                revoke = true;
            } else if (input.status === "active") {
                // Turning someone back on returns them to what they were: signed up, or still waiting for their invitation.
                data.status = a.password_hash ? "active" : "invited";
            } else {
                throw new BadRequestException("The status is either active or disabled.");
            }
        }
        await this.prisma.portal_accounts.update({ where: { id }, data });
        if (revoke || data.role) await this.auth.revokeAll(id);
        const [full] = await this.list(allowed, a.client_id).then((l) => l.filter((x) => x.id === id));
        return full;
    }

    /** For someone who is waiting or has forgotten: invitation if they never signed up, password reset if they did. */
    async resend(id: string, allowed: string[] | null) {
        const a = await this.require(id, allowed);
        return this.auth.sendInvite(a.id);
    }

    async remove(id: string, allowed: string[] | null) {
        await this.require(id, allowed);
        await this.prisma.portal_accounts.delete({ where: { id } });
        return { ok: true };
    }

    /**
     * Everyone listed on a new customer who has an email address gets portal access as a manager, with an invitation.
     * Does nothing while the portal is off. Never throws: the customer is already saved, and a failed email can be
     * sent again from Portal access.
     */
    async inviteContactsOf(clientId: string, orgId: string, actorUserId: string | null): Promise<{ invited: number; failed: number }> {
        const result = { invited: 0, failed: 0 };
        try {
            if (!(await this.settings.isOn())) return result;
            const contacts = await this.prisma.customer_contacts.findMany({ where: { client_id: clientId, NOT: { email: null } }, select: { id: true, name: true, email: true } });
            for (const c of contacts) {
                const email = validEmail(c.email);
                if (!email) continue;
                if (await this.prisma.portal_accounts.findUnique({ where: { email }, select: { id: true } })) continue;
                try {
                    const row = await this.prisma.portal_accounts.create({
                        data: { organization_id: orgId, client_id: clientId, contact_id: c.id, email, name: (c.name || email).slice(0, 120), role: "manager", status: "invited", created_by: actorUserId },
                    });
                    const sent = await this.auth.sendInvite(row.id).catch(() => ({ sent: false }));
                    if (sent.sent) result.invited++;
                    else result.failed++;
                } catch {
                    result.failed++;
                }
            }
        } catch {
            /* nothing to do: see above */
        }
        return result;
    }

    async enabled() {
        return this.settings.isOn();
    }
}
