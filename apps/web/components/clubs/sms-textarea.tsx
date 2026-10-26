'use client';

import { smsLength } from '@sportkarta/lib/sms/text';
import { useState } from 'react';

import { Textarea } from '@/components/ui/textarea';

/**
 * An SMS text box that says, while the person types, how many parts the
 * message will be — a Bulgarian SMS is 70 characters, then 67 per part, and
 * the club pays per part (0051). `{count}` and `{parts}` fill the label.
 * Without JavaScript it is a plain textarea with a length limit.
 */
export function SmsTextarea({
  name,
  defaultValue,
  required,
  maxLength,
  counter,
  id,
}: {
  name: string;
  defaultValue?: string;
  required?: boolean;
  maxLength: number;
  /** e.g. «{count} знака · {parts} SMS» */
  counter: string;
  id?: string;
}) {
  const [value, setValue] = useState(defaultValue ?? '');
  const length = smsLength(value);
  return (
    <>
      <Textarea
        id={id}
        name={name}
        rows={3}
        size="sm"
        required={required}
        maxLength={maxLength}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="mt-1"
      />
      <span className="mt-1 block text-caption text-text-muted" aria-live="polite">
        {counter.replace('{count}', String(value.length)).replace('{parts}', String(length.parts))}
      </span>
    </>
  );
}
