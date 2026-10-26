import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * SMS abstraction (wave F, 0051) — the mail abstraction's twin
 * (lib/src/email/mailer.ts): one interface, swappable transports, so a call
 * site never knows which gateway is behind it. SERVER ONLY (node:fs); the
 * pure text arithmetic lives in `@sportkarta/lib/sms/text`.
 *
 * FAILS CLOSED like resolveMailTransport: production never gets the file,
 * console or memory transports — an SMS is a message to a real phone, and a
 * production deployment that would silently write them to a disk or a log is
 * worse than one that sends nothing. With no gateway configured production
 * resolves to `disabled`, and the worker does not attempt SMS at all.
 *
 * NO GATEWAY ADAPTER YET, deliberately: which EU gateway carries POPS's
 * traffic is the operator's decision (price, DPA, the «POPS» sender ID — plan,
 * manual step 2). An adapter is one class implementing SmsSender, selected
 * here by SMS_TRANSPORT and configured from SMS_API_KEY / SMS_SENDER_ID.
 */

export { SMS_MAX_PARTS, smsLength, smsParts, toE164 } from './text.js';

export interface SmsMessage {
  /** E.164, e.g. +359888123456. */
  to: string;
  text: string;
}

/**
 * A gateway adapter MUST settle within SMS_SEND_TIMEOUT_MS (abort its
 * request): the send runs inside the claim's transaction, which holds the
 * club's monthly SMS counter row (club_sms_usage, 0051) until it commits, so
 * one hung request would stall every SMS of that club.
 */
export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

export const SMS_SEND_TIMEOUT_MS = 10_000;

/** Thrown on send when no usable transport is configured. */
export class SmsNotConfiguredError extends Error {
  readonly code = 'SMS_NOT_CONFIGURED';
  constructor(reason: string) {
    super(`SMS is not configured: ${reason}`);
    this.name = 'SmsNotConfiguredError';
  }
}

export type SmsTransportKind = 'file' | 'console' | 'memory' | 'disabled';

export interface SmsEnv {
  SMS_TRANSPORT?: string | undefined;
  SMS_OUTBOX_DIR?: string | undefined;
  SMS_API_KEY?: string | undefined;
  SMS_SENDER_ID?: string | undefined;
  NODE_ENV?: string | undefined;
}

export interface SmsTransportChoice {
  kind: SmsTransportKind;
  /** Why the transport is disabled — for server logs only. */
  reason?: string;
}

export function resolveSmsTransport(env: SmsEnv): SmsTransportChoice {
  const production = env.NODE_ENV === 'production';
  const requested = env.SMS_TRANSPORT?.trim().toLowerCase() ?? '';
  if (requested === 'file' || requested === 'console' || requested === 'memory') {
    return production
      ? { kind: 'disabled', reason: `SMS_TRANSPORT=${requested} is refused in production` }
      : { kind: requested };
  }
  if (requested !== '') {
    return { kind: 'disabled', reason: `no SMS gateway adapter for "${requested}"` };
  }
  if (production) return { kind: 'disabled', reason: 'SMS_TRANSPORT is unset' };
  // Local default: a readable outbox, like the mail one.
  return { kind: 'file' };
}

/** Always throws on send. */
export class DisabledSmsSender implements SmsSender {
  constructor(private readonly reason: string) {}

  send(): Promise<void> {
    return Promise.reject(new SmsNotConfiguredError(this.reason));
  }
}

/** For tests. */
export class MemorySmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];

  send(message: SmsMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** Development: each message becomes a JSON file (refused in production). */
export class FileSmsSender implements SmsSender {
  constructor(private readonly dir: string) {}

  async send(message: SmsMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = Math.random().toString(36).slice(2, 8);
    await writeFile(
      path.join(this.dir, `${stamp}-${suffix}.json`),
      JSON.stringify({ sentAt: new Date().toISOString(), ...message }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}

/** Development: stdout (refused in production). */
export class ConsoleSmsSender implements SmsSender {
  send(message: SmsMessage): Promise<void> {
    console.log(`[sms] to=${message.to}\n${message.text}`);
    return Promise.resolve();
  }
}

const DEFAULT_OUTBOX_DIR = './var/sms';

/** Never throws: an unusable configuration yields a sender that rejects. */
export function createSmsSender(env: SmsEnv = process.env): {
  sender: SmsSender;
  kind: SmsTransportKind;
} {
  const choice = resolveSmsTransport(env);
  switch (choice.kind) {
    case 'file':
      return {
        sender: new FileSmsSender(env.SMS_OUTBOX_DIR?.trim() || DEFAULT_OUTBOX_DIR),
        kind: 'file',
      };
    case 'console':
      return { sender: new ConsoleSmsSender(), kind: 'console' };
    case 'memory':
      return { sender: new MemorySmsSender(), kind: 'memory' };
    case 'disabled':
      return {
        sender: new DisabledSmsSender(choice.reason ?? 'no transport'),
        kind: 'disabled',
      };
  }
}
