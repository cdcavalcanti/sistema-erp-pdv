import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

/** PIN em scrypt, no mesmo formato do ERP (o hash vem na carga do terminal). */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(secret, salt, 32, SCRYPT)).toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(secret, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(expected, actual);
}

/**
 * Cifra de dados sensíveis no banco local (seção 40): chave de API do ERP, documentos de
 * clientes. AES-256-GCM; o texto guardado é iv.tag.cifrado em base64.
 */
export class Sealer {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Chave de cifra local deve ter 32 bytes');
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  }

  open(sealed: string): string {
    const [iv, tag, enc] = sealed.split('.').map((x) => Buffer.from(x, 'base64'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(enc!), d.final()]).toString('utf8');
  }

  /** Hash com chave (busca por CPF sem guardar o CPF em claro). */
  lookupHash(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('hex');
  }
}

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const hmacSha256 = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex');
