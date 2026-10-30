import { getDb, sql, type SQL } from '@sportkarta/db';
import type {
  DocumentKind,
  DocumentRequiredFor,
  SignatureMethod,
  SignerKind,
} from '@sportkarta/lib/clubs';

import { clubWritableGuard } from './access';
import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import type { DocumentInput, DocumentVersionInput, SignatureInput } from './input';
import {
  clubActorMay,
  clubScope,
  clubStaffWriteScope,
  clubWriteScope,
  memberSelfScope,
  type ClubActor,
} from './scope';

/**
 * Documents and waivers (0055, wave G1 — 1club's waivers): what the club asks
 * its clients to sign, in versions, and the signatures. The database numbers
 * and hashes every version, copies the hash into a signature, and admits a
 * signature only of a live document's LATEST version; who is missing what is
 * the view club_documents_missing (derived, never stored).
 *
 * A missing signature WARNS — the desk, the member card — and never refuses
 * anything (0042's attendance rule).
 *
 * Who: management writes documents (documents.manage); the front of house
 * takes a signature at the desk and is its witness (documents.sign); reading
 * them is members.view. A client signs for themselves, or a guardian for a
 * minor, from the portal (memberSelfScope) — the signer kind is the RECORD's
 * (a minor's is signed by a guardian, and only by one: 0055), never sent; a
 * second submit of the same version is the same signature. An NGO admin
 * reads, and never signs or writes as the club.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/** Placeholders the version stamp overwrites (0055: the number and hash are the database's). */
const STAMPED_VERSION = sql`0`;
const STAMPED_HASH = sql`repeat('0', 64)`;

export interface ClubDocumentSummary {
  id: string;
  kind: DocumentKind;
  title: string;
  titleBg: string;
  titleEn: string | null;
  requiredFor: DocumentRequiredFor;
  archived: boolean;
  version: number;
  /** Clients with any signature of it. */
  signed: number;
  /** Clients it asks for who have not signed what counts (club_documents_missing). */
  missing: number;
}

function titleIn(locale: string): SQL {
  return sql`CASE WHEN ${locale} = 'en' THEN coalesce(doc.title_en, doc.title_bg) ELSE doc.title_bg END`;
}

/** The documents in the actor's scope (members.view) that `where` admits, with their counts. */
function summaries(actor: ClubActor, locale: string, where: SQL): SQL {
  return sql`
    SELECT doc.id, doc.kind, doc.title_bg, doc.title_en, ${titleIn(locale)} AS title,
           doc.required_for, doc.archived_at IS NOT NULL AS archived,
           (SELECT max(v.version) FROM club_document_versions v
             WHERE v.club_id = doc.club_id AND v.document_id = doc.id) AS version,
           (SELECT count(DISTINCT s.member_id) FROM club_document_signatures s
             WHERE s.club_id = doc.club_id AND s.document_id = doc.id) AS signed,
           (SELECT count(*) FROM club_documents_missing dm
             WHERE dm.club_id = doc.club_id AND dm.document_id = doc.id) AS missing
      FROM club_documents doc
     WHERE ${clubScope(actor, 'members.view', 'doc')} AND ${where}`;
}

function summaryOf(row: Record<string, unknown>): ClubDocumentSummary {
  return {
    id: String(row.id),
    kind: String(row.kind) as DocumentKind,
    title: String(row.title),
    titleBg: String(row.title_bg),
    titleEn: text(row.title_en),
    requiredFor: String(row.required_for) as DocumentRequiredFor,
    archived: row.archived === true,
    version: Number(row.version ?? 0),
    signed: Number(row.signed ?? 0),
    missing: Number(row.missing ?? 0),
  };
}

/** The club's documents with their counts (members.view). */
export async function listDocuments(
  actor: ClubActor,
  locale: string,
): Promise<ClubDocumentSummary[]> {
  const result = await getDb().execute(sql`
    ${summaries(actor, locale, sql`true`)}
     ORDER BY doc.archived_at IS NOT NULL, doc.title_bg
     LIMIT 200
  `);
  return result.rows.map(summaryOf);
}

