import { createECDH, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  b64url,
  createPushSender,
  encryptPushPayload,
  fromB64url,
  isPushEndpoint,
  MemoryPushSender,
  parsePushSubscription,
  resolvePushTransport,
  samePath,
  vapidAuthorization,
  vapidKeysFromSecret,
  vapidPublicKey,
  WebPushSender,
} from './index.js';

/** RFC 8291, Appendix A — the worked example. */
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const SECRET = 'a-test-secret-that-is-long-enough-for-hkdf-0123456789';

describe('RFC 8291 content encryption', () => {
  it('reproduces the RFC 8291 example byte for byte', () => {
    const body = encryptPushPayload(
      fromB64url(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: fromB64url(RFC.salt), senderPrivateKey: fromB64url(RFC.asPrivate) },
    );
    expect(b64url(body)).toBe(RFC.body);
    // The header names the sender's key: salt (16), rs = 4096, idlen 65, key.
    expect(body.subarray(16, 20).readUInt32BE()).toBe(4096);
    expect(body[20]).toBe(65);
    expect(b64url(body.subarray(21, 86))).toBe(RFC.asPublic);
  });

  it('uses a fresh key and salt for every message', () => {
    const sub = { p256dh: RFC.uaPublic, auth: RFC.auth };
    const a = encryptPushPayload(Buffer.from('x'), sub);
    const b = encryptPushPayload(Buffer.from('x'), sub);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
  });

  it('refuses malformed keys and an oversized payload', () => {
    expect(() =>
      encryptPushPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: RFC.auth }),
    ).toThrow();
    expect(() =>
      encryptPushPayload(Buffer.alloc(4096), { p256dh: RFC.uaPublic, auth: RFC.auth }),
    ).toThrow(/too large/);
  });
});

describe('VAPID', () => {
  it('derives one stable P-256 key pair from the secret', () => {
    const a = vapidKeysFromSecret(SECRET);
    const b = vapidKeysFromSecret(SECRET);
    expect(a.publicKey).toBe(b.publicKey);
    expect(fromB64url(a.publicKey)).toHaveLength(65);
    expect(vapidKeysFromSecret(`${SECRET}!`).publicKey).not.toBe(a.publicKey);
    expect(() => vapidKeysFromSecret('short')).toThrow();
  });

  it('signs an ES256 token for the endpoint origin that our public key verifies', () => {
    const keys = vapidKeysFromSecret(SECRET);
    const now = new Date('2026-10-26T10:00:00Z');
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      'mailto:ops@pops.bg',
      now,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match as unknown as [string, string, string, string, string];
    expect(k).toBe(keys.publicKey);
    const claims = JSON.parse(fromB64url(c).toString()) as Record<string, unknown>;
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
      sub: 'mailto:ops@pops.bg',
    });
    const point = fromB64url(k);
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64url(point.subarray(1, 33)),
        y: b64url(point.subarray(33)),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        fromB64url(s),
      ),
    ).toBe(true);
  });
});

describe('the endpoint allowlist', () => {
  const ok = [
    'https://fcm.googleapis.com/fcm/send/dXk3:APA91b',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
    'https://web.push.apple.com/QGuQyavXutnMH',
  ];
  const bad = [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evil.example/fcm.googleapis.com/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://fcm.googleapis.com/',
    'https://fcm.googleapis.com/a b',
    'https://user@fcm.googleapis.com/x',
  ];

  it('admits the known push services over https and nothing else', () => {
    for (const url of ok) expect(isPushEndpoint(url), url).toBe(true);
    for (const url of bad) expect(isPushEndpoint(url), url).toBe(false);
  });

  it('agrees with the database CHECK in 0051', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sqlText = readFileSync(
      path.join(here, '..', '..', '..', 'db', 'migrations', '0051_club_messaging.sql'),
      'utf8',
    );
    const found = /"push_subscriptions"\."endpoint" ~ '([^']+)'/.exec(sqlText);
    expect(found).not.toBeNull();
    const sqlPattern = new RegExp((found as RegExpExecArray)[1] as string);
    for (const url of [...ok, ...bad]) {
      expect(sqlPattern.test(url), url).toBe(isPushEndpoint(url));
    }
  });

  it('parses only a well-formed browser subscription', () => {
    const sub = { endpoint: ok[0], keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };
    expect(parsePushSubscription(sub)).toEqual({
      endpoint: ok[0],
      p256dh: RFC.uaPublic,
      auth: RFC.auth,
    });
    expect(parsePushSubscription({ ...sub, endpoint: bad[4] })).toBeNull();
    expect(parsePushSubscription({ ...sub, keys: { p256dh: 'x', auth: RFC.auth } })).toBeNull();
    const offCurve = b64url(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]));
    expect(
      parsePushSubscription({ ...sub, keys: { p256dh: offCurve, auth: RFC.auth } }),
    ).toBeNull();
    expect(parsePushSubscription(null)).toBeNull();
  });
});

