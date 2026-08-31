import { createHash } from 'crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';
import type { ReadyX3Authorization } from '@/types/local-publish-job';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';
import {
  REDNOTE_PUBLISHING_CONTRACT_REVISION,
  type FrozenRednoteAttemptPayload,
  type RednoteTerminalAttemptOutcome,
} from '@/lib/rednote-publishing-contract-v1';
import { readLocalPublishWorkerHeartbeat } from '@/lib/local-publish-worker-heartbeat';

interface AttemptRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  idempotency_key: string;
  source_notion_page_id: string;
  source_local_publish_job_id: string | null;
  frozen_payload: FrozenRednoteAttemptPayload;
  payload_digest: string;
  payload_revision: string;
  executor_type: 'worker' | 'operator';
  executor_kind: 'playwright' | 'microservice' | 'operator';
  executor_id: string;
  requested_at: Date | string;
  created_at: Date | string;
  approved_at: Date | string | null;
  terminal_outcome: RednoteTerminalAttemptOutcome | null;
  terminal_at: Date | string | null;
  receipt_lookup_state: 'pending' | 'identity_pending' | 'found' | 'not_found' | 'not_required';
  receipt_lookup_updated_at: Date | string;
  active: boolean;
  supersedes_attempt_id: string | null;
  superseded_by_attempt_id: string | null;
  claim_token: string | null;
  claim_expires_at: Date | string | null;
  dispatch_authorized_at: Date | string | null;
  authorization_kind?: 'ready_x3' | null;
  late_fallback_policy?: { action: 'schedule' | 'post_now'; maxLateMinutes: 30 } | null;
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

function publicAttempt(row: AttemptRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceNotionPageId: row.source_notion_page_id,
    sourceLocalPublishJobId: row.source_local_publish_job_id,
    payloadDigest: row.payload_digest,
    payloadRevision: row.payload_revision,
    executor: {
      type: row.executor_type,
      kind: row.executor_kind,
      id: row.executor_id,
    },
    requestedAt: iso(row.requested_at),
    createdAt: iso(row.created_at),
    approvedAt: iso(row.approved_at),
    terminalOutcome: row.terminal_outcome,
    terminalAt: iso(row.terminal_at),
    receiptLookupState: row.receipt_lookup_state,
    receiptLookupUpdatedAt: iso(row.receipt_lookup_updated_at),
    active: row.active,
    supersedesAttemptId: row.supersedes_attempt_id,
    supersededByAttemptId: row.superseded_by_attempt_id,
    ...(row.authorization_kind === 'ready_x3' && row.approved_at
      ? { readyX3Authorization: attemptReadyX3Authorization(row) }
      : {}),
  };
}

function attemptReadyX3Authorization(row: AttemptRow): ReadyX3Authorization {
  const payload = row.frozen_payload;
  const media = payload.browserPayload.mediaAssets[0];
  if (!media || !payload.browserPayload.targetPublishAt ||
    payload.browserPayload.timingMode !== 'scheduled' ||
    payload.browserPayload.scheduledDate !== payload.browserPayload.targetPublishAt ||
    frozenPayloadDigest(payload) !== row.payload_digest ||
    payload.payloadDigest !== row.payload_digest ||
    payload.payloadRevision !== row.payload_revision) {
    throw new LocalPublishJobError('Ready x3 attempt is missing its frozen schedule or media', 'INVALID_READY_X3_AUTHORIZATION', 409);
  }
  return {
    kind: 'ready_x3',
    packetRevision: row.payload_revision,
    packetDigest: row.payload_digest,
    media: { url: media.deliveryUrl, type: media.mediaType, identity: rednoteMediaIdentity({ url: media.deliveryUrl, type: media.mediaType }) },
    platform: 'RedNote',
    publishAt: new Date(payload.browserPayload.targetPublishAt).toISOString(),
    authorizedAt: iso(row.approved_at)!,
    lateFallback: row.late_fallback_policy ?? { action: 'post_now', maxLateMinutes: 30 },
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function frozenPayloadDigest(payload: FrozenRednoteAttemptPayload) {
  return createHash('sha256').update(stable(payload.browserPayload)).digest('hex');
}

function validatePayload(payload: FrozenRednoteAttemptPayload) {
  if (payload.contractRevision !== REDNOTE_PUBLISHING_CONTRACT_REVISION) {
    throw new LocalPublishJobError('Unsupported publishing contract revision', 'STALE_REVISION', 409);
  }
  if (frozenPayloadDigest(payload) !== payload.payloadDigest) {
    throw new LocalPublishJobError('Frozen payload digest does not match its content', 'PAYLOAD_DIGEST_MISMATCH', 409);
  }
  if (payload.sourceNotionPageId !== payload.browserPayload.sourcePostId) {
    throw new LocalPublishJobError('Frozen payload source identity does not match', 'PAYLOAD_SOURCE_MISMATCH', 409);
  }
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createRednotePublishAttempt(input: {
  workspaceId: string;
  idempotencyKey: string;
  payload: FrozenRednoteAttemptPayload;
  approve?: boolean;
  readyX3?: boolean;
  supersedesAttemptId?: string;
}) {
  validatePayload(input.payload);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.workspaceId}:${input.payload.sourceNotionPageId}`,
    ]);
    const replay = await client.query<AttemptRow>(
      'SELECT * FROM rednote_publish_attempts WHERE workspace_id=$1 AND idempotency_key=$2::uuid',
      [input.workspaceId, input.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (
        replay.rows[0].payload_digest !== input.payload.payloadDigest ||
        replay.rows[0].payload_revision !== input.payload.payloadRevision
      ) {
        throw new LocalPublishJobError('Idempotency-Key was used for a different frozen attempt', 'IDEMPOTENCY_CONFLICT', 409);
      }
      return { attempt: publicAttempt(replay.rows[0]), created: false };
    }
    if (input.supersedesAttemptId) {
      const superseded = await client.query<AttemptRow>(
        `UPDATE rednote_publish_attempts SET active=false, superseded_by_attempt_id=NULL
         WHERE workspace_id=$1 AND id=$2::uuid AND active=true AND superseded_by_attempt_id IS NULL
         RETURNING *`,
        [input.workspaceId, input.supersedesAttemptId],
      );
      if (!superseded.rows[0]) {
        throw new LocalPublishJobError('The attempt selected for supersession is not active', 'INVALID_SUPERSESSION', 409);
      }
    }
    const p = input.payload;
    const inserted = await client.query<AttemptRow>(
      `INSERT INTO rednote_publish_attempts (
        workspace_id,idempotency_key,contract_revision,source_notion_page_id,
        source_local_publish_job_id,frozen_payload,payload_digest,payload_revision,
        executor_type,executor_kind,executor_id,worker_run_id,playwright_run_id,
         target_publish_at,requested_at,approved_at,active,supersedes_attempt_id,
         authorization_kind,late_fallback_policy
       ) VALUES ($1,$2::uuid,$3,$4,$5::uuid,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         CASE WHEN $16 THEN CURRENT_TIMESTAMP ELSE NULL END,$16,$17::uuid,$18,$19::jsonb) RETURNING *`,
      [
        input.workspaceId, input.idempotencyKey, p.contractRevision, p.sourceNotionPageId,
        p.sourceLocalPublishJobId ?? null, JSON.stringify(p), p.payloadDigest, p.payloadRevision,
        p.executor.type, p.executor.kind, p.executor.id, p.executor.workerRunId ?? null,
        p.executor.playwrightRunId ?? null, p.browserPayload.targetPublishAt, p.requestedAt,
         input.approve === true && p.executor.type === 'worker', input.supersedesAttemptId ?? null,
         input.readyX3 ? 'ready_x3' : null,
         input.readyX3 ? JSON.stringify({ action: 'post_now', maxLateMinutes: 30 }) : null,
      ],
    );
    const row = inserted.rows[0];
    if (input.supersedesAttemptId) {
      await client.query(
        'UPDATE rednote_publish_attempts SET superseded_by_attempt_id=$1 WHERE workspace_id=$2 AND id=$3',
        [row.id, input.workspaceId, input.supersedesAttemptId],
      );
      await client.query(
        `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
         VALUES($1,'superseded',CURRENT_TIMESTAMP,'operator',$2)`,
        [input.supersedesAttemptId, p.executor.id],
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
       VALUES($1,'attempt_created',CURRENT_TIMESTAMP,$2,$3)`,
      [row.id, p.executor.type === 'operator' ? 'operator' : 'create', p.executor.id],
    );
    return { attempt: publicAttempt(row), created: true };
  });
}

