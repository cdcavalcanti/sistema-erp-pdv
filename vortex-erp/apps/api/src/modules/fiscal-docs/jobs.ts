import { systemContext } from '../../db/tx.js';
import { registerSystemJob, registerTenantJob } from '../../worker/registry.js';
import { fanOut } from '../../worker/runner.js';
import { emit } from '../../core/outbox.js';
import { applyTransmitResult, transmitDocument } from './documents.js';
import { renderDanfeHtml } from './danfe.js';
import { runDistribution } from './inbound.js';

// Reenvio de notas em contingência / pendentes (RN-NFE-07)
registerTenantJob('nota.transmitir', async (tx, p: { documentId: string }, deps, job) =>
  transmitDocument(deps.appPool, { ...systemContext(job.tenant_id!), companyId: null }, deps.services, p.documentId));

// Lote em processamento: consulta o resultado
registerTenantJob('nota.consultar', async (tx, p: { documentId: string }, deps) => {
  const d = await tx.one<{ access_key: string; environment: 1 | 2; status: string }>(`SELECT access_key, environment, status FROM fiscal.documents WHERE id = $1`, [p.documentId]);
  if (d.status !== 'em_processamento') return { skipped: d.status };
  const r = await deps.services.fiscalGateway.query(d.access_key, d.environment);
  if (r.status === 'unavailable') throw new Error('SEFAZ indisponível para consulta');
  return applyTransmitResult(tx, deps.services, p.documentId, r);
});

// RN-NFE-10: XML e DANFE ao destinatário por e-mail e, opcionalmente, WhatsApp; link permanente no portal
registerTenantJob('nota.enviar_destinatario', async (tx, p: { documentId: string; force?: boolean }, deps) => {
  const d = await tx.one<Record<string, any>>(`SELECT * FROM fiscal.documents WHERE id = $1`, [p.documentId]);
  if (d.status !== 'autorizada' || (d.sent_to_recipient_at && !p.force)) return { skipped: true };
  const contact = d.party_id
    ? await tx.maybeOne<{ email: string | null; whatsapp: string | null; preferred_channel: string | null }>(
      `SELECT email, whatsapp, preferred_channel FROM registry.party_contacts WHERE party_id = $1 ORDER BY (email IS NOT NULL) DESC LIMIT 1`, [d.party_id])
    : null;
  const email = d.recipient_email ?? contact?.email ?? null;
  const link = `/public/documents/${d.access_key}?tenant=${d.tenant_id}&t=${d.public_token}`;
  const items = await tx.query(`SELECT * FROM fiscal.document_items WHERE document_id = $1 ORDER BY item_number`, [d.id]);
  const sent: string[] = [];
  if (email) {
    const xml = d.authorized_xml_key ? await deps.services.storage.get(d.authorized_xml_key) : null;
    await deps.services.mailer.send({
      to: email, subject: `NF-e ${d.number} - ${d.issuer_name}`,
      html: `<p>Segue a nota fiscal eletrônica nº ${d.number}, série ${d.series}.</p><p>Chave de acesso: ${d.access_key}</p><p>Consulte a qualquer momento: ${link}</p>`,
      attachments: [
        ...(xml ? [{ filename: `${d.access_key}.xml`, content: xml, contentType: 'application/xml' }] : []),
        { filename: `DANFE-${d.number}.html`, content: renderDanfeHtml(d, items), contentType: 'text/html' },
      ],
    });
    sent.push('email');
  }
  if (contact?.whatsapp && contact.preferred_channel === 'whatsapp') {
    await deps.services.messenger.sendWhatsApp(contact.whatsapp, `Sua NF-e nº ${d.number} foi emitida.`, link);
    sent.push('whatsapp');
  }
  await tx.exec(`UPDATE fiscal.documents SET sent_to_recipient_at = now() WHERE id = $1`, [d.id]);
  await tx.exec(`INSERT INTO fiscal.document_events (tenant_id, document_id, kind, status, payload) VALUES ($1,$2,'email_sent',$3,$4)`, [tx.tenantId, d.id, sent.length ? 'sent' : 'no_contact', JSON.stringify({ channels: sent, link })]);
  return { channels: sent };
});

// Distribuição de DF-e: a cada hora por estabelecimento
registerTenantJob('dfe.distribuicao', async (tx, _p, deps) => {
  const ests = await tx.query<{ id: string }>(`SELECT id FROM core.establishments WHERE status = 'active'`);
  const out: Record<string, unknown> = {};
  for (const e of ests) out[e.id] = await runDistribution(tx, deps.services, e.id);
  return out;
});
registerSystemJob('dfe.distribuicao', async (deps) => ({ tenants: await fanOut(deps, 'dfe.distribuicao', {}, `dfe:${new Date().toISOString().slice(0, 13)}`) }));

// RN-ORG-04: aviso de vencimento do certificado (30, 15 e 5 dias) — alimenta o VORTEX Sentinel
registerTenantJob('certificado.aviso', async (tx, p: { establishmentId: string; days: number; expiresAt: string }) => {
  await emit(tx, 'certificado.vencendo', { type: 'establishment', id: p.establishmentId }, p);
  return { notified: true };
});

// Alertas fiscais diários: numeração a inutilizar até o dia 10, contingência parada
registerTenantJob('fiscal.alertas', async (tx) => {
  const stuck = await tx.query<{ id: string }>(`SELECT id FROM fiscal.documents WHERE status = 'contingencia' AND contingency_at < now() - interval '6 hours'`);
  for (const d of stuck) await emit(tx, 'fiscal.contingencia', { type: 'fiscal_document', id: d.id }, { id: d.id, alerta: 'Contingência há mais de 6 horas' });
  const gaps = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM fiscal.documents WHERE issuer_kind = 'own' AND number IS NOT NULL AND status IN ('rascunho','rejeitada') AND created_at < date_trunc('month', now())`);
  return { stuckContingency: stuck.length, numbersToInutilize: gaps.n };
});
registerSystemJob('fiscal.alertas', async (deps) => ({ tenants: await fanOut(deps, 'fiscal.alertas', {}, `fa:${new Date().toISOString().slice(0, 10)}`) }));
