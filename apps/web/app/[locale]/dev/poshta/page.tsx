import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AutoRefresh } from './auto-refresh';

/**
 * Dev-only outbox viewer. Locally mail uses the file transport
 * (lib/src/email/file.ts): every message — including each one-time sign-in
 * code — lands as a JSON file under var/mail instead of being delivered. The
 * operator works without a terminal, so this page IS the local inbox: request
 * a code on /vhod, read it here, sign in as any test account.
 *
 * Never a production surface: these files hold live one-time codes, which is
 * also why resolveMailTransport refuses the file transport in production. The
 * page 404s outright on a production build, and in production there is no
 * outbox directory to read anyway. Deliberately unlinked from any navigation.
 */

export const dynamic = 'force-dynamic';

const OUTBOX_DIR = (): string => process.env.MAIL_OUTBOX_DIR?.trim() || './var/mail';
const MAX_MESSAGES = 15;

interface OutboxMessage {
  file: string;
  to: string;
  subject: string;
  text: string;
  sentAt: string;
  code: string | null;
}

async function readOutbox(): Promise<OutboxMessage[]> {
  const dir = OUTBOX_DIR();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return []; // no outbox yet — nothing has been sent
  }
  // Filenames are ISO timestamps, so a reverse sort is newest-first.
  files.sort().reverse();

  const messages: OutboxMessage[] = [];
  for (const name of files.slice(0, MAX_MESSAGES)) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as {
        to?: string;
        subject?: string;
        text?: string;
        sentAt?: string;
      };
      const text = raw.text ?? '';
      messages.push({
        file: name,
        to: raw.to ?? '',
        subject: raw.subject ?? '',
        text,
        sentAt: raw.sentAt ?? '',
        code: /\b(\d{6})\b/.exec(text)?.[1] ?? null,
      });
    } catch {
      // A message mid-write or malformed: skip it, the refresh will catch it.
    }
  }
  return messages;
}

export default async function DevMailPage({ params }: { params: Promise<{ locale: string }> }) {
  // A production build must not have this page at all — the outbox holds live
  // one-time codes. Belt to the file transport's own production refusal.
  if (process.env.NODE_ENV === 'production') notFound();

  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('DevMail');
  const messages = await readOutbox();

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <AutoRefresh seconds={4} />
      <header className="space-y-2">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
        <p className="text-caption text-text-muted">{t('refreshHint')}</p>
      </header>

      {messages.length === 0 ? (
        <p className="rounded-card border border-line bg-paper-sunk px-3 py-2 text-body-sm text-ink-soft">
          {t('empty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {messages.map((message) => (
            <li key={message.file} className="rounded-card border border-line p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-md bg-brand-subtle px-3 py-1 font-mono text-h4 font-bold tracking-widest text-brand">
                  {message.code ?? t('noCode')}
                </span>
                <span className="text-body-sm font-medium">{message.to}</span>
                <span className="ml-auto text-caption text-text-muted">
                  {message.sentAt
                    ? new Date(message.sentAt).toLocaleString(locale === 'en' ? 'en-GB' : 'bg-BG', {
                        timeZone: 'Europe/Sofia',
                      })
                    : ''}
                </span>
              </div>
              <p className="mt-1 text-body-sm text-ink-soft">{message.subject}</p>
              <details className="mt-2 text-caption text-text-muted">
                <summary className="cursor-pointer">{t('fullMessage')}</summary>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-paper-sunk p-2">
                  {message.text}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