/**
 * Retires only an untouched Ready ×3 schedule.  This deliberately does not
 * treat a changed packet or media as a reschedule: those require new explicit
 * consent and retain the old immutable history.
 */
export async function supersedeUnclaimedReadyX3Schedule(
  workspaceId: string,
  snapshot: LocalPublishSnapshot,
) {
  if (!snapshot.publishAt || new Date(snapshot.publishAt).getTime() <= Date.now()) return false;
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${workspaceId}:${snapshot.notionPageId}`,
    ]);
    const old = await client.query<{ job_id: string; attempt_id: string }>(
      `SELECT job.id AS job_id, attempt.id AS attempt_id
       FROM local_publish_jobs job
       JOIN rednote_publish_attempts attempt
         ON attempt.workspace_id=job.workspace_id
        AND attempt.source_local_publish_job_id=job.id
       WHERE job.workspace_id=$1 AND job.notion_page_id=$2
         AND job.status='queued' AND job.claim_token IS NULL
         AND job.dispatch_authorized_at IS NULL
         AND attempt.active AND attempt.authorization_kind='ready_x3'
         AND attempt.approved_at IS NOT NULL AND attempt.terminal_outcome IS NULL
         AND attempt.claim_token IS NULL AND attempt.dispatch_authorized_at IS NULL
         AND attempt.superseded_by_attempt_id IS NULL
          AND ((attempt.frozen_payload->'browserPayload') - 'scheduledDate'::text - 'targetPublishAt'::text)
             = $3::jsonb
       ORDER BY job.created_at DESC LIMIT 1 FOR UPDATE OF job, attempt`,
      [workspaceId, snapshot.notionPageId, JSON.stringify({
        sourcePostId: snapshot.notionPageId, title: snapshot.title, caption: snapshot.caption,
        tags: snapshot.tags, timingMode: 'scheduled', visibility: 'public', publishMode: snapshot.mediaType,
        mediaAssets: [{ assetId: `${snapshot.mediaType}-${snapshot.mediaIndex}`, deliveryUrl: snapshot.mediaUrl,
          sha256: createHash('sha256').update(snapshot.mediaUrl).digest('hex'),
          mediaType: snapshot.mediaType, role: 'content' }],
      })],
    );
    if (!old.rows[0]) return false;
    await client.query(
      `UPDATE rednote_publish_attempts SET active=false
       WHERE id=$1::uuid AND workspace_id=$2 AND active
         AND dispatch_authorized_at IS NULL AND claim_token IS NULL`,
      [old.rows[0].attempt_id, workspaceId],
    );
    await client.query(
      `UPDATE local_publish_jobs SET status='failed', error_code='READY_X3_SCHEDULE_SUPERSEDED',
        error_message='Superseded by a newly authorized Ready x3 schedule before worker claim.',
        completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1::uuid AND workspace_id=$2 AND status='queued' AND claim_token IS NULL`,
      [old.rows[0].job_id, workspaceId],
    );
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
       VALUES($1::uuid,'superseded',CURRENT_TIMESTAMP,'operator','ready_x3_schedule_supersession')`,
      [old.rows[0].attempt_id],
    );
    return true;
  });
}

