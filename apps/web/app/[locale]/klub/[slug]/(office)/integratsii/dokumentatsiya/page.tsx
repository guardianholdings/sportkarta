import {
  CLUB_WEBHOOK_EVENTS,
  CLUB_WEBHOOK_EVENT_SCOPE,
  WEBHOOK_TOLERANCE_SECONDS,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { MCP_TOOLS } from '@/lib/clubs/mcp';
import { CLUB_API_PER_MINUTE, CLUB_DOOR_PER_MINUTE } from '@/lib/clubs/rate-limit';
import { siteUrl } from '@/lib/seo';

export const dynamic = 'force-dynamic';

/**
 * The club API's documentation (0057), for whoever builds the club's
 * integration. In the office, behind api.manage, because it is the club's:
 * the base URL, the examples and the MCP address are this deployment's.
 * The prose is translated; the code is code.
 */

const ENDPOINTS: readonly { method: string; path: string; scope: string; key: string }[] = [
  { method: 'GET', path: '/club', scope: '—', key: 'club' },
  { method: 'GET', path: '/members?q=&filter=&page=', scope: 'members:read', key: 'membersList' },
  { method: 'GET', path: '/members/{id}', scope: 'members:read', key: 'membersOne' },
  { method: 'POST', path: '/members', scope: 'members:write', key: 'membersCreate' },
  { method: 'GET', path: '/classes?from=&days=', scope: 'schedule:read', key: 'classes' },
  { method: 'POST', path: '/bookings', scope: 'bookings:write', key: 'book' },
  { method: 'GET', path: '/bookings/{id}', scope: 'attendance:read', key: 'bookingOne' },
  { method: 'DELETE', path: '/bookings/{id}', scope: 'bookings:write', key: 'bookingCancel' },
  { method: 'GET', path: '/checkins?from=&to=', scope: 'attendance:read', key: 'checkins' },
  { method: 'GET', path: '/checkins/{id}', scope: 'attendance:read', key: 'checkinOne' },
  { method: 'POST', path: '/checkins', scope: 'attendance:write', key: 'checkinCreate' },
  { method: 'GET', path: '/payments?from=&to=', scope: 'payments:read', key: 'payments' },
  { method: 'GET', path: '/payments/{id}', scope: 'payments:read', key: 'paymentOne' },
];

const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from 'node:crypto';

// header: the POPS-Signature header; body: the raw request body, unparsed.
function verify(secret, header, body) {
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const wanted = createHmac('sha256', secret).update(\`\${t}.\${body}\`).digest();
  const ok = parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const given = Buffer.from(v, 'hex');
      return given.length === wanted.length && timingSafeEqual(given, wanted);
    });
  return ok && Math.abs(Date.now() / 1000 - t) <= ${String(WEBHOOK_TOLERANCE_SECONDS)};
}`;

export default async function ClubApiDocsPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  await requireClubStaff(slug, 'api.manage');
  const t = await getTranslations('ClubIntegrations.docs');
  const base = `${siteUrl()}/api/clubs/v1`;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const code =
    'overflow-x-auto whitespace-pre rounded-md border border-line bg-surface-2 p-3 font-mono text-caption text-ink';
  const small = 'max-w-prose text-body-sm text-ink-soft';

  const webhookExample = JSON.stringify(
    {
      id: '6f1c…',
      seq: 1042,
      type: 'checkin.created',
      created: '2026-11-02T07:15:03.120Z',
      club_id: '9a2e…',
      data: { object_id: 'c41b…', member_id: '27d0…' },
    },
    null,
    2,
  );

  return (
    <main className="space-y-6">
      <div>
        <Link
          href={`/klub/${slug}/integratsii`}
          className="text-body-sm font-semibold text-link hover:text-link-hover"
        >
          ← {t('back')}
        </Link>
        <h1 className="mt-2 text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className={`mt-1.5 ${small}`}>{t('intro')}</p>
      </div>

      <section className={section} aria-labelledby="basics-h">
        <h2 id="basics-h" className="text-h4 font-bold text-ink">
          {t('basics.title')}
        </h2>
        <p className={small}>{t('basics.auth')}</p>
        <pre className={code}>{`curl ${base}/club \\\n  -H "Authorization: Bearer skbk_…"`}</pre>
        <p className={small}>{t('basics.actsAs')}</p>
        <p className={small}>{t('basics.errors')}</p>
        <pre className={code}>
          {'{ "error": { "code": "insufficient_scope", "message": "…" } }'}
        </pre>
        <p className={small}>{t('basics.limits', { perMinute: CLUB_API_PER_MINUTE })}</p>
        <p className={small}>{t('basics.idempotency')}</p>
        <pre className={code}>
          {`curl -X POST ${base}/members \\\n  -H "Authorization: Bearer skbk_…" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: 3f9d2c1e-…" \\\n  -d '{"display_name":"Maria Petrova","email":"maria@example.org","tags":["morning group"]}'`}
        </pre>
        <p className={small}>{t('basics.shapes')}</p>
      </section>

      <section className={section} aria-labelledby="endpoints-h">
        <h2 id="endpoints-h" className="text-h4 font-bold text-ink">
          {t('endpoints.title')}
        </h2>
        <p className={small}>{t('endpoints.base', { base })}</p>
        <ul className="divide-y divide-line">
          {ENDPOINTS.map((endpoint) => (
            <li key={`${endpoint.method} ${endpoint.path}`} className="space-y-1 py-2">
              <p className="break-all font-mono text-body-sm text-ink">
                <span className="font-bold">{endpoint.method}</span> {endpoint.path}
              </p>
              <p className="text-caption text-ink-soft">
                <code>{endpoint.scope}</code> · {t(`endpoints.${endpoint.key}`)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className={section} aria-labelledby="webhooks-h">
        <h2 id="webhooks-h" className="text-h4 font-bold text-ink">
          {t('webhooks.title')}
        </h2>
        <p className={small}>{t('webhooks.intro')}</p>
        <pre className={code}>{webhookExample}</pre>
        <ul className="space-y-1">
          {CLUB_WEBHOOK_EVENTS.map((event) => (
            <li key={event} className="text-caption text-ink-soft">
              <code className="text-ink">{event}</code> →{' '}
              <code>{CLUB_WEBHOOK_EVENT_SCOPE[event]}</code>
            </li>
          ))}
        </ul>
        <p className={small}>{t('webhooks.headers')}</p>
        <p className={small}>{t('webhooks.signature', { tolerance: WEBHOOK_TOLERANCE_SECONDS })}</p>
        <pre className={code}>{VERIFY_SNIPPET}</pre>
        <p className={small}>{t('webhooks.retries')}</p>
        <p className={small}>{t('webhooks.deleted')}</p>
      </section>

      <section className={section} aria-labelledby="doors-h">
        <h2 id="doors-h" className="text-h4 font-bold text-ink">
          {t('doors.title')}
        </h2>
        <p className={small}>{t('doors.intro', { perMinute: CLUB_DOOR_PER_MINUTE })}</p>
        <pre className={code}>
          {`curl -X POST ${base}/access/check \\\n  -H "Authorization: Bearer skbd_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"credential":"<the text the reader read>"}'\n\n{ "allow": true, "checkin": "recorded", "covered": true,\n  "member": { "name": "Maria Petrova" } }\n\n{ "allow": false, "reason": "not_covered" }`}
        </pre>
        <p className={small}>{t('doors.reasons')}</p>
      </section>

      <section className={section} aria-labelledby="mcp-h">
        <h2 id="mcp-h" className="text-h4 font-bold text-ink">
          {t('mcp.title')}
        </h2>
        <p className={small}>{t('mcp.intro')}</p>
        <pre className={code}>
          {`claude mcp add --transport http pops ${siteUrl()}/api/clubs/mcp \\\n  --header "Authorization: Bearer skbk_…"`}
        </pre>
        <p className={small}>{t('mcp.tools')}</p>
        <ul className="space-y-1">
          {MCP_TOOLS.map((tool) => (
            <li key={tool.name} className="text-caption text-ink-soft">
              <code className="text-ink">{tool.name}</code>
              {tool.scope ? (
                <>
                  {' '}
                  → <code>{tool.scope}</code>
                </>
              ) : null}
              {tool.write ? ` · ${t('mcp.write')}` : ''}
            </li>
          ))}
        </ul>
        <p className={small}>{t('mcp.privacy')}</p>
      </section>
    </main>
  );
}
