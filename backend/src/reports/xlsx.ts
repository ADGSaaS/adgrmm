// backend/src/reports/xlsx.ts
//
// A small Excel workbook writer: a sheet per section with a bold, frozen header row, a filter on every column, real
// dates and numbers, and sensible column widths. An .xlsx file is a zip of XML parts, so this writes them directly with
// the zip library the backend already uses, with no spreadsheet package to add.
//
// Text is always written as text (an inline string), so a value that begins with = + - or @ can never run as a
// formula when the file is opened.

export type SheetColumn = { key: string; label: string; type?: "text" | "number" | "percent" | "date" | "status" };
export type SummaryLine = { kind: "title" | "heading" | "pair" | "text" | "blank"; a?: string; b?: string | number };

/** A table sheet (columns and rows) or a summary sheet (free lines). */
export type Sheet = { name: string; columns?: SheetColumn[]; rows?: Array<Record<string, unknown>>; lines?: SummaryLine[] };

const MAX_CELL_CHARS = 32_000;
const MAX_WIDTH = 60;
const MIN_WIDTH = 8;

// Styles, by their position in cellXfs below.
const STYLE_NORMAL = 0;
const STYLE_HEADER = 1;
const STYLE_DATE = 2;
const STYLE_TITLE = 3;
const STYLE_BOLD = 4;

/** Text that is safe inside XML: markup escaped and the control characters XML forbids removed. */
export function xmlText(value: string): string {
    return value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Excel's names for sheets: at most 31 characters, without \ / ? * [ ] :, unique, not empty. */
export function sheetNames(wanted: string[]): string[] {
    const used = new Set<string>();
    return wanted.map((raw) => {
        let name = raw.replace(/[\\/?*[\]:]/g, " ").replace(/^'+|'+$/g, "").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
        let candidate = name;
        for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name.slice(0, 31 - String(n).length - 1)} ${n}`;
        used.add(candidate.toLowerCase());
        return candidate;
    });
}

/** A, B, ... Z, AA ... for a zero-based column. */
export function columnLetter(index: number): string {
    let n = index;
    let out = "";
    do {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
}

/** Excel's own number for a date: days since 1900, with the time as the fraction. */
export function excelDate(value: unknown): number | null {
    const d = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.getTime() / 86_400_000 + 25569;
}

function textCell(ref: string, value: string, style = STYLE_NORMAL): string {
    const text = xmlText(value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) : value);
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${text}</t></is></c>`;
}

function numberCell(ref: string, value: number, style = STYLE_NORMAL): string {
    return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${Number.isInteger(value) ? value : Number(value.toPrecision(15))}</v></c>`;
}

function cell(ref: string, value: unknown, type: SheetColumn["type"]): string {
    if (value === null || value === undefined || value === "") return "";
    if (type === "date") {
        const serial = excelDate(value);
        return serial === null ? textCell(ref, String(value)) : numberCell(ref, serial, STYLE_DATE);
    }
    if (type === "number" || type === "percent") {
        const n = typeof value === "number" ? value : Number(value);
        return Number.isFinite(n) && String(value).trim() !== "" ? numberCell(ref, n) : textCell(ref, String(value));
    }
    if (typeof value === "boolean") return textCell(ref, value ? "Yes" : "No");
    if (value instanceof Date) return textCell(ref, value.toISOString());
    return textCell(ref, String(value));
}

function tableSheet(sheet: Sheet): string {
    const columns = sheet.columns ?? [];
    const rows = sheet.rows ?? [];
    const widths = columns.map((c) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, c.label.length + 3)));
    const body: string[] = [];

    body.push(`<row r="1">${columns.map((c, i) => textCell(`${columnLetter(i)}1`, c.label, STYLE_HEADER)).join("")}</row>`);
    rows.forEach((row, r) => {
        const cells = columns.map((c, i) => {
            const value = row[c.key];
            if (c.type !== "date" && value !== null && value !== undefined) widths[i] = Math.min(MAX_WIDTH, Math.max(widths[i], String(value).length + 2));
            else if (c.type === "date") widths[i] = Math.max(widths[i], 18);
            return cell(`${columnLetter(i)}${r + 2}`, value, c.type);
        });
        body.push(`<row r="${r + 2}">${cells.join("")}</row>`);
    });

    const last = `${columnLetter(Math.max(0, columns.length - 1))}${rows.length + 1}`;
    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>` +
        `<sheetFormatPr defaultRowHeight="15"/>` +
        (columns.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "") +
        `<sheetData>${body.join("")}</sheetData>` +
        (columns.length ? `<autoFilter ref="A1:${last}"/>` : "") +
        `</worksheet>`
    );
}

function summarySheet(sheet: Sheet): string {
    const body: string[] = [];
    let r = 0;
    for (const line of sheet.lines ?? []) {
        r++;
        if (line.kind === "blank") {
            body.push(`<row r="${r}"/>`);
            continue;
        }
        const a = line.a !== undefined ? textCell(`A${r}`, line.a, line.kind === "title" ? STYLE_TITLE : line.kind === "heading" ? STYLE_BOLD : STYLE_NORMAL) : "";
        const b = line.b === undefined ? "" : typeof line.b === "number" ? numberCell(`B${r}`, line.b) : textCell(`B${r}`, line.b);
        body.push(`<row r="${r}">${a}${b}</row>`);
    }
    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<sheetFormatPr defaultRowHeight="15"/>` +
        `<cols><col min="1" max="1" width="42" customWidth="1"/><col min="2" max="2" width="24" customWidth="1"/></cols>` +
        `<sheetData>${body.join("")}</sheetData></worksheet>`
    );
}

const STYLES =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>` +
    `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EBF0"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="5">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

/** Builds the workbook and returns the .xlsx file's bytes. */
export async function buildXlsx(sheets: Sheet[]): Promise<Buffer> {
    if (!sheets.length) throw new Error("A workbook needs at least one sheet.");
    const names = sheetNames(sheets.map((s) => s.name));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const archiver = require("archiver");
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    const finished = new Promise<Buffer>((resolve, reject) => {
        archive.on("data", (c: Buffer) => chunks.push(c));
        archive.on("end", () => resolve(Buffer.concat(chunks)));
        archive.on("error", reject);
    });

    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
    archive.append(
        xml +
            `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
            `<Default Extension="xml" ContentType="application/xml"/>` +
            `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
            `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
            sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
            `</Types>`,
        { name: "[Content_Types].xml" },
    );
    archive.append(
        xml + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        { name: "_rels/.rels" },
    );
    archive.append(
        xml +
            `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
            names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
            `</sheets></workbook>`,
        { name: "xl/workbook.xml" },
    );
    archive.append(
        xml +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
            `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
            `</Relationships>`,
        { name: "xl/_rels/workbook.xml.rels" },
    );
    archive.append(STYLES, { name: "xl/styles.xml" });
    sheets.forEach((sheet, i) => archive.append(sheet.lines ? summarySheet(sheet) : tableSheet(sheet), { name: `xl/worksheets/sheet${i + 1}.xml` }));

    void archive.finalize();
    return finished;
}
