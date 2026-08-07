import { isDeepStrictEqual } from 'util';
import type { QueryResultRow } from 'pg';
import { getPool, sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { ManualPublicReceiptSupersessionInput } from
  '@/lib/manual-public-receipt-supersession-input';
import { manifestHash } from '@/lib/rednote-publish-batches';
import { RECOVERABLE_AMBIGUOUS_CREATOR_ERROR } from
  '@/lib/rednote-publish-job-recovery';
import type {
  LocalPublishSnapshot,
  ManualReconciliationExpectedSnapshot,
} from '@/types/local-publish-job';

interface SupersessionRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  manual_handling_id: string;
  manual_reconciliation_id: string;
  local_publish_job_id: string;
  notion_page_id: string;
  batch_id: string;
  batch_item_id: string;
  manifest_hash: string;
  item_hash: string;
  snapshot_revision: string;
  canonical_notion_revision: string;
  requested_note_id: string;
  requested_share_url: string;
  provenance: 'manual';
  superseded_by: string;
  superseded_at: Date | string;
}

interface JobRow extends QueryResultRow {
  id: string;
  notion_page_id: string;
  snapshot: LocalPublishSnapshot;
  status: string;
  claim_token: string | null;
  claim_attempts: number;
  claim_expires_at: Date | string | null;
  staged_at: Date | string | null;
  dispatch_authorized_at: Date | string | null;
  dispatched_at: Date | string | null;
  note_id: string | null;
  share_url: string | null;
  verified_at: Date | string | null;
  reconciled_at: Date | string | null;
  success_attestation_id: string | null;
  external_disposition_request_id: string | null;
  error_code: string | null;
  error_message: string | null;
  batch_item_id: string | null;
  claim_expired: boolean;
}

interface BatchEvidenceRow extends QueryResultRow {
  batch_id: string;
  batch_status: string;
  manifest_hash: string;
  approved_at: Date | string | null;
  item_id: string;
  notion_page_id: string;
  snapshot: LocalPublishSnapshot;
  item_hash: string;
  state: string;
  local_publish_job_id: string | null;
}

export interface ManualPublicReceiptSupersessionRecord {
  id: string;
  handlingId: string;
  reconciliationId: string;
  jobId: string;
  notionPageId: string;
  batchId: string;
  batchItemId: string;
  manifestHash: string;
  itemHash: string;
  snapshotRevision: string;
  expectedNotionVersion: string;
  noteId: string;
  shareUrl: string;
  provenance: 'manual';
  supersededBy: string;
  supersededAt: string;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: SupersessionRow): ManualPublicReceiptSupersessionRecord {
  return {
    id: row.id,
    handlingId: row.manual_handling_id,
    reconciliationId: row.manual_reconciliation_id,
    jobId: row.local_publish_job_id,
    notionPageId: row.notion_page_id,
    batchId: row.batch_id,
    batchItemId: row.batch_item_id,
    manifestHash: row.manifest_hash,
    itemHash: row.item_hash,
    snapshotRevision: row.snapshot_revision,
    expectedNotionVersion: row.canonical_notion_revision,
    noteId: row.requested_note_id,
    shareUrl: row.requested_share_url,
    provenance: row.provenance,
    supersededBy: row.superseded_by,
    supersededAt: timestamp(row.superseded_at),
  };
}

function conflict(message: string, code = 'MANUAL_RECEIPT_SUPERSESSION_CONFLICT') {
  return new LocalPublishJobError(message, code, 409);
}

function replayMatches(
  record: ManualPublicReceiptSupersessionRecord,
  input: ManualPublicReceiptSupersessionInput,
) {
  return record.notionPageId === input.notionPageId
    && record.expectedNotionVersion === input.expectedNotionVersion
    && record.jobId === input.jobId
    && record.batchId === input.batchId
    && record.batchItemId === input.batchItemId
    && record.manifestHash === input.manifestHash
    && record.itemHash === input.itemHash
    && record.snapshotRevision === input.snapshotRevision
    && record.noteId === input.noteId
    && record.shareUrl === input.shareUrl
    && record.provenance === input.provenance;
}

