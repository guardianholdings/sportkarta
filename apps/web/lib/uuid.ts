const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for a canonical UUID string. Check it BEFORE a value from a URL reaches
 * a `::uuid` comparison: Postgres answers a malformed one with an error, not
 * an empty result, so an unguarded route turns a scanner's junk path into a
 * 500 and a log line — noise that buries the errors the operator looks for.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
