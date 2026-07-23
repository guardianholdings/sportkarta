/**
 * Client-safe display-name resolver. The implementation moved to
 * `@sportkarta/lib/cities` when the worker started needing the same city
 * identity for the weekly digest email — one definition, two processes.
 * Re-exported here so the existing import sites keep working.
 */
export { cityDisplayName } from '@sportkarta/lib/cities';