export interface DocumentVersion {
  id: string;
  version: number;
  /** The title this version was published (and signed) under. */
  titleBg: string;
  titleEn: string | null;
  bodyBg: string;
  bodyEn: string | null;
  requiresResign: boolean;
  sha256: string;
  publishedAt: string;
  /** The publishing member of staff, while they are on the staff. */
  publishedByName: string | null;
}

export interface DocumentSignature {
  id: string;
  memberId: string;
  memberName: string;
  version: number;
  signerKind: SignerKind;
  signerName: string;
  method: SignatureMethod;
  witnessName: string | null;
  signedAt: string;
}

export interface ClubDocumentDetail extends ClubDocumentSummary {
  /** Newest first, at most 50. */
  versions: DocumentVersion[];
  /** Newest first, at most 200. */
  signatures: DocumentSignature[];
  /** Clients it asks for who have not signed what counts, at most 200. */
  missingMembers: { id: string; name: string }[];
}

/** One document with its versions, its signatures and who is missing it (members.view). */
export async function documentForStaff(
  actor: ClubActor,
  documentId: string,
  locale: string,
): Promise<ClubDocumentDetail | null> {
  const db = getDb();
  const found = (await db.execute(summaries(actor, locale, sql`doc.id = ${documentId}::uuid`)))
    .rows[0];
  if (!found) return null;
  const summary = summaryOf(found);
  const [versions, signatures, missing] = await Promise.all([
    db.execute(sql`
      SELECT dv.id, dv.version, dv.title_bg, dv.title_en, dv.body_bg, dv.body_en,
             dv.requires_resign, dv.body_sha256, dv.published_at,
             st.display_name AS published_by_name
        FROM club_document_versions dv
        LEFT JOIN club_staff st ON st.club_id = dv.club_id AND st.user_id = dv.published_by
       WHERE dv.document_id = ${documentId}::uuid AND ${clubScope(actor, 'members.view', 'dv')}
       ORDER BY dv.version DESC
       LIMIT 50
    `),
    db.execute(sql`
      SELECT dsg.id, dsg.member_id, m.display_name, dv.version, dsg.signer_kind, dsg.signer_name,
             dsg.method, st.display_name AS witness_name, dsg.signed_at
        FROM club_document_signatures dsg
        JOIN club_members m ON m.club_id = dsg.club_id AND m.id = dsg.member_id
        JOIN club_document_versions dv ON dv.club_id = dsg.club_id AND dv.id = dsg.version_id
        LEFT JOIN club_staff st ON st.club_id = dsg.club_id AND st.user_id = dsg.witnessed_by
       WHERE dsg.document_id = ${documentId}::uuid AND ${clubScope(actor, 'members.view', 'dsg')}
       ORDER BY dsg.signed_at DESC
       LIMIT 200
    `),
    db.execute(sql`
      SELECT m.id, m.display_name
        FROM club_documents_missing dm
        JOIN club_members m ON m.club_id = dm.club_id AND m.id = dm.member_id
       WHERE dm.document_id = ${documentId}::uuid AND ${clubScope(actor, 'members.view', 'dm')}
       ORDER BY m.display_name
       LIMIT 200
    `),
  ]);
  return {
    ...summary,
    versions: versions.rows.map((row) => ({
      id: String(row.id),
      version: Number(row.version),
      titleBg: String(row.title_bg),
      titleEn: text(row.title_en),
      bodyBg: String(row.body_bg),
      bodyEn: text(row.body_en),
      requiresResign: row.requires_resign === true,
      sha256: String(row.body_sha256),
      publishedAt: iso(row.published_at),
      publishedByName: text(row.published_by_name),
    })),
    signatures: signatures.rows.map((row) => ({
      id: String(row.id),
      memberId: String(row.member_id),
      memberName: String(row.display_name),
      version: Number(row.version),
      signerKind: String(row.signer_kind) as SignerKind,
      signerName: String(row.signer_name),
      method: String(row.method) as SignatureMethod,
      witnessName: text(row.witness_name),
      signedAt: iso(row.signed_at),
    })),
    missingMembers: missing.rows.map((row) => ({
      id: String(row.id),
      name: String(row.display_name),
    })),
  };
}

