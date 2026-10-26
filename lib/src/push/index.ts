import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Web Push (wave F, 0051) without a dependency: VAPID (RFC 8292) to say who
 * is sending, and the aes128gcm content encoding (RFC 8291, RFC 8188) so the
 * push service — Google's, Mozilla's, Microsoft's or Apple's — carries a
 * message it cannot read. node:crypto has every primitive; the encryption is
 * pinned by RFC 8291's own worked example (push.test.ts). SERVER ONLY.
 *
 * THE KEY IS DERIVED, NOT STORED. The VAPID key pair comes from
 * PUSH_VAPID_SECRET by HKDF, so there is no new secret to generate, rotate
 * or lose: deploy.yml derives PUSH_VAPID_SECRET from AUTH_SECRET exactly as
 * it derives CHECKIN_TOKEN_SECRET (a separate key for a separate purpose,
 * never the raw AUTH_SECRET). Changing it orphans every subscription — the
 * browsers bound them to the old public key — so it must not change casually.
 *
 * THE ENDPOINT IS UNTRUSTED. A browser hands it to us and the worker POSTs to
 * it, so only the known push services are accepted (`isPushEndpoint`, the
 * same pattern as 0051's CHECK), the request never follows a redirect, and it
 * times out. A notification carries a title, a line and a same-site path —
 * never a member's name or contact.
 */

// ─── The endpoint allowlist (equal to push_subscriptions_endpoint_known) ───

const PUSH_ENDPOINT =
  /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com)\/[!-~]+$/;

export function isPushEndpoint(value: string): boolean {
  return value.length <= 1000 && PUSH_ENDPOINT.test(value);
}

/** 65-byte uncompressed P-256 point, base64url (87 characters). */
export const P256DH_SHAPE = /^[A-Za-z0-9_-]{87}$/;
/** 16-byte auth secret, base64url (22 characters). */
export const AUTH_SHAPE = /^[A-Za-z0-9_-]{22}$/;

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Whether a base64url string is an uncompressed point ON the P-256 curve —
 * the right length is not enough: an off-curve key passes the shape check
 * and the CHECK, and then fails every encryption to that device.
 */
export function isP256Point(base64url: string): boolean {
  if (!P256DH_SHAPE.test(base64url)) return false;
  const point = Buffer.from(base64url, 'base64url');
  if (point.length !== 65 || point[0] !== 4) return false;
  try {
    createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

/** A browser's subscription, validated, or null. */
export function parsePushSubscription(value: unknown): PushSubscriptionKeys | null {
  if (!value || typeof value !== 'object') return null;
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
  const p256dh = typeof sub.keys?.p256dh === 'string' ? sub.keys.p256dh : '';
  const auth = typeof sub.keys?.auth === 'string' ? sub.keys.auth : '';
  if (!isPushEndpoint(endpoint) || !isP256Point(p256dh) || !AUTH_SHAPE.test(auth)) {
    return null;
  }
  return { endpoint, p256dh, auth };
}

/**
 * A notification's link, as a same-site path — or `/`. Resolved, not
 * prefix-matched: `/\\evil.example` and `/<TAB>/evil.example` start with a
 * slash and still resolve to another origin. The service worker repeats this.
 */
export function samePath(value: string): string {
  const base = 'https://same.invalid';
  try {
    const url = new URL(value, base);
    return url.origin === base && value.startsWith('/') ? `${url.pathname}${url.search}` : '/';
  } catch {
    return '/';
  }
}

// ─── base64url and HKDF ───────────────────────────────────────────────────

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF-Expand for one block (every length here is at most 32). */
function expand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

// ─── VAPID keys from the secret ───────────────────────────────────────────

/** The order of the P-256 group: a private scalar must be in [1, n − 1]. */
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

export interface VapidKeys {
  privateKey: KeyObject;
  /** Uncompressed point, base64url — what PushManager.subscribe() is given. */
  publicKey: string;
}

/** Deterministic: the same secret always yields the same key pair. */
export function vapidKeysFromSecret(secret: string): VapidKeys {
  if (secret.trim().length < 32) throw new Error('PUSH_VAPID_SECRET is too short');
  const prk = hmac(Buffer.from('pops/push-vapid/v1'), Buffer.from(secret));
  for (let counter = 0; counter < 16; counter++) {
    const d = expand(prk, Buffer.from(`p256-${String(counter)}`), 32);
    const scalar = BigInt(`0x${d.toString('hex')}`);
    if (scalar === 0n || scalar >= P256_ORDER) continue;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    const point = ecdh.getPublicKey();
    const privateKey = createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: b64url(d),
        x: b64url(point.subarray(1, 33)),
        y: b64url(point.subarray(33, 65)),
      },
      format: 'jwk',
    });
    return { privateKey, publicKey: b64url(point) };
  }
  throw new Error('could not derive a VAPID key');
}

