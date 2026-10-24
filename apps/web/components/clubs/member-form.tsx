'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { useFormAction } from '@/lib/use-form-action';

import { FormFeedback } from './form-feedback';

/**
 * Create / edit a club client. THERE IS NO DATE-OF-BIRTH FIELD, by design
 * (lib/src/age.ts, apps/web/tests/dob-not-persisted.test.ts): "this is a
 * child" is a tick, and a child hangs under a parent record that receives
 * every message.
 */

export interface MemberState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
  key?: string;
}

type Action = (prev: MemberState, formData: FormData) => Promise<MemberState>;

const INITIAL: MemberState = { error: null };
const label = 'block text-body-sm font-semibold text-ink';

export interface MemberFormLabels {
  displayName: string;
  email: string;
  phone: string;
  isMinor: string;
  minorHint: string;
  guardian: string;
  guardianNone: string;
  tags: string;
  tagsHint: string;
  staffNote: string;
  submit: string;
}

export function MemberForm({
  action,
  slug,
  labels,
  messages,
  guardians,
  member,
}: {
  action: Action;
  slug: string;
  labels: MemberFormLabels;
  messages: ClubFormMessages;
  guardians: { id: string; displayName: string }[];
  member?: {
    id: string;
    displayName: string;
    email: string | null;
    phone: string | null;
    isMinor: boolean;
    guardianId: string | null;
    tags: string[];
    staffNote: string | null;
  };
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  const [isMinor, setIsMinor] = useState(member?.isMinor ?? false);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      {member && <input type="hidden" name="memberId" value={member.id} />}
      <FormFeedback state={state} messages={messages} />
      <div className="space-y-1">
        <label className={label} htmlFor="m-name">
          {labels.displayName}
        </label>
        <Input
          id="m-name"
          name="displayName"
          required
          maxLength={120}
          autoComplete="off"
          defaultValue={member?.displayName}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="m-email">
            {labels.email}
          </label>
          <Input
            id="m-email"
            name="email"
            type="email"
            maxLength={254}
            autoComplete="off"
            defaultValue={member?.email ?? ''}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="m-phone">
            {labels.phone}
          </label>
          <Input
            id="m-phone"
            name="phone"
            type="tel"
            maxLength={32}
            autoComplete="off"
            defaultValue={member?.phone ?? ''}
          />
        </div>
      </div>
      <div className="space-y-2 rounded-card border border-line p-3">
        <Checkbox
          name="isMinor"
          label={labels.isMinor}
          checked={isMinor}
          onChange={(event) => setIsMinor(event.currentTarget.checked)}
        />
        <p className="text-caption text-text-muted">{labels.minorHint}</p>
        {isMinor && (
          <div className="space-y-1">
            <label className={label} htmlFor="m-guardian">
              {labels.guardian}
            </label>
            <Select id="m-guardian" name="guardianMemberId" defaultValue={member?.guardianId ?? ''}>
              <option value="">{labels.guardianNone}</option>
              {guardians.map((guardian) => (
                <option key={guardian.id} value={guardian.id}>
                  {guardian.displayName}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <div className="space-y-1">
        <label className={label} htmlFor="m-tags">
          {labels.tags}
        </label>
        <Input
          id="m-tags"
          name="tags"
          maxLength={700}
          aria-describedby="m-tags-hint"
          defaultValue={member?.tags.join(', ') ?? ''}
        />
        <p id="m-tags-hint" className="text-caption text-text-muted">
          {labels.tagsHint}
        </p>
      </div>
      <div className="space-y-1">
        <label className={label} htmlFor="m-note">
          {labels.staffNote}
        </label>
        <Textarea
          id="m-note"
          name="staffNote"
          maxLength={1000}
          rows={3}
          defaultValue={member?.staffNote ?? ''}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {labels.submit}
      </Button>
    </form>
  );
}

/** Issue a printed card key; the key appears once, in this form's state. */
export function IssueCardButton({
  action,
  slug,
  memberId,
  labels,
  messages,
}: {
  action: Action;
  slug: string;
  memberId: string;
  labels: { submit: string; hint: string; keyTemplate: string };
  messages: ClubFormMessages;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  return (
    <form {...formProps} className="space-y-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="memberId" value={memberId} />
      {state.key ? (
        <p
          role="status"
          className="break-all rounded-card border border-brand-border bg-brand-subtle p-3 font-mono text-body-sm text-ink"
        >
          {labels.keyTemplate.replace('{key}', state.key)}
        </p>
      ) : (
        <FormFeedback state={state} messages={messages} />
      )}
      <p className="text-caption text-text-muted">{labels.hint}</p>
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {labels.submit}
      </Button>
    </form>
  );
}
