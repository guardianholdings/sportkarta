import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Mailer, MailMessage } from './mailer.js';

/**
 * Local-development / e2e transport: each message becomes a JSON file in an
 * outbox directory. The operator never opens a terminal, so a readable outbox
 * is how a sign-in code gets seen locally, and it is how Playwright reads the
 * OTP without the app exposing any test-only endpoint.
 *
 * Refused in production by resolveMailTransport — these files hold live
 * one-time codes.
 */
export class FileMailer implements Mailer {
  constructor(private readonly dir: string) {}

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Random suffix: two sends inside the same millisecond must not collide.
    const suffix = Math.random().toString(36).slice(2, 8);
    const file = path.join(this.dir, `${stamp}-${suffix}.json`);
    await writeFile(
      file,
      JSON.stringify({ sentAt: new Date().toISOString(), ...message }, null, 2),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
  }
}

/** Dev-only stdout transport. Also refused in production. */
export class ConsoleMailer implements Mailer {
  send(message: MailMessage): Promise<void> {
    console.log(`[mail] to=${message.to} subject=${message.subject}\n${message.text}`);
    return Promise.resolve();
  }
}
