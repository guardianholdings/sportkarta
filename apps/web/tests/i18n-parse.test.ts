import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * Every message must PARSE as ICU MessageFormat. A message that does not is
 * not caught by the parity or placeholder tests: next-intl renders its KEY in
 * place of the text («ClubIntegrations.docs.webhooks.signature» stood on the
 * developer docs page because «<hex>» reads as an unclosed tag). Formatting
 * errors from arguments this test does not pass are ignored — only a message
 * that cannot be parsed at all fails.
 */
interface Tree {
  [key: string]: string | Tree;
}

function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : keys(value, path);
  });
}

describe.each([
  ['bg', bg],
  ['en', en],
] as const)('%s.json', (locale, messages) => {
  it('parses every message', () => {
    const broken: string[] = [];
    let current = '';
    const t = createTranslator({
      locale,
      messages: messages as unknown as Tree,
      onError: (error) => {
        if (error.code === 'INVALID_MESSAGE') broken.push(current);
      },
    });
    for (const key of keys(messages as unknown as Tree)) {
      current = key;
      (t as unknown as (k: string) => string)(key);
    }
    expect(broken).toEqual([]);
  });
});