/** Permanently closes an unconsumed Ready x3 consent when its Notion packet changes. */
export async function invalidateLinkedReadyX3Source(
  workspaceId: string,
  localJobId: string,
  claimToken: string,
  reason: string,
) {
  return transaction(async (client) => {
    const job = await client.query<{ id: string }>(
      `UPDATE local_publish_jobs
       SET status='failed', completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP,
           error_code='READY_X3_SOURCE_STALE', error_message=$4
       WHERE workspace_id=$1 AND id=$2::uuid AND claim_token=$3::uuid
         AND status IN ('claimed','staged') AND dispatch_authorized_at IS NULL
       RETURNING id`,
      [workspaceId, localJobId, claimToken, reason],
    );
    if (!job.rows[0]) {
      throw new LocalPublishJobError(
        'The Ready x3 claim is stale while invalidating its source packet',
        'STALE_CLAIM',
        409,
      );
    }
    const attempt = await client.query<AttemptRow>(
      `UPDATE rednote_publish_attempts
       SET active=false, terminal_outcome='known_failed', terminal_at=CURRENT_TIMESTAMP,
           receipt_lookup_state='not_required', receipt_lookup_updated_at=CURRENT_TIMESTAMP,
           claim_expires_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND source_local_publish_job_id=$2::uuid
         AND claim_token=$3::uuid AND authorization_kind='ready_x3'
         AND active AND terminal_outcome IS NULL AND dispatch_authorized_at IS NULL
         AND superseded_by_attempt_id IS NULL
       RETURNING *`,
      [workspaceId, localJobId, claimToken],
    );
    if (!attempt.rows[0]) {
      throw new LocalPublishJobError(
        'The linked Ready x3 authorization is no longer invalidatable',
        'STALE_ATTEMPT',
        409,
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
       VALUES($1,'terminal_outcome_recorded',CURRENT_TIMESTAMP,'admin','ready_x3_source_stale')`,
      [attempt.rows[0].id],
    );
  });
}

export async function getRednotePublishAttempt(workspaceId: string, id: string) {
  const result = await getPool().query<AttemptRow>(
    `SELECT * FROM rednote_publish_attempts WHERE workspace_id=$1 AND id=$2::uuid`,
    [workspaceId, id],
  );
  if (!result.rows[0]) throw new LocalPublishJobError('Publishing attempt was not found', 'ATTEMPT_NOT_FOUND', 404);
  const receipt = await getPool().query(
    `SELECT rednote_url,rednote_note_id,platform_publish_time,captured_at
     FROM rednote_publish_attempt_receipts WHERE attempt_id=$1::uuid`,
    [id],
  );
  return {
    ...publicAttempt(result.rows[0]),
    receipt: receipt.rows[0] ? {
      rednoteUrl: receipt.rows[0].rednote_url,
      rednoteNoteId: receipt.rows[0].rednote_note_id,
      platformPublishTime: iso(receipt.rows[0].platform_publish_time),
      capturedAt: iso(receipt.rows[0].captured_at),
    } : null,
  };
}

export async function getLinkedRednotePublishAttempt(workspaceId: string, localJobId: string) {
  const result = await getPool().query<AttemptRow>(
    `SELECT * FROM rednote_publish_attempts
     WHERE workspace_id=$1 AND source_local_publish_job_id=$2::uuid
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, localJobId],
  );
  if (!result.rows[0]) {
    throw new LocalPublishJobError('The local job is missing its durable publishing attempt', 'ATTEMPT_NOT_FOUND', 409);
  }
  return {
    ...publicAttempt(result.rows[0]),
    payload: result.rows[0].frozen_payload.browserPayload,
  };
}

export async function approveRednotePublishAttempt(workspaceId: string, id: string) {
  const result = await getPool().query<AttemptRow>(
    `UPDATE rednote_publish_attempts SET approved_at=COALESCE(approved_at,CURRENT_TIMESTAMP),active=true
     WHERE workspace_id=$1 AND id=$2::uuid AND executor_type='worker'
       AND terminal_outcome IS NULL AND superseded_by_attempt_id IS NULL RETURNING *`,
    [workspaceId, id],
  );
  if (result.rows[0]) return publicAttempt(result.rows[0]);
  return getRednotePublishAttempt(workspaceId, id);
}

export async function claimRednotePublishAttempt(workspaceId: string, leaseSeconds: number) {
  const result = await getPool().query<AttemptRow>(
    `WITH candidate AS (
       SELECT id FROM rednote_publish_attempts
       WHERE workspace_id=$1 AND active AND approved_at IS NOT NULL
         AND terminal_outcome IS NULL AND dispatch_authorized_at IS NULL
         AND (claim_expires_at IS NULL OR claim_expires_at<=CURRENT_TIMESTAMP)
       ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE rednote_publish_attempts a SET claim_token=gen_random_uuid(),
       claim_expires_at=CURRENT_TIMESTAMP+($2*INTERVAL '1 second')
     FROM candidate WHERE a.id=candidate.id AND a.workspace_id=$1 RETURNING a.*`,
    [workspaceId, leaseSeconds],
  );
  return result.rows[0] ? { ...publicAttempt(result.rows[0]), claimToken: result.rows[0].claim_token, claimExpiresAt: iso(result.rows[0].claim_expires_at), payload: result.rows[0].frozen_payload.browserPayload } : null;
}

export async function authorizeRednotePublishAttempt(workspaceId: string, id: string, claimToken: string) {
  const result = await getPool().query<AttemptRow>(
    `UPDATE rednote_publish_attempts SET dispatch_authorized_at=CURRENT_TIMESTAMP
     WHERE workspace_id=$1 AND id=$2::uuid AND claim_token=$3::uuid
       AND claim_expires_at>CURRENT_TIMESTAMP AND active AND terminal_outcome IS NULL
       AND dispatch_authorized_at IS NULL RETURNING *`,
    [workspaceId, id, claimToken],
  );
  if (!result.rows[0]) throw new LocalPublishJobError('Dispatch authorization is stale or already consumed', 'DISPATCH_NOT_AUTHORIZED', 409);
  await getPool().query(
    `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
     VALUES($1,'execution_started',CURRENT_TIMESTAMP,'worker',$2)`,
    [id, result.rows[0].executor_id],
  );
  return { attemptId: id, authorizedAt: iso(result.rows[0].dispatch_authorized_at) };
}

export async function bindLinkedAttemptClaim(
  workspaceId: string,
  localJobId: string,
  claimToken: string,
  claimExpiresAt: string,
) {
  const result = await getPool().query<AttemptRow>(
    `UPDATE rednote_publish_attempts SET claim_token=$3::uuid,claim_expires_at=$4
     WHERE workspace_id=$1 AND source_local_publish_job_id=$2::uuid AND active
       AND approved_at IS NOT NULL AND terminal_outcome IS NULL
       AND dispatch_authorized_at IS NULL
       AND (claim_expires_at IS NULL OR claim_expires_at<=CURRENT_TIMESTAMP)
     RETURNING *`,
    [workspaceId, localJobId, claimToken, claimExpiresAt],
  );
  if (!result.rows[0]) {
    const replay = await getPool().query<AttemptRow>(
      `SELECT * FROM rednote_publish_attempts
       WHERE workspace_id=$1 AND source_local_publish_job_id=$2::uuid AND active
         AND approved_at IS NOT NULL AND terminal_outcome IS NULL
         AND dispatch_authorized_at IS NULL AND claim_token=$3::uuid
         AND claim_expires_at>CURRENT_TIMESTAMP`,
      [workspaceId, localJobId, claimToken],
    );
    if (replay.rows[0]) return;
    throw new LocalPublishJobError('The linked publishing attempt is not claimable', 'ATTEMPT_NOT_CLAIMABLE', 409);
  }
  await getPool().query(
    `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
     VALUES($1,'worker_claimed',CURRENT_TIMESTAMP,'worker',$2)`,
    [result.rows[0].id, result.rows[0].executor_id],
  );
}

export async function heartbeatLinkedAttempt(
  workspaceId: string,
  localJobId: string,
  claimToken: string,
  claimExpiresAt: string,
) {
  const result = await getPool().query(
    `UPDATE rednote_publish_attempts SET claim_expires_at=$4
     WHERE workspace_id=$1 AND source_local_publish_job_id=$2::uuid
       AND claim_token=$3::uuid AND active AND terminal_outcome IS NULL
       AND claim_expires_at>CURRENT_TIMESTAMP`,
    [workspaceId, localJobId, claimToken, claimExpiresAt],
  );
  if (result.rowCount !== 1) {
    throw new LocalPublishJobError('The linked publishing attempt lease is stale', 'STALE_ATTEMPT', 409);
  }
}

export async function authorizeLinkedAttempt(
  workspaceId: string,
  localJobId: string,
  claimToken: string,
) {
  const found = await getPool().query<AttemptRow>(
    `SELECT * FROM rednote_publish_attempts WHERE workspace_id=$1
       AND source_local_publish_job_id=$2::uuid AND claim_token=$3::uuid`,
    [workspaceId, localJobId, claimToken],
  );
  if (!found.rows[0]) throw new LocalPublishJobError('Linked attempt authorization is stale', 'STALE_ATTEMPT', 409);
  return authorizeRednotePublishAttempt(workspaceId, found.rows[0].id, claimToken);
}

/**
 * The Ready x3 browser-action linearization point.  The source was re-read by
 * the caller immediately before this function; the advisory lock makes that
 * check and this one-shot consume race deterministically with an edit fence.
 */
export async function consumeLinkedReadyX3DispatchAuthorization(
  workspaceId: string,
  localJobId: string,
  claimToken: string,
) {
  return transaction(async (client) => {
    const source = await client.query<{ source_notion_page_id: string }>(
      `SELECT source_notion_page_id FROM rednote_publish_attempts
       WHERE workspace_id=$1 AND source_local_publish_job_id=$2::uuid
         AND claim_token=$3::uuid AND authorization_kind='ready_x3'
       LIMIT 1`,
      [workspaceId, localJobId, claimToken],
    );
    if (!source.rows[0]) {
      throw new LocalPublishJobError('Linked attempt authorization is stale', 'STALE_ATTEMPT', 409);
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${workspaceId}:${source.rows[0].source_notion_page_id}`,
    ]);
    const consumed = await client.query<AttemptRow>(
      `WITH eligible_job AS (
         SELECT id FROM local_publish_jobs
         WHERE id=$2::uuid AND workspace_id=$1 AND claim_token=$3::uuid
           AND status='staged' AND claim_expires_at>CURRENT_TIMESTAMP
           AND dispatch_authorized_at IS NULL AND external_disposition_request_id IS NULL
         FOR UPDATE
       ), attempt AS (
         UPDATE rednote_publish_attempts attempt
         SET dispatch_authorized_at=CURRENT_TIMESTAMP
         FROM eligible_job job
         WHERE attempt.workspace_id=$1 AND attempt.source_local_publish_job_id=job.id
           AND attempt.claim_token=$3::uuid AND attempt.authorization_kind='ready_x3'
           AND attempt.active AND attempt.approved_at IS NOT NULL
           AND attempt.terminal_outcome IS NULL AND attempt.superseded_by_attempt_id IS NULL
           AND attempt.claim_expires_at>CURRENT_TIMESTAMP
           AND attempt.dispatch_authorized_at IS NULL
         RETURNING attempt.*
       )
       UPDATE local_publish_jobs job
       SET dispatch_authorized_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       FROM attempt
       WHERE job.id=$2::uuid AND job.workspace_id=$1
       RETURNING attempt.*`,
      [workspaceId, localJobId, claimToken],
    );
    if (!consumed.rows[0]) {
      throw new LocalPublishJobError(
        'Dispatch authorization is stale, revoked, or already consumed',
        'DISPATCH_NOT_AUTHORIZED',
        409,
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
       VALUES($1,'execution_started',CURRENT_TIMESTAMP,'worker',$2)`,
      [consumed.rows[0].id, consumed.rows[0].executor_id],
    );
    return { attemptId: consumed.rows[0].id, authorizedAt: iso(consumed.rows[0].dispatch_authorized_at) };
  });
}

/**
 * Closes all still-revocable Ready x3 work for a Workbench source before the
 * source mutation is sent to Notion.  A consumed authorization is evidence
 * that a browser action may already have begun and is never represented as a
 * revocation.
 */
export async function fenceReadyX3SourceMutation(
  workspaceId: string,
  sourceNotionPageId: string,
  revision: string,
) {
  if (!revision.trim()) {
    throw new LocalPublishJobError('A source revision is required', 'VALIDATION_ERROR', 400);
  }
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${workspaceId}:${sourceNotionPageId}`,
    ]);
    const started = await client.query<{ attempt_id: string; job_id: string | null }>(
      `SELECT attempt.id AS attempt_id, attempt.source_local_publish_job_id AS job_id
       FROM rednote_publish_attempts attempt
       WHERE attempt.workspace_id=$1 AND attempt.source_notion_page_id=$2
         AND attempt.authorization_kind='ready_x3'
         AND attempt.dispatch_authorized_at IS NOT NULL
       ORDER BY attempt.dispatch_authorized_at DESC LIMIT 1`,
      [workspaceId, sourceNotionPageId],
    );
    if (started.rows[0]) {
      return {
        publicationMayHaveStarted: true,
        attemptId: started.rows[0].attempt_id,
        jobId: started.rows[0].job_id,
      };
    }
    const attempts = await client.query<{ id: string }>(
      `UPDATE rednote_publish_attempts SET active=false,
         terminal_outcome='known_failed', terminal_at=CURRENT_TIMESTAMP,
         receipt_lookup_state='not_required', receipt_lookup_updated_at=CURRENT_TIMESTAMP,
         claim_expires_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND source_notion_page_id=$2
         AND authorization_kind='ready_x3' AND active
         AND approved_at IS NOT NULL AND terminal_outcome IS NULL
         AND superseded_by_attempt_id IS NULL AND dispatch_authorized_at IS NULL
       RETURNING id`,
      [workspaceId, sourceNotionPageId],
    );
    const jobs = await client.query<{ id: string }>(
      `UPDATE local_publish_jobs SET status='failed', completed_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP, error_code='READY_X3_SOURCE_STALE',
         error_message='Invalidated by a Workbench source mutation before dispatch.'
       WHERE workspace_id=$1 AND notion_page_id=$2 AND status IN ('queued','claimed','staged')
         AND dispatch_authorized_at IS NULL
       RETURNING id`,
      [workspaceId, sourceNotionPageId],
    );
    for (const attempt of attempts.rows) {
      await client.query(
        `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
          VALUES($1,'terminal_outcome_recorded',CURRENT_TIMESTAMP,'admin','ready_x3_mutation_fence')`,
        [attempt.id],
      );
    }
    return { publicationMayHaveStarted: false, invalidatedAttemptIds: attempts.rows.map((row) => row.id), invalidatedJobIds: jobs.rows.map((row) => row.id) };
  });
}

export async function requeueReadyX3PrestageClaim(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}) {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new LocalPublishJobError(`${name} is required`, 'VALIDATION_ERROR', 400);
    }
  }
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.workspaceId}:${input.sourceNotionPageId}`,
    ]);
    const locked = await client.query<{
      job_claimed_at: Date | string | null;
      job_claim_expires_at: Date | string | null;
    }>(
      `SELECT job.claimed_at AS job_claimed_at,
              job.claim_expires_at AS job_claim_expires_at
       FROM local_publish_jobs job
       JOIN rednote_publish_attempts attempt
         ON attempt.source_local_publish_job_id=job.id
        AND attempt.workspace_id=job.workspace_id
       WHERE job.workspace_id=$1 AND job.id=$2::uuid
         AND attempt.id=$3::uuid
         AND job.notion_page_id=$4
         AND attempt.source_notion_page_id=$4
         AND attempt.payload_revision=$5
       FOR UPDATE OF job, attempt`,
      [
        input.workspaceId,
        input.jobId,
        input.attemptId,
        input.sourceNotionPageId,
        input.revision,
      ],
    );
    if (!locked.rows[0]) {
      throw new LocalPublishJobError(
        'The exact Ready x3 claim was not found',
        'READY_X3_PRESTAGE_CLAIM_NOT_FOUND',
        404,
      );
    }
    const recovered = await client.query<{ id: string }>(
      `WITH eligible AS (
         SELECT job.id, attempt.id AS attempt_id
         FROM local_publish_jobs job
         JOIN rednote_publish_attempts attempt
           ON attempt.source_local_publish_job_id=job.id
          AND attempt.workspace_id=job.workspace_id
         WHERE job.workspace_id=$1 AND job.id=$2::uuid
           AND attempt.id=$3::uuid
           AND job.notion_page_id=$4
           AND attempt.source_notion_page_id=$4
           AND attempt.payload_revision=$5
           AND job.status='claimed'
           AND job.claim_token IS NOT NULL
           AND job.staged_at IS NULL
           AND job.dispatch_authorized_at IS NULL
           AND job.dispatched_at IS NULL
           AND job.note_id IS NULL AND job.share_url IS NULL
           AND job.success_attestation_id IS NULL
           AND job.external_disposition_request_id IS NULL
           AND attempt.authorization_kind='ready_x3'
           AND attempt.active
           AND attempt.approved_at IS NOT NULL
           AND attempt.terminal_outcome IS NULL
           AND attempt.superseded_by_attempt_id IS NULL
           AND attempt.dispatch_authorized_at IS NULL
           AND attempt.claim_token=job.claim_token
           AND NOT EXISTS (
             SELECT 1 FROM rednote_publish_attempt_events event
             WHERE event.attempt_id=attempt.id
               AND event.event_type='execution_started'
           )
           AND NOT EXISTS (
             SELECT 1 FROM rednote_publish_attempt_receipts receipt
             WHERE receipt.attempt_id=attempt.id
           )
       ), reset_attempt AS (
         UPDATE rednote_publish_attempts attempt
         SET claim_token=NULL, claim_expires_at=NULL
         FROM eligible
         WHERE attempt.id=eligible.attempt_id
         RETURNING attempt.id
       )
       UPDATE local_publish_jobs job
       SET status='queued', claim_token=NULL, claimed_at=NULL,
           claim_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
       FROM eligible
       WHERE job.id=eligible.id
         AND EXISTS (SELECT 1 FROM reset_attempt WHERE id=eligible.attempt_id)
       RETURNING job.id`,
      [
        input.workspaceId,
        input.jobId,
        input.attemptId,
        input.sourceNotionPageId,
        input.revision,
      ],
    );
    if (!recovered.rows[0]) {
      throw new LocalPublishJobError(
        'The Ready x3 claim has staging or execution evidence and cannot be requeued',
        'READY_X3_PRESTAGE_RECOVERY_UNSAFE',
        409,
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id,event_type,occurred_at,actor_type,actor_id,diagnostics
       ) VALUES(
         $1::uuid,'execution_evidence',CURRENT_TIMESTAMP,'admin',
         'ready_x3_prestage_claim_recovery',
         jsonb_build_object(
           'kind','prestage_claim_requeued',
           'priorClaimedAt',$2::timestamptz,
           'priorClaimExpiresAt',$3::timestamptz
         )
       )`,
      [
        input.attemptId,
        locked.rows[0].job_claimed_at,
        locked.rows[0].job_claim_expires_at,
      ],
    );
    return {
      requeued: true,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false,
    };
  });
}

export async function requeueReadyX3InvalidClaimFailure(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}) {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new LocalPublishJobError(`${name} is required`, 'VALIDATION_ERROR', 400);
    }
  }
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.workspaceId}:${input.sourceNotionPageId}`,
    ]);
    await client.query(
      `SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true)`,
    );
    const recovered = await client.query<{ id: string }>(
      `WITH eligible AS (
         SELECT job.id, attempt.id AS attempt_id
         FROM local_publish_jobs job
         JOIN rednote_publish_attempts attempt
           ON attempt.source_local_publish_job_id=job.id
          AND attempt.workspace_id=job.workspace_id
         WHERE job.workspace_id=$1 AND job.id=$2::uuid
           AND attempt.id=$3::uuid
           AND job.notion_page_id=$4
           AND attempt.source_notion_page_id=$4
           AND attempt.payload_revision=$5
           AND job.status='failed'
           AND job.error_code='INVALID_CLAIM'
           AND job.staged_at IS NULL
           AND job.dispatch_authorized_at IS NULL
           AND job.dispatched_at IS NULL
           AND job.note_id IS NULL AND job.share_url IS NULL
           AND job.success_attestation_id IS NULL
           AND job.external_disposition_request_id IS NULL
           AND attempt.authorization_kind='ready_x3'
           AND NOT attempt.active
           AND attempt.approved_at IS NOT NULL
           AND attempt.terminal_outcome='known_failed'
           AND attempt.receipt_lookup_state='not_required'
           AND attempt.superseded_by_attempt_id IS NULL
           AND attempt.dispatch_authorized_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM rednote_publish_attempt_events event
             WHERE event.attempt_id=attempt.id
               AND event.event_type='execution_started'
           )
           AND NOT EXISTS (
             SELECT 1 FROM rednote_publish_attempt_receipts receipt
             WHERE receipt.attempt_id=attempt.id
           )
         FOR UPDATE OF job, attempt
       ), reset_attempt AS (
         UPDATE rednote_publish_attempts attempt
         SET active=true, terminal_outcome=NULL, terminal_at=NULL,
             receipt_lookup_state='pending',
             receipt_lookup_updated_at=CURRENT_TIMESTAMP,
             claim_token=NULL, claim_expires_at=NULL
         FROM eligible
         WHERE attempt.id=eligible.attempt_id
         RETURNING attempt.id
       )
       UPDATE local_publish_jobs job
       SET status='queued', claim_token=NULL, claimed_at=NULL,
           claim_expires_at=NULL, error_code=NULL, error_message=NULL,
           completed_at=NULL, updated_at=CURRENT_TIMESTAMP
       FROM eligible
       WHERE job.id=eligible.id
         AND EXISTS (SELECT 1 FROM reset_attempt WHERE id=eligible.attempt_id)
       RETURNING job.id`,
      [
        input.workspaceId,
        input.jobId,
        input.attemptId,
        input.sourceNotionPageId,
        input.revision,
      ],
    );
    if (!recovered.rows[0]) {
      throw new LocalPublishJobError(
        'The Ready x3 validation failure is not safe to recover',
        'READY_X3_INVALID_CLAIM_RECOVERY_UNSAFE',
        409,
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id,event_type,occurred_at,actor_type,actor_id,diagnostics
       ) VALUES(
         $1::uuid,'execution_evidence',CURRENT_TIMESTAMP,'admin',
         'ready_x3_invalid_claim_recovery',
         jsonb_build_object('kind','invalid_claim_failure_requeued')
       )`,
      [input.attemptId],
    );
    return {
      requeued: true,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false,
    };
  });
}

export async function recordLinkedAttemptOutcome(input: {
  workspaceId: string; localJobId: string; claimToken: string;
  outcome: RednoteTerminalAttemptOutcome;
  receipt?: { rednoteUrl: string; rednoteNoteId: string; platformPublishTime: string; provenance: Record<string, unknown> };
}) {
  const found = await getPool().query<AttemptRow>(
    `SELECT * FROM rednote_publish_attempts WHERE workspace_id=$1
       AND source_local_publish_job_id=$2::uuid AND claim_token=$3::uuid`,
    [input.workspaceId, input.localJobId, input.claimToken],
  );
  if (!found.rows[0]) throw new LocalPublishJobError('Linked attempt result is stale', 'STALE_ATTEMPT_RESULT', 409);
  return recordRednotePublishOutcome({
    workspaceId: input.workspaceId,
    attemptId: found.rows[0].id,
    claimToken: input.claimToken,
    outcome: input.outcome,
    receipt: input.receipt,
  });
}

export async function recordRednotePublishOutcome(input: {
  workspaceId: string; attemptId: string; claimToken: string;
  outcome: RednoteTerminalAttemptOutcome;
  receipt?: { rednoteUrl: string; rednoteNoteId: string; platformPublishTime: string; provenance: Record<string, unknown> };
}) {
  if (input.outcome === 'accepted' && input.receipt &&
      (!input.receipt.rednoteUrl || !input.receipt.rednoteNoteId)) {
    throw new LocalPublishJobError('Receipt URL and Note ID must be recorded atomically', 'INVALID_RECEIPT', 400);
  }
  return transaction(async (client) => {
    const state = input.outcome === 'accepted'
      ? (input.receipt ? 'found' : 'identity_pending')
      : 'not_required';
    const result = await client.query<AttemptRow>(
      `UPDATE rednote_publish_attempts SET terminal_outcome=$4,terminal_at=CURRENT_TIMESTAMP,
        receipt_lookup_state=$5,receipt_lookup_updated_at=CURRENT_TIMESTAMP,active=false,
        claim_expires_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND id=$2::uuid AND claim_token=$3::uuid
         AND (dispatch_authorized_at IS NOT NULL OR $4='known_failed')
         AND terminal_outcome IS NULL RETURNING *`,
      [input.workspaceId, input.attemptId, input.claimToken, input.outcome, state],
    );
    if (!result.rows[0]) {
      const current = await client.query<AttemptRow>(
        'SELECT * FROM rednote_publish_attempts WHERE workspace_id=$1 AND id=$2::uuid',
        [input.workspaceId, input.attemptId],
      );
      if (current.rows[0]?.terminal_outcome === input.outcome) return publicAttempt(current.rows[0]);
      throw new LocalPublishJobError('Attempt result is stale or conflicts with its terminal outcome', 'STALE_ATTEMPT_RESULT', 409);
    }
    if (input.receipt) {
      await client.query(
        `INSERT INTO rednote_publish_attempt_receipts(
          attempt_id,rednote_url,rednote_note_id,platform_publish_time,provenance
        ) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(attempt_id) DO NOTHING`,
        [input.attemptId, input.receipt.rednoteUrl, input.receipt.rednoteNoteId,
          input.receipt.platformPublishTime, JSON.stringify(input.receipt.provenance)],
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
       VALUES($1,'terminal_outcome_recorded',CURRENT_TIMESTAMP,'worker',$2)`,
      [input.attemptId, result.rows[0].executor_id],
    );
    return publicAttempt(result.rows[0]);
  });
}

