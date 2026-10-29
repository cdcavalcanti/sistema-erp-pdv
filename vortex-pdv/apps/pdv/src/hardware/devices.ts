import { Socket } from 'node:net';
import { D } from '@vortex/money';

/**
 * Abstrações de periféricos (seção 57: leitor, impressora, gaveta, balança, display, pinpad
 * e TEF), sem amarrar a aplicação a fabricante. O leitor de código de barras funciona como
 * teclado (a interface recebe o código + Enter); a gaveta abre pelo pulso da impressora; o
 * pinpad é parte do provedor TEF.
 */
export interface ScaleReading {
  weight: string;
  stable: boolean;
}

export interface Scale {
  readonly name: string;
  read(): Promise<ScaleReading>;
  status(): Promise<'ok' | 'offline'>;
}

/**
 * Protocolo Toledo (Prix/P03) e compatíveis: ao pedido ENQ (0x05) a balança responde
 * STX + 5 dígitos do peso em gramas + ETX; 'IIIII' instável, 'SSSSS' sobrecarga, 'NNNNN' negativo.
 */
export function parseToledo(frame: Buffer | string): ScaleReading {
  const s = typeof frame === 'string' ? frame : frame.toString('latin1');
  const m = /\x02([0-9INS]{5})\x03/.exec(s);
  if (!m) throw new Error('Resposta da balança inválida');
  const v = m[1]!;
  if (v === 'IIIII') return { weight: '0', stable: false };
  if (v === 'SSSSS') throw new Error('Balança em sobrecarga');
  if (v === 'NNNNN') throw new Error('Peso negativo na balança: tare novamente');
  return { weight: D(v).dividedBy(1000).toFixed(3), stable: true };
}

/** Balança simulada (desenvolvimento e testes): o peso é colocado pelo teste ou pela tela de status. */
export class SimulatedScale implements Scale {
  readonly name = 'balança simulada';
  weight = '0.000';
  stable = true;
  online = true;
  async read() {
    if (!this.online) throw new Error('Balança desconectada');
    return { weight: this.weight, stable: this.stable };
  }
  async status() {
    return this.online ? 'ok' as const : 'offline' as const;
  }
}

/**
 * Balança Toledo real por TCP: conversor serial-Ethernet da própria balança ou porta serial
 * exposta pelo ser2net no terminal (docs/instalacao.md). Envia ENQ e lê até o ETX.
 */
export class TcpToledoScale implements Scale {
  readonly name = 'balança Toledo (TCP)';
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 2000) {}

  read(): Promise<ScaleReading> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let buf = '';
      const done = (fn: () => void) => { socket.destroy(); fn(); };
      socket.setTimeout(this.timeoutMs, () => done(() => reject(new Error('balança não respondeu'))));
      socket.on('error', (e) => done(() => reject(new Error(`balança inacessível (${e.message})`))));
      socket.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        if (!buf.includes('\x03')) return;
        done(() => { try { resolve(parseToledo(buf)); } catch (e) { reject(e); } });
      });
      socket.connect(this.port, this.host, () => socket.write(Buffer.from([0x05])));
    });
  }

  async status() {
    return this.read().then(() => 'ok' as const, (e: Error) => (/sobrecarga|negativo/.test(e.message) ? 'ok' as const : 'offline' as const));
  }
}

/** Sem balança no terminal: itens pesados entram por etiqueta ou com o peso digitado. */
export class NoScale implements Scale {
  readonly name = 'sem balança';
  async read(): Promise<ScaleReading> {
    throw new Error('não há balança configurada neste terminal; use a etiqueta da balança ou digite o peso');
  }
  async status() {
    return 'ok' as const;
  }
}

/** Display do cliente (2 × 20): mostra item e total. */
export interface CustomerDisplay {
  show(line1: string, line2: string): void;
}

export class MemoryDisplay implements CustomerDisplay {
  lines: [string, string] = ['', ''];
  show(line1: string, line2: string) {
    this.lines = [line1.slice(0, 20).padEnd(20), line2.slice(0, 20).padStart(20)];
  }
}
