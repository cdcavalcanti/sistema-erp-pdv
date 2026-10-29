import { D, type Decimal } from '@vortex/money';
import { isValidGTIN } from '@vortex/validators';

/**
 * Leitura de código (seção 9) e etiqueta de balança (seção 12). Etiquetas EAN-13 que começam
 * com o prefixo configurado no ERP (padrão "2") trazem o código do produto (PLU) e o preço
 * total (centavos) ou o peso (gramas) nos dígitos restantes antes do verificador:
 * 2 PPPPP VVVVVV C (PLU de 5 dígitos) ou 2 PPPP VVVVVVV C (PLU de 4 dígitos).
 */
export interface ScaleConfig {
  prefixes: string[];
  pluDigits: 4 | 5 | 6;
  valueKind: 'price' | 'weight';
}

export type ScanResult =
  | { kind: 'scale'; plu: string; price: Decimal | null; weight: Decimal | null; raw: string }
  | { kind: 'code'; code: string };

export function parseScan(input: string, scale: ScaleConfig): ScanResult {
  const code = input.trim();
  if (/^\d{13}$/.test(code) && isValidGTIN(code)) {
    const prefix = scale.prefixes.find((p) => code.startsWith(p));
    if (prefix) {
      const start = prefix.length;
      const plu = code.slice(start, start + scale.pluDigits).replace(/^0+(?=\d)/, '');
      const valueDigits = code.slice(start + scale.pluDigits, 12);
      const value = D(valueDigits);
      // Preço em centavos; peso em gramas
      return scale.valueKind === 'price'
        ? { kind: 'scale', plu, price: value.dividedBy(100), weight: null, raw: code }
        : { kind: 'scale', plu, price: null, weight: value.dividedBy(1000), raw: code };
    }
  }
  return { kind: 'code', code };
}

/** Quantidade digitada antes do produto: "3*789..." ou "0,350*PAO" (pesável). */
export function splitQuantity(input: string): { quantity: string | null; code: string } {
  const m = /^\s*(\d+(?:[.,]\d{1,4})?)\s*[*xX]\s*(.+)$/.exec(input);
  if (!m) return { quantity: null, code: input.trim() };
  return { quantity: m[1]!.replace(',', '.'), code: m[2]!.trim() };
}
