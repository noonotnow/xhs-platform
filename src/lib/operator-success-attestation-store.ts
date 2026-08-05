import { isDeepStrictEqual } from 'util';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool, sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { manifestHash } from '@/lib/rednote-publish-batches';
import {
  ATTESTATION_RELEASE_CONSUMED_CODE,
  ATTESTATION_RELEASE_CONSUMED_MESSAGE,
  claimTokenDigest,
  OPERATOR_SUCCESS_ATTESTATION_CONTRACT_REVISION,
  OPERATOR_SUCCESS_ATTESTATION_TIME_ZONE,
  operatorSuccessAttestationEnabled,
} from '@/lib/operator-success-attestation-contract';
import {
  RECOVERABLE_AMBIGUOUS_CREATOR_ERROR,
} from '@/lib/rednote-publish-job-recovery';
import type {
  LocalPublishSnapshot,
  OperatorSuccessAttestationEvidence,
  OperatorSuccessAttestationSummary,
} from '@/types/local-publish-job';
import type {
  OperatorSuccessAttestationInput,
} from '@/lib/operator-success-attestation-input';

export interface OperatorSuccessCandidateRow extends QueryResultRow {
  job_id: string;
  notion_page_id: string;
  job_snapshot: LocalPublishSnapshot;
  job_status: string;
  claim_token: string | null;
  claim_expires_at: Date | string | null;
  claim_expired: boolean;
  claim_attempts: number;
  error_code: string | null;
  error_message: string | null;
  staged_at: Date | string | null;
  dispatch_authorized_at: Date | string | null;
  dispatched_at: Date | string | null;
  note_id: string | null;
  share_url: string | null;
  verified_at: Date | string | null;
  reconciled_at: Date | string | null;
  completed_at: Date | string | null;
  external_disposition_request_id: string | null;
  success_attestation_id: string | null;
  batch_id: string;
  batch_status: string;
  manifest_hash: string;
  approved_at: Date | string | null;
  item_id: string;
  item_notion_page_id: string;
  item_snapshot: LocalPublishSnapshot;
  item_hash: string;
  item_state: string;
  dispatch_mode: string;
  item_local_publish_job_id: string | null;
}

export interface OperatorSuccessAttestationRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  local_publish_job_id: string;
  notion_page_id: string;
  batch_id: string;
  batch_item_id: string;
  manifest_hash: string;
  item_hash: string;
  snapshot_revision: string;
  snapshot_digest: string;
  contract_revision: typeof OPERATOR_SUCCESS_ATTESTATION_CONTRACT_REVISION;
  prior_claim_token_digest: string;
  expected_outcome: string;
  requested_publish_at: Date | string;
  attested_by: string;
  attested_at: Date | string;
  release_acknowledged_at?: Date | string | null;
}

function conflict(message: string, code = 'SUCCESS_ATTESTATION_CONFLICT') {
  return new LocalPublishJobError(message, code, 409);
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function expectedScheduledOutcome(publishAt: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATOR_SUCCESS_ATTESTATION_TIME_ZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(publishAt));
  const part = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (!value) throw new Error(`Scheduled outcome is missing ${type}`);
    return value;
  };
  const formatted =
    `${part('month')} ${part('day')}, ${part('year')} at ` +
    `${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`;
  return {
    kind: 'scheduled' as const,
    publishAt,
    timeZone: OPERATOR_SUCCESS_ATTESTATION_TIME_ZONE,
    text: `Successfully scheduled for ${formatted} ET`,
  };
}

function evidence(row: OperatorSuccessCandidateRow): OperatorSuccessAttestationEvidence {
  const requestedPublishAt = row.job_snapshot.publishAt!;
  return {
    batchId: row.batch_id,
    manifestHash: row.manifest_hash,
    itemId: row.item_id,
    jobId: row.job_id,
    itemHash: row.item_hash,
    snapshotRevision: row.job_snapshot.notionLastEditedTime,
    requestedPublishAt,
    expectedOutcome: expectedScheduledOutcome(requestedPublishAt),
  };
}

