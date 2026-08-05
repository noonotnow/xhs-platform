import { isDeepStrictEqual } from 'util';
import type { QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { ManualSchedulingAttestationInput } from '@/lib/manual-scheduling-attestation-input';
import {
  MANUAL_SCHEDULING_ATTESTATION_CONTRACT_REVISION,
} from '@/lib/operator-success-attestation-contract';
import {
  expectedScheduledOutcome,
  loadOperatorSuccessAttestation,
  type OperatorSuccessAttestationRow,
} from '@/lib/operator-success-attestation-store';
import { manifestHash } from '@/lib/rednote-publish-batches';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

interface ManualCandidateRow extends QueryResultRow {
  batch_id: string;
  batch_status: string;
  manifest_hash: string;
  approved_at: Date | string | null;
  item_id: string;
  notion_page_id: string;
  snapshot: LocalPublishSnapshot;
  item_hash: string;
  item_state: string;
  dispatch_mode: string;
  local_publish_job_id: string | null;
}

interface ManualJobRow extends QueryResultRow {
  id: string;
  notion_page_id: string;
  snapshot: LocalPublishSnapshot;
  status: string;
  claim_token: string | null;
  claimed_at: Date | string | null;
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
  batch_item_id: string | null;
}

function conflict(message: string, code = 'MANUAL_SCHEDULING_CONFLICT') {
  return new LocalPublishJobError(message, code, 409);
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertExactReplay(
  row: OperatorSuccessAttestationRow,
  input: ManualSchedulingAttestationInput,
  idempotencyKey: string,
  actor: string,
) {
  if (
    row.idempotency_key !== idempotencyKey ||
    row.provenance !== 'manual_scheduled' ||
    row.contract_revision !== MANUAL_SCHEDULING_ATTESTATION_CONTRACT_REVISION ||
    row.notion_page_id !== input.notionPageId ||
    row.batch_id !== input.batchId ||
    row.batch_item_id !== input.itemId ||
    row.manifest_hash !== input.manifestHash ||
    row.item_hash !== input.itemHash ||
    row.snapshot_revision !== input.snapshotRevision ||
    timestamp(row.requested_publish_at) !== input.requestedPublishAt ||
    row.attested_by !== actor
  ) {
    throw conflict(
      'Idempotency-Key or frozen packet belongs to a different manual scheduling assertion',
      'IDEMPOTENCY_CONFLICT',
    );
  }
}

export async function loadManualSchedulingAttestationReplay(
  input: ManualSchedulingAttestationInput,
  idempotencyKey: string,
  actor: string,
) {
  const client = await getPool().connect();
  try {
    const byKey = await client.query<OperatorSuccessAttestationRow>(
      `SELECT attestation.*, release_ack.acknowledged_at AS release_acknowledged_at
       FROM local_publish_job_success_attestations AS attestation
       LEFT JOIN local_publish_job_success_attestation_release_acks AS release_ack
         ON release_ack.success_attestation_id = attestation.id
       WHERE attestation.idempotency_key = $1::uuid`,
      [idempotencyKey],
    );
    const row = byKey.rows[0];
    if (!row) {
      return null;
    }
    assertExactReplay(row, input, idempotencyKey, actor);
    return {
      attestation: (await loadOperatorSuccessAttestation(row.id))!,
      created: false,
    };
  } finally {
    client.release();
  }
}

function validateCandidate(
  row: ManualCandidateRow,
  input: ManualSchedulingAttestationInput,
) {
  if (
    row.batch_id !== input.batchId ||
    row.item_id !== input.itemId ||
    row.notion_page_id !== input.notionPageId ||
    row.snapshot.notionPageId !== input.notionPageId ||
    row.manifest_hash !== input.manifestHash ||
    row.item_hash !== input.itemHash ||
    row.snapshot.notionLastEditedTime !== input.snapshotRevision ||
    row.snapshot.publishAt !== input.requestedPublishAt ||
    manifestHash(row.snapshot) !== input.itemHash
  ) {
    throw conflict(
      'Post, batch, frozen packet, revision, digest, or requested schedule changed',
      'MANUAL_SCHEDULING_EVIDENCE_MISMATCH',
    );
  }
  if (
    !['approved', 'partially_approved'].includes(row.batch_status) ||
    !row.approved_at ||
    row.dispatch_mode !== 'scheduled' ||
    !row.snapshot.publishAt ||
    !['approved', 'queued'].includes(row.item_state)
  ) {
    throw conflict(
      'Only an exact approved frozen scheduled packet is eligible',
      'MANUAL_SCHEDULING_INELIGIBLE',
    );
  }
  if (row.item_state === 'queued' && !row.local_publish_job_id) {
    throw conflict(
      'The queued frozen packet is missing its exact local queue record',
      'MANUAL_SCHEDULING_QUEUE_CONFLICT',
    );
  }
}

function assertSafeQueuedJob(job: ManualJobRow, row: ManualCandidateRow) {
  if (
    job.notion_page_id !== row.notion_page_id ||
    job.batch_item_id !== row.item_id ||
    !isDeepStrictEqual(job.snapshot, row.snapshot)
  ) {
    throw conflict(
      'The local queue record does not match the exact frozen packet',
      'MANUAL_SCHEDULING_JOB_COLLISION',
    );
  }
  if (
    job.status !== 'queued' ||
    job.claim_token ||
    job.claimed_at ||
    job.staged_at ||
    job.dispatch_authorized_at ||
    job.dispatched_at ||
    job.note_id ||
    job.share_url ||
    job.verified_at ||
    job.reconciled_at ||
    job.completed_at ||
    job.external_disposition_request_id ||
    job.success_attestation_id
  ) {
    throw conflict(
      'A worker already owns or completed the exact local attempt; use its existing lifecycle',
      'MANUAL_SCHEDULING_JOB_COLLISION',
    );
  }
}

export async function insertManualSchedulingAttestation(
  input: ManualSchedulingAttestationInput,
  idempotencyKey: string,
  actor: string,
) {
  const client = await getPool().connect();
  let attestationId: string | undefined;
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`manual-scheduling:${idempotencyKey}`],
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
      assertExactReplay(byKey.rows[0], input, idempotencyKey, actor);
      attestationId = byKey.rows[0].id;
      await client.query('COMMIT');
      return {
        attestation: (await loadOperatorSuccessAttestation(attestationId))!,
        created: false,
      };
    }

    const candidate = await client.query<ManualCandidateRow>(
      `SELECT
         batch.id AS batch_id,
         batch.status AS batch_status,
         batch.manifest_hash,
         batch.approved_at,
         item.id AS item_id,
         item.notion_page_id,
         item.snapshot,
         item.item_hash,
         item.state AS item_state,
         item.dispatch_mode,
         item.local_publish_job_id
       FROM rednote_publish_batch_items AS item
       JOIN rednote_publish_batches AS batch ON batch.id = item.batch_id
       WHERE item.id = $1::uuid AND batch.id = $2::uuid
       FOR UPDATE OF item, batch`,
      [input.itemId, input.batchId],
    );
    const row = candidate.rows[0];
    if (!row) {
      throw conflict(
        'Manual scheduling evidence does not identify an exact frozen batch item',
        'MANUAL_SCHEDULING_NOT_FOUND',
      );
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [row.notion_page_id],
    );
    validateCandidate(row, input);

    let job: ManualJobRow | undefined;
    let priorJobStatus = 'no_worker_job';
    if (row.local_publish_job_id) {
      const lockedJob = await client.query<ManualJobRow>(
        'SELECT * FROM local_publish_jobs WHERE id = $1::uuid FOR UPDATE',
        [row.local_publish_job_id],
      );
      job = lockedJob.rows[0];
      if (!job) {
        throw conflict(
          'The frozen packet references a missing local queue record',
          'MANUAL_SCHEDULING_JOB_COLLISION',
        );
      }
      assertSafeQueuedJob(job, row);
      priorJobStatus = job.status;
    }

    await client.query('LOCK TABLE external_post_reconciliations IN SHARE MODE');
    await client.query('LOCK TABLE xhs_publish_receipts IN SHARE MODE');
    const ownership = await client.query<{ conflict: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM local_publish_jobs AS other
           WHERE other.notion_page_id = $1
             AND ($2::uuid IS NULL OR other.id <> $2::uuid)
             AND (
               other.status NOT IN ('reconciled', 'failed')
               OR other.dispatch_authorized_at IS NOT NULL
               OR other.dispatched_at IS NOT NULL
               OR other.note_id IS NOT NULL
               OR other.share_url IS NOT NULL
               OR other.success_attestation_id IS NOT NULL
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
       ) AS conflict`,
      [row.notion_page_id, job?.id ?? null, row.item_id],
    );
    if (ownership.rows[0]?.conflict) {
      throw conflict(
        'Another durable receipt or lifecycle owns this exact post',
        'MANUAL_SCHEDULING_DURABLE_CONFLICT',
      );
    }

    const existing = await client.query<OperatorSuccessAttestationRow>(
      `SELECT attestation.*, release_ack.acknowledged_at AS release_acknowledged_at
       FROM local_publish_job_success_attestations AS attestation
       LEFT JOIN local_publish_job_success_attestation_release_acks AS release_ack
         ON release_ack.success_attestation_id = attestation.id
       WHERE attestation.batch_item_id = $1::uuid
       FOR SHARE OF attestation`,
      [input.itemId],
    );
    if (existing.rows[0]) {
      assertExactReplay(existing.rows[0], input, idempotencyKey, actor);
      attestationId = existing.rows[0].id;
      await client.query('COMMIT');
      return {
        attestation: (await loadOperatorSuccessAttestation(attestationId))!,
        created: false,
      };
    }

    if (!job) {
      const insertedJob = await client.query<ManualJobRow>(
        `INSERT INTO local_publish_jobs (
           notion_page_id, snapshot, status, idempotency_key, batch_item_id
         ) VALUES ($1, $2::jsonb, 'queued', gen_random_uuid(), $3::uuid)
         RETURNING *`,
        [row.notion_page_id, JSON.stringify(row.snapshot), row.item_id],
      );
      job = insertedJob.rows[0];
      if (!job) {
        throw conflict(
          'The receipt-pending lifecycle could not be created',
          'MANUAL_SCHEDULING_WRITE_FAILED',
        );
      }
    }

    const exactOutcome = expectedScheduledOutcome(input.requestedPublishAt);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO local_publish_job_success_attestations (
         idempotency_key, local_publish_job_id, notion_page_id, batch_id,
         batch_item_id, manifest_hash, item_hash, snapshot_revision,
         snapshot_digest, contract_revision, prior_claim_token_digest,
         expected_outcome, requested_publish_at, prior_job_status,
         prior_claim_attempts, attested_by, provenance
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10,
         NULL, $11, $12::timestamptz, $13, 0, $14, 'manual_scheduled'
       )
       RETURNING id`,
      [
        idempotencyKey,
        job.id,
        row.notion_page_id,
        row.batch_id,
        row.item_id,
        row.manifest_hash,
        row.item_hash,
        row.snapshot.notionLastEditedTime,
        row.item_hash,
        MANUAL_SCHEDULING_ATTESTATION_CONTRACT_REVISION,
        exactOutcome.text,
        exactOutcome.publishAt,
        priorJobStatus,
        actor,
      ],
    );
    attestationId = inserted.rows[0]?.id;
    if (!attestationId) {
      throw conflict(
        'The immutable manual scheduling evidence could not be recorded',
        'MANUAL_SCHEDULING_WRITE_FAILED',
      );
    }
    const updated = await client.query(
      `UPDATE local_publish_jobs
       SET status = 'operator_attested',
           success_attestation_id = $1::uuid,
           claim_token = NULL,
           claim_expires_at = CURRENT_TIMESTAMP,
           next_verification_at = NULL,
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid
         AND status = 'queued'
         AND success_attestation_id IS NULL
       RETURNING id`,
      [attestationId, job.id],
    );
    if (updated.rowCount !== 1) {
      throw conflict(
        'The exact queue record changed before manual scheduling could commit',
        'MANUAL_SCHEDULING_JOB_COLLISION',
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    attestation: (await loadOperatorSuccessAttestation(attestationId!))!,
    created: true,
  };
}
