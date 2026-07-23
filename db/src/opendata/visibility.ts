import { PUBLIC_FACILITY_PREDICATE } from '@sportkarta/lib/opendata';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The public-visibility rule for facilities, as one drizzle fragment, for the
 * whole product (Stage 6.1).
 *
 * WHY THIS FILE EXISTS. Stage 6 publishes the corpus as a file anyone can
 * download. The moment that is true, "which facilities are public?" stops being
 * a detail of the map's read layer and becomes a promise: a bulk download must
 * contain exactly the rows a visitor could already see, no more. Two copies of
 * the predicate — one in apps/web/lib/public-data.ts for the map, one in the
 * export compiler — would hold that promise on the day they were written and
 * break it silently the first time somebody adjusted one of them. A facility
 * withdrawn from the map that stayed in the nightly CSV is not a rendering bug;
 * it is publishing something we decided not to publish.
 *
 * So there is one string (`PUBLIC_FACILITY_PREDICATE`, in the catalogue, where
 * the PII test can read it) and one fragment (here, where queries can use it),
 * and both the map and the export are built from them.
 *
 * `sql.raw` is safe here and only here: the input is a compile-time constant
 * exported from a module with no parameters, not a request value. The
 * catalogue's `assertSafeFragment` runs over it in the export compiler, and the
 * denylist test asserts its contents independently.
 *
 * The alias is `f`, matching every facilities query in the codebase.
 */
export const publicFacilityVisible: SQL = sql.raw(PUBLIC_FACILITY_PREDICATE);
