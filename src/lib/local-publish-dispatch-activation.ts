import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';

const ACTIVE_STATES = ['active', 'consumed'] as const;
const DEFAULT_TTL_MINUTES = 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface ActivationRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  local_publish_job_id: string;
  batch_id: string;
  batch_item_id: string;
  manifest_hash: string;
  item_hash: string;
  source_revision: string;
  expected_worker_id: string;
  expected_worker_contract_revision: string;
  expected_worker_compatibility_revision: string;
  generation: number;
  state: 'prepared' | 'active' | 'consumed' | 'released' | 'cancelled';
  created_at: Date | string;
  created_by: string;
  authorized_at: Date | string | null;
  authorized_by: string | null;
  consumed_at: Date | string | null;
  consumed_by: string | null;
  released_at: Date | string | null;
  released_by: string | null;
  release_reason: string | null;
  cancelled_at: Date | string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  expires_at: Date | string;
}

export interface PrepareDispatchActivationInput {
  workspaceId: string;
  jobId: string;
  batchId: string;
  itemId: string;
  manifestHash: string;
  itemHash: string;
  sourceRevision: string;
  generation: number;
  expectedWorkerId: string;
  expectedWorkerContractRevision: string;
  expectedWorkerCompatibilityRevision: string;
  ttlMinutes?: number;
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

function activation(row: ActivationRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    jobId: row.local_publish_job_id,
    batchId: row.batch_id,
    itemId: row.batch_item_id,
    manifestHash: row.manifest_hash,
    itemHash: row.item_hash,
    sourceRevision: row.source_revision,
    generation: row.generation,
    expectedWorker: {
      id: row.expected_worker_id,
      contractRevision: row.expected_worker_contract_revision,
      compatibilityRevision: row.expected_worker_compatibility_revision,
    },
    state: row.state,
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    authorizedAt: iso(row.authorized_at),
    authorizedBy: row.authorized_by,
    consumedAt: iso(row.consumed_at),
    consumedBy: row.consumed_by,
    releasedAt: iso(row.released_at),
    releasedBy: row.released_by,
    releaseReason: row.release_reason,
    cancelledAt: iso(row.cancelled_at),
    cancelledBy: row.cancelled_by,
    cancellationReason: row.cancellation_reason,
    expiresAt: iso(row.expires_at),
  };
}

function digestNonce(nonce: string) {
  return createHash('sha256').update(nonce).digest('hex');
}

function holdError(message = 'An exclusive dispatch activation hold is active') {
  return new LocalPublishJobError(
    message,
    'DISPATCH_ACTIVATION_HOLD_ACTIVE',
    409,
  );
}

async function appendEvent(
  client: Pick<PoolClient, 'query'>,
  activationId: string,
  eventType: 'prepared' | 'activated' | 'released' | 'cancelled',
  actorId: string,
  details: Record<string, unknown> = {},
) {
  await client.query(
    `INSERT INTO local_publish_dispatch_activation_events (
       activation_id, event_type, actor_type, actor_id, details
     ) VALUES ($1::uuid, $2, 'admin', $3, $4::jsonb)`,
    [activationId, eventType, actorId, JSON.stringify(details)],
  );
}

export async function assertNoDispatchActivationHold(
  queryable: Pick<PoolClient, 'query'> = getPool(),
) {
  const result = await queryable.query(
    `SELECT id
     FROM local_publish_dispatch_activations
     WHERE state = ANY($1::text[])
     LIMIT 1`,
    [ACTIVE_STATES],
  );
  if (result.rows[0]) throw holdError();
}