export async function resolveIdentityPendingReceipt(input: {
  workspaceId: string; attemptId: string; actorId: string;
  receipt?: { rednoteUrl: string; rednoteNoteId: string; platformPublishTime: string; provenance: Record<string, unknown> };
}) {
  return transaction(async (client) => {
    const state = input.receipt ? 'found' : 'not_found';
    const result = await client.query<AttemptRow>(
      `UPDATE rednote_publish_attempts SET receipt_lookup_state=$3,
       receipt_lookup_updated_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND id=$2::uuid AND terminal_outcome='accepted'
         AND receipt_lookup_state IN ('identity_pending','not_found') AND NOT active RETURNING *`,
      [input.workspaceId, input.attemptId, state],
    );
    if (!result.rows[0]) throw new LocalPublishJobError('Attempt is not eligible for receipt lookup', 'RECEIPT_LOOKUP_NOT_ALLOWED', 409);
    if (input.receipt) {
      await client.query(
        `INSERT INTO rednote_publish_attempt_receipts(
          attempt_id,rednote_url,rednote_note_id,platform_publish_time,provenance
        ) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(attempt_id) DO NOTHING`,
        [input.attemptId, input.receipt.rednoteUrl, input.receipt.rednoteNoteId,
          input.receipt.platformPublishTime, JSON.stringify(input.receipt.provenance)],
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
       VALUES($1,'receipt_lookup',CURRENT_TIMESTAMP,'operator',$2)`,
      [input.attemptId, input.actorId],
    );
    return publicAttempt(result.rows[0]);
  });
}

export async function readRednotePublishingOperational(workspaceId: string) {
  const [result, manual, workerHeartbeat] = await Promise.all([
    getPool().query<{
    id: string; notion_page_id: string; snapshot: Record<string, unknown>;
     status: string; updated_at: Date | string; attempt_id: string | null;
    active: boolean | null; payload_revision: string | null;
    terminal_outcome: string | null; receipt_lookup_state: string | null;
    terminal_at: Date | string | null; rednote_note_id: string | null;
     rednote_url: string | null; captured_at: Date | string | null; event_count: string;
     authorization_kind: string | null; approved_at: Date | string | null;
     claim_expires_at: Date | string | null; dispatch_authorized_at: Date | string | null;
  }>(
    `SELECT job.id,job.notion_page_id,job.snapshot,job.status,job.updated_at,
      attempt.id AS attempt_id,attempt.active,attempt.payload_revision,
      attempt.terminal_outcome,attempt.receipt_lookup_state,attempt.terminal_at,
       attempt.authorization_kind,attempt.approved_at,attempt.claim_expires_at,
       attempt.dispatch_authorized_at,
      receipt.rednote_note_id,receipt.rednote_url,receipt.captured_at,
      COALESCE((SELECT count(*) FROM rednote_publish_attempt_events e
        WHERE e.attempt_id=attempt.id),0)::text AS event_count
     FROM local_publish_jobs job
     LEFT JOIN rednote_publish_attempts attempt
       ON attempt.workspace_id=job.workspace_id
      AND attempt.source_local_publish_job_id=job.id
     LEFT JOIN rednote_publish_attempt_receipts receipt ON receipt.attempt_id=attempt.id
     WHERE job.workspace_id=$1 ORDER BY job.created_at DESC LIMIT 100`,
    [workspaceId],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM manual_reconciliation_requests
       WHERE workspace_id=$1 AND status IN ('queued','verifying')`,
      [workspaceId],
    ),
    readLocalPublishWorkerHeartbeat(workspaceId),
  ]);
  const item = (row: typeof result.rows[number]) => {
    const snapshot = row.snapshot;
    const receipt = row.attempt_id ? {
      state: row.receipt_lookup_state ?? 'pending',
      attemptId: row.attempt_id,
      action: row.receipt_lookup_state === 'identity_pending' ? 'Backfill receipt' : null,
      acceptedAt: iso(row.terminal_at),
      noteId: row.rednote_note_id,
      canonicalUrl: row.rednote_url,
      verifiedAt: iso(row.captured_at),
      reconciliationState: row.rednote_note_id ? 'verified' : null,
    } : null;
    return {
      id: row.id,
      workbenchPostId: row.notion_page_id,
      title: typeof snapshot.title === 'string' ? snapshot.title : 'Untitled Rednote revision',
      scheduledDate: typeof snapshot.publishAt === 'string' ? snapshot.publishAt : null,
      mode: snapshot.publishAt ? 'schedule' as const : 'publish' as const,
      state: row.receipt_lookup_state === 'identity_pending' ? 'identity_pending' : row.status,
       eligible: row.status === 'queued' && row.active === true &&
         (row.authorization_kind !== 'ready_x3' || row.approved_at !== null) &&
         row.dispatch_authorized_at === null,
      activeAttempt: row.active === true,
       authorization: row.authorization_kind === 'ready_x3'
         ? { kind: 'ready_x3', state: row.dispatch_authorized_at ? 'consumed' :
           row.active && row.approved_at ? 'ready' : 'invalidated',
           reason: row.dispatch_authorized_at ? 'dispatch_already_authorized' :
             row.active && row.approved_at ? null : 'approval_missing_or_superseded',
           nextAttemptAt: row.dispatch_authorized_at ? null : iso(row.claim_expires_at) }
         : null,
      revision: row.payload_revision ??
        (typeof snapshot.notionLastEditedTime === 'string' ? snapshot.notionLastEditedTime : 'unknown'),
      updatedAt: iso(row.updated_at),
      receipt,
      failure: row.terminal_outcome === 'known_failed' ? 'Publishing attempt failed' :
        row.terminal_outcome === 'outcome_unknown' ? 'Publishing outcome requires reconciliation' : null,
    };
  };
  const queue = result.rows.filter((row) =>
    !['reconciled', 'succeeded', 'failed'].includes(row.status) &&
    row.receipt_lookup_state !== 'identity_pending').map(item);
  const attempts = result.rows.filter((row) => row.attempt_id).map((row) => ({
    ...item(row),
    id: row.attempt_id!,
    eventCount: Number(row.event_count),
  }));
  const count = (predicate: (row: typeof result.rows[number]) => boolean) =>
    result.rows.filter(predicate).length;
  return {
    contractVersion: 'publishing-v1',
    available: true,
    compatibility: { compatible: true, message: 'Durable XHS publishing-v1 control plane is available.' },
    worker: {
      state: workerHeartbeat.state,
      online: workerHeartbeat.online,
      id: workerHeartbeat.id,
      contractRevision: workerHeartbeat.contractRevision,
      compatibilityRevision: workerHeartbeat.compatibilityRevision,
      lastHeartbeatAt: workerHeartbeat.lastHeartbeatAt,
      leaseUntil: workerHeartbeat.leaseUntil,
    },
    polling: workerHeartbeat.polling,
    summary: {
      queued: count((row) => row.status === 'queued'),
      active: count((row) => row.active === true),
      awaitingIdentity: count((row) => row.receipt_lookup_state === 'identity_pending'),
      awaitingVerification: count((row) => ['submitted', 'scheduled', 'verification_pending', 'verified'].includes(row.status)),
      failed: count((row) => row.terminal_outcome === 'known_failed' || row.terminal_outcome === 'outcome_unknown'),
      published: count((row) => Boolean(row.rednote_note_id)),
    },
    queue,
    attempts,
    manualReconciliation: { enabled: true, pending: Number(manual.rows[0]?.count ?? 0) },
    evidenceAt: new Date().toISOString(),
  };
}