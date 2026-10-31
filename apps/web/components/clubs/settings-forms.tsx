'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { useFormAction } from '@/lib/use-form-action';

import { FormFeedback } from './form-feedback';

/**
 * The club settings forms. Labels arrive pre-translated (no club namespace
 * reaches the browser), and every form goes through useFormAction so a
 * refused value comes back above the form as it was typed.
 */

export interface SettingsState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
  code?: string;
}

type Action = (prev: SettingsState, formData: FormData) => Promise<SettingsState>;

const INITIAL: SettingsState = { error: null };
const label = 'block text-body-sm font-semibold text-ink';

export interface SettingsFormLabels {
  nameBg: string;
  nameEn: string;
  kind: string;
  kinds: Record<string, string>;
  descriptionBg: string;
  descriptionEn: string;
  sports: string;
  sportOptions: { value: string; label: string }[];
  city: string;
  cityNone: string;
  cities: { id: number; name: string }[];
  website: string;
  publicEmail: string;
  publicPhone: string;
  publicContactHint: string;
  legalName: string;
  eik: string;
  locale: string;
  localeBg: string;
  localeEn: string;
  bookingTitle: string;
  bookingOpensDays: string;
  cancelDeadlineHours: string;
  mailUnlinked: string;
  mailUnlinkedHint: string;
  accent: string;
  accentHint: string;
  accents: Record<'green' | 'coral' | 'sky', string>;
  save: string;
}

export interface SettingsValues {
  nameBg: string;
  nameEn: string | null;
  kind: string;
  descriptionBg: string | null;
  descriptionEn: string | null;
  sports: string[];
  municipalityId: number | null;
  websiteUrl: string | null;
  publicEmail: string | null;
  publicPhone: string | null;
  legalName: string | null;
  eik: string | null;
  locale: 'bg' | 'en';
  bookingOpensHours: number;
  cancelDeadlineHours: number;
  mailUnlinkedMembers: boolean;
  accent: 'green' | 'coral' | 'sky';
}

