import { isDeepStrictEqual } from 'util';
import type { QueryResultRow } from 'pg';
import { getPool, sql } from '@/lib/db';
import { ManualPostHandlingError } from '@/lib/manual-post-handling-input';
import { NotionPostsError } from '@/lib/notion-posts';
import type {
  ManualHandlingMode,
  ManualPostHandlingSummary,
  ManualReceiptStatus,
} from '@/types/manual-post-handling';

interface ManualPostHandlingRow extends QueryResultRow {
  id: string;
  notion_page_id: string;
  notion_last_edited_time: string;
  handling_mode: ManualHandlingMode;
  receipt_status: ManualReceiptStatus;
  recorded_by: 'admin' | 'plan';
  warnings: string[];
  scheduled_at: Date | string | null;
  manual_reconciliation_id: string | null;
  note_id: string | null;
  share_url: string | null;
  published_at: Date | string | null;
  reconciled_at: Date | string | null;
  idempotency_key: string;
  recorded_at: Date | string;
  updated_at: Date | string;
}

interface LocalOwnershipRow extends QueryResultRow {
  id: string;
  status: string;
  claim_expires_at: Date | string | null;
  staged_at: Date | string | null;
  dispatch_authorized_at: Date | string | null;
  dispatched_at: Date | string | null;
  note_id: string | null;
  share_url: string | null;
  verified_at: Date | string | null;
  reconciled_at: Date | string | null;
  success_attestation_id: string | null;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null) {
  return value ? iso(value) : undefined;
}

function mapRow(row: ManualPostHandlingRow): ManualPostHandlingSummary {
  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    notionVersion: row.notion_last_edited_time,
    mode: row.handling_mode,
    receiptStatus: row.receipt_status,
    recordedBy: row.recorded_by,
    warnings: row.warnings,
    ...(optionalIso(row.scheduled_at) ? { scheduledAt: optionalIso(row.scheduled_at) } : {}),
    ...(row.manual_reconciliation_id
      ? { manualReconciliationId: row.manual_reconciliation_id }
      : {}),
    ...(row.note_id ? { noteId: row.note_id } : {}),
    ...(row.share_url ? { shareUrl: row.share_url } : {}),
    ...(optionalIso(row.published_at) ? { publishedAt: optionalIso(row.published_at) } : {}),
    ...(optionalIso(row.reconciled_at) ? { reconciledAt: optionalIso(row.reconciled_at) } : {}),
    createdAt: iso(row.recorded_at),
    updatedAt: iso(row.updated_at),
  };
}

function hasVerifiedPublicationEvidence(job: LocalOwnershipRow) {
  return Boolean(
    job.verified_at
    || job.reconciled_at
    || (
      job.note_id
      && job.share_url
      && ['submitted', 'scheduled', 'verification_pending', 'verified', 'reconciled']
        .includes(job.status)
    ),
  );
}

function hasLiveUnsafeOwnership(job: LocalOwnershipRow, now: number) {
  if (hasVerifiedPublicationEvidence(job)) return true;
  if (['operator_attested', 'submitted', 'scheduled', 'verification_pending', 'verified']
    .includes(job.status)) {
    return true;
  }
  if (job.status === 'staged') {
    return Boolean(
      job.dispatch_authorized_at
      || (
        job.claim_expires_at
        && new Date(job.claim_expires_at).getTime() > now
      ),
    );
  }
  if (job.status === 'claimed') {
    return Boolean(
      job.claim_expires_at
      && new Date(job.claim_expires_at).getTime() > now,
    );
  }
  return Boolean(
    !['failed', 'reconciled', 'succeeded'].includes(job.status)
    && (job.staged_at || job.dispatch_authorized_at || job.dispatched_at),
  );
}

