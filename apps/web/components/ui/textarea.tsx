import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Textarea — the multi-line sibling of Input, with the same radius, border,
 * placeholder and focus treatment. Exists so free-text fields (the report
 * form, admin notes) stop hand-rolling their own boxes: before this primitive
 * every textarea in the product was a page-local one-off.
 */
const textareaVariants = cva(
  'w-full rounded-input bg-surface px-3.5 py-2.5 text-ink border border-line-strong placeholder:text-text-muted transition-[border-color,box-shadow] duration-150 ease-standard focus-visible:border-brand disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      size: {
        sm: 'text-body-sm',
        md: 'text-body',
      },
      invalid: { true: 'border-danger focus-visible:border-danger', false: '' },
    },
    defaultVariants: { size: 'md', invalid: false },
  },
);

export interface TextareaProps
  extends
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {}

export function Textarea({ className, size, invalid, rows = 4, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      rows={rows}
      className={cn(textareaVariants({ size, invalid }), className)}
      {...props}
    />
  );
}
