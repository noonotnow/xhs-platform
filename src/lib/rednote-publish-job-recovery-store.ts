import type { PoolClient, QueryResultRow } from 'pg';
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
  workspace_id: string;
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
  claimed_at_raw: string | null;
  claim_expires_at: Date | string | null;
  completed_at: Date | string | null;
  completed_at_raw: string | null;
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
  recovery_prior_completed_at_raw: string | null;
  recovery_attempt_id: string | null;
}

interface OwnershipRow extends QueryResultRow {
  active_ownership: boolean;
}

interface RecoveryAuditRow extends QueryResultRow {
  id: string;
  snapshot_revision: string;
  prior_claim_attempts: number;
  prior_completed_at_raw: string;
}

interface RecoveryGenerationRow extends QueryResultRow {
  source_attempt_id: string;
  recovery_attempt_id: string;
  valid: boolean;
}

interface RecoverySourceAttemptRow extends QueryResultRow {
  id: string;
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
    !row.recovery_prior_completed_at_raw
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
    priorCompletedAt: timestamp(row.recovery_prior_completed_at_raw),
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
    jobErrorMessage: row.job_error_message,
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

function recoveryError(
  message: string,
  code: 'RECOVERY_PRECONDITION_FAILED' | 'RECOVERY_STATE_CONFLICT',
) {
  return new LocalPublishJobError(message, code, 409);
}

async function ensureRecoveryAttemptGeneration(
  client: Pick<PoolClient, 'query'>,
  recovery: RecoveryAuditRow,
  row: RecoveryRow,
  {
    auditRecoveredBy,
    generationCreatedBy,
    operation,
  }: {
    auditRecoveredBy: string;
    generationCreatedBy: string;
    operation: 'recover_failed_job' | 'repair_missing_attempt_lineage';
  },
) {
  const existing = await client.query<RecoveryGenerationRow>(
    `SELECT generation.source_attempt_id, generation.recovery_attempt_id,
       (
         source.superseded_by_attempt_id = replacement.id
         AND replacement.supersedes_attempt_id = source.id
         AND replacement.source_local_publish_job_id =
           recovery.local_publish_job_id
         AND replacement.workspace_id = source.workspace_id
         AND replacement.source_notion_page_id = source.source_notion_page_id
         AND replacement.contract_revision = source.contract_revision
         AND replacement.frozen_payload = source.frozen_payload
         AND replacement.payload_digest = source.payload_digest
         AND replacement.payload_revision = source.payload_revision
         AND replacement.payload_revision = recovery.snapshot_revision
         AND replacement.executor_type = source.executor_type
         AND replacement.executor_kind = source.executor_kind
         AND replacement.executor_id = source.executor_id
         AND replacement.target_publish_at IS NOT DISTINCT FROM
           source.target_publish_at
         AND replacement.requested_at = source.requested_at
         AND replacement.approved_at = source.approved_at
         AND replacement.authorization_kind IS NOT DISTINCT FROM
           source.authorization_kind
         AND replacement.late_fallback_policy IS NOT DISTINCT FROM
           source.late_fallback_policy
         AND replacement.active
         AND replacement.approved_at IS NOT NULL
         AND replacement.terminal_outcome IS NULL
         AND replacement.receipt_lookup_state = 'pending'
         AND replacement.claim_token IS NULL
         AND replacement.claim_expires_at IS NULL
         AND replacement.dispatch_authorized_at IS NULL
         AND replacement.worker_run_id IS NULL
         AND replacement.playwright_run_id IS NULL
         AND replacement.superseded_by_attempt_id IS NULL
       ) AS valid
     FROM rednote_publish_recovery_attempt_generations generation
     JOIN rednote_publish_job_recoveries recovery
       ON recovery.id = generation.recovery_id
     JOIN rednote_publish_attempts source
       ON source.id = generation.source_attempt_id
     JOIN rednote_publish_attempts replacement
       ON replacement.id = generation.recovery_attempt_id
     WHERE generation.recovery_id = $1::uuid
     FOR UPDATE OF source, replacement`,
    [recovery.id],
  );
  if (existing.rows[0]) {
    if (!existing.rows[0].valid) {
      throw recoveryError(
        'The audited recovery attempt generation is no longer claimable.',
        'RECOVERY_STATE_CONFLICT',
      );
    }
    return existing.rows[0].recovery_attempt_id;
  }

  const sources = await client.query<RecoverySourceAttemptRow>(
    `SELECT attempt.id
     FROM rednote_publish_attempts attempt
     WHERE attempt.workspace_id = $1
       AND attempt.source_local_publish_job_id = $2::uuid
       AND attempt.executor_type = 'worker'
       AND attempt.approved_at IS NOT NULL
       AND NOT attempt.active
       AND attempt.terminal_outcome = 'known_failed'
       AND attempt.terminal_at <= $3::timestamptz
       AND attempt.receipt_lookup_state = 'not_required'
       AND attempt.dispatch_authorized_at IS NULL
       AND attempt.superseded_by_attempt_id IS NULL
       AND attempt.payload_revision = $4
     FOR UPDATE`,
    [
      row.workspace_id,
      row.job_id,
      recovery.prior_completed_at_raw,
      recovery.snapshot_revision,
    ],
  );
  if (sources.rows.length !== 1) {
    throw recoveryError(
      'Recovery requires exactly one approved terminal worker attempt generation.',
      'RECOVERY_PRECONDITION_FAILED',
    );
  }
  const sourceAttemptId = sources.rows[0].id;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO rednote_publish_attempts (
       workspace_id, idempotency_key, contract_revision,
       source_notion_page_id, source_local_publish_job_id,
       frozen_payload, payload_digest, payload_revision,
       executor_type, executor_kind, executor_id,
       worker_run_id, playwright_run_id, target_publish_at, requested_at,
       approved_at, active, supersedes_attempt_id,
       authorization_kind, late_fallback_policy
     )
     SELECT
       source.workspace_id, gen_random_uuid(), source.contract_revision,
       source.source_notion_page_id, source.source_local_publish_job_id,
       source.frozen_payload, source.payload_digest, source.payload_revision,
       source.executor_type, source.executor_kind, source.executor_id,
       NULL, NULL, source.target_publish_at, source.requested_at,
       source.approved_at, true, source.id,
       source.authorization_kind, source.late_fallback_policy
     FROM rednote_publish_attempts source
     WHERE source.id = $1::uuid
     RETURNING id`,
    [sourceAttemptId],
  );
  const recoveryAttemptId = inserted.rows[0]?.id;
  if (!recoveryAttemptId) {
    throw recoveryError(
      'The approved recovery attempt generation could not be created.',
      'RECOVERY_STATE_CONFLICT',
    );
  }
  const superseded = await client.query<{ id: string }>(
    `UPDATE rednote_publish_attempts
     SET superseded_by_attempt_id = $1::uuid
     WHERE id = $2::uuid
       AND superseded_by_attempt_id IS NULL
       AND NOT active
       AND terminal_outcome = 'known_failed'
       AND receipt_lookup_state = 'not_required'
       AND dispatch_authorized_at IS NULL
     RETURNING id`,
    [recoveryAttemptId, sourceAttemptId],
  );
  if (superseded.rows.length !== 1) {
    throw recoveryError(
      'The terminal worker attempt changed while recovery was being recorded.',
      'RECOVERY_STATE_CONFLICT',
    );
  }
  await client.query(
    `INSERT INTO rednote_publish_recovery_attempt_generations(
       recovery_id, source_attempt_id, recovery_attempt_id
     ) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
    [recovery.id, sourceAttemptId, recoveryAttemptId],
  );
  await client.query(
    `INSERT INTO rednote_publish_attempt_events(
       attempt_id, event_type, occurred_at, actor_type, actor_id, diagnostics
     ) VALUES
       ($1::uuid, 'superseded', CURRENT_TIMESTAMP, 'admin', $3, '{}'::jsonb),
       (
         $2::uuid, 'attempt_created', CURRENT_TIMESTAMP, 'admin', $3,
         '{}'::jsonb
       ),
       (
         $2::uuid, 'administrative_recovery', CURRENT_TIMESTAMP, 'admin', $3,
         jsonb_build_object(
           'recoveryId', $4::text,
           'sourceAttemptId', $1::text,
           'priorClaimAttempts', $5::integer,
           'operation', $6::text,
           'auditRecoveredBy', $7::text
         )
       )`,
    [
      sourceAttemptId,
      recoveryAttemptId,
      generationCreatedBy,
      recovery.id,
      recovery.prior_claim_attempts,
      operation,
      auditRecoveredBy,
    ],
  );
  return recoveryAttemptId;
}

