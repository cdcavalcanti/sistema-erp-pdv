/** Envio de e-mail (XML/DANFE ao destinatário, régua de cobrança, relatórios agendados). */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer | string; contentType: string }[];
}

export interface Mailer {
  send(msg: MailMessage): Promise<{ id: string }>;
}

/** Implementação de desenvolvimento/teste: guarda as mensagens em memória. Produção: provedor SMTP/API. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.sent.push(msg);
    return { id: `mem-${this.sent.length}` };
  }
}

/** Mensageria de WhatsApp via VORTEX Agents (seção 21): aqui só a interface e a versão em memória. */
export interface Messenger {
  sendWhatsApp(to: string, text: string, link?: string): Promise<{ id: string }>;
}
export class MemoryMessenger implements Messenger {
  readonly sent: { to: string; text: string; link?: string }[] = [];
  async sendWhatsApp(to: string, text: string, link?: string) {
    this.sent.push({ to, text, link });
    return { id: `wa-${this.sent.length}` };
  }
}
