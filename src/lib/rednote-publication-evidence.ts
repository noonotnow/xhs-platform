import type { QueryResultRow } from 'pg';
import { sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  isRednoteNoteId,
  normalizeRednoteShareUrl,
} from '@/lib/rednote-publication';

export type RednotePublicationEvidenceInput =
  | {
      contractVersion: 'rednote-evidence/v1';
      kind: 'authenticated_account';
      capturedAt: string;
      accountId: string;
      ownership: 'owned' | 'account_mismatch';
    }
  | {
      contractVersion: 'rednote-evidence/v1';
      kind: 'xsec_access';
      capturedAt: string;
      accessible: true;
    }
  | {
      contractVersion: 'rednote-evidence/v1';
      kind: 'public_index';
      capturedAt: string;
      status: 'indexed' | 'pending' | 'not_found';
      publicUrl?: string;
    }
  | {
      contractVersion: 'rednote-evidence/v1';
      kind: 'removed_restricted';
      capturedAt: string;
      status: 'removed' | 'restricted';
    };

interface EvidenceSummaryRow extends QueryResultRow {
  note_id: string;
  expected_account_id: string | null;
  authenticated_account_id: string | null;
  authenticated_account_at: Date | string | null;
  xsec_accessible_at: Date | string | null;
  public_index_status: 'indexed' | 'pending' | 'not_found' | null;
  public_index_checked_at: Date | string | null;
  public_url: string | null;
  restriction_status: 'removed' | 'restricted' | null;
  restriction_reported_at: Date | string | null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length
    || actual.some((key, index) => key !== sorted[index])
  ) {
    throw new LocalPublishJobError(
      'Evidence body contains unsupported fields',
      'VALIDATION_ERROR',
      400,
    );
  }
}

function timestamp(value: unknown) {
  if (typeof value !== 'string') {
    throw new LocalPublishJobError(
      'capturedAt must be an ISO timestamp',
      'VALIDATION_ERROR',
      400,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new LocalPublishJobError(
      'capturedAt must be an ISO timestamp',
      'VALIDATION_ERROR',
      400,
    );
  }
  return parsed.toISOString();
}

function safeAccountId(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    throw new LocalPublishJobError(
      'accountId must be between 1 and 200 characters',
      'VALIDATION_ERROR',
      400,
    );
  }
  return value.trim();
}

