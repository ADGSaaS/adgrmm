// Links from a device to the tickets screen: a new ticket filled in for the device, and the device's own ticket list.

export type TicketFromDevice = {
    id: string;
    hostname: string;
    alias?: string | null;
    clientId?: string | null;
    client?: string | null;
    site?: string | null;
};

/** The new-ticket form with the customer, the device and the subject "Issue on HOSTNAME" filled in. */
export function newTicketHref(d: TicketFromDevice): string {
    const sp = new URLSearchParams({ new: "1", deviceId: d.id, deviceName: d.alias || d.hostname });
    if (d.clientId) sp.set("clientId", d.clientId);
    if (d.client) sp.set("customerName", d.client);
    if (d.site) sp.set("siteName", d.site);
    return `/tickets?${sp.toString()}`;
}

/** The ticket list narrowed to the tickets that have this device on them. */
export function ticketsForDeviceHref(d: Pick<TicketFromDevice, "id" | "hostname" | "alias">): string {
    return `/tickets?${new URLSearchParams({ deviceId: d.id, deviceName: d.alias || d.hostname }).toString()}`;
}
