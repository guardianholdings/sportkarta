import { createTranslator, useLocale } from 'next-intl';
import { useMemo } from 'react';

/** Copy a server page hands to an admin client component, as `t.raw()` templates. */
export type Labels = Readonly<Record<string, string>>;

export type LabelTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * ICU formatting over a flat label bag.
 *
 * The CSV wizards (/admin/sesii, /admin/rezultati) get their copy from the
 * server page as raw templates: their namespaces are not sent to the browser
 * (i18n/client-messages.ts), and the numbers they print — rows created,
 * facilities ticked — exist only on the client. A `.replace('{count}', …)`
 * cannot choose between «1 тренировка» and «5 тренировки», so this runs the
 * same ICU engine as useTranslations over the bag: `{count, plural, …}` works,
 * and so does every other argument.
 *
 * An unknown key renders as itself, so a missing translation is visible
 * rather than blank.
 */
export function labelTranslator(locale: string, labels: Labels): LabelTranslator {
  const translate = createTranslator({
    locale,
    messages: { labels },
    namespace: 'labels',
    onError: () => undefined,
    getMessageFallback: ({ key }) => key,
  });
  return (key, values) => translate(key, values);
}

export function useLabels(labels: Labels): LabelTranslator {
  const locale = useLocale();
  return useMemo(() => labelTranslator(locale, labels), [locale, labels]);
}
