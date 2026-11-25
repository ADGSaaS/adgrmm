// backend/src/billing/billing.util.ts

export type LineInput = { quantity: number; unitPriceCents: number; taxable: boolean };

export type Totals = { subtotalCents: number; taxCents: number; totalCents: number };

/** Half up, on a value already in cents, so a line's amount is always a whole number of cents. */
export function lineAmount(quantity: number, unitPriceCents: number): number {
    // Quantities have at most two decimals. Working in hundredths keeps binary fractions out of it.
    const hundredths = Math.round(quantity * 100);
    return Math.round((hundredths * unitPriceCents) / 100);
}

export function computeTotals(lines: LineInput[], taxRateBps: number): Totals {
    let subtotalCents = 0;
    let taxableCents = 0;
    for (const line of lines) {
        const amount = lineAmount(line.quantity, line.unitPriceCents);
        subtotalCents += amount;
        if (line.taxable) taxableCents += amount;
    }
    // Tax is worked out on the taxable total, as most tax authorities expect, not rounded line by line.
    const taxCents = Math.round((taxableCents * taxRateBps) / 10_000);
    return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** A date with no time, as yyyy-mm-dd, so a contract's billing day never moves with a timezone. */
export function toDateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
}

export function parseDateOnly(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Dates must look like 2026-12-31.");
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || toDateOnly(date) !== value) throw new Error("That date does not exist.");
    return date;
}

/** Keeps the day of the month where it can, so a contract billed on the 31st uses February's last day. */
export function addMonths(date: Date, months: number, anchorDay = date.getUTCDate()): Date {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + months;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay)));
}

export function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 86_400_000);
}

export function formatMoney(cents: number, currency: string): string {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** A leading =, +, - or @ makes a spreadsheet run the cell as a formula. */
export function csvCell(value: unknown): string {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
