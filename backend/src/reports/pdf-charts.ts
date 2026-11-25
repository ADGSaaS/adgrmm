// backend/src/reports/pdf-charts.ts
//
// Charts for the PDF reports, drawn as vector graphics with the PDF library so they stay sharp when printed and add
// almost nothing to the file size. They follow the same rules as the charts on screen: the same kinds, the same
// colours for good and bad words, and the same data (which already follows whatever filter the person chose).

export type PdfChart = { key: string; title: string; kind: "bar" | "donut" | "line"; data: Array<{ label: string; value: number }> };

const PALETTE = ["#6366f1", "#22c55e", "#f59e0b", "#0ea5e9", "#06b6d4", "#a855f7", "#84cc16", "#14b8a6"];
const GREY = "#94a3b8";
/** Bad words are warm colours, each a different one, so several bad results in one chart can still be told apart. */
const WARM = ["#ef4444", "#f97316", "#eab308", "#dc2626", "#fb7185", "#b45309"];
const COOL_GOOD = ["#22c55e", "#16a34a", "#4ade80"];
const GOOD = /^(online|healthy|success|resolved|on|encrypted|protected|compliant|current|supported|ready|probably ready|in warranty|meets target|no findings|met|[AB])$/i;
const BAD = /^(offline|off|needs attention|crit|denied|failed|open|out of date|not encrypted|missing patches|scan overdue|not scanned|scan failed|critical|replace now|out of support|not ready|stale|no agent|never seen|[DF]|expired|full soon|below target|high risk|medium risk|non-compliant|noisy|breached|installed late|missing too long|never resolved)$/i;

/** Quiet words stay grey, good ones green and bad ones red, whatever place in the ranking they come in. */
export function chartColour(label: string, index: number): string {
    if (label === "Other" || label === "(none)" || label === "Not reported") return GREY;
    if (GOOD.test(label)) return COOL_GOOD[index % COOL_GOOD.length];
    if (BAD.test(label)) return WARM[index % WARM.length];
    return PALETTE[index % PALETTE.length];
}

const COLUMNS = 3;
const GAP = 12;
const CELL_HEIGHT = 112;
const MAX_ITEMS = 6;

/** The first few items, with the rest added up as "Other", so a long list fits its box. */
function limited(data: PdfChart["data"]): PdfChart["data"] {
    if (data.length <= MAX_ITEMS) return data;
    const rest = data.slice(MAX_ITEMS - 1).reduce((s, d) => s + d.value, 0);
    return [...data.slice(0, MAX_ITEMS - 1), { label: "Other", value: rest }];
}

