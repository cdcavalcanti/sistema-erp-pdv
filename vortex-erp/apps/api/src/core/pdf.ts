/**
 * Gerador mínimo de PDF (texto, Helvetica, WinAnsi) para documentos simples como o
 * pedido de compra enviado ao fornecedor. Sem dependências: cada página é uma lista
 * de linhas com posição, tamanho e negrito opcional.
 */
export interface PdfLine {
  text: string;
  x?: number;
  size?: number;
  bold?: boolean;
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;

/** Converte para WinAnsi (Latin-1) e escapa os caracteres especiais do PDF. */
function encode(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const b = c < 256 ? c : ch === '—' || ch === '–' ? 45 : ch === '…' ? 46 : 63;
    if (b === 40 || b === 41 || b === 92) out += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return out;
}

export function renderPdf(lines: PdfLine[], title = 'Documento'): Buffer {
  // Pagina pelo espaço vertical
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  for (const l of lines) {
    const size = l.size ?? 10;
    if (y - size * 1.4 < MARGIN) {
      pages.push([]);
      y = PAGE_H - MARGIN;
    }
    y -= size * 1.4;
    pages[pages.length - 1]!.push(`BT /${l.bold ? 'F2' : 'F1'} ${size} Tf ${MARGIN + (l.x ?? 0)} ${y.toFixed(1)} Td (${encode(l.text)}) Tj ET`);
  }
  const objs: string[] = [];
  const add = (body: string) => objs.push(body) && objs.length;
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title (${encode(title)}) /Producer (VORTEX ERP) >>`);
  const kids: number[] = [];
  for (const p of pages) {
    const stream = p.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