export async function findManualPostHandlingByIdempotencyKey(
  idempotencyKey: string,
) {
  const result = await sql<ManualPostHandlingRow>`
    SELECT *
    FROM plan_operator_scheduled_posts
    WHERE idempotency_key = ${idempotencyKey}::uuid
    LIMIT 1
  `;
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function loadManualPostHandlingByPage(notionPageId: string) {
  const result = await sql<ManualPostHandlingRow>`
    SELECT *
    FROM plan_operator_scheduled_posts
    WHERE notion_page_id = ${notionPageId}
    LIMIT 1
  `;
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listManualPostHandlings() {
  const result = await sql<ManualPostHandlingRow>`
    SELECT *
    FROM plan_operator_scheduled_posts
    ORDER BY recorded_at DESC
    LIMIT 200
  `;
  return result.rows.map(mapRow);
}

export async function loadManualPostHandlingsByPages(notionPageIds: string[]) {
  if (notionPageIds.length === 0) return [];
  const result = await sql<ManualPostHandlingRow>`
    SELECT *
    FROM plan_operator_scheduled_posts
    WHERE notion_page_id = ANY(${notionPageIds}::text[])
    ORDER BY recorded_at DESC
  `;
  return result.rows.map(mapRow);
}

export async function insertManualPostHandling(input: {
  notionPageId: string;
  notionVersion: string;
  mode: ManualHandlingMode;
  scheduledAt?: string;
  warnings: string[];
  recordedBy: 'admin' | 'plan';
  idempotencyKey: string;
}) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('rednote-bootstrap-batch', 0))",
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [input.notionPageId],
    );

    const replay = await client.query<ManualPostHandlingRow>(
      `SELECT *
       FROM plan_operator_scheduled_posts
       WHERE idempotency_key = $1::uuid
       FOR UPDATE`,
      [input.idempotencyKey],
    );
    if (replay.rows[0]) {
      const handling = mapRow(replay.rows[0]);
      const matches =
        handling.notionPageId === input.notionPageId
        && handling.notionVersion === input.notionVersion
        && handling.mode === input.mode
        && handling.recordedBy === input.recordedBy
        && (handling.scheduledAt ?? null) === (input.scheduledAt ?? null)
        && isDeepStrictEqual(handling.warnings, input.warnings);
      if (!matches) {
        throw new ManualPostHandlingError(
          'Idempotency-Key was already used for a different manual handling',
          'IDEMPOTENCY_CONFLICT',
          409,
        );
      }
      await client.query('COMMIT');
      return { handling, created: false };
    }

    const existing = await client.query<ManualPostHandlingRow>(
      `SELECT *
       FROM plan_operator_scheduled_posts
       WHERE notion_page_id = $1
       FOR UPDATE`,
      [input.notionPageId],
    );
    if (existing.rows[0]) {
      throw new ManualPostHandlingError(
        'This post already has durable manual handling state',
        'MANUAL_HANDLING_EXISTS',
        409,
      );
    }

    const jobs = await client.query<LocalOwnershipRow>(
      `SELECT id, status, claim_expires_at, staged_at, dispatch_authorized_at,
              dispatched_at, note_id, share_url, verified_at, reconciled_at,
              success_attestation_id
       FROM local_publish_jobs
       WHERE notion_page_id = $1
       ORDER BY created_at DESC
       FOR UPDATE`,
      [input.notionPageId],
    );
    if (jobs.rows.some((job) => hasLiveUnsafeOwnership(job, Date.now()))) {
      throw new ManualPostHandlingError(
        'A live worker stage, submission, or verified publication still owns this post',
        'LIVE_AUTOMATION_OWNERSHIP',
        409,
      );
    }

    const incompatibleReceipt = await client.query(
      `SELECT 1
       FROM xhs_publish_receipts
       WHERE notion_page_id = $1
         AND status = 'published'
         AND note_id IS NOT NULL
         AND share_url IS NOT NULL
       UNION ALL
       SELECT 1
       FROM external_post_reconciliations
       WHERE notion_page_id = $1
         AND status = 'succeeded'
       LIMIT 1`,
      [input.notionPageId],
    );
    if (incompatibleReceipt.rows[0]) {
      throw new ManualPostHandlingError(
        'A verified publication receipt already exists for this post',
        'VERIFIED_PUBLICATION_EXISTS',
        409,
      );
    }

    const activeBatch = await client.query<{ id: string; state: string }>(
      `SELECT id, state
       FROM rednote_publish_batch_items
       WHERE notion_page_id = $1
         AND state NOT IN ('invalidated', 'reconciled', 'failed')
       FOR UPDATE`,
      [input.notionPageId],
    );
    if (activeBatch.rows.some((item) =>
      ['submitted', 'scheduled', 'verification_pending', 'verified']
        .includes(item.state))) {
      throw new ManualPostHandlingError(
        'A live batch item still owns this post',
        'LIVE_AUTOMATION_OWNERSHIP',
        409,
      );
    }

    await client.query(
      `UPDATE local_publish_jobs
       SET status = 'failed',
          error_code = $2,
          error_message = $3,
           claim_expires_at = CURRENT_TIMESTAMP,
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE notion_page_id = $1
         AND status NOT IN ('failed', 'reconciled', 'succeeded')`,
      [
        input.notionPageId,
        input.recordedBy === 'plan'
         ? 'OPERATOR_SCHEDULED_BY_PLAN'
         : 'MANUAL_HANDLING_RECORDED',
        input.recordedBy === 'plan'
         ? 'Operator scheduled outside the local worker by PLAN'
         : 'Operator handling superseded inactive local automation',
      ],
    );
    await client.query(
      `UPDATE rednote_publish_batch_items
       SET state = 'invalidated',
           invalidation_reason = 'Operator handling superseded inactive local automation',
           updated_at = CURRENT_TIMESTAMP
       WHERE notion_page_id = $1
         AND state IN ('needs_approval', 'approved', 'queued', 'claimed', 'staged')`,
      [input.notionPageId],
    );

    const inserted = await client.query<ManualPostHandlingRow>(
      `INSERT INTO plan_operator_scheduled_posts (
         notion_page_id,
         scheduled_at,
         notion_last_edited_time,
         recorded_by,
         handling_mode,
         receipt_status,
         warnings,
         idempotency_key
       ) VALUES ($1, $2::timestamptz, $3, $4, $5, 'pending', $6::jsonb, $7::uuid)
       RETURNING *`,
      [
        input.notionPageId,
        input.scheduledAt ?? null,
        input.notionVersion,
        input.recordedBy,
        input.mode,
        JSON.stringify(input.warnings),
        input.idempotencyKey,
      ],
    );
    await client.query('COMMIT');
    return { handling: mapRow(inserted.rows[0]), created: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function normalizeManualPostHandlingError(error: unknown) {
  if (error instanceof ManualPostHandlingError || error instanceof NotionPostsError) {
    return error;
  }
  console.error('Manual post handling operation failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  return new ManualPostHandlingError(
    'The manual handling operation failed',
    'MANUAL_HANDLING_FAILED',
    503,
  );
}
