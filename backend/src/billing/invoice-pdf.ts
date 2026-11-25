// backend/src/billing/invoice-pdf.ts
import { formatMoney } from "./billing.util";

export type PdfInput = {
    kind: string;
    number: string;
    status: string;
    issueDate: string | null;
    dueDate: string | null;
    currency: string;
    company: { name: string; lines: string[] };
    clientName: string;
    lines: Array<{ description: string; quantity: number; unitPriceCents: number; amountCents: number }>;
    subtotalCents: number;
    taxCents: number;
    taxRateBps: number;
    totalCents: number;
    paidCents: number;
    notes: string | null;
    footer: string | null;
};

const LEFT = 50;
const RIGHT = 545;
const COLUMNS = { description: LEFT, quantity: 340, unit: 400, amount: 475 };
const PAGE_BOTTOM = 730;

export function renderInvoicePdf(input: PdfInput): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const PDFDocument = require("pdfkit");
        const doc = new PDFDocument({ size: "LETTER", margin: 50, info: { Title: `${input.kind} ${input.number}` } });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const money = (cents: number) => formatMoney(cents, input.currency);
        const quote = input.kind === "quote";

        doc.font("Helvetica-Bold").fontSize(20).text(input.company.name || "", LEFT, 50, { width: 300 });
        doc.font("Helvetica").fontSize(9).fillColor("#555555");
        for (const line of input.company.lines) doc.text(line, { width: 300 });

        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(20).text(quote ? "QUOTE" : "INVOICE", 350, 50, { width: RIGHT - 350, align: "right" });
        doc.font("Helvetica").fontSize(10);
        const meta = [`Number: ${input.number}`, input.issueDate ? `Date: ${input.issueDate}` : null, input.dueDate && !quote ? `Due: ${input.dueDate}` : null].filter(Boolean) as string[];
        for (const line of meta) doc.text(line, 350, undefined, { width: RIGHT - 350, align: "right" });

        let y = Math.max(doc.y, 130) + 20;
        doc.font("Helvetica-Bold").fontSize(10).text(quote ? "Prepared for" : "Bill to", LEFT, y);
        doc.font("Helvetica").text(input.clientName, LEFT);
        y = doc.y + 20;

        const header = (top: number) => {
            doc.font("Helvetica-Bold").fontSize(9);
            doc.text("Description", COLUMNS.description, top, { width: 280 });
            doc.text("Qty", COLUMNS.quantity, top, { width: 50, align: "right" });
            doc.text("Price", COLUMNS.unit, top, { width: 65, align: "right" });
            doc.text("Amount", COLUMNS.amount, top, { width: RIGHT - COLUMNS.amount, align: "right" });
            doc.moveTo(LEFT, top + 13).lineTo(RIGHT, top + 13).strokeColor("#999999").stroke();
            doc.font("Helvetica");
            return top + 19;
        };

        y = header(y);
        for (const line of input.lines) {
            const height = doc.heightOfString(line.description, { width: 280 });
            if (y + height > PAGE_BOTTOM) {
                doc.addPage();
                y = header(50);
            }
            doc.fontSize(9);
            doc.text(line.description, COLUMNS.description, y, { width: 280 });
            doc.text(String(line.quantity), COLUMNS.quantity, y, { width: 50, align: "right" });
            doc.text(money(line.unitPriceCents), COLUMNS.unit, y, { width: 65, align: "right" });
            doc.text(money(line.amountCents), COLUMNS.amount, y, { width: RIGHT - COLUMNS.amount, align: "right" });
            y += Math.max(height, 12) + 6;
        }

        if (y + 90 > PAGE_BOTTOM) {
            doc.addPage();
            y = 50;
        }
        doc.moveTo(350, y).lineTo(RIGHT, y).strokeColor("#999999").stroke();
        y += 8;

        const total = (label: string, value: string, bold = false) => {
            doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9);
            doc.text(label, 350, y, { width: 120 });
            doc.text(value, 450, y, { width: RIGHT - 450, align: "right" });
            y += bold ? 18 : 14;
        };
        total("Subtotal", money(input.subtotalCents));
        if (input.taxCents) total(`Tax (${(input.taxRateBps / 100).toFixed(2)}%)`, money(input.taxCents));
        total("Total", money(input.totalCents), true);
        if (input.paidCents) {
            total("Paid", money(input.paidCents));
            total("Balance due", money(input.totalCents - input.paidCents), true);
        }

        y += 12;
        doc.font("Helvetica").fontSize(9).fillColor("#333333");
        if (input.notes) {
            doc.text(input.notes, LEFT, y, { width: RIGHT - LEFT });
            y = doc.y + 8;
        }
        if (input.footer) doc.text(input.footer, LEFT, y, { width: RIGHT - LEFT });

        doc.end();
    });
}
