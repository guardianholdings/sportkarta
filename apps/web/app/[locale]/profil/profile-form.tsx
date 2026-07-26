'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{t('displayNameLabel')}</span>
        <Input
          type="text"
          name="displayName"
          required
          maxLength={60}
          defaultValue={displayName}
          autoComplete="nickname"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{t('homeCityLabel')}</span>
        <Input type="text" name="homeCity" maxLength={80} defaultValue={homeCity} />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{t('dateOfBirthLabel')}</span>
        <Input
          type="date"
          name="dateOfBirth"
          // Never pre-filled: the value is not stored anywhere to fill it from.
          autoComplete="off"
        />
        <span className="text-caption text-text-muted">{t('dateOfBirthHint')}</span>
      </label>

      {/*
        Informational only. The category restricted nothing after the operator
        decision of 2026-07-25 (minors are treated as adults), so the copy no
        longer promises or withholds anything — it just reflects what was
        derived from a date we did not keep.
      */}
      <p className="text-body-sm text-ink-soft">
        {isMinor ? t('categoryMinor') : t('categoryAdult')}
      </p>

      {state.error && (
        <p role="alert" className="text-body-sm text-danger">
          {t(`error_${state.error}`)}
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-body-sm text-success">
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
      <p className="text-body-sm text-ink-soft">{t('deleteExplainer')}</p>
      <ul className="list-disc space-y-1 pl-5 text-body-sm text-ink-soft">
        <li>{t('deleteBulletProfile')}</li>
        <li>{t('deleteBulletContributions')}</li>
        <li>{t('deleteBulletAudit')}</li>
      </ul>
      {/* Locale only — the expected word is resolved server-side, never trusted
          from the form. */}
      <input type="hidden" name="locale" value={locale} />
      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">
          {t('deleteConfirmLabel', { word: confirmationWord })}
        </span>
        <Input type="text" name="confirmation" required autoComplete="off" />
      </label>
      {state.error && (
        <p role="alert" className="text-body-sm text-danger">
          {t(`error_${state.error}`)}
        </p>
      )}
      <Button type="submit" variant="danger" disabled={pending}>
        {t('deleteSubmit')}
      </Button>
    </form>
  );
}
