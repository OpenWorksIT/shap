import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: string | Buffer; contentType: string }[];
  replyTo?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function createMailer(smtpUrl: string, from: string, log: FastifyBaseLogger): Mailer {
  if (!smtpUrl) {
    return {
      async send(mail) {
        // Dev / unconfigured: log the envelope only (bodies can contain personal info).
        log.info({ to: mail.to, subject: mail.subject }, 'email (SMTP not configured, not sent)');
      },
    };
  }
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(mail) {
      try {
        await transport.sendMail({ from, ...mail });
      } catch (err) {
                log.error({ err: (err as Error).message, subject: mail.subject }, 'email send failed');
        throw err;
      }
    },
  };
}
