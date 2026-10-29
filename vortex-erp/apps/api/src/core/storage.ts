import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { sha256 } from './crypto.js';

/**
 * Armazenamento de objetos imutável (RN-NFE-08): XML autorizado e protocolo
 * guardados por 5+ anos. Gravação "write once": a mesma chave nunca é sobrescrita.
 * Em produção, implementação S3 com versionamento e Object Lock (modo compliance).
 */
export interface ObjectStorage {
  putImmutable(key: string, content: Buffer | string, contentType: string): Promise<{ key: string; sha256: string }>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

export class LocalImmutableStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    if (clean.includes('..')) throw new Error('Chave de armazenamento inválida');
    return join(this.root, clean);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.path(key), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async putImmutable(key: string, content: Buffer | string, _contentType: string): Promise<{ key: string; sha256: string }> {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hash = sha256(buf);
    const p = this.path(key);
    if (await this.exists(key)) {
      const prev = await readFile(p);
      if (sha256(prev) === hash) return { key, sha256: hash };
      throw new Error(`Objeto imutável já existe com conteúdo diferente: ${key}`);
    }
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, buf, { flag: 'wx', mode: 0o444 });
    return { key, sha256: hash };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
}
