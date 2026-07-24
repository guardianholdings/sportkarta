'use client';

import type { CampaignRow } from '@sportkarta/db';
import {
  CAMPAIGN_EVENT_KINDS,
  CAMPAIGN_LEADERBOARD_TYPES,
  CAMPAIGN_TEMPLATES,
  CITY_BOARD_MIN_MEMBERS,
} from '@sportkarta/lib/campaigns';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import type { CampaignFormState } from './actions';

const INITIAL: CampaignFormState = { error: null, saved: false };

export interface CityOption {
  id: number;
  name: string;
}

/**
 * The campaign editor.
 *
 * Every scoring knob here maps to one field of the rules document validated in
 * lib/src/campaigns/rules.ts — a checkbox per event kind plus its weight, an
 * optional sports filter, an optional per-day cap. The form deliberately cannot
 * express anything the grammar does not accept, so "the admin built an invalid
 * campaign" is a shape the UI makes unreachable rather than an error message.
 */
export function CampaignForm({
  action,
  campaign,
  cities,
  sportLabels,
}: {
  action: (state: CampaignFormState, formData: FormData) => Promise<CampaignFormState>;
  campaign?: CampaignRow;
  cities: CityOption[];
  sportLabels: Record<string, string>;
}) {
  const t = useTranslations('AdminCampaigns');
  const [state, formAction, pending] = useActionState<CampaignFormState, FormData>(
    action,
    INITIAL,
  );

  const [scopeKind, setScopeKind] = useState(campaign?.scope.kind ?? 'national');
  const [leaderboardType, setLeaderboardType] = useState(
    campaign?.leaderboardType ?? 'individual',
  );

  const weightFor = (kind: string): number | undefined =>
    campaign?.rules.events.find((event) => event.kind === kind)?.weight;
  const selectedSports = new Set(campaign?.rules.sports ?? []);

  const field = 'w-full rounded border border-neutral-300 px-3 py-2';

  return (
    <form action={formAction} className="space-y-8">
      {campaign && <input type="hidden" name="id" value={campaign.id} />}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase text-neutral-500">{t('sectionBasics')}</h2>

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('slugLabel')}</span>
          <input
            type="text"
            name="slug"
            required
            maxLength={60}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            defaultValue={campaign?.slug ?? ''}
            className={field}
          />
          <span className="block text-xs text-neutral-500">{t('slugHint')}</span>
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('titleBgLabel')}</span>
          <input
            type="text"
            name="titleBg"
            required
            maxLength={120}
            defaultValue={campaign?.titleBg ?? ''}
            className={field}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('titleEnLabel')}</span>
          <input
            type="text"
            name="titleEn"
            maxLength={120}
            defaultValue={campaign?.titleEn ?? ''}
            className={field}
          />
          <span className="block text-xs text-neutral-500">{t('translationHint')}</span>
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('blurbBgLabel')}</span>
          <textarea name="blurbBg" rows={3} maxLength={2000} defaultValue={campaign?.blurbBg ?? ''} className={field} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('blurbEnLabel')}</span>
          <textarea name="blurbEn" rows={3} maxLength={2000} defaultValue={campaign?.blurbEn ?? ''} className={field} />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('prizeBgLabel')}</span>
          <textarea name="prizeBg" rows={2} maxLength={2000} defaultValue={campaign?.prizeBg ?? ''} className={field} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('prizeEnLabel')}</span>
          <textarea name="prizeEn" rows={2} maxLength={2000} defaultValue={campaign?.prizeEn ?? ''} className={field} />
        </label>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase text-neutral-500">{t('sectionWindow')}</h2>
        <div className="flex flex-wrap gap-4">
          <label className="space-y-1">
            <span className="block text-sm font-medium">{t('startsOnLabel')}</span>
            <input type="date" name="startsOn" required defaultValue={campaign?.window.startsOn ?? ''} className="rounded border border-neutral-300 px-3 py-2" />
          </label>
          <label className="space-y-1">
            <span className="block text-sm font-medium">{t('endsOnLabel')}</span>
            <input type="date" name="endsOn" required defaultValue={campaign?.window.endsOn ?? ''} className="rounded border border-neutral-300 px-3 py-2" />
          </label>
        </div>
        <p className="text-xs text-neutral-500">{t('windowHint')}</p>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase text-neutral-500">{t('sectionScope')}</h2>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('scopeLabel')}</span>
          <select
            name="scopeKind"
            value={scopeKind}
            onChange={(event) => setScopeKind(event.target.value as typeof scopeKind)}
            className={field}
          >
            <option value="national">{t('scope_national')}</option>
            <option value="city">{t('scope_city')}</option>
            <option value="quarter">{t('scope_quarter')}</option>
          </select>
        </label>

        {scopeKind !== 'national' && (
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('municipalityLabel')}</span>
            <select name="municipalityId" defaultValue={campaign?.scope.kind !== 'national' ? String(campaign?.scope.municipalityId ?? '') : ''} className={field}>
              <option value="">{t('choose')}</option>
              {cities.map((city) => (
                <option key={city.id} value={city.id}>
                  {city.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {scopeKind === 'quarter' && (
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('quarterLabel')}</span>
            <input
              type="text"
              name="quarter"
              maxLength={120}
              defaultValue={campaign?.scope.kind === 'quarter' ? campaign.scope.quarter : ''}
              className={field}
            />
            <span className="block text-xs text-neutral-500">{t('quarterHint')}</span>
          </label>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase text-neutral-500">{t('sectionScoring')}</h2>
        <p className="text-xs text-neutral-500">{t('scoringHint')}</p>

        <ul className="space-y-2">
          {CAMPAIGN_EVENT_KINDS.map((kind) => {
            const weight = weightFor(kind);
            return (
              <li key={kind} className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2">
                  <input type="checkbox" name={`event_${kind}`} defaultChecked={weight !== undefined} />
                  <span className="text-sm">{t(`event_${kind}`)}</span>
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500">{t('weightLabel')}</span>
                  <input
                    type="number"
                    name={`weight_${kind}`}
                    min={1}
                    max={1000}
                    defaultValue={weight ?? 1}
                    className="w-24 rounded border border-neutral-300 px-2 py-1"
                  />
                </label>
              </li>
            );
          })}
        </ul>

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('perDayCapLabel')}</span>
          <input
            type="number"
            name="perDayCap"
            min={1}
            defaultValue={campaign?.rules.perDayCap ?? ''}
            className="w-32 rounded border border-neutral-300 px-3 py-2"
          />
          <span className="block text-xs text-neutral-500">{t('perDayCapHint')}</span>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('sportsLabel')}</legend>
          <p className="text-xs text-neutral-500">{t('sportsHint')}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {CANONICAL_SPORTS.map((sport) => (
              <label key={sport} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="sports" value={sport} defaultChecked={selectedSports.has(sport)} />
                {sportLabels[sport] ?? sport}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase text-neutral-500">{t('sectionBoard')}</h2>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('leaderboardTypeLabel')}</span>
          <select
            name="leaderboardType"
            value={leaderboardType}
            onChange={(event) => setLeaderboardType(event.target.value as typeof leaderboardType)}
            className={field}
          >
            {CAMPAIGN_LEADERBOARD_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`leaderboardType_${type}`)}
              </option>
            ))}
          </select>
        </label>
        {/*
          The consequence of this choice is a privacy one, so it is stated at
          the point of choosing rather than buried in documentation: an
          individual board names people and therefore shows only adults with a
          public passport, while a city board names nobody and can safely
          include everyone — with small municipalities suppressed.
        */}
        <p className="text-xs text-neutral-500">
          {leaderboardType === 'individual'
            ? t('leaderboardIndividualNote')
            : t('leaderboardCityNote', { min: CITY_BOARD_MIN_MEMBERS })}
        </p>

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('templateLabel')}</span>
          <select name="template" defaultValue={campaign?.template ?? 'standard'} className={field}>
            {CAMPAIGN_TEMPLATES.map((template) => (
              <option key={template} value={template}>
                {t(`template_${template}`)}
              </option>
            ))}
          </select>
        </label>
      </section>

      {state.error && <p className="text-sm text-red-700">{t(`error_${state.error}`)}</p>}
      {state.saved && <p className="text-sm text-green-700">{t('saved')}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {campaign ? t('save') : t('create')}
      </button>
    </form>
  );
}
