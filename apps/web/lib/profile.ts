import { sql, type SQL } from '@sportkarta/db';
import { deriveIsMinor, InvalidDateOfBirthError } from '@sportkarta/lib/age';

/**
 * Minimal member profile (docs/ROADMAP.md §5).
 *
 * The date of birth is an INPUT ONLY. It enters buildProfileUpdate, becomes a
 * boolean, and is gone when the function returns — it is never part of the
 * persisted shape, never echoed back to the client, and never logged (its value
 * does not even appear in the validation errors).
 *
 * apps/web/tests/dob-not-persisted.test.ts runs this exact path against a
 * recording database and asserts the date reaches neither SQL nor the console.
 */

export const DISPLAY_NAME_MAX = 60;
export const HOME_CITY_MAX = 80;

/**
 * The complete set of columns the profile form may write. Anything not listed
 * here — role, is_minor without a DOB, email, and above all a date of birth —
 * cannot be set through this path.
 */
export const PROFILE_PERSISTED_FIELDS = ['displayName', 'homeCity', 'isMinor'] as const;

export interface ProfileFormInput {
  displayName: string;
  homeCity: string;
  /** Raw YYYY-MM-DD from the form. Consumed here; never stored. */
  dateOfBirth?: string | undefined;
}

export interface ProfileUpdate {
  displayName: string;
  homeCity: string | null;
  /** Absent when the member did not (re)state a date of birth. */
  isMinor?: boolean;
}

export type ProfileError =
  | 'display_name_required'
  | 'display_name_too_long'
  | 'home_city_too_long'
  | 'invalid_date_of_birth';

export class ProfileValidationError extends Error {
  constructor(readonly code: ProfileError) {
    super(code);
    this.name = 'ProfileValidationError';
  }
}

/**
 * Pure: form input in, persistable fields out. Throws before any database work
 * when the input is unusable.
 */
export function buildProfileUpdate(input: ProfileFormInput, now: Date = new Date()): ProfileUpdate {
  const displayName = input.displayName.trim().replace(/\s+/g, ' ');
  if (!displayName) throw new ProfileValidationError('display_name_required');
  if (displayName.length > DISPLAY_NAME_MAX) {
    throw new ProfileValidationError('display_name_too_long');
  }

  const homeCityRaw = input.homeCity.trim().replace(/\s+/g, ' ');
  if (homeCityRaw.length > HOME_CITY_MAX) throw new ProfileValidationError('home_city_too_long');
  const homeCity = homeCityRaw || null;

  const dateOfBirth = input.dateOfBirth?.trim();
  if (!dateOfBirth) return { displayName, homeCity };

  try {
    // The one and only use of the date. `isMinor` is all that survives this line.
    return { displayName, homeCity, isMinor: deriveIsMinor(dateOfBirth, now) };
  } catch (error) {
    if (error instanceof InvalidDateOfBirthError) {
      throw new ProfileValidationError('invalid_date_of_birth');
    }
    throw error;
  }
}

interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Persist a built update. Takes the database handle as a parameter so tests can
 * observe exactly which values are bound into the statement.
 */
export async function saveProfile(
  db: SqlRunner,
  userId: string,
  update: ProfileUpdate,
): Promise<void> {
  const isMinorAssignment =
    update.isMinor === undefined ? sql`` : sql`, is_minor = ${update.isMinor}`;

  await db.execute(sql`
    UPDATE users
    SET display_name = ${update.displayName},
        home_city = ${update.homeCity}
        ${isMinorAssignment}
    WHERE id = ${userId}
  `);
}