function summary(row: OperatorSuccessAttestationRow): OperatorSuccessAttestationSummary {
  const requestedPublishAt = timestamp(row.requested_publish_at);
  const localReleaseIdentity = {
    jobId: row.local_publish_job_id,
    notionPageId: row.notion_page_id,
    priorClaimTokenDigest: row.prior_claim_token_digest,
    batchId: row.batch_id,
    manifestHash: row.manifest_hash,
    itemHash: row.item_hash,
    snapshotRevision: row.snapshot_revision,
    requestedPublishAt,
    publishMode: 'scheduled' as const,
  };
  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    contractRevision: row.contract_revision,
    batchId: row.batch_id,
    manifestHash: row.manifest_hash,
    itemId: row.batch_item_id,
    jobId: row.local_publish_job_id,
    itemHash: row.item_hash,
    snapshotRevision: row.snapshot_revision,
    snapshotDigest: row.snapshot_digest,
    priorClaimTokenDigest: row.prior_claim_token_digest,
    releaseRequired: !row.release_acknowledged_at,
    localReleaseIdentity,
    requestedPublishAt,
    expectedOutcome: {
      kind: 'scheduled',
      publishAt: requestedPublishAt,
      timeZone: OPERATOR_SUCCESS_ATTESTATION_TIME_ZONE,
      text: row.expected_outcome,
    },
    attestedBy: row.attested_by,
    attestedAt: timestamp(row.attested_at),
  };
}

export function validateExactOperatorSuccessAttestationReplay(
  row: OperatorSuccessAttestationRow,
  input: OperatorSuccessAttestationInput,
  idempotencyKey: string,
  actor: string,
) {
  if (
    row.idempotency_key !== idempotencyKey ||
    row.local_publish_job_id !== input.jobId ||
    row.batch_id !== input.batchId ||
    row.batch_item_id !== input.itemId ||
    row.manifest_hash !== input.manifestHash ||
    row.item_hash !== input.itemHash ||
    row.snapshot_revision !== input.snapshotRevision ||
    timestamp(row.requested_publish_at) !== input.requestedPublishAt ||
    row.attested_by !== actor
  ) {
    throw conflict(
      'Idempotency-Key or durable ownership belongs to a different attestation',
      'IDEMPOTENCY_CONFLICT',
    );
  }
}

export function validateOperatorSuccessCandidate(
  row: OperatorSuccessCandidateRow,
  input: OperatorSuccessAttestationInput,
) {
  const frozenPublishAt = row.job_snapshot.publishAt;
  if (
    row.job_id !== input.jobId ||
    row.batch_id !== input.batchId ||
    row.item_id !== input.itemId ||
    row.item_local_publish_job_id !== input.jobId ||
    row.notion_page_id !== row.item_notion_page_id ||
    row.job_snapshot.notionPageId !== row.notion_page_id ||
    row.item_snapshot.notionPageId !== row.notion_page_id ||
    row.manifest_hash !== input.manifestHash ||
    row.item_hash !== input.itemHash ||
    row.job_snapshot.notionLastEditedTime !== input.snapshotRevision ||
    row.item_snapshot.notionLastEditedTime !== input.snapshotRevision ||
    frozenPublishAt !== input.requestedPublishAt ||
    row.item_snapshot.publishAt !== input.requestedPublishAt ||
    !isDeepStrictEqual(row.job_snapshot, row.item_snapshot) ||
    manifestHash(row.job_snapshot) !== input.itemHash
  ) {
    throw conflict(
      'Job, page, batch linkage, frozen snapshot, digest, or requested schedule changed',
      'SUCCESS_ATTESTATION_EVIDENCE_MISMATCH',
    );
  }
  if (!row.claim_token) {
    throw conflict(
      'The exact prior local attempt has no claim identity to revoke',
      'SUCCESS_ATTESTATION_ATTEMPT_MISMATCH',
    );
  }
  if (
    row.batch_status !== 'approved' ||
    !row.approved_at ||
    row.dispatch_mode !== 'scheduled' ||
    !frozenPublishAt
  ) {
    throw conflict(
      'Only an exact approved frozen scheduled attempt can be attested',
      'SUCCESS_ATTESTATION_INELIGIBLE',
    );
  }
  if (
    row.dispatched_at ||
    row.note_id ||
    row.share_url ||
    row.verified_at ||
    row.reconciled_at ||
    row.external_disposition_request_id
  ) {
    throw conflict(
      'Durable dispatch, identity, verification, or disposition evidence conflicts',
      'SUCCESS_ATTESTATION_DURABLE_CONFLICT',
    );
  }
  const expiredStaged = row.job_status === 'staged' &&
    row.claim_expired &&
    Boolean(row.staged_at && row.dispatch_authorized_at);
  const ambiguousFailure = row.job_status === 'failed' &&
    row.error_code === RECOVERABLE_AMBIGUOUS_CREATOR_ERROR &&
    Boolean(row.staged_at || row.dispatch_authorized_at) &&
    Boolean(row.completed_at);
  if (!expiredStaged && !ambiguousFailure) {
    throw conflict(
      'Only the exact expired staged or terminal ambiguous Creator attempt is eligible',
      row.job_status === 'failed'
        ? 'SUCCESS_ATTESTATION_DEFINITIVE_FAILURE'
        : 'SUCCESS_ATTESTATION_INELIGIBLE',
    );
  }
}

