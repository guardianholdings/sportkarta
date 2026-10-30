/**
 * Club documents (wave G1, 0055) — waivers, house rules, a parent's consent:
 * the closed vocabularies and limits the office, the portal and the database
 * share. A document's TEXT lives in versions (append-only, hashed by the
 * database); a signature names the version it signed.
 */

/** club_documents_kind_known (0055). */
export const DOCUMENT_KINDS = ['waiver', 'rules', 'consent', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** club_documents_required_known (0055): who must sign it. */
export const DOCUMENT_REQUIRED_FOR = ['none', 'all', 'minors', 'trial'] as const;
export type DocumentRequiredFor = (typeof DOCUMENT_REQUIRED_FOR)[number];

/** club_document_signatures_signer_known (0055). */
export const SIGNER_KINDS = ['self', 'guardian'] as const;
export type SignerKind = (typeof SIGNER_KINDS)[number];

/** club_document_signatures_method_known (0055). */
export const SIGNATURE_METHODS = ['portal', 'desk'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

export const DOCUMENT_TITLE_MAX = 120;
export const DOCUMENT_BODY_MAX = 20000;
export const SIGNER_NAME_MAX = 120;

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export function isDocumentRequiredFor(value: unknown): value is DocumentRequiredFor {
  return typeof value === 'string' && (DOCUMENT_REQUIRED_FOR as readonly string[]).includes(value);
}

/*
 * A version's hash is the database's (0055, club_document_versions_stamp):
 * hex sha256( H(title_bg) || H(title_en or '') || H(body_bg) || H(body_en or '') )
 * with H = sha256 of the UTF-8 bytes — four fixed parts, so no two versions
 * share it. Computing it needs a digest, which this client-safe module does
 * not import.
 */