const number = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}...` : text);

type Box = { x: number; y: number; w: number; h: number };

function bar(doc: any, chart: PdfChart, box: Box) {
    const data = limited(chart.data);
    const max = Math.max(1, ...data.map((d) => d.value));
    const rowH = Math.min(14, box.h / Math.max(1, data.length));
    const labelW = box.w * 0.38;
    const valueW = 30;
    const barW = box.w - labelW - valueW - 6;
    // As many characters as fit the label column at this size.
    const maxChars = Math.max(6, Math.floor((labelW - 4) / 3.5));
    data.forEach((d, i) => {
        const y = box.y + i * rowH;
        doc.font("Helvetica").fontSize(7).fillColor("#333333").text(clip(d.label, maxChars), box.x, y + 2, { width: labelW - 4, lineBreak: false, ellipsis: true });
        doc.roundedRect(box.x + labelW, y + 2, barW, rowH - 5, 2).fill("#eceff3");
        doc.roundedRect(box.x + labelW, y + 2, Math.max(2, (d.value / max) * barW), rowH - 5, 2).fill(chartColour(d.label, i));
        doc.fillColor("#555555").text(number(d.value), box.x + labelW + barW + 4, y + 2, { width: valueW, lineBreak: false });
    });
}

function donut(doc: any, chart: PdfChart, box: Box) {
    const data = limited(chart.data);
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    const radius = Math.min(box.h, box.w * 0.4) / 2;
    const cx = box.x + radius;
    const cy = box.y + box.h / 2;
    let start = -Math.PI / 2;
    data.forEach((d, i) => {
        const sweep = (d.value / total) * Math.PI * 2;
        if (sweep <= 0) return;
        if (sweep >= Math.PI * 2 - 0.0001) {
            doc.circle(cx, cy, radius).fill(chartColour(d.label, i));
        } else {
            const end = start + sweep;
            const x0 = cx + radius * Math.cos(start);
            const y0 = cy + radius * Math.sin(start);
            const x1 = cx + radius * Math.cos(end);
            const y1 = cy + radius * Math.sin(end);
            doc.path(`M ${cx} ${cy} L ${x0} ${y0} A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x1} ${y1} Z`).fill(chartColour(d.label, i));
            start = end;
        }
    });
    doc.circle(cx, cy, radius * 0.58).fill("#ffffff");
    const legendX = box.x + radius * 2 + 10;
    const rowH = Math.min(14, box.h / Math.max(1, data.length));
    data.forEach((d, i) => {
        const y = box.y + (box.h - data.length * rowH) / 2 + i * rowH;
        doc.rect(legendX, y + 3, 6, 6).fill(chartColour(d.label, i));
        doc.font("Helvetica").fontSize(7).fillColor("#333333").text(`${clip(d.label, 16)}  ${number(d.value)} (${Math.round((d.value / total) * 100)}%)`, legendX + 10, y + 2, { width: box.w - radius * 2 - 22, lineBreak: false, ellipsis: true });
    });
}

function line(doc: any, chart: PdfChart, box: Box) {
    const data = chart.data;
    const max = Math.max(1, ...data.map((d) => d.value));
    const plotH = box.h - 16;
    const stepX = data.length > 1 ? box.w / (data.length - 1) : 0;
    const yFor = (v: number) => box.y + 4 + (1 - v / max) * (plotH - 8);
    // a faint baseline and a line along the top for the busiest day
    doc.moveTo(box.x, box.y + plotH).lineTo(box.x + box.w, box.y + plotH).lineWidth(0.5).strokeColor("#cbd5e1").stroke();
    if (data.length > 1) {
        doc.moveTo(box.x, yFor(data[0].value));
        data.forEach((d, i) => doc.lineTo(box.x + i * stepX, yFor(d.value)));
        doc.lineWidth(1.4).strokeColor("#6366f1").stroke();
    } else if (data.length === 1) {
        doc.circle(box.x + box.w / 2, yFor(data[0].value), 2.5).fill("#6366f1");
    }
    doc.font("Helvetica").fontSize(6.5).fillColor("#555555");
    doc.text(data[0]?.label ?? "", box.x, box.y + plotH + 3, { width: box.w / 3, lineBreak: false });
    doc.text(`busiest day: ${number(max)}`, box.x + box.w / 3, box.y + plotH + 3, { width: box.w / 3, align: "center", lineBreak: false });
    doc.text(data[data.length - 1]?.label ?? "", box.x + (box.w * 2) / 3, box.y + plotH + 3, { width: box.w / 3, align: "right", lineBreak: false });
}

/**
 * Draws a grid of charts from the current position, three to a row, starting a new page when a row will not fit.
 * Charts with nothing in them are left out, as they are on screen. Returns how many were drawn.
 */
export function drawCharts(doc: any, charts: PdfChart[], opts: { margin: number; width: number; bottom: () => number; columns?: number }): number {
    const shown = charts.filter((c) => c.data.length > 0 && c.data.some((d) => d.value > 0));
    if (!shown.length) return 0;
    const columns = opts.columns ?? COLUMNS;
    const cellW = (opts.width - GAP * (columns - 1)) / columns;
    let rowTop = doc.y;
    shown.forEach((chart, i) => {
        const col = i % columns;
        if (col === 0) {
            if (i > 0) rowTop += CELL_HEIGHT + GAP;
            if (rowTop + CELL_HEIGHT > opts.bottom()) {
                doc.addPage();
                rowTop = doc.y;
            }
        }
        const x = opts.margin + col * (cellW + GAP);
        doc.roundedRect(x, rowTop, cellW, CELL_HEIGHT, 4).lineWidth(0.6).strokeColor("#dde1e7").stroke();
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#111111").text(clip(chart.title, 38), x + 8, rowTop + 6, { width: cellW - 16, lineBreak: false, ellipsis: true });
        const box: Box = { x: x + 8, y: rowTop + 22, w: cellW - 16, h: CELL_HEIGHT - 30 };
        if (chart.kind === "donut") donut(doc, chart, box);
        else if (chart.kind === "line") line(doc, chart, box);
        else bar(doc, chart, box);
    });
    // continue below the last row
    doc.x = opts.margin;
    doc.y = rowTop + CELL_HEIGHT + GAP;
    return shown.length;
}
