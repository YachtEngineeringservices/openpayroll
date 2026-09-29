/**
 * Minimal single-font-family PDF writer (zero dependencies): US Letter pages, Helvetica and
 * Helvetica-Bold (standard 14 fonts, no embedding), text and lines. Content streams are left
 * uncompressed so tests can check the text in the file directly. ASCII text only.
 */

export interface TextOp { x: number; y: number; text: string; size?: number; bold?: boolean; align?: "left" | "right" | "center"; gray?: number }
export interface LineOp { x1: number; y1: number; x2: number; y2: number; width?: number; gray?: number }
export interface Page { texts: TextOp[]; lines: LineOp[] }

export const PAGE_W = 612, PAGE_H = 792;

// Helvetica widths (per 1000 em) for ASCII 32..126 (standard Helvetica metrics). Used only to right-align and center text.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const ascii = (s: string) => s.normalize("NFKD").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7e]/g, "");
export function textWidth(s: string, size: number, bold = false): number {
  const w = bold ? HELV_B : HELV;
  return [...ascii(s)].reduce((a, c) => a + (w[c.charCodeAt(0) - 32] ?? 556), 0) * size / 1000;
}
const esc = (s: string) => ascii(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const n = (v: number) => (Math.round(v * 100) / 100).toString();

function stream(p: Page): string {
  const ops: string[] = [];
  for (const l of p.lines) ops.push(`${n(l.gray ?? 0)} G ${n(l.width ?? 0.5)} w ${n(l.x1)} ${n(l.y1)} m ${n(l.x2)} ${n(l.y2)} l S`);
  for (const t of p.texts) {
    const size = t.size ?? 9;
    const w = textWidth(t.text, size, t.bold);
    const x = t.align === "right" ? t.x - w : t.align === "center" ? t.x - w / 2 : t.x;
    ops.push(`BT ${n(t.gray ?? 0)} g /${t.bold ? "F2" : "F1"} ${n(size)} Tf ${n(x)} ${n(t.y)} Td (${esc(t.text)}) Tj ET`);
  }
  return ops.join("\n");
}

/** Serialize pages to a PDF file (Buffer). `title` goes into the document info. */
export function renderPdf(pages: Page[], title: string, created = new Date()): Buffer {
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const catalog = add(""), pagesId = add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const p of pages) {
    const body = stream(p);
    const c = add(`<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const d = created.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const info = add(`<< /Title (${esc(title)}) /Producer (openpayroll) /CreationDate (D:${d}Z) >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