export type SaveDocumentResult =
  { ok: true; documentId: string } | { ok: false; error: 'not_allowed' };

/**
 * A new document with its first version, or edited settings (kind, who must
 * sign) — documents.manage. The title and the text change only by a new
 * version, so a signature keeps what it signed.
 */
export async function saveDocument(
  db: TransactionalDb,
  actor: ClubActor,
  input: DocumentInput,
  documentId: string | null,
  firstVersion: DocumentVersionInput | null,
): Promise<SaveDocumentResult> {
  return db.transaction(async (tx): Promise<SaveDocumentResult> => {
    if (documentId === null) {
      if (!firstVersion) return { ok: false, error: 'not_allowed' };
      const created = await tx.execute(sql`
        INSERT INTO club_documents (club_id, kind, title_bg, title_en, required_for, created_by)
        SELECT ${actor.clubId}::uuid, ${input.kind}, ${firstVersion.titleBg},
               ${firstVersion.titleEn}, ${input.requiredFor}, ${actor.userId}
         WHERE ${clubActorMay(actor, 'documents.manage', { write: true })}
        RETURNING id
      `);
      const id = text(created.rows[0]?.id);
      if (!id) return { ok: false, error: 'not_allowed' };
      const first = await tx.execute(sql`
        INSERT INTO club_document_versions (club_id, document_id, version, title_bg, title_en,
                                            body_bg, body_en, requires_resign, body_sha256,
                                            published_by)
        SELECT doc.club_id, doc.id, ${STAMPED_VERSION}, ${firstVersion.titleBg},
               ${firstVersion.titleEn}, ${firstVersion.bodyBg}, ${firstVersion.bodyEn}, true,
               ${STAMPED_HASH}, ${actor.userId}
          FROM club_documents doc
         WHERE doc.id = ${id}::uuid AND ${clubWriteScope(actor, 'documents.manage', 'doc')}
        RETURNING id
      `);
      // A document without its text could never be signed nor given one.
      if (first.rows.length === 0) throw new Error('club document: the first version was refused');
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'document_saved',
        detail: { documentId: id, created: true },
      });
      return { ok: true, documentId: id };
    }
    const updated = await tx.execute(sql`
      UPDATE club_documents doc
         SET kind = ${input.kind}, required_for = ${input.requiredFor}
       WHERE doc.id = ${documentId}::uuid AND ${clubWriteScope(actor, 'documents.manage', 'doc')}
      RETURNING doc.id
    `);
    if (updated.rows.length === 0) return { ok: false, error: 'not_allowed' };
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'document_saved',
      detail: { documentId },
    });
    return { ok: true, documentId };
  });
}

/**
 * A new version of a live document's text (documents.manage). Its number and
 * hash are the database's; `requiresResign` decides whether earlier
 * signatures still count.
 */
export async function publishVersion(
  db: TransactionalDb,
  actor: ClubActor,
  documentId: string,
  input: DocumentVersionInput,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const created = await tx.execute(sql`
      INSERT INTO club_document_versions (club_id, document_id, version, title_bg, title_en,
                                          body_bg, body_en, requires_resign, body_sha256,
                                          published_by)
      SELECT doc.club_id, doc.id, ${STAMPED_VERSION}, ${input.titleBg}, ${input.titleEn},
             ${input.bodyBg}, ${input.bodyEn}, ${input.requiresResign}, ${STAMPED_HASH},
             ${actor.userId}
        FROM club_documents doc
       WHERE doc.id = ${documentId}::uuid AND doc.archived_at IS NULL
         AND ${clubWriteScope(actor, 'documents.manage', 'doc')}
      RETURNING version
    `);
    const row = created.rows[0];
    if (!row) return null;
    const version = Number(row.version);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'document_versioned',
      detail: { documentId, version, requiresResign: input.requiresResign },
    });
    return version;
  });
}

