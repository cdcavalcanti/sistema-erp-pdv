/**
 * BR Code do Pix (padrão EMV® MPM do Banco Central): payload "copia e cola" do QR Code
 * dinâmico, com a URL de cobrança do PSP e CRC16-CCITT no fim.
 */
const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

export function crc16(payload: string): string {
  let crc = 0xffff;
  for (const ch of Buffer.from(payload, 'utf8')) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const clean = (s: string, max: number) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, max);

export function dynamicBrCode(p: { location: string; amount: string; merchantName: string; merchantCity: string }): string {
  const body = [
    field('00', '01'),
    field('01', '12'),
    field('26', field('00', 'br.gov.bcb.pix') + field('25', p.location)),
    field('52', '0000'),
    field('53', '986'),
    field('54', p.amount),
    field('58', 'BR'),
    field('59', clean(p.merchantName, 25)),
    field('60', clean(p.merchantCity, 15)),
    field('62', field('05', '***')),
  ].join('') + '6304';
  return body + crc16(body);
}

export function isValidBrCode(code: string): boolean {
  return code.length > 8 && crc16(code.slice(0, -4)) === code.slice(-4);
}
