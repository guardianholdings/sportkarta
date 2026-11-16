/**
 * B, contradiction (c): «Новото съоръжение се появява на картата веднага» is
 * not true for a paid place while paid venues are hidden; the add form says so
 * in paidHiddenHint, right above the footer. One rule for both, so the hint and
 * the footer can never disagree.
 */
export function appearsOnMapNow(access: string, paidHidden: boolean | undefined): boolean {
  return !(access === 'paid' && paidHidden === true);
}