async function lockedCandidate(client: PoolClient, jobId: string) {
  const result = await client.query<OperatorSuccessCandidateRow>(
    `SELECT
       job.id AS job_id,
       job.notion_page_id,
       job.snapshot AS job_snapshot,
       job.status AS job_status,
       job.claim_token,
       job.claim_expires_at,
       job.claim_expires_at <= CURRENT_TIMESTAMP AS claim_expired,
       job.claim_attempts,
       job.error_code,
       job.error_message,
       job.staged_at,
       job.dispatch_authorized_at,
       job.dispatched_at,
       job.note_id,
       job.share_url,
       job.verified_at,
       job.reconciled_at,
       job.completed_at,
       job.external_disposition_request_id,
       job.success_attestation_id,
       batch.id AS batch_id,
       batch.status AS batch_status,
       batch.manifest_hash,
       batch.approved_at,
       item.id AS item_id,
       item.notion_page_id AS item_notion_page_id,
       item.snapshot AS item_snapshot,
       item.item_hash,
       item.state AS item_state,
       item.dispatch_mode,
       item.local_publish_job_id AS item_local_publish_job_id
     FROM local_publish_jobs AS job
     JOIN rednote_publish_batch_items AS item ON item.id = job.batch_item_id
     JOIN rednote_publish_batches AS batch ON batch.id = item.batch_id
     WHERE job.id = $1::uuid
     FOR UPDATE OF job, item, batch`,
    [jobId],
  );
  if (!result.rows[0]) {
    throw conflict(
      'Attestation evidence does not identify an exact bounded local job',
      'SUCCESS_ATTESTATION_NOT_FOUND',
    );
  }
  return result.rows[0];
}

export const OPERATOR_SUCCESS_ATTESTATION_OWNERSHIP_SQL = `SELECT (
       EXISTS (
         SELECT 1 FROM local_publish_jobs AS other
         WHERE other.notion_page_id = $1
           AND other.id <> $2::uuid
           AND (
             other.status NOT IN ('reconciled', 'failed')
             OR (
               other.status = 'failed'
               AND (
                 other.dispatch_authorized_at IS NOT NULL
                 OR other.dispatched_at IS NOT NULL
                 OR other.note_id IS NOT NULL
                 OR other.share_url IS NOT NULL
                 OR other.success_attestation_id IS NOT NULL
               )
             )
           )
       )
       OR EXISTS (
         SELECT 1 FROM rednote_publish_batch_items AS other
         WHERE other.notion_page_id = $1
           AND other.id <> $3::uuid
           AND other.state NOT IN ('invalidated', 'reconciled', 'failed')
       )
       OR EXISTS (
         SELECT 1 FROM manual_reconciliation_requests
         WHERE notion_page_id = $1
       )
       OR EXISTS (
         SELECT 1 FROM external_post_reconciliations
         WHERE notion_page_id = $1
       )
       OR EXISTS (
         SELECT 1 FROM xhs_publish_receipts
         WHERE notion_page_id = $1
       )
     ) AS conflict`;

