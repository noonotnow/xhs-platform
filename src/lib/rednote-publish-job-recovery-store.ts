import type { QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  validateRecoveryCandidate,
  type ExistingRecoveryAudit,
  type RecoveryCandidateState,
  type RednotePublishJobRecoveryInput,
} from '@/lib/rednote-publish-job-recovery';
import type {
  LocalPublishSnapshot,
  RednotePublishJobRecovery,
} from '@/types/local-publish-job';

interface RecoveryRow extends QueryResultRow {
  batch_id: string;
  batch_status: string;
  manifest_hash: string;
  approved_at: Date | string | null;
  item_id: string;
  item_batch_id: string;
  item_hash: string;
  item_state: string;
  item_local_publish_job_id: string | null;
  item_snapshot: LocalPublishSnapshot;
  job_id: string;
  job_batch_item_id: string | null;
  job_status: string;
  job_snapshot: LocalPublishSnapshot;
  notion_page_id: string;
  job_error_code: string | null;
  job_error_message: string | null;
  claim_token: string | null;
  claim_attempts: number;
  claimed_at: Date | string | null;
  claim_expires_at: Date | string | null;
  completed_at: Date | string | null;
  staged_at: Date | string | null;
  dispatch_authorized_at: Date | string | null;
  dispatched_at: Date | string | null;
  note_id: string | null;
  share_url: string | null;
  verification_attempts: number;
  next_verification_at: Date | string | null;
  verified_at: Date | string | null;
  reconciled_at: Date | string | null;
  recovery_id: string | null;
  recovered_by: string | null;
  recovered_at: Date | string | null;
  recovery_batch_id: string | null;
  recovery_manifest_hash: string | null;
  recovery_item_id: string | null;
  recovery_item_hash: string | null;
  recovery_snapshot_revision: string | null;
  recovery_prior_claim_attempts: number | null;
  recovery_prior_claimed_at: Date | string | null;
  recovery_prior_completed_at: Date | string | null;
}

interface OwnershipRow extends QueryResultRow {
  active_ownership: boolean;
}

