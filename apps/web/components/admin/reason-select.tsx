import { reasonsFor, type ReasonContext } from '@sportkarta/lib/moderation';

import { Select } from '@/components/ui/select';

/**
 * The reason a refusal is logged with and explained by (0034). Required, with
 * no default: the empty first option means a moderator has to CHOOSE, because
 * a pre-selected reason is the one every statement of reasons would carry.
 *
 * Shared by /admin/moderation and the facility editor, which decides a facility
 * awaiting verification through the same logged path (A-4).
 */
export function ReasonSelect({
  context,
  label,
  placeholder,
  labelFor,
  size = 'sm',
}: {
  context: ReasonContext;
  label: string;
  placeholder: string;
  labelFor: (slug: string) => string;
  size?: 'sm' | 'md';
}) {
  return (
    <Select name="reason" required defaultValue="" size={size} aria-label={label}>
      <option value="" disabled>
        {placeholder}
      </option>
      {reasonsFor(context).map((slug) => (
        <option key={slug} value={slug}>
          {labelFor(slug)}
        </option>
      ))}
    </Select>
  );
}