async function assertNoConflictingOwnership(
  client: PoolClient,
  row: OperatorSuccessCandidateRow,
) {
  const ownership = await client.query<{ conflict: boolean }>(
    OPERATOR_SUCCESS_ATTESTATION_OWNERSHIP_SQL,
    [row.notion_page_id, row.job_id, row.item_id],
  );
  if (ownership.rows[0]?.conflict) {
    throw conflict(
      'Another durable receipt or lifecycle owns this exact page',
      'SUCCESS_ATTESTATION_DURABLE_CONFLICT',
    );
  }
}

export async function insertOperatorSuccessAttestation(
  input: OperatorSuccessAttestationInput,
  idempotencyKey: string,
  actor: string,
) {
  if (!operatorSuccessAttestationEnabled()) {
    throw new LocalPublishJobError(
      'The local worker attestation release contract is not enabled',
      'SUCCESS_ATTESTATION_CONTRACT_DISABLED',
      503,
    );
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`success-attestation:${idempotencyKey}`],
    );
    const byKey = await client.query<OperatorSuccessAttestationRow>(
      `SELECT attestation.*, release_ack.acknowledged_at AS release_acknowledged_at
       FROM local_publish_job_success_attestations AS attestation
       LEFT JOIN local_publish_job_success_attestation_release_acks AS release_ack
         ON release_ack.success_attestation_id = attestation.id
       WHERE attestation.idempotency_key = $1::uuid
       FOR SHARE OF attestation`,
      [idempotencyKey],
    );
    if (byKey.rows[0]) {
      validateExactOperatorSuccessAttestationReplay(
        byKey.rows[0],
        input,
        idempotencyKey,
        actor,
      );
      await client.query('COMMIT');
      return { attestation: summary(byKey.rows[0]), created: false };
    }
    const row = await lockedCandidate(client, input.jobId);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [row.notion_page_id],
    );
    await client.query('LOCK TABLE external_post_reconciliations IN SHARE MODE');
    await client.query('LOCK TABLE xhs_publish_receipts IN SHARE MODE');
    validateOperatorSuccessCandidate(row, input);
    await assertNoConflictingOwnership(client, row);
    const existing = await client.query<OperatorSuccessAttestationRow>(
      `SELECT attestation.*, release_ack.acknowledged_at AS release_acknowledged_at
       FROM local_publish_job_success_attestations AS attestation
       LEFT JOIN local_publish_job_success_attestation_release_acks AS release_ack
         ON release_ack.success_attestation_id = attestation.id
       WHERE attestation.local_publish_job_id = $1::uuid
         OR attestation.batch_item_id = $2::uuid
       FOR SHARE OF attestation`,
      [input.jobId, input.itemId],
    );
    if (existing.rows[0]) {
      validateExactOperatorSuccessAttestationReplay(
        existing.rows[0],
        input,
        idempotencyKey,
        actor,
      );
      await client.query('COMMIT');
      return { attestation: summary(existing.rows[0]), created: false };
    }
    const exactEvidence = evidence(row);
    const inserted = await client.query<OperatorSuccessAttestationRow>(
      `INSERT INTO local_publish_job_success_attestations (
         idempotency_key, local_publish_job_id, notion_page_id, batch_id,
         batch_item_id, manifest_hash, item_hash, snapshot_revision,
         snapshot_digest, contract_revision, prior_claim_token_digest,
         expected_outcome, requested_publish_at,
         prior_job_status, prior_error_code, prior_error_message,
         prior_claim_attempts, prior_staged_at, prior_dispatch_authorized_at,
         prior_completed_at, attested_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10,
         $11, $12, $13::timestamptz, $14, $15, $16, $17, $18, $19, $20, $21
       )
       RETURNING *`,
      [
        idempotencyKey,
        row.job_id,
        row.notion_page_id,
        row.batch_id,
        row.item_id,
        row.manifest_hash,
        row.item_hash,
        row.job_snapshot.notionLastEditedTime,
        row.item_hash,
        OPERATOR_SUCCESS_ATTESTATION_CONTRACT_REVISION,
        claimTokenDigest(row.claim_token!),
        exactEvidence.expectedOutcome.text,
        exactEvidence.requestedPublishAt,
        row.job_status,
        row.error_code,
        row.error_message,
        row.claim_attempts,
        row.staged_at,
        row.dispatch_authorized_at,
        row.completed_at,
        actor,
      ],
    );
    const attestation = inserted.rows[0];
    if (!attestation) throw conflict('The durable attestation could not be inserted');
    const updatedJob = await client.query(
      `UPDATE local_publish_jobs
       SET status = 'operator_attested',
           success_attestation_id = $1::uuid,
           claim_token = NULL,
           claim_expires_at = CURRENT_TIMESTAMP,
           next_verification_at = CURRENT_TIMESTAMP,
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid
         AND success_attestation_id IS NULL
       RETURNING id`,
      [attestation.id, input.jobId],
    );
    const updatedItem = await client.query(
      `UPDATE rednote_publish_batch_items
       SET state = 'operator_attested',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid
         AND local_publish_job_id = $2::uuid
         AND state IN ($3, 'operator_attested')
       RETURNING id`,
      [input.itemId, input.jobId, row.item_state],
    );
    if (updatedJob.rowCount !== 1 || updatedItem.rowCount !== 1) {
      throw conflict('The exact job changed before attestation could be committed');
    }
    await client.query('COMMIT');
    return { attestation: summary(attestation), created: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface OperatorSuccessReleaseRow extends QueryResultRow {
  job_status: string;
  claim_token: string | null;
  claim_expires_at: Date | string | null;
  attestation_id: string;
  requested_publish_at: Date | string;
  acknowledgement_claim_token_digest: string | null;
}

export async function acknowledgeOperatorSuccessAttestationRelease(
  jobId: string,
  claimToken: string,
) {
  const acknowledgementDigest = claimTokenDigest(claimToken);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`attestation-release:${jobId}`],
    );
    const result = await client.query<OperatorSuccessReleaseRow>(
      `SELECT
         job.status AS job_status,
         job.claim_token,
         job.claim_expires_at,
         attestation.id AS attestation_id,
         attestation.requested_publish_at,
         release_ack.acknowledgement_claim_token_digest
       FROM local_publish_jobs AS job
       JOIN local_publish_job_success_attestations AS attestation
         ON attestation.id = job.success_attestation_id
       LEFT JOIN local_publish_job_success_attestation_release_acks AS release_ack
         ON release_ack.success_attestation_id = attestation.id
       WHERE job.id = $1::uuid
       FOR UPDATE OF job, attestation`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) {
      throw conflict(
        'The operator-attested release does not identify an exact durable receipt',
        'ATTESTATION_RELEASE_NOT_FOUND',
      );
    }
    if (row.acknowledgement_claim_token_digest) {
      if (row.acknowledgement_claim_token_digest !== acknowledgementDigest) {
        throw conflict(
          'The release was already acknowledged by a different verification claim',
          'ATTESTATION_RELEASE_ACK_CONFLICT',
        );
      }
      await client.query('COMMIT');
      return { replayed: true };
    }
    const claimExpiresAt = row.claim_expires_at
      ? new Date(row.claim_expires_at).getTime()
      : 0;
    if (
      row.job_status !== 'operator_attested' ||
      row.claim_token !== claimToken ||
      claimExpiresAt <= Date.now()
    ) {
      throw conflict(
        'The operator-attested release claim is stale, expired, or mismatched',
        'STALE_CLAIM',
      );
    }
    await client.query(
      `INSERT INTO local_publish_job_success_attestation_release_acks (
         success_attestation_id,
         acknowledgement_claim_token_digest
       ) VALUES ($1::uuid, $2)`,
      [row.attestation_id, acknowledgementDigest],
    );
    const updated = await client.query(
      `UPDATE local_publish_jobs
       SET next_verification_at = GREATEST(
             CURRENT_TIMESTAMP,
             $1::timestamptz + INTERVAL '15 minutes'
           ),
           claim_expires_at = CURRENT_TIMESTAMP,
           error_code = $2,
           error_message = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4::uuid
         AND status = 'operator_attested'
         AND success_attestation_id = $5::uuid
       RETURNING id`,
      [
        row.requested_publish_at,
        ATTESTATION_RELEASE_CONSUMED_CODE,
        ATTESTATION_RELEASE_CONSUMED_MESSAGE,
        jobId,
        row.attestation_id,
      ],
    );
    if (updated.rowCount !== 1) {
      throw conflict(
        'The operator-attested job changed before release acknowledgement committed',
        'ATTESTATION_RELEASE_ACK_CONFLICT',
      );
    }
    await client.query('COMMIT');
    return { replayed: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listOperatorSuccessAttestationEvidence() {
  if (!operatorSuccessAttestationEnabled()) return [];
  const result = await sql<OperatorSuccessCandidateRow>`
    SELECT
      job.id AS job_id,
      job.notion_page_id,
      job.snapshot AS job_snapshot,
      job.status AS job_status,
      job.claim_token,
      job.claim_expires_at,
      job.claim_expires_at <= CURRENT_TIMESTAMP AS claim_expired,
      job.claim_attempts,
      job.error_code,
      job.error_message,
      job.staged_at,
      job.dispatch_authorized_at,
      job.dispatched_at,
      job.note_id,
      job.share_url,
      job.verified_at,
      job.reconciled_at,
      job.completed_at,
      job.external_disposition_request_id,
      job.success_attestation_id,
      batch.id AS batch_id,
      batch.status AS batch_status,
      batch.manifest_hash,
      batch.approved_at,
      item.id AS item_id,
      item.notion_page_id AS item_notion_page_id,
      item.snapshot AS item_snapshot,
      item.item_hash,
      item.state AS item_state,
      item.dispatch_mode,
      item.local_publish_job_id AS item_local_publish_job_id
    FROM local_publish_jobs AS job
    JOIN rednote_publish_batch_items AS item ON item.id = job.batch_item_id
    JOIN rednote_publish_batches AS batch ON batch.id = item.batch_id
    WHERE job.success_attestation_id IS NULL
      AND (
        (
          job.status = 'staged'
          AND job.claim_expires_at <= CURRENT_TIMESTAMP
          AND job.staged_at IS NOT NULL
          AND job.dispatch_authorized_at IS NOT NULL
        )
        OR (
          job.status = 'failed'
          AND job.error_code = ${RECOVERABLE_AMBIGUOUS_CREATOR_ERROR}
          AND (job.staged_at IS NOT NULL OR job.dispatch_authorized_at IS NOT NULL)
          AND job.completed_at IS NOT NULL
        )
      )
    ORDER BY job.created_at DESC
    LIMIT 20
  `;
  return result.rows.flatMap((row) => {
    try {
      const candidate = evidence(row);
      validateOperatorSuccessCandidate(row, candidate);
      return [candidate];
    } catch (error) {
      console.warn('Ignoring invalid operator success attestation candidate', {
        jobId: row.job_id,
        itemId: row.item_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
}

export async function loadOperatorSuccessAttestation(id: string) {
  const result = await sql<OperatorSuccessAttestationRow>`
    SELECT attestation.*, release_ack.acknowledged_at AS release_acknowledged_at
    FROM local_publish_job_success_attestations AS attestation
    LEFT JOIN local_publish_job_success_attestation_release_acks AS release_ack
      ON release_ack.success_attestation_id = attestation.id
    WHERE attestation.id = ${id}::uuid
    LIMIT 1
  `;
  return result.rows[0] ? summary(result.rows[0]) : undefined;
}
