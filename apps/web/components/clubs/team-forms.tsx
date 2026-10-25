'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { useFormAction } from '@/lib/use-form-action';

import { FormFeedback } from './form-feedback';

export interface TeamState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
}

const INITIAL: TeamState = { error: null };

/** Invite by address; the worker mails the link. Empties after a success. */
export function StaffInviteForm({
  action,
  slug,
  roles,
  labels,
  messages,
}: {
  action: (prev: TeamState, formData: FormData) => Promise<TeamState>;
  slug: string;
  roles: { value: string; label: string }[];
  labels: { email: string; role: string; submit: string };
  messages: ClubFormMessages;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL, {
    resetWhen: (s) => s.saved === true,
  });
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <FormFeedback state={state} messages={messages} />
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <div className="space-y-1">
          <label className="block text-body-sm font-semibold text-ink" htmlFor="invite-email">
            {labels.email}
          </label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-body-sm font-semibold text-ink" htmlFor="invite-role">
            {labels.role}
          </label>
          <Select id="invite-role" name="role" defaultValue={roles.at(-1)?.value}>
            {roles.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pending}>
          {labels.submit}
        </Button>
      </div>
    </form>
  );
}
