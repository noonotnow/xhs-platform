import { isDeepStrictEqual } from 'util';
import type { QueryResultRow } from 'pg';
import { sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type {
  ExternalPostSnapshot,
  ExternalReconciliationOutcome,
  ExternalReconciliationStatus,
  ExternalReconciliationSummary,
} from '@/types/local-publish-job';

const PROCESSING_LEASE_MS = 5 * 60 * 1000;

interface ExternalReconciliationRow extends QueryResultRow {
  id: string;
  note_id: string;
  share_url: string;
  snapshot: ExternalPostSnapshot;
  status: ExternalReconciliationStatus;
  idempotency_key: string;
  outcome: ExternalReconciliationOutcome | null;
  notion_page_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

export interface StoredExternalReconciliation {
  id: string;
  noteId: string;
  shareUrl: string;
  snapshot: ExternalPostSnapshot;
  status: ExternalReconciliationStatus;
  outcome?: ExternalReconciliationOutcome;
  notionPageId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: ExternalReconciliationRow): StoredExternalReconciliation {
  return {
    id: row.id,
    noteId: row.note_id,
    shareUrl: row.share_url,
    snapshot: row.snapshot,
    status: row.status,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.notion_page_id ? { notionPageId: row.notion_page_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(row.completed_at ? { completedAt: timestamp(row.completed_at) } : {}),
  };
}

export function externalReconciliationSummary(
  record: StoredExternalReconciliation,
): ExternalReconciliationSummary {
  return {
    id: record.id,
    noteId: record.noteId,
    shareUrl: record.shareUrl,
    title: record.snapshot.title,
    mediaType: record.snapshot.mediaType,
    status: record.status,
    ...(record.outcome ? { outcome: record.outcome } : {}),
    ...(record.notionPageId ? { notionPageId: record.notionPageId } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  };
}

export async function beginExternalReconciliation(
  snapshot: ExternalPostSnapshot,
  idempotencyKey: string,
) {
  const inserted = await sql<ExternalReconciliationRow>`
    INSERT INTO external_post_reconciliations (
      note_id,
      share_url,
      snapshot,
      idempotency_key
    )
    VALUES (
      ${snapshot.noteId},
      ${snapshot.shareUrl},
      ${JSON.stringify(snapshot)}::jsonb,
      ${idempotencyKey}::uuid
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  if (inserted.rows[0]) {
    return { record: mapRow(inserted.rows[0]), acquired: true };
  }

  const conflicts = await sql<ExternalReconciliationRow>`
    SELECT *
    FROM external_post_reconciliations
    WHERE idempotency_key = ${idempotencyKey}::uuid
       OR note_id = ${snapshot.noteId}
       OR share_url = ${snapshot.shareUrl}
    ORDER BY created_at
    LIMIT 3
  `;
  if (conflicts.rows.length !== 1) {
    throw new LocalPublishJobError(
      'Verified post conflicts with multiple reconciliation records',
      'RECONCILIATION_CONFLICT',
      409,
    );
  }
  const existing = mapRow(conflicts.rows[0]);
  if (!isDeepStrictEqual(existing.snapshot, snapshot)) {
    throw new LocalPublishJobError(
      'The verified post or Idempotency-Key was already reconciled with different content',
      'RECONCILIATION_CONFLICT',
      409,
    );
  }
  if (existing.status === 'succeeded') {
    return { record: existing, acquired: false };
  }

  const stale = Date.now() - new Date(existing.updatedAt).getTime() >= PROCESSING_LEASE_MS;
  if (existing.status === 'processing' && !stale) {
    throw new LocalPublishJobError(
      'This verified post is already being reconciled',
      'RECONCILIATION_IN_PROGRESS',
      409,
    );
  }

  const reclaimed = await sql<ExternalReconciliationRow>`
    UPDATE external_post_reconciliations
    SET status = 'processing',
        outcome = NULL,
        notion_page_id = NULL,
        error_code = NULL,
        error_message = NULL,
        completed_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${existing.id}::uuid
      AND (
        status = 'failed'
        OR (
          status = 'processing'
          AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        )
      )
    RETURNING *
  `;
  if (!reclaimed.rows[0]) {
    throw new LocalPublishJobError(
      'This verified post is already being reconciled',
      'RECONCILIATION_IN_PROGRESS',
      409,
    );
  }
  return { record: mapRow(reclaimed.rows[0]), acquired: true };
}

export async function completeExternalReconciliation(
  id: string,
  notionPageId: string,
  outcome: ExternalReconciliationOutcome,
) {
  const result = await sql<ExternalReconciliationRow>`
    UPDATE external_post_reconciliations
    SET status = 'succeeded',
        notion_page_id = ${notionPageId},
        outcome = ${outcome},
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status = 'processing'
    RETURNING *
  `;
  if (!result.rows[0]) {
    throw new LocalPublishJobError(
      'The reconciliation claim could not be completed',
      'INVALID_RECONCILIATION_TRANSITION',
      409,
    );
  }
  return mapRow(result.rows[0]);
}

export async function failExternalReconciliation(
  id: string,
  code: string,
  message: string,
) {
  await sql`
    UPDATE external_post_reconciliations
    SET status = 'failed',
        error_code = ${code},
        error_message = ${message},
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status = 'processing'
  `;
}

export async function listExternalReconciliations() {
  const result = await sql<ExternalReconciliationRow>`
    SELECT *
    FROM external_post_reconciliations
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return result.rows.map(mapRow);
}