export async function assertExactActiveDispatchRecovery(
  queryable: Pick<PoolClient, 'query'>,
  jobId: string,
) {
  const result = await queryable.query<{ generation: number } & QueryResultRow>(
    `SELECT generation
     FROM local_publish_dispatch_activations
     WHERE state = 'active'
       AND local_publish_job_id = $1::uuid
       AND expires_at > CURRENT_TIMESTAMP
     LIMIT 1`,
    [jobId],
  );
  if (!result.rows[0]) {
    throw new LocalPublishJobError(
      'Recovery requires an unexpired active hold for this exact job',
      'DISPATCH_ACTIVATION_REQUIRED',
      409,
    );
  }
  const existing = await queryable.query<{ count: string } & QueryResultRow>(
    `SELECT COUNT(*)::text AS count
     FROM rednote_publish_recovery_attempt_generations generation
     JOIN rednote_publish_attempts attempt
       ON attempt.id = generation.recovery_attempt_id
     WHERE attempt.source_local_publish_job_id = $1::uuid`,
    [jobId],
  );
  if (Number(existing.rows[0]?.count ?? 0) + 1 !== result.rows[0].generation) {
    throw new LocalPublishJobError(
      'Recovery does not match the held attempt generation',
      'DISPATCH_ACTIVATION_GENERATION_MISMATCH',
      409,
    );
  }
}

