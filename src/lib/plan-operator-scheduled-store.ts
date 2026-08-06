import type { QueryResultRow } from 'pg';
import { getPool, sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { PlanOperatorScheduledInput } from '@/lib/plan-operator-scheduled-input';

interface MarkerRow extends QueryResultRow {
  id: string;
  notion_page_id: string;
  idempotency_key: string;
  notion_last_edited_time: string;
  scheduled_at: Date | string;
  recorded_by: string;
  recorded_at: Date | string;
  reconciled_at: Date | string | null;
}

interface JobRow extends QueryResultRow {
  id: string;
  status: string;
  claim_token: string | null;
  claim_attempts: number;
  claimed_at: Date | string | null;
  staged_at: Date | string | null;
  dispatch_authorized_at: Date | string | null;
  dispatched_at: Date | string | null;
  note_id: string | null;
  share_url: string | null;
  verified_at: Date | string | null;
  reconciled_at: Date | string | null;
  completed_at: Date | string | null;
  success_attestation_id: string | null;
  external_disposition_request_id: string | null;
}

interface BatchItemRow extends QueryResultRow {
  id: string;
  state: string;
  local_publish_job_id: string | null;
}

export interface PlanOperatorScheduledState {
  id: string;
  notionPageId: string;
  state: 'operator_scheduled_receipt_pending' | 'reconciled';
  scheduledAt: string;
  notionVersion: string;
  recordedBy: string;
  recordedAt: string;
  reconciledAt?: string;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapMarker(row: MarkerRow): PlanOperatorScheduledState {
  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    state: row.reconciled_at ? 'reconciled' : 'operator_scheduled_receipt_pending',
    scheduledAt: timestamp(row.scheduled_at),
    notionVersion: row.notion_last_edited_time,
    recordedBy: row.recorded_by,
    recordedAt: timestamp(row.recorded_at),
    ...(row.reconciled_at ? { reconciledAt: timestamp(row.reconciled_at) } : {}),
  };
}

function replayMatches(
  row: MarkerRow,
  input: PlanOperatorScheduledInput,
  idempotencyKey: string,
) {
  return row.idempotency_key === idempotencyKey &&
    row.notion_page_id === input.notionPageId &&
    row.notion_last_edited_time === input.expectedNotionVersion &&
    timestamp(row.scheduled_at) === input.expectedScheduledAt;
}

function replayConflict() {
  return new LocalPublishJobError(
    'The idempotency key or Notion page already belongs to a different operator-scheduled request',
    'PLAN_OPERATOR_SCHEDULED_REPLAY_MISMATCH',
    409,
  );
}

function isPristineQueuedJob(job: JobRow) {
  return job.status === 'queued' &&
    !job.claim_token &&
    job.claim_attempts === 0 &&
    !job.claimed_at &&
    !job.staged_at &&
    !job.dispatch_authorized_at &&
    !job.dispatched_at &&
    !job.note_id &&
    !job.share_url &&
    !job.verified_at &&
    !job.reconciled_at &&
    !job.completed_at &&
    !job.success_attestation_id &&
    !job.external_disposition_request_id;
}

export async function loadPlanOperatorScheduledState(notionPageId: string) {
  const result = await sql<MarkerRow>`
    SELECT *
    FROM plan_operator_scheduled_posts
    WHERE notion_page_id = ${notionPageId}
    LIMIT 1
  `;
  return result.rows[0] ? mapMarker(result.rows[0]) : null;
}

export async function loadPlanOperatorScheduledReplay(
  input: PlanOperatorScheduledInput,
  idempotencyKey: string,
) {
  const result = await sql<MarkerRow>`
    SELECT *
    FROM plan_operator_scheduled_posts
    WHERE idempotency_key = ${idempotencyKey}::uuid
       OR notion_page_id = ${input.notionPageId}
    ORDER BY (idempotency_key = ${idempotencyKey}::uuid) DESC
    LIMIT 1
  `;
  const row = result.rows[0];
  if (!row) return null;
  if (!replayMatches(row, input, idempotencyKey)) throw replayConflict();
  return mapMarker(row);
}

export async function listPlanOperatorScheduledPageIds(pageIds: string[]) {
  if (pageIds.length === 0) return new Set<string>();
  const result = await sql<{ notion_page_id: string }>`
    SELECT notion_page_id
    FROM plan_operator_scheduled_posts
    WHERE notion_page_id = ANY(${pageIds}::text[])
      AND reconciled_at IS NULL
  `;
  return new Set(result.rows.map((row) => row.notion_page_id));
}

export async function insertPlanOperatorScheduledState(
  input: PlanOperatorScheduledInput,
  idempotencyKey: string,
) {
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
    const existing = await client.query<MarkerRow>(
      `SELECT *
       FROM plan_operator_scheduled_posts
       WHERE idempotency_key = $1::uuid OR notion_page_id = $2
       FOR UPDATE`,
      [idempotencyKey, input.notionPageId],
    );
    if (existing.rows[0]) {
      if (!replayMatches(existing.rows[0], input, idempotencyKey)) {
        throw replayConflict();
      }
      await client.query('COMMIT');
      return { execution: mapMarker(existing.rows[0]), created: false };
    }

    const jobs = await client.query<JobRow>(
      `SELECT id, status, claim_token, claim_attempts, claimed_at, staged_at,
              dispatch_authorized_at, dispatched_at, note_id, share_url,
              verified_at, reconciled_at, completed_at, success_attestation_id,
              external_disposition_request_id
       FROM local_publish_jobs
       WHERE notion_page_id = $1
       ORDER BY created_at
       FOR UPDATE`,
      [input.notionPageId],
    );
    if (jobs.rows.some((job) => !isPristineQueuedJob(job))) {
      throw new LocalPublishJobError(
        'A worker or another durable lifecycle already acted on this post',
        'PLAN_OPERATOR_SCHEDULED_ACTIVE_WORKER_CONFLICT',
        409,
      );
    }

    const items = await client.query<BatchItemRow>(
      `SELECT id, state, local_publish_job_id
       FROM rednote_publish_batch_items
       WHERE notion_page_id = $1
       FOR UPDATE`,
      [input.notionPageId],
    );
    if (items.rows.some((item) =>
      !['needs_approval', 'approved', 'queued'].includes(item.state) ||
      (item.state === 'queued' && !item.local_publish_job_id))) {
      throw new LocalPublishJobError(
        'A publish batch already advanced or ambiguously acted on this post',
        'PLAN_OPERATOR_SCHEDULED_ACTIVE_WORKER_CONFLICT',
        409,
      );
    }

    await client.query('LOCK TABLE manual_reconciliation_requests IN SHARE MODE');
    await client.query('LOCK TABLE external_post_reconciliations IN SHARE MODE');
    await client.query('LOCK TABLE xhs_publish_receipts IN SHARE MODE');
    await client.query(
      'LOCK TABLE local_publish_job_success_attestations IN SHARE MODE',
    );
    const durableConflict = await client.query<{ conflict: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM manual_reconciliation_requests WHERE notion_page_id = $1
         )
         OR EXISTS (
           SELECT 1 FROM external_post_reconciliations WHERE notion_page_id = $1
         )
         OR EXISTS (
           SELECT 1 FROM xhs_publish_receipts WHERE notion_page_id = $1
         )
         OR EXISTS (
           SELECT 1
           FROM local_publish_job_success_attestations
           WHERE notion_page_id = $1
         )
       ) AS conflict`,
      [input.notionPageId],
    );
    if (durableConflict.rows[0]?.conflict) {
      throw new LocalPublishJobError(
        'A receipt, reconciliation, or immutable worker record already owns this post',
        'PLAN_OPERATOR_SCHEDULED_DURABLE_CONFLICT',
        409,
      );
    }

    await client.query(
      `UPDATE local_publish_jobs
       SET status = 'failed',
           claim_expires_at = CURRENT_TIMESTAMP,
           error_code = 'OPERATOR_SCHEDULED_BY_PLAN',
           error_message =
             'PLAN recorded operator scheduling; automatic dispatch and recovery are closed',
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE notion_page_id = $1
         AND status = 'queued'
         AND claim_token IS NULL
         AND claim_attempts = 0`,
      [input.notionPageId],
    );
    await client.query(
      `UPDATE rednote_publish_batch_items
       SET state = 'invalidated',
           invalidation_reason =
             'PLAN recorded operator scheduling; this packet is permanently non-dispatchable.',
           updated_at = CURRENT_TIMESTAMP
       WHERE notion_page_id = $1
         AND state IN ('needs_approval', 'approved', 'queued', 'failed')`,
      [input.notionPageId],
    );
    const inserted = await client.query<MarkerRow>(
      `INSERT INTO plan_operator_scheduled_posts (
         notion_page_id, idempotency_key, notion_last_edited_time, scheduled_at
       ) VALUES ($1, $2::uuid, $3, $4::timestamptz)
       RETURNING *`,
      [
        input.notionPageId,
        idempotencyKey,
        input.expectedNotionVersion,
        input.expectedScheduledAt,
      ],
    );
    await client.query('COMMIT');
    return { execution: mapMarker(inserted.rows[0]), created: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
