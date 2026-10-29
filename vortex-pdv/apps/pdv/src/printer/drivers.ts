import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Socket } from 'node:net';

/** Driver de impressora (seção 45: Printer Service, sem amarrar a fabricante). */
export type PrinterStatus = 'ok' | 'paper_low' | 'paper_out' | 'offline' | 'error';

export interface PrinterDriver {
  readonly name: string;
  print(data: Buffer, preview: string): Promise<void>;
  status(): Promise<PrinterStatus>;
}

/** Desenvolvimento/homologação: grava cada impressão em arquivo (.bin ESC/POS e .txt legível). */
export class FilePrinter implements PrinterDriver {
  readonly name = 'arquivo';
  readonly printed: string[] = [];
  /** Bytes ESC/POS enviados (conferência de gaveta e QR nos testes) */
  readonly jobs: Buffer[] = [];
  simulated: PrinterStatus = 'ok';
  private n = 0;
  constructor(private readonly dir: string | null) {
    if (dir) mkdirSync(dir, { recursive: true });
  }
  async print(data: Buffer, preview: string) {
    if (this.simulated === 'offline' || this.simulated === 'paper_out' || this.simulated === 'error') throw new Error(`Impressora ${this.simulated === 'paper_out' ? 'sem papel' : 'indisponível'}`);
    this.printed.push(preview);
    this.jobs.push(data);
    if (this.dir) {
      const base = join(this.dir, `${Date.now()}-${++this.n}`);
      writeFileSync(`${base}.bin`, data);
      writeFileSync(`${base}.txt`, preview);
    }
  }
  async status() {
    return this.simulated;
  }
}

/** Impressora térmica em rede (RAW na porta 9100). Status pelo DLE EOT 4 (sensor de papel). */
export class TcpPrinter implements PrinterDriver {
  readonly name = 'rede';
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 5000) {}

  private send(data: Buffer, expectReply: boolean): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const s = new Socket();
      const chunks: Buffer[] = [];
      s.setTimeout(this.timeoutMs);
      s.on('timeout', () => { s.destroy(); expectReply ? resolve(null) : reject(new Error('Impressora não respondeu')); });
      s.on('error', reject);
      s.on('data', (d) => { chunks.push(d); s.end(); });
      s.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
      s.connect(this.port, this.host, () => {
        s.write(data);
        if (!expectReply) s.end();
      });
    });
  }

  async print(data: Buffer) {
    await this.send(data, false);
  }

  async status(): Promise<PrinterStatus> {
    try {
      const r = await this.send(Buffer.from([0x10, 0x04, 0x04]), true);
      if (!r || !r.length) return 'offline';
      const b = r[0]!;
      if (b & 0x60) return 'paper_out';
      if (b & 0x0c) return 'paper_low';
      return 'ok';
    } catch {
      return 'offline';
    }
  }
}

export class NullPrinter implements PrinterDriver {
  readonly name = 'nenhuma';
  async print() {}
  async status(): Promise<PrinterStatus> {
    return 'offline';
  }
}
