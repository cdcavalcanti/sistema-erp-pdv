import { EscPos } from './escpos.js';
import { receiptLines, receiptText, type ReceiptData } from './receipt.js';
import type { PrinterDriver, PrinterStatus } from './drivers.js';

/** Printer Service: monta o comprovante, imprime, abre a gaveta e informa a situação. */
export class PrinterService {
  constructor(readonly driver: PrinterDriver, private readonly width: () => 32 | 42 | 48) {}

  render(r: ReceiptData): { text: string; escpos: Buffer } {
    const w = this.width();
    const lines = receiptLines(r, w);
    const p = new EscPos();
    for (const l of lines) {
      if ('rule' in l) p.align('left').line('-'.repeat(w));
      else if ('qr' in l) p.align('center').qr(l.qr).line();
      else p.align(l.align ?? 'left').bold(Boolean(l.bold)).size(Boolean(l.double)).line(l.text).size(false).bold(false);
    }
    p.feed(4).cut();
    return { text: receiptText(lines, w), escpos: p.build() };
  }

  async print(r: ReceiptData, opts: { openDrawer?: boolean } = {}): Promise<{ text: string }> {
    const { text, escpos } = this.render(r);
    const data = opts.openDrawer ? Buffer.concat([new EscPos().drawer().build(), escpos]) : escpos;
    await this.driver.print(data, text);
    return { text };
  }

  async printText(title: string, body: string[]): Promise<void> {
    const p = new EscPos().align('center').bold(true).line(title).bold(false).align('left');
    for (const l of body) p.line(l);
    p.feed(4).cut();
    await this.driver.print(p.build(), [title, ...body].join('\n'));
  }

  async openDrawer(): Promise<void> {
    await this.driver.print(new EscPos().drawer().build(), '[gaveta aberta]');
  }

  status(): Promise<PrinterStatus> {
    return this.driver.status();
  }
}