/** Archive (it asks nobody any more; its signatures stay) or restore — documents.manage. */
export async function setDocumentArchived(
  db: TransactionalDb,
  actor: ClubActor,
  documentId: string,
  archived: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx.execute(sql`
      UPDATE club_documents doc
         SET archived_at = ${archived ? sql`now()` : sql`NULL`}
       WHERE doc.id = ${documentId}::uuid
         AND ${archived ? sql`doc.archived_at IS NULL` : sql`doc.archived_at IS NOT NULL`}
         AND ${clubWriteScope(actor, 'documents.manage', 'doc')}
      RETURNING doc.id
    `);
    if (changed.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: archived ? 'document_archived' : 'document_restored',
      detail: { documentId },
    });
    return true;
  });
}

export interface MemberDocument {
  documentId: string;
  title: string;
  kind: DocumentKind;
  requiredFor: DocumentRequiredFor;
  /** The latest version — what a new signature signs. */
  versionId: string;
  version: number;
  /** The document asks this client and what they signed does not count (or nothing). */
  missing: boolean;
  /** Their newest signature of it, any version. */
  lastSigned: {
    id: string;
    version: number;
    signedAt: string;
    signerName: string;
    method: SignatureMethod;
  } | null;
}

/**
 * A live document is offered to a record when it is optional (asks nobody),
 * when it asks this record and the record has not signed what counts, or
 * when the record has signed it before — never a minors' consent to an adult
 * nor a trial's rules to everybody. `doc` and the record's id in scope.
 */
function offeredTo(memberId: SQL): SQL {
  return sql`(doc.required_for = 'none'
    OR EXISTS (SELECT 1 FROM club_documents_missing dm
                WHERE dm.club_id = doc.club_id AND dm.document_id = doc.id
                  AND dm.member_id = ${memberId})
    OR EXISTS (SELECT 1 FROM club_document_signatures os
                WHERE os.club_id = doc.club_id AND os.document_id = doc.id
                  AND os.member_id = ${memberId}))`;
}

/** The club's live documents as they stand for one client — the member card (members.view). */
export async function memberDocuments(
  actor: ClubActor,
  memberId: string,
  locale: string,
): Promise<MemberDocument[]> {
  const result = await getDb().execute(sql`
    SELECT doc.id, ${titleIn(locale)} AS title, doc.kind, doc.required_for,
           lv.id AS version_id, lv.version,
           EXISTS (SELECT 1 FROM club_documents_missing dm
                    WHERE dm.club_id = doc.club_id AND dm.document_id = doc.id
                      AND dm.member_id = ${memberId}::uuid) AS missing,
           ls.id AS signature_id, ls.version AS signed_version, ls.signed_at, ls.signer_name,
           ls.method
      FROM club_documents doc
      JOIN LATERAL (SELECT v.id, v.version FROM club_document_versions v
                     WHERE v.club_id = doc.club_id AND v.document_id = doc.id
                     ORDER BY v.version DESC LIMIT 1) lv ON true
      LEFT JOIN LATERAL (SELECT s.id, sv.version, s.signed_at, s.signer_name, s.method
                           FROM club_document_signatures s
                           JOIN club_document_versions sv ON sv.club_id = s.club_id
                                                         AND sv.id = s.version_id
                          WHERE s.club_id = doc.club_id AND s.document_id = doc.id
                            AND s.member_id = ${memberId}::uuid
                          ORDER BY s.signed_at DESC LIMIT 1) ls ON true
     WHERE doc.archived_at IS NULL AND ${clubScope(actor, 'members.view', 'doc')}
       AND EXISTS (SELECT 1 FROM club_members m
                    WHERE m.club_id = doc.club_id AND m.id = ${memberId}::uuid)
       AND ${offeredTo(sql`${memberId}::uuid`)}
     ORDER BY missing DESC, doc.title_bg
  `);
  return result.rows.map((row) => ({
    documentId: String(row.id),
    title: String(row.title),
    kind: String(row.kind) as DocumentKind,
    requiredFor: String(row.required_for) as DocumentRequiredFor,
    versionId: String(row.version_id),
    version: Number(row.version),
    missing: row.missing === true,
    lastSigned:
      row.signature_id === null || row.signature_id === undefined
        ? null
        : {
            id: String(row.signature_id),
            version: Number(row.signed_version),
            signedAt: iso(row.signed_at),
            signerName: String(row.signer_name),
            method: String(row.method) as SignatureMethod,
          },
  }));
}

