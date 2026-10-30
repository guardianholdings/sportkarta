import {
  CLUB_API_SCOPES,
  CLUB_WEBHOOK_EVENTS,
  DOOR_ACCESS_RULES,
  clubHasFeature,
  lowestTierWith,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { SecretOnceForm } from '@/components/clubs/secret-once-form';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { listClubApiKeys } from '@/lib/clubs/api-keys';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { listDoorDevices } from '@/lib/clubs/doors';
import { clubSwitchOn, featureOn } from '@/lib/clubs/features';
import { clubLocations } from '@/lib/clubs/settings';
import {
  listWebhookDeliveries,
  listWebhookEndpoints,
  webhookMasterSecret,
} from '@/lib/clubs/webhooks';
import { formatDateTime } from '@/lib/format';
import { siteUrl } from '@/lib/seo';

import {
  addWebhookAction,
  createDoorAction,
  issueKeyAction,
  revokeDoorAction,
  revokeKeyAction,
  rotateWebhookAction,
  webhookStateAction,
} from './actions';

export const dynamic = 'force-dynamic';

/** next-intl reads '.' as nesting: a scope or an event name becomes a flat key. */
function flat(name: string): string {
  return name.replace(/[.:]/g, '_');
}

const OUTCOME_CODES = [
  'keyRevoked',
  'webhookDisabled',
  'webhookEnabled',
  'webhookRemoved',
  'doorRevoked',
] as const;

const ERROR_CODES = [
  'feature_off',
  'name_invalid',
  'scopes_none',
  'too_many_keys',
  'not_allowed',
  'not_configured',
  'url_invalid',
  'url_not_https',
  'url_credentials',
  'url_port',
  'url_host',
  'events_none',
  'too_many_endpoints',
  'location_invalid',
  'rule_invalid',
  'invalid',
] as const;

/**
 * «Интеграции» (0057): the club's API keys, its webhooks, its door
 * controllers and how to connect its own AI assistant. Management only
 * (api.manage); the Pro tier, and only once the operator has switched the
 * API on (CLUB_API_ENABLED).
 */
export default async function ClubIntegrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'api.manage');
  const [t, tClub] = await Promise.all([
    getTranslations('ClubIntegrations'),
    getTranslations('Club'),
  ]);
  const { rezultat } = await searchParams;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const small = 'text-caption text-ink-soft';
  const quiet = 'min-h-11 text-body-sm font-semibold text-link hover:text-link-hover';
  const box = 'rounded-card border border-line p-3';
  const summary = 'min-h-11 cursor-pointer text-body-sm font-semibold text-ink';

  if (!clubHasFeature(club.tier, 'api') || !clubSwitchOn('api')) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">
          {clubSwitchOn('api')
            ? t('upsell', { tier: tClub(`tier.${lowestTierWith('api')}`) })
            : t('notEnabled')}
        </p>
      </main>
    );
  }

  const webhooksOn = featureOn(club, 'webhooks');
  const webhooksReady = webhooksOn && webhookMasterSecret() !== null;
  const doorsOn = featureOn(club, 'door_access');
  const mcpOn = featureOn(club, 'mcp');
  const [keys, endpoints, doors, locations] = await Promise.all([
    listClubApiKeys(actor),
    webhooksOn ? listWebhookEndpoints(actor) : Promise.resolve([]),
    doorsOn ? listDoorDevices(actor) : Promise.resolve([]),
    doorsOn ? clubLocations(actor) : Promise.resolve([]),
  ]);
  const logs = await Promise.all(
    endpoints.map((endpoint) => listWebhookDeliveries(actor, endpoint.id, 15)),
  );
  const errors: Record<string, string> = Object.fromEntries(
    ERROR_CODES.map((code) => [code, t(`errors.${code}`)]),
  );
  const secretStrings = (prefix: 'keys' | 'webhooks' | 'doors' | 'rotate') => ({
    created: t(`${prefix}.created`),
    copyHint: t(`${prefix}.copyHint`),
    errors,
  });
  const when = (iso: string | null) => (iso ? formatDateTime(iso, locale) : t('never'));
  const hidden = <input type="hidden" name="slug" value={slug} />;
  // A closed list: the query string is never used to index a catalogue.
  const succeeded =
    rezultat !== undefined && (OUTCOME_CODES as readonly string[]).includes(rezultat);

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
        <p className="mt-2">
          <Link
            href={`/klub/${slug}/integratsii/dokumentatsiya`}
            className="text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {t('docsLink')} →
          </Link>
        </p>
      </div>

      {rezultat && (
        <p
          role="status"
          className={
            succeeded
              ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
              : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
          }
        >
          {succeeded
            ? t(`outcome.${rezultat}`)
            : Object.hasOwn(errors, rezultat)
              ? errors[rezultat]
              : errors.invalid}
        </p>
      )}

      {/* ─── API keys ─────────────────────────────────────────────────── */}
      <section className={section} aria-labelledby="keys-h">
        <h2 id="keys-h" className="text-h4 font-bold text-ink">
          {t('keys.title')}
        </h2>
        <p className={`max-w-prose ${small}`}>{t('keys.intro')}</p>
        {keys.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('keys.empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {keys.map((key) => (
              <li key={key.id} className="space-y-1 py-3">
                <p id={`key-${key.id}`} className="text-body font-semibold text-ink">
                  {key.name}{' '}
                  <span className="font-mono text-caption text-ink-soft">{key.prefix}…</span>
                </p>
                <p className={small}>
                  {key.scopes.map((scope) => t(`keys.scope.${flat(scope)}`)).join(' · ')}
                </p>
                <p className={small}>
                  {key.creatorActive
                    ? t('keys.createdBy', { name: key.creatorName ?? tClub('formerUser') })
                    : t('keys.creatorGone')}
                  {' · '}
                  {t('keys.lastUsed', { when: when(key.lastUsedAt) })}
                </p>
                <form action={revokeKeyAction}>
                  {hidden}
                  <input type="hidden" name="keyId" value={key.id} />
                  <ConfirmButton
                    message={t('keys.revokeConfirm')}
                    className={quiet}
                    aria-describedby={`key-${key.id}`}
                  >
                    {t('keys.revoke')}
                  </ConfirmButton>
                </form>
              </li>
            ))}
          </ul>
        )}
        <details className={box}>
          <summary className={summary}>{t('keys.new')}</summary>
          <div className="mt-3">
            <SecretOnceForm
              action={issueKeyAction}
              submit={t('keys.create')}
              strings={secretStrings('keys')}
            >
              {hidden}
              <div className="space-y-1">
                <label className={field} htmlFor="key-name">
                  {t('keys.name')}
                </label>
                <Input id="key-name" name="name" maxLength={60} required />
                <p className={small}>{t('keys.nameHint')}</p>
              </div>
              <fieldset className="space-y-1">
                <legend className={field}>{t('keys.scopes')}</legend>
                {CLUB_API_SCOPES.map((scope) => (
                  <label key={scope} className="flex min-h-11 items-center gap-2 text-body-sm">
                    <input type="checkbox" name="scope" value={scope} className="size-5" />
                    <span>
                      {t(`keys.scope.${flat(scope)}`)}{' '}
                      <code className="text-caption text-ink-soft">{scope}</code>
                    </span>
                  </label>
                ))}
                <p className={small}>{t('keys.scopesHint')}</p>
              </fieldset>
            </SecretOnceForm>
          </div>
        </details>
      </section>

      {/* ─── Webhooks ─────────────────────────────────────────────────── */}
      {webhooksOn && (
        <section className={section} aria-labelledby="webhooks-h">
          <h2 id="webhooks-h" className="text-h4 font-bold text-ink">
            {t('webhooks.title')}
          </h2>
          <p className={`max-w-prose ${small}`}>{t('webhooks.intro')}</p>
          {!webhooksReady && (
            <p className="text-body-sm text-warning">{t('errors.not_configured')}</p>
          )}
          {endpoints.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('webhooks.empty')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {endpoints.map((endpoint, index) => (
                <li key={endpoint.id} className="space-y-2 py-3">
                  <p
                    id={`hook-${endpoint.id}`}
                    className="break-all font-mono text-body-sm text-ink"
                  >
                    {endpoint.url}
                  </p>
                  {endpoint.description && <p className={small}>{endpoint.description}</p>}
                  <p className={endpoint.creatorActive ? small : 'text-caption text-warning'}>
                    {endpoint.creatorActive
                      ? t('webhooks.createdBy', {
                          name: endpoint.creatorName ?? tClub('formerUser'),
                        })
                      : t('webhooks.creatorGone')}
                  </p>
                  <p className={small}>
                    {t(`webhooks.state.${endpoint.disabled ?? 'live'}`)}
                    {endpoint.failingSince && !endpoint.disabled
                      ? ` · ${t('webhooks.failingSince', { when: when(endpoint.failingSince) })}`
                      : ''}
                    {' · '}
                    {t('webhooks.lastSuccess', { when: when(endpoint.lastSuccessAt) })}
                    {' · '}
                    {t('webhooks.counts', {
                      pending: endpoint.pending,
                      failed: endpoint.failedLastWeek,
                    })}
                  </p>
                  <p className={small}>
                    {endpoint.events.map((event) => t(`webhooks.event.${flat(event)}`)).join(' · ')}
                  </p>
                  <div className="flex flex-wrap gap-x-4">
                    <form action={webhookStateAction}>
                      {hidden}
                      <input type="hidden" name="endpointId" value={endpoint.id} />
                      <input
                        type="hidden"
                        name="op"
                        value={endpoint.disabled ? 'enable' : 'disable'}
                      />
                      <button
                        type="submit"
                        className={quiet}
                        aria-describedby={`hook-${endpoint.id}`}
                      >
                        {endpoint.disabled ? t('webhooks.enable') : t('webhooks.disable')}
                      </button>
                    </form>
                    <form action={webhookStateAction}>
                      {hidden}
                      <input type="hidden" name="endpointId" value={endpoint.id} />
                      <input type="hidden" name="op" value="remove" />
                      <ConfirmButton
                        message={t('webhooks.removeConfirm')}
                        className={quiet}
                        aria-describedby={`hook-${endpoint.id}`}
                      >
                        {t('webhooks.remove')}
                      </ConfirmButton>
                    </form>
                  </div>
                  {webhooksReady && (
                    <details className={box}>
                      <summary className={summary} aria-describedby={`hook-${endpoint.id}`}>
                        {t('webhooks.rotate')}
                      </summary>
                      <div className="mt-2">
                        <SecretOnceForm
                          action={rotateWebhookAction}
                          submit={t('webhooks.rotateSubmit')}
                          strings={secretStrings('rotate')}
                        >
                          {hidden}
                          <input type="hidden" name="endpointId" value={endpoint.id} />
                          <p className={small}>{t('webhooks.rotateHint')}</p>
                          <label className="flex min-h-11 items-center gap-2 text-body-sm">
                            <input type="checkbox" name="expireNow" value="1" className="size-5" />
                            <span>{t('webhooks.expireNow')}</span>
                          </label>
                        </SecretOnceForm>
                      </div>
                    </details>
                  )}
                  <details className={box}>
                    <summary className={summary} aria-describedby={`hook-${endpoint.id}`}>
                      {t('webhooks.log')}
                    </summary>
                    {(logs[index] ?? []).length === 0 ? (
                      <p className="mt-2 text-body-sm text-text-muted">{t('webhooks.logEmpty')}</p>
                    ) : (
                      <ul className="mt-2 space-y-1">
                        {(logs[index] ?? []).map((delivery) => (
                          <li key={delivery.id} className="text-caption text-ink">
                            {formatDateTime(delivery.occurredAt, locale)} ·{' '}
                            {t(`webhooks.event.${flat(delivery.event)}`)} ·{' '}
                            {t(`webhooks.delivery.${delivery.state}`)}
                            {delivery.attempts > 0
                              ? ` · ${t('webhooks.attempts', { count: delivery.attempts })}`
                              : ''}
                            {delivery.lastStatus !== null
                              ? ` · HTTP ${String(delivery.lastStatus)}`
                              : ''}
                            {delivery.lastError
                              ? ` · ${t(`webhooks.error.${delivery.lastError}`)}`
                              : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          )}
          {webhooksReady && (
            <details className={box}>
              <summary className={summary}>{t('webhooks.new')}</summary>
              <div className="mt-3">
                <SecretOnceForm
                  action={addWebhookAction}
                  submit={t('webhooks.add')}
                  strings={secretStrings('webhooks')}
                >
                  {hidden}
                  <div className="space-y-1">
                    <label className={field} htmlFor="hook-url">
                      {t('webhooks.url')}
                    </label>
                    <Input
                      id="hook-url"
                      name="url"
                      type="url"
                      inputMode="url"
                      placeholder="https://"
                      maxLength={500}
                      required
                    />
                    <p className={small}>{t('webhooks.urlHint')}</p>
                  </div>
                  <div className="space-y-1">
                    <label className={field} htmlFor="hook-description">
                      {t('webhooks.description')}
                    </label>
                    <Input id="hook-description" name="description" maxLength={60} />
                  </div>
                  <fieldset className="space-y-1">
                    <legend className={field}>{t('webhooks.events')}</legend>
                    {CLUB_WEBHOOK_EVENTS.map((event) => (
                      <label key={event} className="flex min-h-11 items-center gap-2 text-body-sm">
                        <input type="checkbox" name="event" value={event} className="size-5" />
                        <span>
                          {t(`webhooks.event.${flat(event)}`)}{' '}
                          <code className="text-caption text-ink-soft">{event}</code>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </SecretOnceForm>
              </div>
            </details>
          )}
        </section>
      )}

      {/* ─── Doors ────────────────────────────────────────────────────── */}
      {doorsOn && (
        <section className={section} aria-labelledby="doors-h">
          <h2 id="doors-h" className="text-h4 font-bold text-ink">
            {t('doors.title')}
          </h2>
          <p className={`max-w-prose ${small}`}>{t('doors.intro')}</p>
          {doors.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('doors.empty')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {doors.map((door) => (
                <li key={door.id} className="space-y-1 py-3">
                  <p id={`door-${door.id}`} className="text-body font-semibold text-ink">
                    {door.name}
                  </p>
                  <p className={small}>
                    {door.locationName} · {t(`doors.rules.${door.rule}`)} ·{' '}
                    {t('doors.lastSeen', { when: when(door.lastSeenAt) })}
                  </p>
                  <form action={revokeDoorAction}>
                    {hidden}
                    <input type="hidden" name="deviceId" value={door.id} />
                    <ConfirmButton
                      message={t('doors.revokeConfirm')}
                      className={quiet}
                      aria-describedby={`door-${door.id}`}
                    >
                      {t('doors.revoke')}
                    </ConfirmButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
          {locations.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('doors.noLocations')}</p>
          ) : (
            <details className={box}>
              <summary className={summary}>{t('doors.new')}</summary>
              <div className="mt-3">
                <SecretOnceForm
                  action={createDoorAction}
                  submit={t('doors.create')}
                  strings={secretStrings('doors')}
                >
                  {hidden}
                  <div className="space-y-1">
                    <label className={field} htmlFor="door-name">
                      {t('doors.name')}
                    </label>
                    <Input id="door-name" name="name" maxLength={60} required />
                  </div>
                  <div className="space-y-1">
                    <label className={field} htmlFor="door-location">
                      {t('doors.location')}
                    </label>
                    <Select id="door-location" name="locationId" required>
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <fieldset className="space-y-1">
                    <legend className={field}>{t('doors.rule')}</legend>
                    {DOOR_ACCESS_RULES.map((rule) => (
                      <label key={rule} className="flex min-h-11 items-start gap-2 text-body-sm">
                        <input
                          type="radio"
                          name="rule"
                          value={rule}
                          defaultChecked={rule === 'covered'}
                          className="mt-1 size-5"
                        />
                        <span>
                          <span className="font-semibold">{t(`doors.rules.${rule}`)}</span>
                          <span className={`block ${small}`}>{t(`doors.ruleHint.${rule}`)}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </SecretOnceForm>
              </div>
            </details>
          )}
        </section>
      )}

      {/* ─── The club's own AI assistant ─────────────────────────────── */}
      {mcpOn && (
        <section className={section} aria-labelledby="mcp-h">
          <h2 id="mcp-h" className="text-h4 font-bold text-ink">
            {t('mcp.title')}
          </h2>
          <p className={`max-w-prose ${small}`}>{t('mcp.intro')}</p>
          <p className="text-body-sm text-ink">{t('mcp.endpoint')}</p>
          <p className="break-all rounded-md border border-line bg-surface-2 p-2 font-mono text-caption">
            {`${siteUrl()}/api/clubs/mcp`}
          </p>
          <p className={`max-w-prose ${small}`}>{t('mcp.howTo')}</p>
          <p className="max-w-prose rounded-card border border-warning-border bg-warning-bg p-3 text-body-sm text-ink">
            {t('mcp.privacy')}
          </p>
        </section>
      )}
    </main>
  );
}
