import type { Tx } from '../db/tx.js';
import { decrypt, encrypt } from './crypto.js';

export type SecretKind = 'certificate_a1' | 'certificate_password' | 'mfa_totp' | 'nfce_csc' | 'integration_token' | 'bank_credentials';

/** Cofre de segredos (RN-ORG-04): nada sensível fica em texto no banco ou em disco. */
export class Vault {
  constructor(private readonly masterKey: Buffer) {}

  async put(tx: Tx, kind: SecretKind, name: string, value: Buffer | string, opts: { metadata?: Record<string, unknown>; expiresAt?: Date | null } = {}): Promise<string> {
    const enc = encrypt(this.masterKey, Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'));
    const row = await tx.one<{ id: string }>(
      `INSERT INTO core.secrets (tenant_id, kind, name, ciphertext, iv, auth_tag, metadata, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tx.tenantId, kind, name, enc.ciphertext, enc.iv, enc.tag, JSON.stringify(opts.metadata ?? {}), opts.expiresAt ?? null, tx.userId],
    );
    return row.id;
  }

  async get(tx: Tx, id: string): Promise<Buffer> {
    const row = await tx.one<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
      `SELECT ciphertext, iv, auth_tag FROM core.secrets WHERE id = $1`, [id], 'Segredo');
    return decrypt(this.masterKey, { ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag });
  }

  async getString(tx: Tx, id: string): Promise<string> {
    return (await this.get(tx, id)).toString('utf8');
  }
}