describe('the web sender', () => {
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: RFC.uaPublic,
    auth: RFC.auth,
  };
  const payload = { title: 'Зала Сила', body: 'Напомняне', url: '/klub/x/az' };

  function senderAnswering(status: number) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status }));
    }) as unknown as typeof fetch;
    return {
      sender: new WebPushSender(vapidKeysFromSecret(SECRET), 'mailto:o@pops.bg', fetchImpl),
      calls,
    };
  }

  it('posts an encrypted body that never follows a redirect', async () => {
    const { sender, calls } = senderAnswering(201);
    expect(await sender.send(sub, payload)).toBe('sent');
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.redirect).toBe('error');
    expect(init.headers['Content-Encoding']).toBe('aes128gcm');
    expect(init.headers.Authorization).toMatch(/^vapid t=/);
    expect(Buffer.from(init.body as Uint8Array).includes(Buffer.from('Напомняне'))).toBe(false);
  });

  it('reports a gone or refusing device, and throws only what may pass', async () => {
    expect(await senderAnswering(410).sender.send(sub, payload)).toBe('gone');
    expect(await senderAnswering(404).sender.send(sub, payload)).toBe('gone');
    expect(await senderAnswering(403).sender.send(sub, payload)).toBe('rejected');
    expect(await senderAnswering(413).sender.send(sub, payload)).toBe('rejected');
    await expect(senderAnswering(429).sender.send(sub, payload)).rejects.toThrow(/429/);
    await expect(senderAnswering(503).sender.send(sub, payload)).rejects.toThrow(/503/);
  });

  it('rejects a device whose key is not on the curve, without calling the service', async () => {
    const { sender, calls } = senderAnswering(201);
    const offCurve = b64url(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]));
    expect(await sender.send({ ...sub, p256dh: offCurve }, payload)).toBe('rejected');
    expect(calls).toHaveLength(0);
  });

  it('keeps a notification’s link on our own site', () => {
    expect(samePath('/klub/x/az')).toBe('/klub/x/az');
    expect(samePath('/klub/x/az?y=1')).toBe('/klub/x/az?y=1');
    for (const bad of [
      '//evil.example/x',
      '/\\evil.example',
      '/\t/evil.example',
      'https://evil.example/',
      'javascript:alert(1)',
    ]) {
      expect(samePath(bad), bad).toBe('/');
    }
  });

  it('never posts to an endpoint off the allowlist', async () => {
    const { sender, calls } = senderAnswering(201);
    expect(await sender.send({ ...sub, endpoint: 'https://127.0.0.1/x' }, payload)).toBe('gone');
    expect(calls).toHaveLength(0);
  });

  it('encrypts to the device key it is given', async () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const { sender, calls } = senderAnswering(201);
    await sender.send({ ...sub, p256dh: b64url(ua.getPublicKey()) }, payload);
    expect((calls[0]?.init.body as Uint8Array).length).toBeGreaterThan(86 + 16);
  });
});

describe('transport selection fails closed', () => {
  it('never runs a file or memory transport in production', () => {
    for (const PUSH_TRANSPORT of ['file', 'memory']) {
      expect(resolvePushTransport({ NODE_ENV: 'production', PUSH_TRANSPORT }).kind).toBe(
        'disabled',
      );
    }
  });

  it('needs the secret and a contact for web push in production', () => {
    expect(resolvePushTransport({ NODE_ENV: 'production' }).kind).toBe('disabled');
    expect(
      resolvePushTransport({
        NODE_ENV: 'production',
        PUSH_VAPID_SECRET: SECRET,
        NEXT_PUBLIC_SITE_URL: 'https://pops.bg',
      }).kind,
    ).toBe('web');
    expect(vapidPublicKey({ NODE_ENV: 'production' })).toBeNull();
  });

  it('writes an outbox in development', () => {
    expect(resolvePushTransport({}).kind).toBe('file');
    expect(createPushSender({ PUSH_TRANSPORT: 'memory' }).sender).toBeInstanceOf(MemoryPushSender);
    expect(vapidPublicKey({})).not.toBeNull();
  });
});
