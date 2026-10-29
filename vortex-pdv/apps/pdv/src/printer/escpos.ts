/**
 * Construtor de comandos ESC/POS (impressoras térmicas: Epson, Elgin, Bematech, Daruma...).
 * Texto em CP860 (português); QR Code nativo (GS ( k).
 */
const ESC = 0x1b;
const GS = 0x1d;

const CP860: Record<string, number> = {
  Ç: 0x80, ü: 0x81, é: 0x82, â: 0x83, ã: 0x84, à: 0x85, Á: 0x86, ç: 0x87, ê: 0x88, Ê: 0x89, è: 0x8a, Í: 0x8b, Ô: 0x8c, ì: 0x8d, Ã: 0x8e, Â: 0x8f,
  É: 0x90, À: 0x91, È: 0x92, ô: 0x93, õ: 0x94, ò: 0x95, Ú: 0x96, ù: 0x97, Ì: 0x98, Õ: 0x99, Ü: 0x9a, Ù: 0x9d, Ó: 0x9f, á: 0xa0, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ª: 0xa6, º: 0xa7,
};

export function encodeCp860(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out.push(c < 0x80 ? c : CP860[ch] ?? 0x3f);
  }
  return out;
}

export class EscPos {
  private bytes: number[] = [ESC, 0x40, ESC, 0x74, 3];

  align(a: 'left' | 'center' | 'right') {
    this.bytes.push(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
    return this;
  }
  bold(on: boolean) {
    this.bytes.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }
  size(double: boolean) {
    this.bytes.push(GS, 0x21, double ? 0x11 : 0x00);
    return this;
  }
  line(text = '') {
    this.bytes.push(...encodeCp860(text), 0x0a);
    return this;
  }
  qr(data: string) {
    const d = encodeCp860(data);
    const len = d.length + 3;
    this.bytes.push(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00); // modelo 2
    this.bytes.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 0x05); // tamanho do módulo
    this.bytes.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x30); // correção L
    this.bytes.push(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...d);
    this.bytes.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);
    return this;
  }
  feed(n = 3) {
    this.bytes.push(ESC, 0x64, n);
    return this;
  }
  cut() {
    this.bytes.push(GS, 0x56, 0x42, 0x00);
    return this;
  }
  /** Pulso de abertura da gaveta de dinheiro (pino 2) */
  drawer() {
    this.bytes.push(ESC, 0x70, 0x00, 0x19, 0xfa);
    return this;
  }
  build(): Buffer {
    return Buffer.from(this.bytes);
  }
}
