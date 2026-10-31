import {
  AUDIENCE_FILTERS,
  AUDIENCE_SEGMENTS,
  BROADCAST_BODY_MAX,
  BROADCAST_SUBJECT_MAX,
  SMS_BODY_MAX,
  type MessageChannel,
} from '@sportkarta/lib/clubs';
import { getTranslations } from 'next-intl/server';

import { SmsTextarea } from '@/components/clubs/sms-textarea';
import { Button } from '@/components/ui/button';
import { chipClass } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { audienceValue } from '@/lib/clubs/input';
import type { ClubBroadcast } from '@/lib/clubs/messages';

import { saveBroadcastAction } from './actions';

/** The three views of «Съобщения»: messages, automatic ones, SMS settings. */
export async function MessagesTabs({
  slug,
  current,
  show,
}: {
  slug: string;
  current: 'list' | 'auto' | 'sms';
  show: { auto: boolean; sms: boolean };
}) {
  const t = await getTranslations('ClubMessages');
  const tabs = [
    { key: 'list', href: `/klub/${slug}/saobshteniya`, label: t('tabs.list') },
    ...(show.auto
      ? [{ key: 'auto', href: `/klub/${slug}/saobshteniya/avtomatichni`, label: t('tabs.auto') }]
      : []),
    ...(show.sms
      ? [{ key: 'sms', href: `/klub/${slug}/saobshteniya/sms`, label: t('tabs.sms') }]
      : []),
  ];
  return (
    <nav aria-label={t('tabs.label')} className="-mx-4 overflow-x-auto px-4">
      <ul className="flex gap-2 pb-1">
        {tabs.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              aria-current={tab.key === current ? 'page' : undefined}
              className={chipClass({ selected: tab.key === current, className: 'min-h-11' })}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The message form, new or a draft being edited. Plain HTML constraints
 * (required, maxlength) catch what a person can get wrong before the post,
 * so the redirect-with-result pattern of the office never loses a long text.
 */
export async function ComposeForm({
  slug,
  draft,
  channels,
  plans,
  classes,
  tags,
}: {
  slug: string;
  draft: ClubBroadcast | null;
  channels: MessageChannel[];
  plans: { id: string; name: string }[];
  classes: { id: string; title: string }[];
  tags: string[];
}) {
  const [t, tClub, tMembers] = await Promise.all([
    getTranslations('ClubMessages'),
    getTranslations('Club'),
    getTranslations('ClubMembers'),
  ]);
  const field = 'block text-body-sm font-semibold text-ink';
  const hint = 'mt-1 block text-caption font-normal text-text-muted';
  const chosen = new Set<MessageChannel>(draft?.channels ?? ['email']);
  const current = draft ? audienceValue(draft.audience) : 'all';
  return (
    <form action={saveBroadcastAction} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      {draft && <input type="hidden" name="broadcastId" value={draft.id} />}

      <fieldset className="space-y-2">
        <legend className={field}>{t('purpose.label')}</legend>
        {(['service', 'marketing'] as const).map((purpose) => (
          <label key={purpose} className="flex min-h-11 items-start gap-3 text-body-sm text-ink">
            <input
              type="radio"
              name="purpose"
              value={purpose}
              required
              defaultChecked={(draft?.purpose ?? 'service') === purpose}
              className="mt-1 size-4 accent-[var(--brand)]"
            />
            <span>
              <span className="font-semibold">{t(`purpose.${purpose}`)}</span>
              <span className={hint}>{t(`purpose.${purpose}Hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className={field}>{t('channels.label')}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {channels.map((channel) => (
            <label key={channel} className="flex min-h-11 items-center gap-2 text-body-sm text-ink">
              <input
                type="checkbox"
                name="channels"
                value={channel}
                defaultChecked={chosen.has(channel)}
                className="size-4 accent-[var(--brand)]"
              />
              {t(`channels.${channel}`)}
            </label>
          ))}
        </div>
        <p className="text-caption text-text-muted">{t('channels.hint')}</p>
      </fieldset>

      <label className={field}>
        {t('audience.label')}
        <Select name="audience" defaultValue={current} size="sm" className="mt-1 max-w-md">
          <option value="all">{t('audience.all')}</option>
          <optgroup label={t('audience.segment')}>
            {AUDIENCE_SEGMENTS.map((segment) => (
              <option key={segment} value={`segment:${segment}`}>
                {tClub(`segment.${segment}`)}
              </option>
            ))}
          </optgroup>
          <optgroup label={t('audience.filter')}>
            {AUDIENCE_FILTERS.map((filter) => (
              <option key={filter} value={`filter:${filter}`}>
                {tMembers(`filter.${filter}`)}
              </option>
            ))}
          </optgroup>
          {plans.length > 0 && (
            <optgroup label={t('audience.plan')}>
              {plans.map((plan) => (
                <option key={plan.id} value={`plan:${plan.id}`}>
                  {plan.name}
                </option>
              ))}
            </optgroup>
          )}
          {classes.length > 0 && (
            <optgroup label={t('audience.class')}>
              {classes.map((klass) => (
                <option key={klass.id} value={`class:${klass.id}`}>
                  {klass.title}
                </option>
              ))}
            </optgroup>
          )}
          {tags.length > 0 && (
            <optgroup label={t('audience.tag')}>
              {tags.map((tag) => (
                <option key={tag} value={`tag:${tag}`}>
                  {tag}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        <span className={hint}>{t('audience.hint')}</span>
      </label>

      <label className={field}>
        {t('subject')}
        <Input
          name="subject"
          required
          maxLength={BROADCAST_SUBJECT_MAX}
          defaultValue={draft?.subject ?? ''}
          size="sm"
          className="mt-1"
        />
        <span className={hint}>{t('subjectHint')}</span>
      </label>

      <label className={field}>
        {t('body')}
        <Textarea
          name="body"
          required
          maxLength={BROADCAST_BODY_MAX}
          rows={8}
          size="sm"
          defaultValue={draft?.body ?? ''}
          className="mt-1"
        />
        <span className={hint}>{t('placeholders')}</span>
      </label>

      {channels.includes('sms') && (
        <label className={field}>
          {t('smsBody')}
          <SmsTextarea
            name="smsBody"
            maxLength={SMS_BODY_MAX}
            defaultValue={draft?.smsBody ?? ''}
            counter={t.raw('smsCounter') as string}
          />
          <span className={hint}>{t('smsBodyHint')}</span>
        </label>
      )}

      <Button type="submit">{draft ? t('saveDraft') : t('createDraft')}</Button>
    </form>
  );
}