/** Of `memberIds`, the clients missing a document — the «Липсва декларация» warning (members.view). */
export async function missingFor(actor: ClubActor, memberIds: string[]): Promise<Set<string>> {
  if (memberIds.length === 0) return new Set();
  const result = await getDb().execute(sql`
    SELECT DISTINCT dm.member_id FROM club_documents_missing dm
     WHERE ${clubScope(actor, 'members.view', 'dm')}
       AND dm.member_id = ANY(${sql.param(memberIds)}::uuid[])
  `);
  return new Set(result.rows.map((row) => String(row.member_id)));
}

export type SignResult =
  | { ok: true }
  | { ok: false; error: 'not_allowed' | 'stale_version' | 'guardian_minor' | 'already_signed' };

/** Who signs a record, by the record: a guardian for a minor, else the client. */
const SIGNER_KIND = sql`CASE WHEN m.is_minor THEN 'guardian' ELSE 'self' END`;

function signRefusal(error: unknown): SignResult | null {
  const constraint = violatedConstraint(error);
  // The same version is already signed for this client — in the portal, a
  // second submit; at the desk, the client signed meanwhile (this witness and
  // typed name were not recorded, and the desk is told so).
  if (constraint === 'club_document_signatures_once') return { ok: false, error: 'already_signed' };
  if (constraint === 'club_document_signatures_current')
    return { ok: false, error: 'stale_version' };
  if (constraint === 'club_document_signatures_guardian_minor') {
    return { ok: false, error: 'guardian_minor' };
  }
  return null;
}

/**
 * A signature taken at the desk (documents.sign): the member of staff is its
 * witness — the club's own staff only (clubStaffWriteScope: an NGO admin
 * never witnesses for a club). `versionId` is the version the signer was
 * shown — refused if a newer one was published meanwhile.
 */
export async function signAtDesk(
  db: TransactionalDb,
  actor: ClubActor,
  memberId: string,
  documentId: string,
  versionId: string,
  input: SignatureInput,
): Promise<SignResult> {
  try {
    return await db.transaction(async (tx): Promise<SignResult> => {
      const created = await tx.execute(sql`
        INSERT INTO club_document_signatures (club_id, document_id, version_id, member_id,
                                              signer_kind, signer_name, method, witnessed_by,
                                              body_sha256)
        SELECT m.club_id, ${documentId}::uuid, ${versionId}::uuid, m.id, ${SIGNER_KIND},
               ${input.signerName}, 'desk', ${actor.userId}, ${STAMPED_HASH}
          FROM club_members m
         WHERE m.id = ${memberId}::uuid AND m.archived_at IS NULL
           AND ${clubStaffWriteScope(actor, 'documents.sign', 'm')}
        RETURNING id
      `);
      if (created.rows.length === 0) return { ok: false, error: 'not_allowed' };
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'document_signed',
        subjectMemberId: memberId,
        detail: { documentId, versionId, method: 'desk' },
      });
      return { ok: true };
    });
  } catch (error: unknown) {
    const refused = signRefusal(error);
    if (refused) return refused;
    throw error;
  }
}