export function parseRednotePublicationEvidence(
  noteId: string,
  value: unknown,
): RednotePublicationEvidenceInput {
  if (!isRednoteNoteId(noteId)) {
    throw new LocalPublishJobError('Invalid RedNote Note ID', 'VALIDATION_ERROR', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('Evidence body must be an object', 'VALIDATION_ERROR', 400);
  }
  const body = value as Record<string, unknown>;
  if (body.contractVersion !== 'rednote-evidence/v1') {
    throw new LocalPublishJobError(
      'contractVersion must be rednote-evidence/v1',
      'VALIDATION_ERROR',
      400,
    );
  }
  const capturedAt = timestamp(body.capturedAt);
  if (body.kind === 'authenticated_account') {
    exactKeys(body, ['accountId', 'capturedAt', 'contractVersion', 'kind', 'ownership']);
    if (!['owned', 'account_mismatch'].includes(String(body.ownership))) {
      throw new LocalPublishJobError(
        'ownership must be owned or account_mismatch',
        'VALIDATION_ERROR',
        400,
      );
    }
    return {
      contractVersion: 'rednote-evidence/v1',
      kind: 'authenticated_account',
      capturedAt,
      accountId: safeAccountId(body.accountId),
      ownership: body.ownership as 'owned' | 'account_mismatch',
    };
  }
  if (body.kind === 'xsec_access') {
    exactKeys(body, ['accessible', 'capturedAt', 'contractVersion', 'kind']);
    if (body.accessible !== true) {
      throw new LocalPublishJobError(
        'accessible must be true',
        'VALIDATION_ERROR',
        400,
      );
    }
    return {
      contractVersion: 'rednote-evidence/v1',
      kind: 'xsec_access',
      capturedAt,
      accessible: true,
    };
  }
  if (body.kind === 'public_index') {
    exactKeys(body, body.publicUrl === undefined
      ? ['capturedAt', 'contractVersion', 'kind', 'status']
      : ['capturedAt', 'contractVersion', 'kind', 'publicUrl', 'status']);
    if (!['indexed', 'pending', 'not_found'].includes(String(body.status))) {
      throw new LocalPublishJobError(
        'status must be indexed, pending, or not_found',
        'VALIDATION_ERROR',
        400,
      );
    }
    if (body.publicUrl !== undefined) {
      if (
        typeof body.publicUrl !== 'string'
        || normalizeRednoteShareUrl(noteId, body.publicUrl) !== body.publicUrl
        || body.status !== 'indexed'
      ) {
        throw new LocalPublishJobError(
          'publicUrl must be the query-free explore URL for an indexed note',
          'VALIDATION_ERROR',
          400,
        );
      }
    }
    return {
      contractVersion: 'rednote-evidence/v1',
      kind: 'public_index',
      capturedAt,
      status: body.status as 'indexed' | 'pending' | 'not_found',
      ...(body.publicUrl ? { publicUrl: body.publicUrl as string } : {}),
    };
  }
  if (body.kind === 'removed_restricted') {
    exactKeys(body, ['capturedAt', 'contractVersion', 'kind', 'status']);
    if (!['removed', 'restricted'].includes(String(body.status))) {
      throw new LocalPublishJobError(
        'status must be removed or restricted',
        'VALIDATION_ERROR',
        400,
      );
    }
    return {
      contractVersion: 'rednote-evidence/v1',
      kind: 'removed_restricted',
      capturedAt,
      status: body.status as 'removed' | 'restricted',
    };
  }
  throw new LocalPublishJobError(
    'kind must be authenticated_account, xsec_access, public_index, or removed_restricted',
    'VALIDATION_ERROR',
    400,
  );
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : undefined;
}

function summary(row: EvidenceSummaryRow) {
  return {
    noteId: row.note_id,
    expectedAccountId: row.expected_account_id ?? undefined,
    authenticatedAccount: row.authenticated_account_id && row.authenticated_account_at
      ? {
          accountId: row.authenticated_account_id,
          capturedAt: iso(row.authenticated_account_at),
        }
      : undefined,
    xsecAccess: row.xsec_accessible_at
      ? { accessible: true as const, capturedAt: iso(row.xsec_accessible_at) }
      : undefined,
    publicIndex: row.public_index_status && row.public_index_checked_at
      ? {
          status: row.public_index_status,
          checkedAt: iso(row.public_index_checked_at),
          ...(row.public_url ? { publicUrl: row.public_url } : {}),
        }
      : undefined,
    restriction: row.restriction_status && row.restriction_reported_at
      ? {
          status: row.restriction_status,
          reportedAt: iso(row.restriction_reported_at),
        }
      : undefined,
  };
}

export async function recordRednotePublicationEvidence(
  workspaceId: string,
  noteId: string,
  evidence: RednotePublicationEvidenceInput,
) {
  const accountId = evidence.kind === 'authenticated_account'
    ? evidence.accountId
    : null;
  const suppliedStatus = evidence.kind === 'authenticated_account'
    ? evidence.ownership
    : evidence.kind === 'xsec_access'
      ? 'accessible'
      : evidence.status;
  const publicUrl = evidence.kind === 'public_index'
    ? evidence.publicUrl ?? null
    : null;
  const result = await sql<EvidenceSummaryRow>`
    WITH target AS (
      SELECT *
      FROM local_publish_jobs
      WHERE workspace_id = ${workspaceId}
        AND note_id = ${noteId}
        AND status IN ('verified', 'reconciled', 'verification_pending')
      ORDER BY created_at DESC
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO rednote_publication_evidence(
        workspace_id, local_publish_job_id, attempt_id, note_id,
        evidence_kind, captured_at, account_id, evidence_status, public_url
      )
      SELECT workspace_id, id,
        (SELECT attempt.id FROM rednote_publish_attempts AS attempt
         WHERE attempt.workspace_id = target.workspace_id
           AND attempt.source_local_publish_job_id = target.id
         ORDER BY attempt.created_at DESC LIMIT 1),
        ${noteId}, ${evidence.kind}, ${evidence.capturedAt}::timestamptz,
        ${accountId},
        CASE
          WHEN ${evidence.kind} = 'authenticated_account'
            AND (
              snapshot->>'expectedAccountId' IS DISTINCT FROM ${accountId}
              OR ${suppliedStatus} <> 'owned'
            )
            THEN 'account_mismatch'
          ELSE ${suppliedStatus}
        END,
        ${publicUrl}
      FROM target
      RETURNING local_publish_job_id
    ),
    updated AS (
      UPDATE local_publish_jobs AS job
      SET authenticated_account_id = CASE
            WHEN ${evidence.kind} = 'authenticated_account'
              AND job.snapshot->>'expectedAccountId' = ${accountId}
              AND ${suppliedStatus} = 'owned'
              AND (
                job.authenticated_account_at IS NULL
                OR job.authenticated_account_at <= ${evidence.capturedAt}::timestamptz
              )
              THEN ${accountId}
            ELSE job.authenticated_account_id
          END,
          authenticated_account_at = CASE
            WHEN ${evidence.kind} = 'authenticated_account'
              AND job.snapshot->>'expectedAccountId' = ${accountId}
              AND ${suppliedStatus} = 'owned'
              AND (
                job.authenticated_account_at IS NULL
                OR job.authenticated_account_at <= ${evidence.capturedAt}::timestamptz
              )
              THEN ${evidence.capturedAt}::timestamptz
            ELSE job.authenticated_account_at
          END,
          xsec_accessible_at = CASE
            WHEN ${evidence.kind} = 'xsec_access'
              AND (
                job.xsec_accessible_at IS NULL
                OR job.xsec_accessible_at <= ${evidence.capturedAt}::timestamptz
              )
              THEN ${evidence.capturedAt}::timestamptz
            ELSE job.xsec_accessible_at
          END,
          public_index_status = CASE
            WHEN ${evidence.kind} = 'public_index'
              AND (
                job.public_index_checked_at IS NULL
                OR job.public_index_checked_at <= ${evidence.capturedAt}::timestamptz
              )
              THEN ${suppliedStatus}
            ELSE job.public_index_status
          END,
          public_index_checked_at = CASE
            WHEN ${evidence.kind} = 'public_index'
              AND (
                job.public_index_checked_at IS NULL
                OR job.public_index_checked_at <= ${evidence.capturedAt}::timestamptz
              )
              THEN ${evidence.capturedAt}::timestamptz
            ELSE job.public_index_checked_at
          END,
          share_url = CASE
            WHEN ${evidence.kind} = 'public_index'
              AND ${suppliedStatus} = 'indexed'
              AND ${publicUrl} IS NOT NULL
              AND (
                job.public_index_checked_at IS NULL
                OR job.public_index_checked_at <= ${evidence.capturedAt}::timestamptz
              )
              THEN ${publicUrl}
            ELSE job.share_url
          END,
          provider_restriction_status = CASE
            WHEN ${evidence.kind} = 'removed_restricted'
              AND (
                job.provider_restriction_reported_at IS NULL
                OR job.provider_restriction_reported_at <= ${evidence.capturedAt}::timestamptz
              )
              THEN ${suppliedStatus}
            ELSE job.provider_restriction_status
          END,
          provider_restriction_reported_at = CASE
            WHEN ${evidence.kind} = 'removed_restricted'
              AND (
                job.provider_restriction_reported_at IS NULL
                OR job.provider_restriction_reported_at <= ${evidence.capturedAt}::timestamptz
              )
              THEN ${evidence.capturedAt}::timestamptz
            ELSE job.provider_restriction_reported_at
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE job.id IN (SELECT local_publish_job_id FROM inserted)
      RETURNING
        note_id,
        snapshot->>'expectedAccountId' AS expected_account_id,
        authenticated_account_id,
        authenticated_account_at,
        xsec_accessible_at,
        public_index_status,
        public_index_checked_at,
        share_url AS public_url,
        provider_restriction_status AS restriction_status,
        provider_restriction_reported_at AS restriction_reported_at
    )
    SELECT * FROM updated
  `;
  const row = result.rows[0];
  if (!row) {
    throw new LocalPublishJobError(
      'No publication with this Note ID is eligible for evidence updates',
      'PUBLICATION_NOT_FOUND',
      404,
    );
  }
  if (
    evidence.kind === 'authenticated_account'
    && (
      evidence.ownership !== 'owned'
      || row.expected_account_id !== evidence.accountId
    )
  ) {
    throw new LocalPublishJobError(
      'Authenticated Creator account does not match expectedAccountId',
      'ACCOUNT_MISMATCH',
      409,
    );
  }
  return summary(row);
}

export async function readRednotePublicationEvidence(
  workspaceId: string,
  noteId: string,
) {
  if (!isRednoteNoteId(noteId)) {
    throw new LocalPublishJobError('Invalid RedNote Note ID', 'VALIDATION_ERROR', 400);
  }
  const result = await sql<EvidenceSummaryRow>`
    SELECT
      note_id,
      snapshot->>'expectedAccountId' AS expected_account_id,
      authenticated_account_id,
      authenticated_account_at,
      xsec_accessible_at,
      public_index_status,
      public_index_checked_at,
      share_url AS public_url,
      provider_restriction_status AS restriction_status,
      provider_restriction_reported_at AS restriction_reported_at
    FROM local_publish_jobs
    WHERE workspace_id = ${workspaceId}
      AND note_id = ${noteId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!result.rows[0]) {
    throw new LocalPublishJobError(
      'No publication with this Note ID was found',
      'PUBLICATION_NOT_FOUND',
      404,
    );
  }
  return summary(result.rows[0]);
}