export async function findManualPublicReceiptSupersessionByIdempotencyKey(
  idempotencyKey: string,
) {
  const result = await sql<SupersessionRow>`
    SELECT *
    FROM manual_public_receipt_supersessions
    WHERE idempotency_key = ${idempotencyKey}::uuid
    LIMIT 1
  `;
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function supersedeAmbiguousLocalAttemptWithManualReceipt(input: {
  request: ManualPublicReceiptSupersessionInput;
  expected: ManualReconciliationExpectedSnapshot;
  warnings: string[];
  scheduledAt?: string;
  idempotencyKey: string;
  operatorEmail: string;
}) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [input.request.notionPageId],
    );

    const replay = await client.query<SupersessionRow>(
      `SELECT *
       FROM manual_public_receipt_supersessions
       WHERE idempotency_key = $1::uuid
       FOR UPDATE`,
      [input.idempotencyKey],
    );
    if (replay.rows[0]) {
      const record = mapRow(replay.rows[0]);
      if (!replayMatches(record, input.request)) {
        throw conflict(
          'Idempotency-Key was already used for a different manual receipt supersession',
          'IDEMPOTENCY_CONFLICT',
        );
      }
      await client.query('COMMIT');
      return { record, created: false };
    }

    const existingSupersession = await client.query(
      `SELECT id
       FROM manual_public_receipt_supersessions
       WHERE notion_page_id = $1 OR local_publish_job_id = $2::uuid
       FOR UPDATE`,
      [input.request.notionPageId, input.request.jobId],
    );
    if (existingSupersession.rows[0]) {
      throw conflict('This page or local attempt already has a supersession audit');
    }

    const existingHandling = await client.query(
      `SELECT id
       FROM plan_operator_scheduled_posts
       WHERE notion_page_id = $1
          OR idempotency_key = $2::uuid
       FOR UPDATE`,
      [input.request.notionPageId, input.idempotencyKey],
    );
    const existingReconciliation = await client.query(
      `SELECT id
       FROM manual_reconciliation_requests
       WHERE idempotency_key = $1::uuid
          OR requested_note_id = $2
          OR (
            notion_page_id = $3
            AND status IN ('queued', 'verifying')
          )
       FOR UPDATE`,
      [
        input.idempotencyKey,
        input.request.noteId,
        input.request.notionPageId,
      ],
    );
    if (existingHandling.rows[0] || existingReconciliation.rows[0]) {
      throw conflict('This page already has manual handling or reconciliation state');
    }

    const receipt = await client.query(
      `SELECT id
       FROM xhs_publish_receipts
       WHERE notion_page_id = $1
          OR note_id = $2
          OR share_url = $3
       FOR UPDATE`,
      [
        input.request.notionPageId,
        input.request.noteId,
        input.request.shareUrl,
      ],
    );
    const external = await client.query(
      `SELECT id
       FROM external_post_reconciliations
       WHERE notion_page_id = $1
          OR note_id = $2
          OR share_url = $3
       FOR UPDATE`,
      [
        input.request.notionPageId,
        input.request.noteId,
        input.request.shareUrl,
      ],
    );
    if (receipt.rows[0] || external.rows[0]) {
      throw conflict(
        'A durable public identity already exists for this page',
        'PUBLIC_IDENTITY_EXISTS',
      );
    }

    const jobs = await client.query<JobRow>(
      `SELECT *,
              COALESCE(claim_expires_at <= CURRENT_TIMESTAMP, false) AS claim_expired
       FROM local_publish_jobs
       WHERE notion_page_id = $1
       ORDER BY created_at DESC
       FOR UPDATE`,
      [input.request.notionPageId],
    );
    const job = jobs.rows.find((row) => row.id === input.request.jobId);
    if (!job) {
      throw conflict('The exact local publish job does not own this page');
    }
    const otherUnsafeJob = jobs.rows.some((row) =>
      row.id !== job.id
      && (
        row.status !== 'failed'
        || row.dispatched_at
        || row.note_id
        || row.share_url
        || row.verified_at
        || row.reconciled_at
        || row.success_attestation_id
        || row.external_disposition_request_id
      ));
    if (otherUnsafeJob) {
      throw conflict('Another local publish lifecycle owns this page');
    }
    const eligibleExpiredStage =
      job.status === 'staged'
      && job.claim_expired;
    const eligibleTerminalAmbiguity =
      job.status === 'failed'
      && job.error_code === RECOVERABLE_AMBIGUOUS_CREATOR_ERROR;
    if (
      (!eligibleExpiredStage && !eligibleTerminalAmbiguity)
      || !job.staged_at
      || !job.dispatch_authorized_at
      || job.dispatched_at
      || job.note_id
      || job.share_url
      || job.verified_at
      || job.reconciled_at
      || job.success_attestation_id
      || job.external_disposition_request_id
      || job.notion_page_id !== input.request.notionPageId
      || job.batch_item_id !== input.request.batchItemId
      || job.snapshot.notionLastEditedTime !== input.request.snapshotRevision
    ) {
      throw conflict(
        'The local attempt is not an exact expired staged or terminal ambiguous candidate',
        'LOCAL_ATTEMPT_NOT_ELIGIBLE',
      );
    }

    const batchEvidence = await client.query<BatchEvidenceRow>(
      `SELECT batch.id AS batch_id,
              batch.status AS batch_status,
              batch.manifest_hash,
              batch.approved_at,
              item.id AS item_id,
              item.notion_page_id,
              item.snapshot,
              item.item_hash,
              item.state,
              item.local_publish_job_id
       FROM rednote_publish_batches AS batch
       JOIN rednote_publish_batch_items AS item
         ON item.batch_id = batch.id
       WHERE batch.id = $1::uuid
         AND item.id = $2::uuid
       FOR UPDATE OF batch, item`,
      [input.request.batchId, input.request.batchItemId],
    );
    const evidence = batchEvidence.rows[0];
    if (
      !evidence
      || evidence.batch_status !== 'approved'
      || !evidence.approved_at
      || evidence.batch_id !== input.request.batchId
      || evidence.item_id !== input.request.batchItemId
      || evidence.notion_page_id !== input.request.notionPageId
      || evidence.local_publish_job_id !== input.request.jobId
      || evidence.manifest_hash !== input.request.manifestHash
      || evidence.item_hash !== input.request.itemHash
      || evidence.snapshot.notionLastEditedTime !== input.request.snapshotRevision
      || !['staged', 'failed'].includes(evidence.state)
      || !isDeepStrictEqual(evidence.snapshot, job.snapshot)
      || manifestHash(job.snapshot) !== input.request.itemHash
    ) {
      throw conflict(
        'The batch, item, hash, or frozen snapshot evidence changed',
        'SUPERSESSION_EVIDENCE_MISMATCH',
      );
    }

    const handling = await client.query<{ id: string }>(
      `INSERT INTO plan_operator_scheduled_posts (
         notion_page_id, scheduled_at, notion_last_edited_time, recorded_by,
         handling_mode, receipt_status, warnings, idempotency_key
       ) VALUES ($1, $2::timestamptz, $3, 'admin', 'published', 'pending',
         $4::jsonb, $5::uuid)
       RETURNING id`,
      [
        input.request.notionPageId,
        input.scheduledAt ?? null,
        input.request.expectedNotionVersion,
        JSON.stringify(input.warnings),
        input.idempotencyKey,
      ],
    );
    const reconciliation = await client.query<{ id: string }>(
      `INSERT INTO manual_reconciliation_requests (
         notion_page_id, source_local_job_id, requested_note_id,
         requested_share_url, expected_snapshot, request_kind, idempotency_key
       ) VALUES ($1, $2::uuid, $3, $4, $5::jsonb, 'notion_only', $6::uuid)
       RETURNING id`,
      [
        input.request.notionPageId,
        input.request.jobId,
        input.request.noteId,
        input.request.shareUrl,
        JSON.stringify(input.expected),
        input.idempotencyKey,
      ],
    );
    if (!handling.rows[0] || !reconciliation.rows[0]) {
      throw new LocalPublishJobError(
        'The manual receipt supersession could not be created',
        'QUEUE_WRITE_FAILED',
        503,
      );
    }

    const inserted = await client.query<SupersessionRow>(
      `INSERT INTO manual_public_receipt_supersessions (
         idempotency_key, manual_handling_id, manual_reconciliation_id,
         local_publish_job_id, notion_page_id, batch_id, batch_item_id,
         manifest_hash, item_hash, snapshot_revision,
         canonical_notion_revision, requested_note_id, requested_share_url,
         provenance, prior_job_status, prior_error_code, prior_error_message,
         prior_claim_attempts, prior_claim_expires_at, prior_staged_at,
         prior_dispatch_authorized_at, superseded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7::uuid,
         $8, $9, $10, $11, $12, $13, 'manual', $14, $15, $16, $17,
         $18::timestamptz, $19::timestamptz, $20::timestamptz, $21
       )
       RETURNING *`,
      [
        input.idempotencyKey,
        handling.rows[0].id,
        reconciliation.rows[0].id,
        input.request.jobId,
        input.request.notionPageId,
        input.request.batchId,
        input.request.batchItemId,
        input.request.manifestHash,
        input.request.itemHash,
        input.request.snapshotRevision,
        input.request.expectedNotionVersion,
        input.request.noteId,
        input.request.shareUrl,
        job.status,
        job.error_code,
        job.error_message,
        job.claim_attempts,
        job.claim_expires_at,
        job.staged_at,
        job.dispatch_authorized_at,
        input.operatorEmail,
      ],
    );
    const stopped = await client.query(
      `UPDATE local_publish_jobs
       SET status = 'failed',
           error_code = 'MANUAL_PUBLIC_RECEIPT_SUPERSESSION',
           error_message =
             'Operator supplied manual public identity; ambiguous worker attempt is permanently quarantined pending verification',
           claim_expires_at = CURRENT_TIMESTAMP,
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid
         AND notion_page_id = $2
         AND batch_item_id = $3::uuid
         AND status IN ('staged', 'failed')
         AND staged_at IS NOT NULL
         AND dispatch_authorized_at IS NOT NULL
         AND dispatched_at IS NULL
         AND note_id IS NULL
         AND share_url IS NULL
         AND verified_at IS NULL
         AND reconciled_at IS NULL
         AND success_attestation_id IS NULL
         AND external_disposition_request_id IS NULL
       RETURNING id`,
      [
        input.request.jobId,
        input.request.notionPageId,
        input.request.batchItemId,
      ],
    );
    const quarantined = await client.query(
      `UPDATE rednote_publish_batch_items
       SET state = 'invalidated',
           invalidation_reason =
             'Manual public receipt superseded one ambiguous worker attempt pending verification',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid
         AND batch_id = $2::uuid
         AND local_publish_job_id = $3::uuid
         AND item_hash = $4
         AND state IN ('staged', 'failed')
       RETURNING id`,
      [
        input.request.batchItemId,
        input.request.batchId,
        input.request.jobId,
        input.request.itemHash,
      ],
    );
    if (!inserted.rows[0] || stopped.rowCount !== 1 || quarantined.rowCount !== 1) {
      throw conflict('The local attempt changed before it could be quarantined');
    }
    await client.query('COMMIT');
    return { record: mapRow(inserted.rows[0]), created: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
