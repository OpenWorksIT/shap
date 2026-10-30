import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError } from './errors.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: string | Buffer; contentType: string }[];
  replyTo?: string;
  /** Shown as the sender's name (the trading name); the address is always MAIL_FROM's. */
  fromName?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** Signs in to the mail server without sending anything; null when that works. */
  check?(): Promise<string | null>;
}

/** What went wrong, in words someone setting up a mailbox can act on (never the password). */
export function mailProblem(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e.code === 'EAUTH' || e.responseCode === 535) return 'the mail server refused the username or password in SMTP_URL';
  if (e.code === 'EDNS' || e.code === 'ENOTFOUND') return 'the mail server’s name in SMTP_URL wasn’t found';
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ECONNREFUSED' || e.code === 'ESOCKET')
    return 'couldn’t reach the mail server (check the server name and port in SMTP_URL: 465 with smtps://, 587 with smtp://)';
  if (e.responseCode && e.responseCode >= 500) return `the mail server wouldn’t send it (${(e.message ?? '').replace(/\s+/g, ' ').slice(0, 160)})`;
  return 'the email couldn’t be sent';
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
  // "Company <accounts@x.co.za>" or just the address.
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from.trim();
  return {
    async send({ fromName, ...mail }) {
      try {
        await transport.sendMail({ from: fromName ? { name: fromName, address } : from, ...mail });
      } catch (err) {
        log.error({ err: (err as Error).message, code: (err as { code?: string }).code, subject: mail.subject }, 'email send failed');
        const why = mailProblem(err);
        throw new HttpError(502, `Not sent: ${why}.`, 'email_failed');
      }
    },
    async check() {
      try {
        await transport.verify();
        return null;
      } catch (err) {
        return mailProblem(err);
      }
    },
  };
}
