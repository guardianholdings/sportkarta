import { ConsoleMailer, FileMailer } from './file.js';
import {
  DisabledMailer,
  MemoryMailer,
  resolveMailTransport,
  type MailEnv,
  type Mailer,
} from './mailer.js';
import { SmtpMailer } from './smtp.js';

export * from './mailer.js';
export { brandEmailHtml } from './html.js';
export * from './weekly-digest.js';
export * from './session-mail.js';
export * from './delivery.js';
export * from './moderation-mail.js';
export * from './sign-in-mail.js';
export { POPS_MARK_PNG } from './assets/pops-mark.js';
export { UNBOUNDED_800_WOFF2 } from './assets/unbounded-800.js';
export { FileMailer, ConsoleMailer } from './file.js';
export { DEFAULT_FROM_NAME, formatFrom, SmtpMailer } from './smtp.js';

const DEFAULT_OUTBOX_DIR = './var/mail';

/**
 * Build the mailer for the current environment. Never throws: an unusable
 * configuration yields a DisabledMailer that rejects on send, so a missing SMTP
 * relay degrades sign-in instead of taking the public site down.
 */
export function createMailer(env: MailEnv = process.env): Mailer {
  const choice = resolveMailTransport(env);
  switch (choice.kind) {
    case 'smtp':
      return new SmtpMailer(env);
    case 'file':
      return new FileMailer(env.MAIL_OUTBOX_DIR?.trim() || DEFAULT_OUTBOX_DIR);
    case 'console':
      return new ConsoleMailer();
    case 'memory':
      return new MemoryMailer();
    case 'disabled':
      return new DisabledMailer(choice.reason ?? 'no transport configured');
  }
}