export async function recoverStoredApprovedPublishJobTransaction(
  client: Pick<PoolClient, 'query'>,
  input: RednotePublishJobRecoveryInput,
  recoveredBy: string,
) {
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('rednote-bootstrap-batch', 0))",
    );
    const identity = await client.query<{
      workspace_id: string;
      notion_page_id: string;
    }>(
      `SELECT workspace_id, notion_page_id
       FROM local_publish_jobs
       WHERE id = $1::uuid`,
      [input.jobId],
    );
    const target = identity.rows[0];
    if (!target) {
      throw new LocalPublishJobError(
        'Recovery evidence does not identify an existing bounded publish job.',
        'RECOVERY_PRECONDITION_FAILED',
        409,
      );
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${target.workspace_id}:${target.notion_page_id}`],
    );
    const locked = await client.query<RecoveryRow>(
      `SELECT
         job.workspace_id,
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
         job.claimed_at::text AS claimed_at_raw,
         job.claim_expires_at,
         job.completed_at,
         job.completed_at::text AS completed_at_raw,
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
         recovery.prior_completed_at::text AS
           recovery_prior_completed_at_raw,
         generation.recovery_attempt_id
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
       LEFT JOIN rednote_publish_recovery_attempt_generations generation
         ON generation.recovery_id = recovery.id
       WHERE job.id = $1::uuid
         AND job.success_attestation_id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM plan_operator_scheduled_posts operator_scheduled
           WHERE operator_scheduled.workspace_id = job.workspace_id
             AND operator_scheduled.notion_page_id = job.notion_page_id
         )
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
    if (
      row.workspace_id !== target.workspace_id ||
      row.notion_page_id !== target.notion_page_id
    ) {
      throw new LocalPublishJobError(
        'Recovery ownership changed while acquiring the page lock.',
        'RECOVERY_PRECONDITION_FAILED',
        409,
      );
    }
    const existingAudit = audit(row);
    if (row.recovery_id && !existingAudit) {
      throw recoveryError(
        'The latest immutable recovery audit is incomplete.',
        'RECOVERY_PRECONDITION_FAILED',
      );
    }
    await client.query('LOCK TABLE external_post_reconciliations IN SHARE MODE');
    const ownership = await client.query<OwnershipRow>(
      `SELECT EXISTS (
         SELECT 1
         FROM rednote_publish_revision_blockers(
           $1,
           $2,
           $3,
           $4::uuid,
           $5::uuid,
           $6::uuid
         )
       ) AS active_ownership`,
      [
        row.workspace_id,
        row.notion_page_id,
        row.item_snapshot.notionLastEditedTime,
        row.item_id,
        row.job_id,
        row.recovery_attempt_id,
      ],
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
    if (action === 'repair_missing_attempt_lineage' && existingAudit) {
      if (!row.recovery_prior_completed_at_raw) {
        throw recoveryError(
          'The recovery audit is missing its exact completion timestamp.',
          'RECOVERY_STATE_CONFLICT',
        );
      }
      await ensureRecoveryAttemptGeneration(
        client,
        {
          id: existingAudit.id,
          snapshot_revision: existingAudit.snapshotRevision,
          prior_claim_attempts: existingAudit.priorClaimAttempts,
          prior_completed_at_raw: row.recovery_prior_completed_at_raw,
        },
        row,
        {
          auditRecoveredBy: existingAudit.recoveredBy,
          generationCreatedBy: recoveredBy,
          operation: 'repair_missing_attempt_lineage',
        },
      );
      await client.query('COMMIT');
      return result(existingAudit, row.approved_at, true);
    }
    if (!row.claimed_at_raw || !row.completed_at_raw) {
      throw new LocalPublishJobError(
        'The failed publish job is missing exact terminal timestamps.',
        'RECOVERY_PRECONDITION_FAILED',
        409,
      );
    }
    const inserted = await client.query<RecoveryAuditRow & {
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
       RETURNING id, recovered_at, snapshot_revision, prior_claim_attempts,
         prior_completed_at::text AS prior_completed_at_raw`,
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
        row.claimed_at_raw,
        row.completed_at_raw,
        recoveredBy,
      ],
    );
    if (!inserted.rows[0]) {
      throw recoveryError(
        'The recovery audit could not be recorded.',
        'RECOVERY_STATE_CONFLICT',
      );
    }
    await ensureRecoveryAttemptGeneration(
      client,
      inserted.rows[0],
      row,
      {
        auditRecoveredBy: recoveredBy,
        generationCreatedBy: recoveredBy,
        operation: 'recover_failed_job',
      },
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
         AND external_disposition_request_id IS NULL
         AND success_attestation_id IS NULL
         AND status = 'failed'
         AND error_code = $6
         AND error_message IS NOT DISTINCT FROM $7
         AND claim_attempts = $3
         AND claimed_at = $4::timestamptz
         AND completed_at = $5::timestamptz`,
      [
        row.job_id,
        row.item_id,
        row.claim_attempts,
        row.claimed_at_raw,
        row.completed_at_raw,
        row.job_error_code,
        row.job_error_message,
      ],
    );
    if (updated.rowCount !== 1) {
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
      priorClaimedAt: row.claimed_at_raw,
      priorCompletedAt: row.completed_at_raw,
    };
    await client.query('COMMIT');
    return result(record, row.approved_at, false);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function recoverStoredApprovedPublishJob(
  input: RednotePublishJobRecoveryInput,
  recoveredBy: string,
) {
  const client = await getPool().connect();
  try {
    return await recoverStoredApprovedPublishJobTransaction(
      client,
      input,
      recoveredBy,
    );
  } finally {
    client.release();
  }
}
