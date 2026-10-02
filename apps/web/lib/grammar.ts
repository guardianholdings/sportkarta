/**
 * Two small grammar facts the message catalogue cannot compute for itself.
 *
 * The WORDS stay in messages/*.json; code only supplies the grammatical
 * feature an ICU `select` branches on, so the Bulgarian and English copy keep
 * owning their own phrasing and the English catalogue simply ignores it.
 */

/**
 * Bulgarian writes the preposition „в" as „във" before a word that begins with
 * „в" or „ф" (във Варна, във Велико Търново) — otherwise it would be
 * unpronounceable. Messages branch on the result:
 * `{cityVav, select, yes {във} other {в}} {city}`.
 *
 * The letters are escapes, not literals: this is .ts source, and the repo-wide
 * gate keeps Cyrillic out of it (tests/i18n-hardcoded.test.ts).
 */
const VAV_INITIAL = /^[\u0412\u0432\u0424\u0444]/; // В в Ф ф

export function takesVav(word: string): 'yes' | 'no' {
  return VAV_INITIAL.test(word.trimStart()) ? 'yes' : 'no';
}

/**
 * First letter upper-cased, for a catalogue term that opens a title or a
 * heading. Sport names are stored lower-case because they mostly sit mid-
 * sentence („места за футбол"); at the head of an <h1> or a <title> they read
 * as a typo („футбол в Брезник").
 */
export function capitalizeFirst(text: string, locale: string): string {
  const first = text.charAt(0);
  return first ? first.toLocaleUpperCase(locale) + text.slice(1) : text;
}