/**
 * The account may sign `m` from the portal: an adult's own record, or a
 * minor's as the guardian on the record.
 */
function portalSigner(userId: string): SQL {
  return sql`CASE WHEN m.is_minor
    THEN EXISTS (SELECT 1 FROM club_member_links gl
                  WHERE gl.member_id = m.guardian_member_id AND gl.user_id = ${userId}
                    AND gl.status = 'active')
    ELSE EXISTS (SELECT 1 FROM club_member_links sl
                  WHERE sl.member_id = m.id AND sl.user_id = ${userId}
                    AND sl.status = 'active') END`;
}

export interface PortalDocument {
  memberId: string;
  memberName: string;
  /** The account's own record (else a child it is the guardian of). */
  own: boolean;
  documentId: string;
  title: string;
  kind: DocumentKind;
  requiredFor: DocumentRequiredFor;
  versionId: string;
  version: number;
  body: string;
  missing: boolean;
  signedAt: string | null;
  /** This account signs it (else a guardian does — a minor's own account). */
  canSign: boolean;
}

/** The club's live documents for the account's own record and its children's — the portal. */
export async function portalDocuments(
  userId: string,
  clubId: string,
  locale: string,
): Promise<PortalDocument[]> {
  const result = await getDb().execute(sql`
    SELECT m.id AS member_id, m.display_name,
           EXISTS (SELECT 1 FROM club_member_links ol
                    WHERE ol.member_id = m.id AND ol.user_id = ${userId}
                      AND ol.status = 'active') AS own,
           doc.id, ${titleIn(locale)} AS title, doc.kind, doc.required_for,
           lv.id AS version_id, lv.version,
           CASE WHEN ${locale} = 'en' THEN coalesce(lv.body_en, lv.body_bg) ELSE lv.body_bg END
             AS body,
           EXISTS (SELECT 1 FROM club_documents_missing dm
                    WHERE dm.club_id = doc.club_id AND dm.document_id = doc.id
                      AND dm.member_id = m.id) AS missing,
           (SELECT max(s.signed_at) FROM club_document_signatures s
             WHERE s.club_id = doc.club_id AND s.document_id = doc.id AND s.member_id = m.id)
             AS signed_at,
           ${portalSigner(userId)} AS can_sign
      FROM club_members m
      JOIN club_documents doc ON doc.club_id = m.club_id AND doc.archived_at IS NULL
      JOIN LATERAL (SELECT v.id, v.version, v.body_bg, v.body_en FROM club_document_versions v
                     WHERE v.club_id = doc.club_id AND v.document_id = doc.id
                     ORDER BY v.version DESC LIMIT 1) lv ON true
     WHERE ${memberSelfScope(userId, clubId, 'm')} AND m.archived_at IS NULL
       AND ${offeredTo(sql`m.id`)}
     ORDER BY own DESC, m.display_name, missing DESC, doc.title_bg
     LIMIT 100
  `);
  return result.rows.map((row) => ({
    memberId: String(row.member_id),
    memberName: String(row.display_name),
    own: row.own === true,
    documentId: String(row.id),
    title: String(row.title),
    kind: String(row.kind) as DocumentKind,
    requiredFor: String(row.required_for) as DocumentRequiredFor,
    versionId: String(row.version_id),
    version: Number(row.version),
    body: String(row.body),
    missing: row.missing === true,
    signedAt: isoOrNull(row.signed_at),
    canSign: row.can_sign === true,
  }));
}

/**
 * How many documents the portal offers the account, and how many of them it
 * should sign — the portal home's link (no texts fetched).
 */