/**
 * The Authorization header for one push service (RFC 8292): a 12-hour ES256
 * JWT whose audience is the endpoint's origin, and our public key.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now = new Date(),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

// ─── RFC 8291 content encryption ─────────────────────────────────────────

const RECORD_SIZE = 4096;

export interface EncryptOptions {
  /** Test seams: RFC 8291 Appendix A's fixed values. */
  salt?: Uint8Array;
  senderPrivateKey?: Uint8Array;
}

/** One aes128gcm record: header (salt, rs, our public key) and ciphertext. */
export function encryptPushPayload(
  plaintext: Uint8Array,
  subscription: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  options: EncryptOptions = {},
): Buffer {
  const uaPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) {
    throw new Error('push subscription keys are malformed');
  }
  const ecdh = createECDH('prime256v1');
  if (options.senderPrivateKey) ecdh.setPrivateKey(options.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);

  const salt = Buffer.from(options.salt ?? randomBytes(16));
  const prk = hmac(salt, ikm);
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  // One record, so the delimiter is 0x02 (last record), with no padding.
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (padded.length + 16 > RECORD_SIZE) throw new Error('push payload too large');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

// ─── Senders ──────────────────────────────────────────────────────────────

/** What a notification shows. `url` is a same-site path. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Replaces an earlier notification with the same tag on the device. */
  tag?: string;
}

/**
 * `gone`: the subscription no longer exists — delete it. `rejected`: the
 * service or the device's keys refuse this message for good (400, 403, 413,
 * a key that cannot be encrypted to) — count it against the device, but do
 * not retry. A failure that may pass (network, 429, 5xx) is THROWN.
 */
export type PushResult = 'sent' | 'gone' | 'rejected';

export interface PushSender {
  send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<PushResult>;
}

/** A push service refused for a reason that may pass (429, 5xx, timeout). */
export class PushDeliveryError extends Error {
  constructor(readonly status: number | null) {
    super(`push delivery failed${status === null ? '' : ` (${String(status)})`}`);
    this.name = 'PushDeliveryError';
  }
}

export class PushNotConfiguredError extends Error {
  readonly code = 'PUSH_NOT_CONFIGURED';
  constructor(reason: string) {
    super(`Push is not configured: ${reason}`);
    this.name = 'PushNotConfiguredError';
  }
}

function payloadBytes(payload: PushPayload): Buffer {
  const url = samePath(payload.url);
  return Buffer.from(
    JSON.stringify({
      title: payload.title.slice(0, 120),
      body: payload.body.slice(0, 300),
      url,
      ...(payload.tag ? { tag: payload.tag.slice(0, 64) } : {}),
    }),
  );
}

