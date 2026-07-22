import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileMailer } from './file.js';
import { createMailer } from './index.js';
import { MailNotConfiguredError, MemoryMailer, resolveMailTransport } from './mailer.js';

const SMTP = {
  SMTP_HOST: 'smtp.example.org',
  SMTP_FROM: 'SportKarta <no-reply@example.org>',
};

describe('resolveMailTransport', () => {
  it('defaults to the file outbox in development and to SMTP once a host is set', () => {
    expect(resolveMailTransport({}).kind).toBe('file');
    expect(resolveMailTransport({ ...SMTP }).kind).toBe('smtp');
  });

  it('fails closed in production rather than sending nowhere silently', () => {
    const choice = resolveMailTransport({ NODE_ENV: 'production' });
    expect(choice.kind).toBe('disabled');
    expect(choice.reason).toMatch(/SMTP_HOST/);
  });

  it('refuses non-delivering transports in production (codes would leak or vanish)', () => {
    for (const transport of ['file', 'console', 'memory']) {
      const choice = resolveMailTransport({ NODE_ENV: 'production', MAIL_TRANSPORT: transport });
      expect(choice.kind).toBe('disabled');
      expect(choice.reason).toMatch(/refused in production/);
    }
  });

  it('disables SMTP when the configuration is incomplete', () => {
    expect(resolveMailTransport({ SMTP_HOST: 'smtp.example.org' }).reason).toMatch(/SMTP_FROM/);
    expect(resolveMailTransport({ ...SMTP, SMTP_PORT: 'submission' }).reason).toMatch(/SMTP_PORT/);
    expect(resolveMailTransport({ MAIL_TRANSPORT: 'carrier-pigeon' }).kind).toBe('disabled');
  });

  it('still allows file transport in development when SMTP is also set', () => {
    expect(resolveMailTransport({ ...SMTP, MAIL_TRANSPORT: 'file' }).kind).toBe('file');
  });
});

describe('createMailer', () => {
  it('never throws on construction — a broken config only fails at send time', async () => {
    const mailer = createMailer({ NODE_ENV: 'production' });
    await expect(
      mailer.send({ to: 'a@example.org', subject: 'x', text: 'y' }),
    ).rejects.toBeInstanceOf(MailNotConfiguredError);
  });

  it('returns a memory transport on request outside production', async () => {
    const mailer = createMailer({ MAIL_TRANSPORT: 'memory' });
    expect(mailer).toBeInstanceOf(MemoryMailer);
    await mailer.send({ to: 'a@example.org', subject: 'x', text: 'y' });
    expect((mailer as MemoryMailer).sent).toHaveLength(1);
  });
});

describe('FileMailer', () => {
  it('writes one owner-only JSON file per message', async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), 'sk-mail-')), 'outbox');
    const mailer = new FileMailer(dir);
    await mailer.send({ to: 'igrach@example.org', subject: 'Код за вход', text: 'код: 123456' });

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const file = path.join(dir, files[0] as string);
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    expect(written.to).toBe('igrach@example.org');
    expect(written.text).toContain('123456');
  });
});