interface RequeuedItemRow extends QueryResultRow {
  state: string;
  local_publish_job_id: string | null;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalTimestamp(value: Date | string | null) {
  return value ? timestamp(value) : null;
}

function audit(row: RecoveryRow): ExistingRecoveryAudit | null {
  if (
    !row.recovery_id ||
    !row.recovered_by ||
    !row.recovered_at ||
    !row.recovery_batch_id ||
    !row.recovery_manifest_hash ||
    !row.recovery_item_id ||
    !row.recovery_item_hash ||
    !row.recovery_snapshot_revision ||
    row.recovery_prior_claim_attempts === null ||
    !row.recovery_prior_completed_at
  ) {
    return null;
  }
  return {
    id: row.recovery_id,
    batchId: row.recovery_batch_id,
    manifestHash: row.recovery_manifest_hash,
    itemId: row.recovery_item_id,
    jobId: row.job_id,
    itemHash: row.recovery_item_hash,
    snapshotRevision: row.recovery_snapshot_revision,
    recoveredBy: row.recovered_by,
    recoveredAt: timestamp(row.recovered_at),
    priorClaimAttempts: row.recovery_prior_claim_attempts,
    priorClaimedAt: optionalTimestamp(row.recovery_prior_claimed_at),
    priorCompletedAt: timestamp(row.recovery_prior_completed_at),
  };
}

function candidate(row: RecoveryRow, activeOwnership: boolean): RecoveryCandidateState {
  return {
    batchId: row.batch_id,
    batchStatus: row.batch_status,
    manifestHash: row.manifest_hash,
    approvedAt: optionalTimestamp(row.approved_at),
    itemId: row.item_id,
    itemBatchId: row.item_batch_id,
    itemHash: row.item_hash,
    itemState: row.item_state,
    itemLocalPublishJobId: row.item_local_publish_job_id,
    itemSnapshot: row.item_snapshot,
    jobId: row.job_id,
    jobBatchItemId: row.job_batch_item_id,
    jobStatus: row.job_status,
    jobSnapshot: row.job_snapshot,
    jobErrorCode: row.job_error_code,
    jobClaimAttempts: row.claim_attempts,
    jobClaimToken: row.claim_token,
    jobClaimedAt: optionalTimestamp(row.claimed_at),
    jobClaimExpiresAt: optionalTimestamp(row.claim_expires_at),
    jobCompletedAt: optionalTimestamp(row.completed_at),
    stagedAt: optionalTimestamp(row.staged_at),
    dispatchAuthorizedAt: optionalTimestamp(row.dispatch_authorized_at),
    dispatchedAt: optionalTimestamp(row.dispatched_at),
    noteId: row.note_id,
    shareUrl: row.share_url,
    nextVerificationAt: optionalTimestamp(row.next_verification_at),
    verifiedAt: optionalTimestamp(row.verified_at),
    reconciledAt: optionalTimestamp(row.reconciled_at),
    verificationAttempts: row.verification_attempts,
    activeOwnership,
    audit: audit(row),
  };
}

function result(
  record: ExistingRecoveryAudit,
  approvedAt: Date | string,
  alreadyRecovered: boolean,
): RednotePublishJobRecovery {
  return {
    id: record.id,
    batchId: record.batchId,
    manifestHash: record.manifestHash,
    itemId: record.itemId,
    jobId: record.jobId,
    itemHash: record.itemHash,
    snapshotRevision: record.snapshotRevision,
    approvedAt: timestamp(approvedAt),
    recoveredBy: record.recoveredBy,
    recoveredAt: record.recoveredAt,
    priorClaimAttempts: record.priorClaimAttempts,
    alreadyRecovered,
  };
}

export async function recoverStoredApprovedPublishJob(
  input: RednotePublishJobRecoveryInput,
  recoveredBy: string,
) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('rednote-bootstrap-batch', 0))",
    );
    const locked = await client.query<RecoveryRow>(
      `SELECT
         batch.id AS batch_id,
         batch.status AS batch_status,
         batch.manifest_hash,
         batch.approved_at,
         item.id AS item_id,
         item.batch_id AS item_batch_id,
         item.item_hash,
         item.state AS item_state,
         item.local_publish_job_id AS item_local_publish_job_id,
         item.snapshot AS item_snapshot,
         job.id AS job_id,
         job.batch_item_id AS job_batch_item_id,
         job.status AS job_status,
         job.snapshot AS job_snapshot,
         job.notion_page_id,
         job.error_code AS job_error_code,
         job.error_message AS job_error_message,
         job.claim_token,
         job.claim_attempts,
         job.claimed_at,
         job.claim_expires_at,
         job.completed_at,
         job.staged_at,
         job.dispatch_authorized_at,
         job.dispatched_at,
         job.note_id,
         job.share_url,
         job.verification_attempts,
         job.next_verification_at,
         job.verified_at,
         job.reconciled_at,
         recovery.id AS recovery_id,
         recovery.recovered_by,
         recovery.recovered_at,
         recovery.batch_id AS recovery_batch_id,
         recovery.manifest_hash AS recovery_manifest_hash,
         recovery.batch_item_id AS recovery_item_id,
         recovery.item_hash AS recovery_item_hash,
         recovery.snapshot_revision AS recovery_snapshot_revision,
         recovery.prior_claim_attempts AS recovery_prior_claim_attempts,
         recovery.prior_claimed_at AS recovery_prior_claimed_at,
         recovery.prior_completed_at AS recovery_prior_completed_at
       FROM local_publish_jobs AS job
       JOIN rednote_publish_batch_items AS item ON item.id = job.batch_item_id
       JOIN rednote_publish_batches AS batch ON batch.id = item.batch_id
       LEFT JOIN LATERAL (
         SELECT *
         FROM rednote_publish_job_recoveries
         WHERE local_publish_job_id = job.id
         ORDER BY prior_claim_attempts DESC, recovered_at DESC
         LIMIT 1
       ) AS recovery ON TRUE
       WHERE job.id = $1::uuid
       FOR UPDATE OF batch, item, job`,
      [input.jobId],
    );
    const row = locked.rows[0];
    if (!row) {
      throw new LocalPublishJobError(
        'Recovery evidence does not identify an existing bounded publish job.',
        'RECOVERY_PRECONDITION_FAILED',
        409,
      );
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [row.notion_page_id],
    );
    await client.query('LOCK TABLE external_post_reconciliations IN SHARE MODE');
    const ownership = await client.query<OwnershipRow>(
      `SELECT (
         EXISTS (
           SELECT 1
           FROM local_publish_jobs AS other_job
           WHERE other_job.notion_page_id = $1
             AND other_job.id <> $2::uuid
             AND (
               other_job.batch_item_id IS NOT NULL
               OR other_job.status NOT IN ('reconciled', 'failed')
               OR other_job.dispatch_authorized_at IS NOT NULL
               OR other_job.dispatched_at IS NOT NULL
               OR other_job.note_id IS NOT NULL
               OR other_job.share_url IS NOT NULL
             )
         )
         OR EXISTS (
           SELECT 1
           FROM rednote_publish_batch_items AS other_item
           WHERE other_item.notion_page_id = $1
             AND other_item.id <> $3::uuid
             AND (
               other_item.local_publish_job_id IS NOT NULL
               OR other_item.state NOT IN ('invalidated', 'reconciled', 'failed')
             )
         )
         OR EXISTS (
           SELECT 1
           FROM manual_reconciliation_requests
           WHERE notion_page_id = $1
             AND status IN ('queued', 'verifying')
         )
         OR EXISTS (
           SELECT 1
           FROM external_post_reconciliations
           WHERE status = 'processing'
         )
       ) AS active_ownership`,
      [row.notion_page_id, row.job_id, row.item_id],
    );
    const action = validateRecoveryCandidate(
      candidate(row, ownership.rows[0]?.active_ownership === true),
      input,
      recoveredBy,
    );
    if (!row.approved_at) {
      throw new LocalPublishJobError(
        'The bounded batch approval timestamp is missing.',
        'RECOVERY_PRECONDITION_FAILED',
        409,
      );
    }
    const existingAudit = audit(row);
    if (action === 'already_recovered' && existingAudit) {
      await client.query('COMMIT');
      return result(existingAudit, row.approved_at, true);
    }
    const inserted = await client.query<{
      id: string;
      recovered_at: Date | string;
    }>(
      `INSERT INTO rednote_publish_job_recoveries (
         local_publish_job_id,
         batch_item_id,
         batch_id,
         manifest_hash,
         item_hash,
         snapshot_revision,
         prior_error_code,
         prior_error_message,
         prior_claim_attempts,
         prior_claimed_at,
         prior_completed_at,
         recovered_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
         $7, $8, $9, $10::timestamptz, $11::timestamptz, $12
       )
       RETURNING id, recovered_at`,
      [
        row.job_id,
        row.item_id,
        row.batch_id,
        row.manifest_hash,
        row.item_hash,
        input.snapshotRevision,
        row.job_error_code,
        row.job_error_message,
        row.claim_attempts,
        row.claimed_at,
        row.completed_at,
        recoveredBy,
      ],
    );
    const updated = await client.query(
      `UPDATE local_publish_jobs
       SET status = 'queued',
           claim_token = NULL,
           claimed_at = NULL,
           claim_expires_at = NULL,
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid
         AND batch_item_id = $2::uuid
         AND status = 'failed'
         AND error_code = 'BOUNDED_BATCH_BYPASS_DISABLED'
         AND claim_attempts = $3
         AND claimed_at = $4::timestamptz
         AND completed_at = $5::timestamptz`,
      [row.job_id, row.item_id, row.claim_attempts, row.claimed_at, row.completed_at],
    );
    if (updated.rowCount !== 1 || !inserted.rows[0]) {
      throw new LocalPublishJobError(
        'The publish job changed before recovery could be committed.',
        'RECOVERY_PRECONDITION_FAILED',
        409,
      );
    }
    const requeuedItem = await client.query<RequeuedItemRow>(
      `SELECT state, local_publish_job_id
       FROM rednote_publish_batch_items
       WHERE id = $1::uuid`,
      [row.item_id],
    );
    if (
      requeuedItem.rows[0]?.state !== 'queued' ||
      requeuedItem.rows[0].local_publish_job_id !== row.job_id
    ) {
      throw new LocalPublishJobError(
        'The batch item did not mirror the recovered job state.',
        'RECOVERY_PRECONDITION_FAILED',
        409,
      );
    }
    const record: ExistingRecoveryAudit = {
      id: inserted.rows[0].id,
      batchId: row.batch_id,
      manifestHash: row.manifest_hash,
      itemId: row.item_id,
      jobId: row.job_id,
      itemHash: row.item_hash,
      snapshotRevision: input.snapshotRevision,
      recoveredBy,
      recoveredAt: timestamp(inserted.rows[0].recovered_at),
      priorClaimAttempts: row.claim_attempts,
      priorClaimedAt: optionalTimestamp(row.claimed_at),
      priorCompletedAt: timestamp(row.completed_at!),
    };
    await client.query('COMMIT');
    return result(record, row.approved_at, false);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