export class WebPushSender implements PushSender {
  constructor(
    private readonly keys: VapidKeys,
    private readonly subject: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<PushResult> {
    // Re-checked here as well as by the CHECK: the worker's own guard.
    if (!isPushEndpoint(subscription.endpoint)) return 'gone';
    let body: Buffer;
    try {
      body = encryptPushPayload(payloadBytes(payload), subscription);
    } catch {
      // The device's stored key cannot be encrypted to: it never will be.
      return 'rejected';
    }
    let response: Response;
    try {
      response = await this.fetchImpl(subscription.endpoint, {
        method: 'POST',
        headers: {
          TTL: String(24 * 3600),
          Urgency: 'normal',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          Authorization: vapidAuthorization(subscription.endpoint, this.keys, this.subject),
        },
        // A plain Uint8Array (not a Buffer): the DOM's BodyInit, in every tsconfig.
        body: new Uint8Array(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PushDeliveryError(null);
    }
    if (response.status === 404 || response.status === 410) return 'gone';
    if (response.status >= 200 && response.status < 300) return 'sent';
    // Throttled or the service is down: may pass, so retried.
    if (response.status === 429 || response.status >= 500) {
      throw new PushDeliveryError(response.status);
    }
    // 400/403/413: this message to this device will not go by retrying.
    return 'rejected';
  }
}

/** For tests. */
export class MemoryPushSender implements PushSender {
  readonly sent: { endpoint: string; payload: PushPayload }[] = [];
  /** Endpoints that answer 410. */
  readonly gone = new Set<string>();
  /** Endpoints that answer 403. */
  readonly rejected = new Set<string>();
  /** Endpoints that answer 503 (thrown). */
  readonly down = new Set<string>();

  send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<PushResult> {
    if (this.gone.has(subscription.endpoint)) return Promise.resolve('gone');
    if (this.rejected.has(subscription.endpoint)) return Promise.resolve('rejected');
    if (this.down.has(subscription.endpoint)) return Promise.reject(new PushDeliveryError(503));
    this.sent.push({ endpoint: subscription.endpoint, payload });
    return Promise.resolve('sent');
  }
}

/**
 * Development: a JSON file per notification. The endpoint is a capability
 * URL, so only its host is written.
 */
export class FilePushSender implements PushSender {
  constructor(private readonly dir: string) {}

  async send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<PushResult> {
    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = Math.random().toString(36).slice(2, 8);
    await writeFile(
      path.join(this.dir, `${stamp}-${suffix}.json`),
      JSON.stringify(
        {
          sentAt: new Date().toISOString(),
          host: new URL(subscription.endpoint).host,
          ...payload,
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    return 'sent';
  }
}

export class DisabledPushSender implements PushSender {
  constructor(private readonly reason: string) {}

  send(): Promise<PushResult> {
    return Promise.reject(new PushNotConfiguredError(this.reason));
  }
}

export type PushTransportKind = 'web' | 'file' | 'memory' | 'disabled';

export interface PushEnv {
  PUSH_TRANSPORT?: string | undefined;
  PUSH_VAPID_SECRET?: string | undefined;
  PUSH_OUTBOX_DIR?: string | undefined;
  NEXT_PUBLIC_SITE_URL?: string | undefined;
  CONTACT_EMAIL?: string | undefined;
  NODE_ENV?: string | undefined;
}

/** A fixed development secret: local keys only, refused in production. */
const DEV_SECRET = 'pops-development-push-vapid-secret-not-for-production';

/** The secret the key pair derives from, or null when there is none. */
export function pushVapidSecret(env: PushEnv): string | null {
  const secret = env.PUSH_VAPID_SECRET?.trim() ?? '';
  if (secret.length >= 32) return secret;
  return env.NODE_ENV === 'production' ? null : DEV_SECRET;
}

/** The VAPID public key a browser subscribes with, or null (push unavailable). */
export function vapidPublicKey(env: PushEnv = process.env): string | null {
  const secret = pushVapidSecret(env);
  return secret ? vapidKeysFromSecret(secret).publicKey : null;
}

/** RFC 8292's `sub`: a contact for the push services' operators. */
export function vapidSubject(env: PushEnv): string | null {
  const contact = env.CONTACT_EMAIL?.trim() ?? '';
  if (/^[^@\s]+@[^@\s]+$/.test(contact)) return `mailto:${contact}`;
  const site = env.NEXT_PUBLIC_SITE_URL?.trim() ?? '';
  return site.startsWith('https://') ? site : null;
}

export function resolvePushTransport(env: PushEnv): { kind: PushTransportKind; reason?: string } {
  const production = env.NODE_ENV === 'production';
  const requested = env.PUSH_TRANSPORT?.trim().toLowerCase() ?? '';
  if (requested === 'file' || requested === 'memory') {
    return production
      ? { kind: 'disabled', reason: `PUSH_TRANSPORT=${requested} is refused in production` }
      : { kind: requested };
  }
  if (requested === 'web' || (requested === '' && production)) {
    if (!pushVapidSecret(env)) return { kind: 'disabled', reason: 'PUSH_VAPID_SECRET is unset' };
    if (!vapidSubject(env)) return { kind: 'disabled', reason: 'no https site URL or contact' };
    return { kind: 'web' };
  }
  if (requested !== '')
    return { kind: 'disabled', reason: `unknown PUSH_TRANSPORT "${requested}"` };
  return { kind: 'file' };
}

const DEFAULT_OUTBOX_DIR = './var/push';

export function createPushSender(env: PushEnv = process.env): {
  sender: PushSender;
  kind: PushTransportKind;
} {
  const choice = resolvePushTransport(env);
  switch (choice.kind) {
    case 'web': {
      const secret = pushVapidSecret(env) as string;
      return {
        sender: new WebPushSender(vapidKeysFromSecret(secret), vapidSubject(env) as string),
        kind: 'web',
      };
    }
    case 'file':
      return {
        sender: new FilePushSender(env.PUSH_OUTBOX_DIR?.trim() || DEFAULT_OUTBOX_DIR),
        kind: 'file',
      };
    case 'memory':
      return { sender: new MemoryPushSender(), kind: 'memory' };
    case 'disabled':
      return {
        sender: new DisabledPushSender(choice.reason ?? 'no transport'),
        kind: 'disabled',
      };
  }
}
