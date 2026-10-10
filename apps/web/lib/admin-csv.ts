/**
 * The column mapping the admin CSV wizards post back (/admin/sesii,
 * /admin/rezultati, /admin/obshtini) — read in ONE place.
 *
 * The mapping step renders one `map.<field>` select per field, whose value is
 * the zero-based column index, or '' for «— пропусни —». `Number('')` is 0, so
 * the readers that only asked `Number.isInteger(index)` mapped every skipped
 * field to the FIRST column: bulk-created sessions went public with the
 * facility slug as their description, and result rows carried the participant
 * (often an email address) as team, score and note — which replaceResults then
 * wrote over the stored results (UX audit 2026-10-10, A-1). The municipal inbox
 * had been bitten once already and guarded itself; that guard now lives here.
 *
 * Only the wizard's own fields are read, and only plain non-negative integers:
 * the posted form is a pointer into the CSV, never a parameter surface.
 */
export function readColumnMapping<F extends string>(
  formData: FormData,
  fields: readonly F[],
): Partial<Record<F, number>> {
  const mapping: Partial<Record<F, number>> = {};
  for (const field of fields) {
    const value = formData.get(`map.${field}`);
    // '' is «— пропусни —»; a File, a sign, a decimal point or a space is no
    // column either.
    if (typeof value !== 'string' || !/^\d+$/.test(value)) continue;
    const index = Number(value);
    if (Number.isSafeInteger(index)) mapping[field] = index;
  }
  return mapping;
}
