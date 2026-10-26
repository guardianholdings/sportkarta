import { describe, expect, it } from 'vitest';

import { createSmsSender, MemorySmsSender, resolveSmsTransport } from './index.js';
import { smsLength, smsParts, toE164 } from './text.js';

describe('SMS parts', () => {
  it('counts GSM 03.38 text at 160, then 153 per part', () => {
    expect(smsLength('Hello').encoding).toBe('gsm7');
    expect(smsParts('a'.repeat(160))).toBe(1);
    expect(smsParts('a'.repeat(161))).toBe(2);
    expect(smsParts('a'.repeat(306))).toBe(2);
    expect(smsParts('a'.repeat(307))).toBe(3);
  });

  it('counts an extension character as two septets', () => {
    expect(smsLength('€').units).toBe(2);
    expect(smsParts(`${'a'.repeat(159)}€`)).toBe(2);
  });

  it('switches the whole message to UCS-2 for one Cyrillic letter: 70, then 67', () => {
    expect(smsLength('Напомняне').encoding).toBe('ucs2');
    expect(smsParts('я'.repeat(70))).toBe(1);
    expect(smsParts('я'.repeat(71))).toBe(2);
    expect(smsParts('я'.repeat(134))).toBe(2);
    expect(smsParts('я'.repeat(135))).toBe(3);
    expect(smsParts(`${'a'.repeat(100)}я`)).toBe(2);
  });

  it('counts an emoji as two UTF-16 units', () => {
    expect(smsLength('🙂').units).toBe(2);
  });
});

describe('E.164', () => {
  it.each([
    ['0888 123 456', '+359888123456'],
    ['+359 888 123 456', '+359888123456'],
    ['00359888123456', '+359888123456'],
    ['359888123456', '+359888123456'],
    ['(02) 981-23-45', '+35929812345'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%s → %s', (raw, e164) => {
    expect(toE164(raw)).toBe(e164);
  });

  it.each(['888123456', '+359 0888 123 456', '+12', 'abc', '', '+0888123456'])(
    'refuses %s',
    (raw) => {
      expect(toE164(raw)).toBeNull();
    },
  );
});

describe('transport selection fails closed', () => {
  it('never writes SMS to a file, the console or memory in production', () => {
    for (const SMS_TRANSPORT of ['file', 'console', 'memory', '']) {
      expect(resolveSmsTransport({ NODE_ENV: 'production', SMS_TRANSPORT }).kind).toBe('disabled');
    }
  });

  it('refuses a gateway it has no adapter for', () => {
    expect(resolveSmsTransport({ SMS_TRANSPORT: 'acme' }).kind).toBe('disabled');
  });

  it('writes an outbox in development, and rejects on send when disabled', async () => {
    expect(resolveSmsTransport({}).kind).toBe('file');
    expect(createSmsSender({ SMS_TRANSPORT: 'memory' }).sender).toBeInstanceOf(MemorySmsSender);
    const { sender, kind } = createSmsSender({ NODE_ENV: 'production' });
    expect(kind).toBe('disabled');
    await expect(sender.send({ to: '+359888123456', text: 'x' })).rejects.toThrow(/not configured/);
  });
});