export async function portalDocumentCounts(
  userId: string,
  clubId: string,
): Promise<{ offered: number; toSign: number }> {
  const row = (
    await getDb().execute(sql`
      SELECT count(*)::int AS offered,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM club_documents_missing dm
                WHERE dm.club_id = doc.club_id AND dm.document_id = doc.id
                  AND dm.member_id = m.id) AND ${portalSigner(userId)})::int AS to_sign
        FROM club_members m
        JOIN club_documents doc ON doc.club_id = m.club_id AND doc.archived_at IS NULL
       WHERE ${memberSelfScope(userId, clubId, 'm')} AND m.archived_at IS NULL
         AND ${offeredTo(sql`m.id`)}
    `)
  ).rows[0];
  return { offered: Number(row?.offered ?? 0), toSign: Number(row?.to_sign ?? 0) };
}

/**
 * The client signs from the portal — their own record, or a child's as its
 * guardian. A minor's own account does not sign their record: a guardian does
 * (portalSigner). The club must be writable.
 */
export async function signInPortal(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  memberId: string,
  documentId: string,
  versionId: string,
  signerName: string,
): Promise<SignResult> {
  try {
    return await db.transaction(async (tx): Promise<SignResult> => {
      const created = await tx.execute(sql`
        INSERT INTO club_document_signatures (club_id, document_id, version_id, member_id,
                                              signer_kind, signer_name, method, body_sha256)
        SELECT m.club_id, ${documentId}::uuid, ${versionId}::uuid, m.id, ${SIGNER_KIND},
               ${signerName}, 'portal', ${STAMPED_HASH}
          FROM club_members m
         WHERE m.id = ${memberId}::uuid AND m.archived_at IS NULL
           AND ${memberSelfScope(userId, clubId, 'm')} AND ${portalSigner(userId)}
           AND ${clubWritableGuard(clubId)}
        RETURNING id
      `);
      if (created.rows.length === 0) return { ok: false, error: 'not_allowed' };
      await recordClubAudit(tx, {
        clubId,
        by: { kind: 'member', userId },
        action: 'document_signed',
        subjectMemberId: memberId,
        detail: { documentId, versionId, method: 'portal' },
      });
      return { ok: true };
    });
  } catch (error: unknown) {
    const refused = signRefusal(error);
    if (refused) return refused;
    throw error;
  }
}

export interface SignatureRecord {
  id: string;
  clubName: string;
  documentTitle: string;
  version: number;
  bodyBg: string;
  bodyEn: string | null;
  sha256: string;
  memberName: string;
  signerKind: SignerKind;
  signerName: string;
  method: SignatureMethod;
  witnessName: string | null;
  signedAt: string;
}

/** One signature with the exact text it signed — the print view (members.view). */
export async function signatureForPrint(
  actor: ClubActor,
  signatureId: string,
): Promise<SignatureRecord | null> {
  const row = (
    await getDb().execute(sql`
      SELECT dsg.id, c.name_bg AS club_name, dv.title_bg, dv.version, dv.body_bg, dv.body_en,
             dsg.body_sha256, m.display_name, dsg.signer_kind, dsg.signer_name, dsg.method,
             st.display_name AS witness_name, dsg.signed_at
        FROM club_document_signatures dsg
        JOIN clubs c ON c.id = dsg.club_id
        JOIN club_document_versions dv ON dv.club_id = dsg.club_id AND dv.id = dsg.version_id
        JOIN club_members m ON m.club_id = dsg.club_id AND m.id = dsg.member_id
        LEFT JOIN club_staff st ON st.club_id = dsg.club_id AND st.user_id = dsg.witnessed_by
       WHERE dsg.id = ${signatureId}::uuid AND ${clubScope(actor, 'members.view', 'dsg')}
    `)
  ).rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    clubName: String(row.club_name),
    documentTitle: String(row.title_bg),
    version: Number(row.version),
    bodyBg: String(row.body_bg),
    bodyEn: text(row.body_en),
    sha256: String(row.body_sha256),
    memberName: String(row.display_name),
    signerKind: String(row.signer_kind) as SignerKind,
    signerName: String(row.signer_name),
    method: String(row.method) as SignatureMethod,
    witnessName: text(row.witness_name),
    signedAt: iso(row.signed_at),
  };
}
