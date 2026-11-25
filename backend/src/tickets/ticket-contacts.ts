// The customer's own contacts as the person who asked on a ticket. They are the contact list on the customer record
// (customer_contacts), not the portal accounts (a separate login) and not the mailbox address book (contacts).
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { ClientAccessService } from "../reports/client-access.service";
import { orgOf } from "./ticket-devices";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const oneLine = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

const present = (c: { id: string; client_id: string; name: string; job_title: string | null; email: string | null; phone: string | null; mobile: string | null; role: string; is_primary: boolean }) => ({
    id: c.id,
    clientId: c.client_id,
    name: c.name,
    jobTitle: c.job_title,
    email: c.email,
    phone: c.phone,
    mobile: c.mobile,
    role: c.role,
    isPrimary: c.is_primary,
});

/** The contact is one of this customer's: what a ticket's requester has to be. Returns the contact. */
export async function requireCustomerContact(prisma: Pick<PrismaService, "customer_contacts">, contactId: string, clientId: string | null) {
    if (!isCanonicalUuid(contactId)) throw new BadRequestException("That contact does not exist.");
    const c = await prisma.customer_contacts.findUnique({ where: { id: contactId }, select: { id: true, client_id: true, name: true, email: true } });
    if (!c) throw new BadRequestException("That contact does not exist.");
    if (clientId && c.client_id !== clientId) throw new BadRequestException("That contact belongs to a different customer than the ticket.");
    return c;
}

@Injectable()
export class TicketContactsService {
    constructor(private readonly prisma: PrismaService, private readonly access: ClientAccessService) { }

    /** The customer exists in this organization and, for a person limited to some customers, is one of theirs. */
    private async client(clientId: string, req: any) {
        const orgId = orgOf(req);
        if (!isCanonicalUuid(clientId)) throw new BadRequestException("Choose the customer first.");
        const c = await this.prisma.clients.findFirst({ where: { id: clientId, ...(orgId ? { organization_id: orgId } : {}) }, select: { id: true, name: true } });
        if (!c) throw new NotFoundException("Customer not found");
        const visible = await this.access.visibleClientsFor(req?.user?.id ? String(req.user.id) : null);
        if (visible && !visible.includes(c.id)) throw new NotFoundException("Customer not found");
        return c;
    }

    /** A customer's contacts, the main one first; typing narrows them by name, email or phone. */
    async search(clientId: string, q: unknown, req: any) {
        await this.client(clientId, req);
        const term = oneLine(q).slice(0, 100);
        const rows = await this.prisma.customer_contacts.findMany({
            where: {
                client_id: clientId,
                ...(term
                    ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }, { phone: { contains: term } }, { mobile: { contains: term } }] }
                    : {}),
            },
            orderBy: [{ is_primary: "desc" }, { name: "asc" }],
            take: 50,
        });
        return { items: rows.map(present) };
    }

    /** Adds a contact to the customer record from the ticket form. An email the customer already has is not added twice. */
    async create(body: { clientId?: unknown; name?: unknown; email?: unknown; phone?: unknown; jobTitle?: unknown }, req: any) {
        const clientId = String(body?.clientId ?? "");
        await this.client(clientId, req);
        const name = oneLine(body?.name);
        if (!name) throw new BadRequestException("Give the contact a name.");
        if (name.length > 120) throw new BadRequestException("The name is too long (120 characters at most).");
        const email = oneLine(body?.email).toLowerCase();
        if (email && (!EMAIL.test(email) || email.length > 200)) throw new BadRequestException("That email address does not look right.");
        const phone = oneLine(body?.phone);
        if (phone.length > 40) throw new BadRequestException("The phone number is too long (40 characters at most).");
        const jobTitle = oneLine(body?.jobTitle);
        if (jobTitle.length > 120) throw new BadRequestException("The job title is too long (120 characters at most).");
        if (email) {
            const dup = await this.prisma.customer_contacts.findFirst({ where: { client_id: clientId, email: { equals: email, mode: "insensitive" } }, select: { id: true, name: true } });
            if (dup) throw new ConflictException(`${dup.name} already has that email address at this customer. Choose them from the list.`);
        }
        const count = await this.prisma.customer_contacts.count({ where: { client_id: clientId } });
        if (count >= 50) throw new BadRequestException("A customer can have 50 contacts at most.");
        const made = await this.prisma.customer_contacts.create({
            data: { client_id: clientId, name, email: email || null, phone: phone || null, job_title: jobTitle || null, role: "other", is_primary: count === 0 },
        });
        return present(made);
    }
}
