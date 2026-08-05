import { isDeepStrictEqual } from 'util';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool, sql } from '@/lib/db';
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

export async function lockExternalReconciliationIdentity(
  client: Pick<PoolClient, 'query'>,
  noteId: string,
  shareUrl: string,
) {
  const locks = [
    `rednote-note:${noteId}`,
    `rednote-share-url:${shareUrl}`,
  ].sort();
  for (const lock of locks) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [lock],
    );
  }
}

export async function beginExternalReconciliation(
  snapshot: ExternalPostSnapshot,
  idempotencyKey: string,
  targetDispositionId?: string,
) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await lockExternalReconciliationIdentity(
      client,
      snapshot.noteId,
      snapshot.shareUrl,
    );
    const inserted = await client.query<ExternalReconciliationRow>(
      `INSERT INTO external_post_reconciliations (
         note_id,
         share_url,
         snapshot,
         idempotency_key
       )
       SELECT $1, $2, $3::jsonb, $4::uuid
       WHERE NOT EXISTS (
         SELECT 1
         FROM manual_reconciliation_requests AS disposition
         WHERE disposition.request_kind = 'targeted_local_job'
           AND (
             disposition.requested_note_id = $1
             OR disposition.requested_share_url = $2
           )
           AND NOT (
             $5::uuid IS NOT NULL
             AND disposition.id = $5::uuid
             AND disposition.requested_note_id = $1
             AND disposition.requested_share_url = $2
           )
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        snapshot.noteId,
        snapshot.shareUrl,
        JSON.stringify(snapshot),
        idempotencyKey,
        targetDispositionId ?? null,
      ],
    );
    if (inserted.rows[0]) {
      await client.query('COMMIT');
      return { record: mapRow(inserted.rows[0]), acquired: true };
    }

    const dispositions = await client.query<{
      id: string;
      requested_note_id: string;
      requested_share_url: string;
    }>(
      `SELECT id, requested_note_id, requested_share_url
       FROM manual_reconciliation_requests
       WHERE request_kind = 'targeted_local_job'
         AND (
           requested_note_id = $1
           OR requested_share_url = $2
         )
       ORDER BY created_at
       LIMIT 3`,
      [snapshot.noteId, snapshot.shareUrl],
    );
    if (dispositions.rows.length > 0) {
      const owner = dispositions.rows[0];
      const exactOwner = dispositions.rows.length === 1 &&
        owner.id === targetDispositionId &&
        owner.requested_note_id === snapshot.noteId &&
        owner.requested_share_url === snapshot.shareUrl;
      if (!exactOwner) {
        throw new LocalPublishJobError(
          'Verified post is owned by a targeted local job disposition',
          'RECONCILIATION_CONFLICT',
          409,
        );
      }
    }

    const conflicts = await client.query<ExternalReconciliationRow>(
      `SELECT *
       FROM external_post_reconciliations
       WHERE idempotency_key = $1::uuid
          OR note_id = $2
          OR share_url = $3
       ORDER BY created_at
       LIMIT 3`,
      [idempotencyKey, snapshot.noteId, snapshot.shareUrl],
    );
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
      await client.query('COMMIT');
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

    const reclaimed = await client.query<ExternalReconciliationRow>(
      `UPDATE external_post_reconciliations
       SET status = 'processing',
           outcome = NULL,
           notion_page_id = NULL,
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid
         AND (
           status = 'failed'
           OR (
             status = 'processing'
             AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
           )
         )
       RETURNING *`,
      [existing.id],
    );
    if (!reclaimed.rows[0]) {
      throw new LocalPublishJobError(
        'This verified post is already being reconciled',
        'RECONCILIATION_IN_PROGRESS',
        409,
      );
    }
    await client.query('COMMIT');
    return { record: mapRow(reclaimed.rows[0]), acquired: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