export async function prepareDispatchActivation(
  input: PrepareDispatchActivationInput,
  actorId: string,
) {
  if (
    !input.workspaceId
    || input.workspaceId.length > 200
    || !UUID_PATTERN.test(input.jobId)
    || !UUID_PATTERN.test(input.batchId)
    || !UUID_PATTERN.test(input.itemId)
    || !SHA256_PATTERN.test(input.manifestHash)
    || !SHA256_PATTERN.test(input.itemHash)
    || !input.sourceRevision
    || input.sourceRevision.length > 200
    || !input.expectedWorkerId
    || input.expectedWorkerId.length > 200
    || !input.expectedWorkerContractRevision
    || input.expectedWorkerContractRevision.length > 100
    || !input.expectedWorkerCompatibilityRevision
    || input.expectedWorkerCompatibilityRevision.length > 100
  ) {
    throw new LocalPublishJobError(
      'Prepare requires exact UUIDs, SHA-256 hashes, source revision, and worker identity',
      'VALIDATION_ERROR',
      400,
    );
  }
  const nonce = randomBytes(32).toString('base64url');
  const ttlMinutes = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 24 * 60) {
    throw new LocalPublishJobError(
      'ttlMinutes must be between 5 and 1440',
      'VALIDATION_ERROR',
      400,
    );
  }
  if (!Number.isInteger(input.generation) || input.generation < 0) {
    throw new LocalPublishJobError(
      'generation must be a non-negative integer',
      'VALIDATION_ERROR',
      400,
    );
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('local-publish-dispatch-activation', 0))",
    );
    await assertNoDispatchActivationHold(client);
    const target = await client.query<{
      workspace_id: string;
      job_id: string;
      batch_id: string;
      item_id: string;
      manifest_hash: string;
      item_hash: string;
      source_revision: string;
      job_status: string;
      active_attempt: boolean;
      recoverable_attempt: boolean;
      recovery_generations: string;
      worker_id: string | null;
      contract_revision: string | null;
      compatibility_revision: string | null;
      lease_expires_at: Date | string | null;
    } & QueryResultRow>(
      `SELECT
         job.workspace_id,
         job.id AS job_id,
         batch.id AS batch_id,
         item.id AS item_id,
         batch.manifest_hash,
         item.item_hash,
         job.snapshot->>'notionLastEditedTime' AS source_revision,
         job.status AS job_status,
         EXISTS (
           SELECT 1 FROM rednote_publish_attempts attempt
           WHERE attempt.source_local_publish_job_id = job.id
             AND attempt.active AND attempt.approved_at IS NOT NULL
             AND attempt.terminal_outcome IS NULL
             AND attempt.dispatch_authorized_at IS NULL
         ) AS active_attempt,
         EXISTS (
           SELECT 1 FROM rednote_publish_attempts attempt
           WHERE attempt.source_local_publish_job_id = job.id
             AND NOT attempt.active AND attempt.approved_at IS NOT NULL
             AND attempt.terminal_outcome = 'known_failed'
             AND attempt.dispatch_authorized_at IS NULL
         ) AS recoverable_attempt,
         (
           SELECT COUNT(*)::text
           FROM rednote_publish_recovery_attempt_generations generation
           JOIN rednote_publish_attempts attempt
             ON attempt.id = generation.recovery_attempt_id
           WHERE attempt.source_local_publish_job_id = job.id
         ) AS recovery_generations,
         heartbeat.worker_id,
         heartbeat.contract_revision,
         heartbeat.compatibility_revision,
         heartbeat.lease_expires_at
       FROM local_publish_jobs job
       JOIN rednote_publish_batch_items item
         ON item.id = job.batch_item_id
        AND item.local_publish_job_id = job.id
       JOIN rednote_publish_batches batch ON batch.id = item.batch_id
       LEFT JOIN local_publish_worker_heartbeats heartbeat
         ON heartbeat.workspace_id = job.workspace_id
        AND heartbeat.worker_id = $2
       WHERE job.id = $1::uuid
         AND batch.approved_at IS NOT NULL
         AND batch.status IN ('approved', 'partially_approved')
       FOR UPDATE OF job, item, batch`,
      [input.jobId, input.expectedWorkerId],
    );
    const row = target.rows[0];
    if (
      !row
      || row.workspace_id !== input.workspaceId
      || row.job_id !== input.jobId
      || row.batch_id !== input.batchId
      || row.item_id !== input.itemId
      || row.manifest_hash !== input.manifestHash
      || row.item_hash !== input.itemHash
      || row.source_revision !== input.sourceRevision
    ) {
      throw new LocalPublishJobError(
        'The activation target does not match the immutable batch job identity',
        'DISPATCH_ACTIVATION_TARGET_MISMATCH',
        409,
      );
    }
    const recoveryGenerations = Number(row.recovery_generations);
    const dispatchReady = row.job_status === 'queued'
      && row.active_attempt
      && input.generation === recoveryGenerations;
    const recoveryReady = row.job_status === 'failed'
      && row.recoverable_attempt
      && input.generation === recoveryGenerations + 1;
    if (!dispatchReady && !recoveryReady) {
      throw new LocalPublishJobError(
        'The exact job is neither dispatch-ready nor recoverable at this generation',
        'DISPATCH_ACTIVATION_TARGET_NOT_READY',
        409,
      );
    }
    if (
      row.worker_id !== input.expectedWorkerId
      || row.contract_revision !== input.expectedWorkerContractRevision
      || row.compatibility_revision !== input.expectedWorkerCompatibilityRevision
      || !row.lease_expires_at
      || new Date(row.lease_expires_at).getTime() <= Date.now()
    ) {
      throw new LocalPublishJobError(
        'The expected worker identity or release is not currently online',
        'DISPATCH_ACTIVATION_WORKER_MISMATCH',
        409,
      );
    }
    const inserted = await client.query<ActivationRow>(
      `INSERT INTO local_publish_dispatch_activations (
         workspace_id, local_publish_job_id, batch_id, batch_item_id,
         manifest_hash, item_hash, source_revision,
         expected_worker_id, expected_worker_contract_revision,
         expected_worker_compatibility_revision, generation, nonce_digest,
         created_by, expires_at
       ) VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, CURRENT_TIMESTAMP + ($14 * INTERVAL '1 minute')
       ) RETURNING *`,
      [
        input.workspaceId,
        input.jobId,
        input.batchId,
        input.itemId,
        input.manifestHash,
        input.itemHash,
        input.sourceRevision,
        input.expectedWorkerId,
        input.expectedWorkerContractRevision,
        input.expectedWorkerCompatibilityRevision,
        input.generation,
        digestNonce(nonce),
        actorId,
        ttlMinutes,
      ],
    );
    await appendEvent(client, inserted.rows[0].id, 'prepared', actorId, {
      generation: input.generation,
    });
    await client.query('COMMIT');
    return { activation: activation(inserted.rows[0]), nonce };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function activateDispatchActivation(
  activationId: string,
  nonce: string,
  actorId: string,
) {
  if (
    !UUID_PATTERN.test(activationId)
    || nonce.length < 32
    || nonce.length > 200
  ) {
    throw new LocalPublishJobError(
      'activationId and nonce are invalid',
      'VALIDATION_ERROR',
      400,
    );
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('local-publish-dispatch-activation', 0))",
    );
    await assertNoDispatchActivationHold(client);
    const result = await client.query<ActivationRow>(
      `UPDATE local_publish_dispatch_activations activation
       SET state = 'active',
           authorized_at = CURRENT_TIMESTAMP,
           authorized_by = $3
       FROM local_publish_worker_heartbeats heartbeat
       WHERE activation.id = $1::uuid
         AND activation.nonce_digest = $2
         AND activation.state = 'prepared'
         AND activation.expires_at > CURRENT_TIMESTAMP
         AND heartbeat.workspace_id = activation.workspace_id
         AND heartbeat.worker_id = activation.expected_worker_id
         AND heartbeat.contract_revision =
           activation.expected_worker_contract_revision
         AND heartbeat.compatibility_revision =
           activation.expected_worker_compatibility_revision
         AND heartbeat.lease_expires_at > CURRENT_TIMESTAMP
         AND NOT EXISTS (
           SELECT 1
           FROM local_publish_jobs competing
           WHERE competing.id <> activation.local_publish_job_id
             AND competing.status IN ('claimed', 'staged')
         )
       RETURNING activation.*`,
      [activationId, digestNonce(nonce), actorId],
    );
    if (!result.rows[0]) {
      throw new LocalPublishJobError(
        'The prepared activation is stale, expired, or does not match the expected worker',
        'DISPATCH_ACTIVATION_NOT_ACTIVATABLE',
        409,
      );
    }
    await appendEvent(client, activationId, 'activated', actorId);
    await client.query('COMMIT');
    return activation(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelDispatchActivation(
  activationId: string,
  actorId: string,
  reason: string,
) {
  if (!UUID_PATTERN.test(activationId)) {
    throw new LocalPublishJobError(
      'activationId must be one exact UUID',
      'VALIDATION_ERROR',
      400,
    );
  }
  if (!reason.trim() || reason.trim().length > 500) {
    throw new LocalPublishJobError(
      'cancellationReason must contain 1 to 500 characters',
      'VALIDATION_ERROR',
      400,
    );
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('local-publish-dispatch-activation', 0))",
    );
    const result = await client.query<ActivationRow>(
      `UPDATE local_publish_dispatch_activations activation
       SET state = 'cancelled',
           cancelled_at = CURRENT_TIMESTAMP,
           cancelled_by = $2,
           cancellation_reason = $3
       WHERE activation.id = $1::uuid
         AND (
           activation.state = 'prepared'
           OR (
             activation.state = 'active'
             AND NOT EXISTS (
               SELECT 1
               FROM local_publish_worker_heartbeats heartbeat
               WHERE heartbeat.workspace_id = activation.workspace_id
                 AND heartbeat.worker_id = activation.expected_worker_id
                 AND heartbeat.lease_expires_at > CURRENT_TIMESTAMP
             )
             AND EXISTS (
               SELECT 1
               FROM local_publish_jobs job
               WHERE job.id = activation.local_publish_job_id
                 AND job.status = 'queued'
             )
           )
         )
       RETURNING activation.*`,
      [activationId, actorId, reason.trim()],
    );
    if (!result.rows[0]) {
      throw new LocalPublishJobError(
        'Cancellation requires a prepared activation, or an unconsumed active activation with the expected worker offline',
        'DISPATCH_ACTIVATION_NOT_CANCELLABLE',
        409,
      );
    }
    await appendEvent(client, activationId, 'cancelled', actorId, {
      reason: reason.trim(),
    });
    await client.query('COMMIT');
    return activation(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseDispatchActivation(
  activationId: string,
  actorId: string,
  reason: string,
) {
  if (!UUID_PATTERN.test(activationId)) {
    throw new LocalPublishJobError(
      'activationId must be one exact UUID',
      'VALIDATION_ERROR',
      400,
    );
  }
  if (!reason.trim() || reason.trim().length > 500) {
    throw new LocalPublishJobError(
      'releaseReason must contain 1 to 500 characters',
      'VALIDATION_ERROR',
      400,
    );
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('local-publish-dispatch-activation', 0))",
    );
    const result = await client.query<ActivationRow>(
      `UPDATE local_publish_dispatch_activations activation
       SET state = 'released',
           released_at = CURRENT_TIMESTAMP,
           released_by = $2,
           release_reason = $3
       WHERE activation.id = $1::uuid
         AND activation.state = 'consumed'
         AND NOT EXISTS (
           SELECT 1
           FROM local_publish_worker_heartbeats heartbeat
           WHERE heartbeat.workspace_id = activation.workspace_id
             AND heartbeat.worker_id = activation.expected_worker_id
             AND heartbeat.lease_expires_at > CURRENT_TIMESTAMP
         )
         AND EXISTS (
           SELECT 1
           FROM local_publish_jobs job
           WHERE job.id = activation.local_publish_job_id
             AND job.status NOT IN ('claimed', 'staged')
         )
       RETURNING activation.*`,
      [activationId, actorId, reason.trim()],
    );
    if (!result.rows[0]) {
      throw new LocalPublishJobError(
        'Release requires a consumed activation with the expected worker offline and no in-flight exact publish',
        'DISPATCH_ACTIVATION_NOT_RELEASABLE',
        409,
      );
    }
    await appendEvent(client, activationId, 'released', actorId, {
      reason: reason.trim(),
    });
    await client.query('COMMIT');
    return activation(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function inspectDispatchActivation() {
  const [holds, inventory] = await Promise.all([
    getPool().query<ActivationRow>(
      `SELECT *
       FROM local_publish_dispatch_activations
       ORDER BY created_at DESC
       LIMIT 20`,
    ),
    getPool().query<{
      queued_jobs: string;
      failed_jobs: string;
      active_attempts: string;
    } & QueryResultRow>(
      `SELECT
         COUNT(*) FILTER (WHERE job.status = 'queued')::text AS queued_jobs,
         COUNT(*) FILTER (WHERE job.status = 'failed')::text AS failed_jobs,
         (
           SELECT COUNT(*)::text
           FROM rednote_publish_attempts attempt
           WHERE attempt.active
             AND attempt.approved_at IS NOT NULL
             AND attempt.terminal_outcome IS NULL
         ) AS active_attempts
       FROM local_publish_jobs job
       WHERE job.batch_item_id IS NOT NULL`,
    ),
  ]);
  const counts = inventory.rows[0];
  return {
    current: holds.rows.find((row) => ACTIVE_STATES.includes(
      row.state as (typeof ACTIVE_STATES)[number],
    ))
      ? activation(holds.rows.find((row) => ACTIVE_STATES.includes(
        row.state as (typeof ACTIVE_STATES)[number],
      ))!)
      : null,
    recent: holds.rows.map(activation),
    inventory: {
      queuedBatchJobs: Number(counts?.queued_jobs ?? 0),
      failedBatchJobs: Number(counts?.failed_jobs ?? 0),
      activeApprovedAttempts: Number(counts?.active_attempts ?? 0),
    },
  };
}

export function dispatchActivationNonceDigest(nonce: string) {
  return digestNonce(nonce);
}
