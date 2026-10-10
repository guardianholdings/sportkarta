/**
 * The verify deck's order (/admin/verify, UX audit 2026-10-10 A-3).
 *
 * Every decision revalidates the page, so the deck receives a fresh server
 * batch — in name order — after each one. Rebuilt naively, it put a card the
 * operator had just skipped straight back on top. This is a batch as the deck
 * shows it: without the cards decided here, and with the skipped ones after
 * the rest, in the order they were skipped.
 */
export function arrangeDeck<T extends { id: string }>(
  cards: readonly T[],
  decided: ReadonlySet<string>,
  skipped: readonly string[],
): T[] {
  const open = cards.filter((card) => !decided.has(card.id));
  const later = new Set(skipped);
  const back = skipped.flatMap((id) => open.filter((card) => card.id === id));
  return [...open.filter((card) => !later.has(card.id)), ...back];
}
