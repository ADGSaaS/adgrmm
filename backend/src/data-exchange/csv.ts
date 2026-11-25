// backend/src/data-exchange/csv.ts
//
// A small CSV reader (RFC 4180: quoted cells, doubled quotes, line breaks inside quotes, CRLF or LF, a leading
// byte order mark). It stops at a row limit, so a huge file cannot use up the server's memory.
import { BadRequestException } from "@nestjs/common";

export type ParsedCsv = { header: string[]; rows: string[][]; /** The line each row started on, for error messages. */ lines: number[] };

/** "Account Number", "account-number" and "account_number" all name the same column. */
export function normalizeHeader(h: string): string {
    return h.replace(/^﻿/, "").trim().toLowerCase().replace(/[\s\-.]+/g, "_");
}

export function parseCsv(input: string, opts: { maxRows: number; maxColumns?: number }): ParsedCsv {
    const maxColumns = opts.maxColumns ?? 60;
    const text = input.replace(/^﻿/, "");
    const records: string[][] = [];
    const lines: number[] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let line = 1;
    let startLine = 1;
    let i = 0;
    const endRow = () => {
        row.push(cell);
        cell = "";
        // A line with nothing on it is not a record.
        if (!(row.length === 1 && row[0].trim() === "")) {
            if (row.length > maxColumns) throw new BadRequestException(`Line ${startLine} has more than ${maxColumns} columns. Is this a CSV file?`);
            records.push(row);
            lines.push(startLine);
            // One header line plus the data rows.
            if (records.length > opts.maxRows + 1) throw new BadRequestException(`That file has more than ${opts.maxRows} rows. Split it into smaller files.`);
        }
        row = [];
        startLine = line;
    };
    while (i < text.length) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i += 2;
                    continue;
                }
                quoted = false;
                i++;
                continue;
            }
            if (c === "\n") line++;
            cell += c;
            i++;
            continue;
        }
        if (c === '"' && cell === "") {
            quoted = true;
            i++;
        } else if (c === ",") {
            row.push(cell);
            cell = "";
            i++;
        } else if (c === "\r" || c === "\n") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            i++;
            line++;
            endRow();
        } else {
            cell += c;
            i++;
        }
    }
    if (quoted) throw new BadRequestException("A quoted cell is never closed. Check for a missing quote mark.");
    if (cell !== "" || row.length) endRow();
    if (!records.length) throw new BadRequestException("The file is empty.");
    const header = records[0].map(normalizeHeader);
    if (new Set(header.filter(Boolean)).size !== header.filter(Boolean).length) throw new BadRequestException("Two columns have the same name.");
    return { header, rows: records.slice(1), lines: lines.slice(1) };
}

/** Cells that were exported with a leading quote to stop a spreadsheet running them as a formula. */
export function undefuse(cell: string): string {
    return /^'[\s\u0000-\u001f]*[=+\-@]/.test(cell) ? cell.slice(1) : cell;
}
