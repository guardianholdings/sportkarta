'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';

import { deleteAccountAction, updateProfileAction, type ProfileState } from './actions';

const INITIAL: ProfileState = { error: null, saved: false };

export function ProfileForm({
  displayName,
  homeCity,
  isMinor,
}: {
  displayName: string;
  homeCity: string;
  isMinor: boolean;
}) {
  const t = useTranslations('Profile');
  const [state, action, pending] = useActionState<ProfileState, FormData>(
    updateProfileAction,
    INITIAL,
  );

  return (
    <form action={action} className="space-y-4">
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('displayNameLabel')}</span>
        <input
          type="text"
          name="displayName"
          required
          maxLength={60}
          defaultValue={displayName}
          autoComplete="nickname"
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('homeCityLabel')}</span>
        <input
          type="text"
          name="homeCity"
          maxLength={80}
          defaultValue={homeCity}
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('dateOfBirthLabel')}</span>
        <input
          type="date"
          name="dateOfBirth"
          // Never pre-filled: the value is not stored anywhere to fill it from.
          autoComplete="off"
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
        <span className="block text-xs text-neutral-500">{t('dateOfBirthHint')}</span>
      </label>

      <p className="text-sm text-neutral-600">
        {isMinor ? t('categoryMinor') : t('categoryAdult')}
      </p>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {t(`error_${state.error}`)}
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-sm text-green-700">
          {t('saved')}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {t('submit')}
      </Button>
    </form>
  );
}

export function DeleteAccountForm({ confirmationWord }: { confirmationWord: string }) {
  const t = useTranslations('Profile');
  const locale = useLocale();
  const [state, action, pending] = useActionState<ProfileState, FormData>(
    deleteAccountAction,
    INITIAL,
  );

  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-neutral-600">{t('deleteExplainer')}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-600">
        <li>{t('deleteBulletProfile')}</li>
        <li>{t('deleteBulletContributions')}</li>
        <li>{t('deleteBulletAudit')}</li>
      </ul>
      {/* Locale only — the expected word is resolved server-side, never trusted
          from the form. */}
      <input type="hidden" name="locale" value={locale} />
      <label className="block space-y-1">
        <span className="text-sm font-medium">
          {t('deleteConfirmLabel', { word: confirmationWord })}
        </span>
        <input
          type="text"
          name="confirmation"
          required
          autoComplete="off"
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {t(`error_${state.error}`)}
        </p>
      )}
      <Button type="submit" variant="destructive" disabled={pending}>
        {t('deleteSubmit')}
      </Button>
    </form>
  );
}