export function SettingsForm({
  action,
  slug,
  labels,
  messages,
  values,
}: {
  action: Action;
  slug: string;
  labels: SettingsFormLabels;
  messages: ClubFormMessages;
  values: SettingsValues;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      <FormFeedback state={state} messages={messages} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="s-name-bg">
            {labels.nameBg}
          </label>
          <Input
            id="s-name-bg"
            name="nameBg"
            required
            maxLength={120}
            defaultValue={values.nameBg}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="s-name-en">
            {labels.nameEn}
          </label>
          <Input id="s-name-en" name="nameEn" maxLength={120} defaultValue={values.nameEn ?? ''} />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="s-kind">
            {labels.kind}
          </label>
          <Select id="s-kind" name="kind" defaultValue={values.kind}>
            {Object.entries(labels.kinds).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="s-city">
            {labels.city}
          </label>
          <Select id="s-city" name="municipalityId" defaultValue={values.municipalityId ?? ''}>
            <option value="">{labels.cityNone}</option>
            {labels.cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <label className={label} htmlFor="s-desc-bg">
          {labels.descriptionBg}
        </label>
        <Textarea
          id="s-desc-bg"
          name="descriptionBg"
          maxLength={2000}
          rows={4}
          defaultValue={values.descriptionBg ?? ''}
        />
      </div>
      <div className="space-y-1">
        <label className={label} htmlFor="s-desc-en">
          {labels.descriptionEn}
        </label>
        <Textarea
          id="s-desc-en"
          name="descriptionEn"
          maxLength={2000}
          rows={3}
          defaultValue={values.descriptionEn ?? ''}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className={label}>{labels.sports}</legend>
        <div className="flex max-h-56 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded-card border border-line p-3">
          {labels.sportOptions.map((sport) => (
            <Checkbox
              key={sport.value}
              name="sports"
              value={sport.value}
              label={sport.label}
              defaultChecked={values.sports.includes(sport.value)}
            />
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <label className={label} htmlFor="s-web">
            {labels.website}
          </label>
          <Input
            id="s-web"
            name="website"
            inputMode="url"
            maxLength={300}
            defaultValue={values.websiteUrl ?? ''}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="s-email">
            {labels.publicEmail}
          </label>
          <Input
            id="s-email"
            name="publicEmail"
            type="email"
            maxLength={254}
            defaultValue={values.publicEmail ?? ''}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="s-phone">
            {labels.publicPhone}
          </label>
          <Input
            id="s-phone"
            name="publicPhone"
            type="tel"
            maxLength={32}
            defaultValue={values.publicPhone ?? ''}
          />
        </div>
      </div>
      <p className="text-caption text-text-muted">{labels.publicContactHint}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1 sm:col-span-2">
          <label className={label} htmlFor="s-legal">
            {labels.legalName}
          </label>
          <Input
            id="s-legal"
            name="legalName"
            maxLength={200}
            defaultValue={values.legalName ?? ''}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="s-eik">
            {labels.eik}
          </label>
          <Input
            id="s-eik"
            name="eik"
            inputMode="numeric"
            pattern="[0-9]{9}|[0-9]{13}"
            defaultValue={values.eik ?? ''}
          />
        </div>
      </div>
      <fieldset className="space-y-3 rounded-card border border-line p-3">
        <legend className="px-1 text-body-sm font-bold text-ink">{labels.bookingTitle}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label className={label} htmlFor="s-opens">
              {labels.bookingOpensDays}
            </label>
            <Input
              id="s-opens"
              name="bookingOpensDays"
              type="number"
              min={1}
              max={90}
              defaultValue={Math.round(values.bookingOpensHours / 24)}
            />
          </div>
          <div className="space-y-1">
            <label className={label} htmlFor="s-deadline">
              {labels.cancelDeadlineHours}
            </label>
            <Input
              id="s-deadline"
              name="cancelDeadlineHours"
              type="number"
              min={0}
              max={168}
              defaultValue={values.cancelDeadlineHours}
            />
          </div>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="s-accent">
            {labels.accent}
          </label>
          <Select
            id="s-accent"
            name="accent"
            defaultValue={values.accent}
            aria-describedby="s-accent-hint"
          >
            {(['green', 'coral', 'sky'] as const).map((accent) => (
              <option key={accent} value={accent}>
                {labels.accents[accent]}
              </option>
            ))}
          </Select>
          <p id="s-accent-hint" className="text-caption text-text-muted">
            {labels.accentHint}
          </p>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="s-locale">
            {labels.locale}
          </label>
          <Select id="s-locale" name="locale" defaultValue={values.locale}>
            <option value="bg">{labels.localeBg}</option>
            <option value="en">{labels.localeEn}</option>
          </Select>
        </div>
        <Checkbox
          name="mailUnlinkedMembers"
          label={labels.mailUnlinked}
          defaultChecked={values.mailUnlinkedMembers}
        />
        <p className="text-caption text-text-muted">{labels.mailUnlinkedHint}</p>
      </fieldset>
      <Button type="submit" disabled={pending}>
        {labels.save}
      </Button>
    </form>
  );
}

export interface LocationFormLabels {
  name: string;
  address: string;
  facility: string;
  facilityNone: string;
  facilities: { id: string; name: string }[];
  submit: string;
}

export function LocationForm({
  action,
  slug,
  labels,
  messages,
  location,
}: {
  action: Action;
  slug: string;
  labels: LocationFormLabels;
  messages: ClubFormMessages;
  location?: { id: string; name: string; address: string | null; facilityId: string | null };
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL, {
    resetWhen: (s) => s.saved === true && !location,
  });
  const id = location?.id ?? 'new';
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      {location && <input type="hidden" name="locationId" value={location.id} />}
      <FormFeedback state={state} messages={messages} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className={label} htmlFor={`l-name-${id}`}>
            {labels.name}
          </label>
          <Input
            id={`l-name-${id}`}
            name="name"
            required
            maxLength={120}
            defaultValue={location?.name}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor={`l-address-${id}`}>
            {labels.address}
          </label>
          <Input
            id={`l-address-${id}`}
            name="address"
            maxLength={300}
            defaultValue={location?.address ?? ''}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor={`l-facility-${id}`}>
            {labels.facility}
          </label>
          <Select
            id={`l-facility-${id}`}
            name="facilityId"
            defaultValue={location?.facilityId ?? ''}
          >
            <option value="">{labels.facilityNone}</option>
            {labels.facilities.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {labels.submit}
      </Button>
    </form>
  );
}

export interface KioskLabels {
  name: string;
  location: string;
  create: string;
  newCode: string;
  /** "Open {url} … {code}" with the placeholders already in place. */
  codeTemplate: string;
}

function CodeLine({ template, code }: { template: string; code: string }) {
  const [before, after] = template.split('{code}');
  return (
    <p
      role="status"
      className="rounded-card border border-brand-border bg-brand-subtle p-3 text-body-sm text-ink"
    >
      {before}
      <strong className="font-mono text-h4 tracking-widest">{code}</strong>
      {after}
    </p>
  );
}

export function KioskCreateForm({
  action,
  slug,
  labels,
  messages,
  locations,
}: {
  action: Action;
  slug: string;
  labels: KioskLabels;
  messages: ClubFormMessages;
  locations: { id: string; name: string }[];
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      {state.code ? (
        <CodeLine template={labels.codeTemplate} code={state.code} />
      ) : (
        <FormFeedback state={state} messages={messages} />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="k-name">
            {labels.name}
          </label>
          <Input id="k-name" name="name" maxLength={60} />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="k-location">
            {labels.location}
          </label>
          <Select id="k-location" name="locationId" required>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <Button type="submit" variant="secondary" disabled={pending || locations.length === 0}>
        {labels.create}
      </Button>
    </form>
  );
}

export function KioskCodeButton({
  action,
  slug,
  deviceId,
  labels,
  messages,
}: {
  action: Action;
  slug: string;
  deviceId: string;
  labels: KioskLabels;
  messages: ClubFormMessages;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  return (
    <form {...formProps} className="space-y-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="deviceId" value={deviceId} />
      {state.code ? (
        <CodeLine template={labels.codeTemplate} code={state.code} />
      ) : (
        <FormFeedback state={state} messages={messages} />
      )}
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {labels.newCode}
      </Button>
    </form>
  );
}
