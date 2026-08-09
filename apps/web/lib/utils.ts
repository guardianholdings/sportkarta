import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The seed type scale registers custom `text-*` font-size utilities
// (text-body-sm, text-overline, text-h1 …). Tailwind-merge must know these are
// FONT SIZES, not colours — otherwise `text-body-sm` and `text-on-brand` look
// like the same `text-*` group and it drops one, silently killing a button's
// text colour (brand-on-brand). Teaching it the size names keeps them distinct.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'overline',
            'caption',
            'body-sm',
            'body',
            'body-lg',
            'h4',
            'h3',
            'h2',
            'h1',
            'display-lg',
            'display-xl',
            'display-2xl',
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
