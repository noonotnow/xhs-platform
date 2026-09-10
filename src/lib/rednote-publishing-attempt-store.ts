import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { isDeepStrictEqual } from 'util';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  rednotePublishMedia,
  snapshotPublishMedia,
} from '@/lib/rednote-publish-authorization';
import { storedManifestHash } from '@/lib/rednote-publish-batch-store';
import type { ReadyX3Authorization } from '@/types/local-publish-job';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';
import {
  REDNOTE_PUBLISHING_CONTRACT_REVISION,
  type FrozenRednoteAttemptPayload,
  type FrozenRednoteBrowserPayload,
  type RednoteTerminalAttemptOutcome,
} from '@/lib/rednote-publishing-contract-v1';
import { readLocalPublishWorkerHeartbeat } from '@/lib/local-publish-worker-heartbeat';
import { CLAIM_LEASE_EXPIRED_MESSAGE } from '@/lib/local-publish-job-store';

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

interface AttemptReceiptRow extends QueryResultRow {
  rednote_url: string | null;
  rednote_note_id: string;
}

async function assertAttemptReceiptMatches(
  loadReceipt: () => Promise<{ rows: AttemptReceiptRow[] }>,
  expected: { rednoteUrl?: string; rednoteNoteId: string },
) {
  const stored = (await loadReceipt()).rows[0];
  if (
    !stored
    || stored.rednote_note_id !== expected.rednoteNoteId
    || (
      stored.rednote_url !== null
      && expected.rednoteUrl !== undefined
      && stored.rednote_url !== expected.rednoteUrl
    )
  ) {
    throw new LocalPublishJobError(
      'The submitted publication identity conflicts with the immutable attempt receipt',
      'ATTEMPT_RECEIPT_CONFLICT',
      409,
    );
  }
}

const readyX3SourceLockContext = new AsyncLocalStorage<string>();
const LEGACY_READY_X3_LATE_FALLBACK_POLICY = {
  action: 'post_now',
  maxLateMinutes: 30,
} as const;

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
  const contentMedia = payload.browserPayload.mediaAssets.map((item) =>
    rednotePublishMedia(item.mediaType, item.deliveryUrl));
  const action = payload.browserPayload.timingMode === 'post_now'
    ? 'post_now' as const
    : 'schedule' as const;
  const timingMatches = action === 'schedule'
    ? payload.browserPayload.scheduledDate === payload.browserPayload.targetPublishAt
    : payload.browserPayload.targetPublishAt === payload.requestedAt;
  if (!media || !payload.browserPayload.targetPublishAt ||
    !payload.browserPayload.scheduledDate ||
    !timingMatches ||
    frozenPayloadDigest(payload) !== row.payload_digest ||
    payload.payloadDigest !== row.payload_digest ||
    payload.payloadRevision !== row.payload_revision) {
    throw new LocalPublishJobError('Ready x3 attempt is missing its frozen schedule or media', 'INVALID_READY_X3_AUTHORIZATION', 409);
  }
  return {
    kind: 'ready_x3',
    action,
    packetRevision: row.payload_revision,
    packetDigest: row.payload_digest,
    media: contentMedia,
    platform: 'RedNote',
    publishAt: new Date(payload.browserPayload.scheduledDate).toISOString(),
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

function stableDigest(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export async function createLinkedRednotePublishAttempt(
  snapshot: LocalPublishSnapshot,
  idempotencyKey: string,
  workspaceId: string,
  localJobId: string,
  readyX3Action?: 'schedule' | 'post_now',
  createAttempt: typeof createRednotePublishAttempt = createRednotePublishAttempt,
) {
  return createApprovedLinkedRednotePublishAttempt(
    snapshot,
    idempotencyKey,
    workspaceId,
    localJobId,
    readyX3Action,
    readyX3Action ? 'ready_x3' : null,
    createAttempt,
  );
}

export async function createBatchLinkedRednotePublishAttempt(
  snapshot: LocalPublishSnapshot,
  idempotencyKey: string,
  workspaceId: string,
  localJobId: string,
  action: 'schedule' | 'post_now',
  createAttempt: typeof createRednotePublishAttempt = createRednotePublishAttempt,
) {
  return createApprovedLinkedRednotePublishAttempt(
    snapshot,
    idempotencyKey,
    workspaceId,
    localJobId,
    action,
    'batch',
    createAttempt,
  );
}

async function createApprovedLinkedRednotePublishAttempt(
  snapshot: LocalPublishSnapshot,
  idempotencyKey: string,
  workspaceId: string,
  localJobId: string,
  action: 'schedule' | 'post_now' | undefined,
  authorizationKind: 'ready_x3' | 'batch' | null,
  createAttempt: typeof createRednotePublishAttempt,
) {
  if (!snapshot.expectedAccountId) {
    throw new LocalPublishJobError(
      'REDNOTE_EXPECTED_ACCOUNT_ID is required before creating an executable attempt',
      'EXPECTED_ACCOUNT_NOT_CONFIGURED',
      503,
    );
  }
  const requestedAt = new Date().toISOString();
  const timingMode = action ??
    (snapshot.publishAt ? 'schedule' as const : 'post_now' as const);
  const commonBrowserPayload = {
    sourcePostId: snapshot.notionPageId,
    expectedAccountId: snapshot.expectedAccountId,
    title: snapshot.title,
    caption: snapshot.caption,
    tags: snapshot.tags,
    scheduledDate: snapshot.publishAt ?? null,
    targetPublishAt: timingMode === 'post_now'
      ? requestedAt
      : snapshot.publishAt ?? requestedAt,
    timingMode: timingMode === 'schedule' ? 'scheduled' as const : 'post_now' as const,
    visibility: 'public' as const,
  };
  const media = snapshotPublishMedia(snapshot);
  let browserPayload: FrozenRednoteBrowserPayload;
  if (snapshot.mediaType === 'video') {
    if (media.length !== 1 || media[0]?.type !== 'video') {
      throw new LocalPublishJobError(
        'Video publishing attempts require exactly one canonical video',
        'INVALID_MEDIA',
        409,
      );
    }
    browserPayload = {
      ...commonBrowserPayload,
      publishMode: 'video',
      mediaAssets: [{
        assetId: 'video-0',
        deliveryUrl: media[0].url,
        sha256: createHash('sha256').update(media[0].url).digest('hex'),
        mediaType: 'video',
        role: 'content',
      }],
      ...(snapshot.thumbnailUrl
        ? {
            coverAsset: {
              assetId: 'video-cover',
              deliveryUrl: snapshot.thumbnailUrl,
              sha256: createHash('sha256').update(snapshot.thumbnailUrl).digest('hex'),
              mediaType: 'image' as const,
              role: 'cover' as const,
            },
          }
        : {}),
    };
  } else {
    const imageAssets = media.map((item, index) => {
      if (item.type !== 'image') {
        throw new LocalPublishJobError(
          'Image publishing attempts require only canonical images',
          'INVALID_MEDIA',
          409,
        );
      }
      return {
        assetId: `image-${index}`,
        deliveryUrl: item.url,
        sha256: createHash('sha256').update(item.url).digest('hex'),
        mediaType: 'image' as const,
        role: 'content' as const,
      };
    });
    if (!imageAssets[0]) {
      throw new LocalPublishJobError(
        'Image publishing attempts require at least one canonical image',
        'INVALID_MEDIA',
        409,
      );
    }
    browserPayload = {
      ...commonBrowserPayload,
      publishMode: 'image',
      mediaAssets: [imageAssets[0], ...imageAssets.slice(1)],
    };
  }
  const payload: FrozenRednoteAttemptPayload = {
    contractRevision: REDNOTE_PUBLISHING_CONTRACT_REVISION,
    sourceNotionPageId: snapshot.notionPageId,
    sourceLocalPublishJobId: localJobId,
    payloadRevision: snapshot.notionLastEditedTime,
    payloadDigest: '',
    requestedAt,
    executor: {
      type: 'worker' as const,
      kind: 'playwright' as const,
      id: 'local-publish-worker',
    },
    browserPayload,
  };
  payload.payloadDigest = frozenPayloadDigest(payload);
  return createAttempt({
    workspaceId,
    idempotencyKey,
    payload,
    approve: authorizationKind !== null,
    readyX3: authorizationKind === 'ready_x3',
  });
}

export function linkedAttemptMatchesApprovedBatch(
  attempt: {
    approvedAt?: string | null;
    readyX3Authorization?: ReadyX3Authorization;
    payload?: FrozenRednoteBrowserPayload;
  },
  snapshot: LocalPublishSnapshot,
  action: 'schedule' | 'post_now',
) {
  const payload = attempt.payload;
  if (!attempt.approvedAt || attempt.readyX3Authorization || !payload) return false;
  return attemptPayloadMatchesApprovedBatch(payload, snapshot, action);
}

function attemptPayloadMatchesApprovedBatch(
  payload: FrozenRednoteBrowserPayload,
  snapshot: LocalPublishSnapshot,
  action: 'schedule' | 'post_now',
) {
  const media = payload.mediaAssets.map((item) =>
    rednotePublishMedia(item.mediaType, item.deliveryUrl));
  return payload.sourcePostId === snapshot.notionPageId &&
    payload.expectedAccountId === snapshot.expectedAccountId &&
    payload.title === snapshot.title &&
    payload.caption === snapshot.caption &&
    isDeepStrictEqual(payload.tags, snapshot.tags) &&
    payload.publishMode === snapshot.mediaType &&
    payload.scheduledDate === (snapshot.publishAt ?? null) &&
    payload.timingMode === (action === 'schedule' ? 'scheduled' : 'post_now') &&
    (action === 'post_now' || payload.targetPublishAt === snapshot.publishAt) &&
    isDeepStrictEqual(media, snapshotPublishMedia(snapshot)) &&
    (
      snapshot.mediaType !== 'video' ||
      payload.coverAsset?.deliveryUrl === snapshot.thumbnailUrl
    );
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

async function assertNoCompetingPublishLifecycle(
  client: PoolClient,
  input: {
    workspaceId: string;
    jobId: string;
    attemptId: string;
    sourceNotionPageId: string;
    revision: string;
  },
) {
  const blocker = await client.query<{ lifecycle_id: string }>(
    `SELECT lifecycle_id
     FROM rednote_publish_recovery_revision_blockers(
       $1,
       $2,
       $3,
       (
         SELECT COALESCE(job.batch_item_id, item.id)
         FROM local_publish_jobs job
         LEFT JOIN rednote_publish_batch_items item
           ON item.local_publish_job_id = job.id
          AND item.workspace_id = job.workspace_id
          AND item.notion_page_id = job.notion_page_id
         WHERE job.id = $4::uuid
           AND job.workspace_id = $1
       ),
       $4::uuid,
       $5::uuid
     )
     LIMIT 1`,
    [
      input.workspaceId,
      input.sourceNotionPageId,
      input.revision,
      input.jobId,
      input.attemptId,
    ],
  );
  if (blocker.rows[0]) {
    throw new LocalPublishJobError(
      'Another publish lifecycle or durable evidence owns this page revision.',
      'PUBLISH_LIFECYCLE_RECOVERY_CONFLICT',
      409,
    );
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
    const sourceLockKey = `${input.workspaceId}:${input.payload.sourceNotionPageId}`;
    if (readyX3SourceLockContext.getStore() !== sourceLockKey) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        sourceLockKey,
      ]);
    }
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
         input.readyX3 ? JSON.stringify(LEGACY_READY_X3_LATE_FALLBACK_POLICY) : null,
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
 * Retires every untouched Ready ×3 authorization for this source. Once any
 * authorization enters worker execution, replacement fails closed because the
 * provider side effect may already be in flight.
 */
export async function withReadyX3SourceLock<T>(
  workspaceId: string,
  notionPageId: string,
  operation: () => Promise<T>,
) {
  return transaction(async (client) => {
    const sourceLockKey = `${workspaceId}:${notionPageId}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      sourceLockKey,
    ]);
    return readyX3SourceLockContext.run(sourceLockKey, operation);
  });
}

export async function supersedeUnclaimedReadyX3Schedule(
  workspaceId: string,
  snapshot: LocalPublishSnapshot,
  action: 'schedule' | 'post_now',
) {
  if (!snapshot.publishAt) return false;
  return transaction(async (client) => {
    const old = await client.query<{
      job_id: string;
      attempt_id: string;
      job_status: string;
      job_claim_token: string | null;
      job_dispatch_authorized_at: Date | string | null;
      attempt_claim_token: string | null;
      attempt_dispatch_authorized_at: Date | string | null;
    }>(
      `SELECT job.id AS job_id, attempt.id AS attempt_id,
          job.status AS job_status, job.claim_token AS job_claim_token,
          job.dispatch_authorized_at AS job_dispatch_authorized_at,
          attempt.claim_token AS attempt_claim_token,
          attempt.dispatch_authorized_at AS attempt_dispatch_authorized_at
       FROM local_publish_jobs job
       JOIN rednote_publish_attempts attempt
         ON attempt.workspace_id=job.workspace_id
        AND attempt.source_local_publish_job_id=job.id
       WHERE job.workspace_id=$1 AND job.notion_page_id=$2
         AND attempt.active AND attempt.authorization_kind='ready_x3'
         AND attempt.approved_at IS NOT NULL AND attempt.terminal_outcome IS NULL
         AND attempt.superseded_by_attempt_id IS NULL
       ORDER BY job.created_at
       FOR UPDATE OF job, attempt`,
      [workspaceId, snapshot.notionPageId],
    );
    if (old.rows.some((row) =>
      row.job_status !== 'queued' ||
      row.job_claim_token !== null ||
      row.job_dispatch_authorized_at !== null ||
      row.attempt_claim_token !== null ||
      row.attempt_dispatch_authorized_at !== null
    )) {
      throw new LocalPublishJobError(
        `The existing Ready x3 attempt has already entered worker execution; ${action} authorization is blocked until it is resolved.`,
        'READY_X3_ATTEMPT_IN_PROGRESS',
        409,
      );
    }
    if (old.rows.length === 0) return false;
    for (const row of old.rows) {
      await client.query(
        `UPDATE rednote_publish_attempts SET active=false
         WHERE id=$1::uuid AND workspace_id=$2 AND active
           AND dispatch_authorized_at IS NULL AND claim_token IS NULL`,
        [row.attempt_id, workspaceId],
      );
      await client.query(
        `UPDATE local_publish_jobs SET status='failed', error_code='READY_X3_SCHEDULE_SUPERSEDED',
          error_message='Superseded by a newly authorized Ready x3 action before worker claim.',
          completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1::uuid AND workspace_id=$2 AND status='queued' AND claim_token IS NULL`,
        [row.job_id, workspaceId],
      );
      await client.query(
        `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
         VALUES($1::uuid,'superseded',CURRENT_TIMESTAMP,'operator','ready_x3_action_supersession')`,
        [row.attempt_id],
      );
    }
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
    await assertNoCompetingPublishLifecycle(client, input);
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
         $1::uuid,'administrative_recovery',CURRENT_TIMESTAMP,'admin',
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

type RecoverableReadyX3PreproviderFailure =
  | 'INVALID_CLAIM'
  | 'NOT_LOGGED_IN'
  | 'INTERNAL_ERROR'
  | 'SCHEDULE_READBACK_MISMATCH';

class ReadyX3RecoveryDiagnosticRollback extends Error {
  constructor(readonly result: {
    jobId: string;
    attemptId: string;
    publicationMayHaveStarted: false;
  }) {
    super('Ready x3 recovery diagnostic rolled back');
  }
}

async function requeueReadyX3PreproviderFailure(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}, recovery: {
  errorCode: RecoverableReadyX3PreproviderFailure;
  errorMessageLike?: string;
  actorId: string;
  evidenceKind: string;
  unsafeMessage: string;
  unsafeCode: string;
}, diagnosticOnly = false) {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new LocalPublishJobError(`${name} is required`, 'VALIDATION_ERROR', 400);
    }
  }
  try {
    return await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${input.workspaceId}:${input.sourceNotionPageId}`,
      ]);
      await assertNoCompetingPublishLifecycle(client, input);
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
           AND job.error_code=$6
            AND ($7::text IS NULL OR job.error_message LIKE $7)
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
        recovery.errorCode,
        recovery.errorMessageLike ?? null,
      ],
    );
      if (!recovered.rows[0]) {
        throw new LocalPublishJobError(
        recovery.unsafeMessage,
        recovery.unsafeCode,
        409,
      );
    }
      await client.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id,event_type,occurred_at,actor_type,actor_id,diagnostics
       ) VALUES(
         $1::uuid,'administrative_recovery',CURRENT_TIMESTAMP,'admin',
         $2,
          jsonb_build_object('kind',$3::text)
       )`,
      [input.attemptId, recovery.actorId, recovery.evidenceKind],
    );
      const result = {
        jobId: input.jobId,
        attemptId: input.attemptId,
        publicationMayHaveStarted: false as const,
      };
      if (diagnosticOnly) {
        throw new ReadyX3RecoveryDiagnosticRollback(result);
      }
      return { requeued: true, ...result };
    });
  } catch (error) {
    if (diagnosticOnly && error instanceof ReadyX3RecoveryDiagnosticRollback) {
      return { diagnosticPassed: true, rolledBack: true, ...error.result };
    }
    throw error;
  }
}

export async function requeueReadyX3InvalidClaimFailure(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}) {
  return requeueReadyX3PreproviderFailure(input, {
    errorCode: 'INVALID_CLAIM',
    actorId: 'ready_x3_invalid_claim_recovery',
    evidenceKind: 'invalid_claim_failure_requeued',
    unsafeMessage: 'The Ready x3 validation failure is not safe to recover',
    unsafeCode: 'READY_X3_INVALID_CLAIM_RECOVERY_UNSAFE',
  });
}

const MISCLASSIFIED_BATCH_INVALID_CLAIM_MESSAGE =
  'readyX3Authorization: must exactly match the frozen packet revision, schedule, and media fields';

const EXPIRED_BATCH_CLAIM_SQL_GUARDS = [
  ['jobPageMatches', 'job.notion_page_id=$4'],
  ['attemptPageMatches', 'attempt.source_notion_page_id=$4'],
  ['attemptRevisionMatchesInput', 'attempt.payload_revision=$5'],
  ['jobClaimed', "job.status='claimed'"],
  ['jobErrorCodeAbsent', 'job.error_code IS NULL'],
  ['jobErrorMessageAbsent', 'job.error_message IS NULL'],
  ['jobClaimPresent', 'job.claim_token IS NOT NULL'],
  ['jobClaimedAtPresent', 'job.claimed_at IS NOT NULL'],
  ['jobLeaseExpired', 'job.claim_expires_at<=CURRENT_TIMESTAMP'],
  ['jobStagedAbsent', 'job.staged_at IS NULL'],
  ['jobDispatchAuthorizationAbsent', 'job.dispatch_authorized_at IS NULL'],
  ['jobDispatchedAbsent', 'job.dispatched_at IS NULL'],
  ['jobVerifiedAbsent', 'job.verified_at IS NULL'],
  ['jobReconciledAbsent', 'job.reconciled_at IS NULL'],
  ['jobCompletedAbsent', 'job.completed_at IS NULL'],
  ['jobNoteIdAbsent', 'job.note_id IS NULL'],
  ['jobShareUrlAbsent', 'job.share_url IS NULL'],
  ['jobSuccessAttestationAbsent', 'job.success_attestation_id IS NULL'],
  ['jobExternalDispositionAbsent', 'job.external_disposition_request_id IS NULL'],
  ['jobReceiptContractAbsent', 'job.receipt_contract_version IS NULL'],
  ['jobReceiptOutcomeAbsent', 'job.receipt_outcome IS NULL'],
  ['jobReceiptAcknowledgementAbsent', 'job.receipt_acknowledged_at IS NULL'],
  ['jobAuthenticatedAccountAbsent', 'job.authenticated_account_id IS NULL'],
  ['jobAuthenticatedAccountTimeAbsent', 'job.authenticated_account_at IS NULL'],
  ['jobXsecEvidenceAbsent', 'job.xsec_accessible_at IS NULL'],
  ['jobPublicIndexStatusAbsent', 'job.public_index_status IS NULL'],
  ['jobPublicIndexCheckAbsent', 'job.public_index_checked_at IS NULL'],
  ['jobProviderRestrictionAbsent', 'job.provider_restriction_status IS NULL'],
  ['jobProviderRestrictionReportAbsent', 'job.provider_restriction_reported_at IS NULL'],
  ['batchItemLinked', 'item.id=job.batch_item_id AND item.local_publish_job_id=job.id'],
  ['batchLinked', 'batch.id=item.batch_id'],
  ['batchItemClaimed', "item.state='claimed'"],
  ['batchApproved', "batch.status IN ('approved','partially_approved')"],
  ['batchApprovalPresent', 'batch.approved_at IS NOT NULL'],
  ['attemptRecordFound', 'attempt.id=$3::uuid'],
  ['attemptLinked', 'attempt.source_local_publish_job_id=job.id'],
  ['attemptWorkspaceMatches', 'attempt.workspace_id=job.workspace_id'],
  ['attemptReadyX3', "attempt.authorization_kind='ready_x3'"],
  ['batchDispatchScheduled', "item.dispatch_mode='scheduled'"],
  ['legacyFallbackExact', 'attempt.late_fallback_policy=$6::jsonb'],
  ['attemptActive', 'attempt.active'],
  ['attemptApprovalPresent', 'attempt.approved_at IS NOT NULL'],
  ['attemptTerminalOutcomeAbsent', 'attempt.terminal_outcome IS NULL'],
  ['attemptTerminalTimeAbsent', 'attempt.terminal_at IS NULL'],
  ['attemptReceiptPending', "attempt.receipt_lookup_state='pending'"],
  ['attemptNotSuperseded', 'attempt.superseded_by_attempt_id IS NULL'],
  ['attemptDispatchAuthorizationAbsent', 'attempt.dispatch_authorized_at IS NULL'],
  ['workerRunAbsent', 'attempt.worker_run_id IS NULL'],
  ['playwrightRunAbsent', 'attempt.playwright_run_id IS NULL'],
  ['claimTokensMatch', 'attempt.claim_token=job.claim_token'],
  ['claimExpiriesMatch', 'attempt.claim_expires_at=job.claim_expires_at'],
  ['attemptLeaseExpired', 'attempt.claim_expires_at<=CURRENT_TIMESTAMP'],
  ['workerClaimedEventPresent', `EXISTS (
    SELECT 1 FROM rednote_publish_attempt_events event
    WHERE event.attempt_id=attempt.id AND event.event_type='worker_claimed'
  )`],
  ['executionStartedAbsent', `NOT EXISTS (
    SELECT 1 FROM rednote_publish_attempt_events event
    WHERE event.attempt_id=attempt.id AND event.event_type='execution_started'
  )`],
  ['receiptAbsent', `NOT EXISTS (
    SELECT 1 FROM rednote_publish_attempt_receipts receipt
    WHERE receipt.attempt_id=attempt.id
  )`],
  ['publicationEvidenceAbsent', `NOT EXISTS (
    SELECT 1 FROM rednote_publication_evidence evidence
    WHERE evidence.workspace_id=job.workspace_id
      AND evidence.local_publish_job_id=job.id
  )`],
] as const;

type ExpiredBatchClaimSqlCheck = typeof EXPIRED_BATCH_CLAIM_SQL_GUARDS[number][0];
type ExpiredBatchClaimChecks = Record<string, boolean>;

type ExpiredBatchClaimCandidate = QueryResultRow & {
  id: string;
  claim_token: string;
  claim_expires_at: Date | string;
  payload_digest: string;
  payload_revision: string;
  frozen_payload: FrozenRednoteAttemptPayload;
  approved_at: Date | string;
  late_fallback_policy: unknown;
  job_snapshot: LocalPublishSnapshot;
  batch_snapshot: LocalPublishSnapshot;
  dispatch_mode: 'scheduled' | 'post_now';
  item_hash: string;
  manifest_hash: string;
  batch_manifest: Array<{
    notionPageId: string;
    itemHash: string;
    dispatchMode: 'scheduled' | 'post_now';
    lateBySeconds: number;
  }>;
  sql_checks?: Record<ExpiredBatchClaimSqlCheck, boolean>;
};

type MisclassifiedBatchPacketCandidate = Pick<
  ExpiredBatchClaimCandidate,
  | 'payload_digest'
  | 'payload_revision'
  | 'frozen_payload'
  | 'late_fallback_policy'
  | 'job_snapshot'
  | 'batch_snapshot'
  | 'item_hash'
  | 'manifest_hash'
  | 'batch_manifest'
>;

function evaluateMisclassifiedBatchPacket(
  row: MisclassifiedBatchPacketCandidate | undefined,
  input: {
    jobId: string;
    sourceNotionPageId: string;
    revision: string;
  },
) {
  const payload = row?.frozen_payload;
  const check = (test: () => boolean) => {
    try {
      return Boolean(row && test());
    } catch {
      return false;
    }
  };
  return {
    batchManifestSingleItem: check(() => row!.batch_manifest?.length === 1),
    jobSnapshotMatchesBatchSnapshot: check(() =>
      isDeepStrictEqual(row!.job_snapshot, row!.batch_snapshot)),
    jobSnapshotRevisionMatches: check(() =>
      row!.job_snapshot.notionLastEditedTime === input.revision),
    batchSnapshotRevisionMatches: check(() =>
      row!.batch_snapshot.notionLastEditedTime === input.revision),
    legacyFallbackValueMatches: check(() =>
      isDeepStrictEqual(row!.late_fallback_policy, LEGACY_READY_X3_LATE_FALLBACK_POLICY)),
    batchItemDigestValid: check(() =>
      stableDigest(row!.batch_snapshot) === row!.item_hash),
    batchManifestDigestValid: check(() =>
      storedManifestHash(row!.batch_manifest) === row!.manifest_hash),
    attemptRevisionMatches: check(() => row!.payload_revision === input.revision),
    frozenDigestFieldMatches: check(() => payload!.payloadDigest === row!.payload_digest),
    frozenRevisionMatchesAttempt: check(() =>
      payload!.payloadRevision === row!.payload_revision),
    frozenRevisionMatchesInput: check(() => payload!.payloadRevision === input.revision),
    frozenPageMatches: check(() =>
      payload!.sourceNotionPageId === input.sourceNotionPageId),
    frozenJobMatches: check(() => payload!.sourceLocalPublishJobId === input.jobId),
    frozenTimingScheduled: check(() => payload!.browserPayload.timingMode === 'scheduled'),
    frozenPayloadDigestValid: check(() =>
      frozenPayloadDigest(payload!) === row!.payload_digest),
    frozenPayloadMatchesApprovedBatch: check(() =>
      attemptPayloadMatchesApprovedBatch(payload!.browserPayload, row!.batch_snapshot, 'schedule')),
  };
}

function expiredBatchClaimSqlWhere() {
  return EXPIRED_BATCH_CLAIM_SQL_GUARDS.map(([, expression]) => `(${expression})`).join('\nAND ');
}

function expiredBatchClaimSqlChecks() {
  const chunks = [];
  for (let index = 0; index < EXPIRED_BATCH_CLAIM_SQL_GUARDS.length; index += 20) {
    const entries = EXPIRED_BATCH_CLAIM_SQL_GUARDS.slice(index, index + 20)
      .flatMap(([name, expression]) => [`'${name}'`, `COALESCE((${expression}),false)`]);
    chunks.push(`jsonb_build_object(${entries.join(',')})`);
  }
  return chunks.join(' || ');
}

function evaluateExpiredBatchClaimCandidate(
  row: ExpiredBatchClaimCandidate | undefined,
  input: {
    jobId: string;
    sourceNotionPageId: string;
    revision: string;
  },
) {
  const checks: ExpiredBatchClaimChecks = {
    recordFound: Boolean(row),
    ...Object.fromEntries(
      EXPIRED_BATCH_CLAIM_SQL_GUARDS.map(([name]) => [name, Boolean(row)]),
    ),
    ...(row?.sql_checks ?? {}),
    ...evaluateMisclassifiedBatchPacket(row, input),
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return { eligible: failedChecks.length === 0, checks, failedChecks };
}

export async function diagnoseExpiredMisclassifiedBatchClaim(input: {
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
  const result = await getPool().query<ExpiredBatchClaimCandidate>(
    `SELECT attempt.id,attempt.claim_token,attempt.claim_expires_at,
        attempt.payload_digest,attempt.payload_revision,
        attempt.frozen_payload,attempt.approved_at,
        attempt.late_fallback_policy,
        job.snapshot AS job_snapshot,item.snapshot AS batch_snapshot,
        item.dispatch_mode,item.item_hash,batch.manifest_hash,
        (
          SELECT json_agg(
            json_build_object(
              'notionPageId',manifest_item.notion_page_id,
              'itemHash',manifest_item.item_hash,
              'dispatchMode',manifest_item.dispatch_mode,
              'lateBySeconds',manifest_item.late_by_seconds
            )
            ORDER BY manifest_item.snapshot->>'publishAt' NULLS FIRST,
              manifest_item.created_at
          )
          FROM rednote_publish_batch_items manifest_item
          WHERE manifest_item.batch_id=batch.id
        ) AS batch_manifest,
        ${expiredBatchClaimSqlChecks()} AS sql_checks
     FROM local_publish_jobs job
     LEFT JOIN rednote_publish_batch_items item
       ON item.id=job.batch_item_id
     LEFT JOIN rednote_publish_batches batch
       ON batch.id=item.batch_id
     LEFT JOIN rednote_publish_attempts attempt
       ON attempt.id=$3::uuid
     WHERE job.workspace_id=$1 AND job.id=$2::uuid`,
    [
      input.workspaceId,
      input.jobId,
      input.attemptId,
      input.sourceNotionPageId,
      input.revision,
      JSON.stringify(LEGACY_READY_X3_LATE_FALLBACK_POLICY),
    ],
  );
  return evaluateExpiredBatchClaimCandidate(result.rows[0], input);
}

export async function requeueMisclassifiedBatchInvalidClaimFailure(input: {
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
    await assertNoCompetingPublishLifecycle(client, input);
    await client.query(
      `SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true)`,
    );
    await client.query(
      `SELECT set_config('app.batch_authorization_reclassification', 'on', true)`,
    );
    const locked = await client.query<{
      id: string;
      payload_digest: string;
      payload_revision: string;
      frozen_payload: FrozenRednoteAttemptPayload;
      approved_at: Date | string;
      job_snapshot: LocalPublishSnapshot;
      batch_snapshot: LocalPublishSnapshot;
      dispatch_mode: 'scheduled' | 'post_now';
    }>(
      `SELECT attempt.id,attempt.payload_digest,attempt.payload_revision,
          attempt.frozen_payload,attempt.approved_at,
          job.snapshot AS job_snapshot,item.snapshot AS batch_snapshot,
          item.dispatch_mode
       FROM local_publish_jobs job
       JOIN rednote_publish_batch_items item
         ON item.id=job.batch_item_id
        AND item.local_publish_job_id=job.id
       JOIN rednote_publish_batches batch ON batch.id=item.batch_id
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
         AND job.error_message LIKE '%' || $6 || '%'
         AND job.staged_at IS NULL
         AND job.dispatch_authorized_at IS NULL
         AND job.dispatched_at IS NULL
         AND job.note_id IS NULL AND job.share_url IS NULL
         AND job.success_attestation_id IS NULL
         AND job.external_disposition_request_id IS NULL
         AND item.state='failed'
         AND batch.status IN ('approved','partially_approved')
         AND batch.approved_at IS NOT NULL
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
       FOR UPDATE OF job,item,batch,attempt`,
      [
        input.workspaceId,
        input.jobId,
        input.attemptId,
        input.sourceNotionPageId,
        input.revision,
        MISCLASSIFIED_BATCH_INVALID_CLAIM_MESSAGE,
      ],
    );
    const row = locked.rows[0];
    const payload = row?.frozen_payload;
    if (
      !row ||
      !isDeepStrictEqual(row.job_snapshot, row.batch_snapshot) ||
      payload.payloadDigest !== row.payload_digest ||
      payload.payloadRevision !== row.payload_revision ||
      payload.sourceNotionPageId !== input.sourceNotionPageId ||
      payload.sourceLocalPublishJobId !== input.jobId ||
      frozenPayloadDigest(payload) !== row.payload_digest ||
      !attemptPayloadMatchesApprovedBatch(
        payload.browserPayload,
        row.batch_snapshot,
        row.dispatch_mode === 'post_now' ? 'post_now' : 'schedule',
      )
    ) {
      throw new LocalPublishJobError(
        'The failed claim is not an exact misclassified bounded-batch attempt',
        'BATCH_AUTHORIZATION_REPAIR_UNSAFE',
        409,
      );
    }
    const attempt = await client.query<{ id: string }>(
      `UPDATE rednote_publish_attempts
       SET authorization_kind=NULL,late_fallback_policy=NULL,
           active=true,terminal_outcome=NULL,terminal_at=NULL,
           receipt_lookup_state='pending',
           receipt_lookup_updated_at=CURRENT_TIMESTAMP,
           claim_token=NULL,claim_expires_at=NULL
       WHERE workspace_id=$1 AND id=$2::uuid
         AND source_local_publish_job_id=$3::uuid
         AND authorization_kind='ready_x3'
         AND NOT active AND approved_at IS NOT NULL
         AND terminal_outcome='known_failed'
         AND receipt_lookup_state='not_required'
         AND dispatch_authorized_at IS NULL
         AND superseded_by_attempt_id IS NULL
       RETURNING id`,
      [input.workspaceId, input.attemptId, input.jobId],
    );
    const job = await client.query<{ id: string }>(
      `UPDATE local_publish_jobs
       SET status='queued',claim_token=NULL,claimed_at=NULL,
           claim_expires_at=NULL,error_code=NULL,error_message=NULL,
           completed_at=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND id=$2::uuid
         AND status='failed' AND error_code='INVALID_CLAIM'
         AND dispatch_authorized_at IS NULL AND dispatched_at IS NULL
         AND EXISTS (
           SELECT 1 FROM rednote_publish_attempts attempt
           WHERE attempt.id=$3::uuid
             AND attempt.source_local_publish_job_id=local_publish_jobs.id
             AND attempt.workspace_id=local_publish_jobs.workspace_id
             AND attempt.authorization_kind IS NULL
             AND attempt.active AND attempt.terminal_outcome IS NULL
         )
       RETURNING id`,
      [input.workspaceId, input.jobId, input.attemptId],
    );
    if (!attempt.rows[0] || !job.rows[0]) {
      throw new LocalPublishJobError(
        'The failed bounded-batch claim changed during recovery',
        'BATCH_AUTHORIZATION_REPAIR_UNSAFE',
        409,
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id,event_type,occurred_at,actor_type,actor_id,diagnostics
       ) VALUES(
         $1::uuid,'administrative_recovery',CURRENT_TIMESTAMP,'admin',
         'batch_authorization_invalid_claim_recovery',
         jsonb_build_object(
           'kind','batch_authorization_reclassified',
           'priorAuthorizationKind','ready_x3'
         )
       )`,
      [input.attemptId],
    );
    return {
      requeued: true,
      reclassifiedAuthorization: 'batch' as const,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false as const,
    };
  });
}

export async function requeueExpiredMisclassifiedBatchClaim(input: {
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
    await assertNoCompetingPublishLifecycle(client, input);
    await client.query(
      `SELECT set_config('app.expired_batch_claim_reclassification', 'on', true)`,
    );
    const locked = await client.query<ExpiredBatchClaimCandidate>(
      `SELECT attempt.id,attempt.claim_token,attempt.claim_expires_at,
          attempt.payload_digest,attempt.payload_revision,
          attempt.frozen_payload,attempt.approved_at,
          attempt.late_fallback_policy,
          job.snapshot AS job_snapshot,item.snapshot AS batch_snapshot,
          item.dispatch_mode,item.item_hash,batch.manifest_hash,
          (
            SELECT json_agg(
              json_build_object(
                'notionPageId',manifest_item.notion_page_id,
                'itemHash',manifest_item.item_hash,
                'dispatchMode',manifest_item.dispatch_mode,
                'lateBySeconds',manifest_item.late_by_seconds
              )
              ORDER BY manifest_item.snapshot->>'publishAt' NULLS FIRST,
                manifest_item.created_at
            )
            FROM rednote_publish_batch_items manifest_item
            WHERE manifest_item.batch_id=batch.id
          ) AS batch_manifest
       FROM local_publish_jobs job
       JOIN rednote_publish_batch_items item
         ON item.id=job.batch_item_id
        AND item.local_publish_job_id=job.id
       JOIN rednote_publish_batches batch ON batch.id=item.batch_id
       JOIN rednote_publish_attempts attempt
         ON attempt.source_local_publish_job_id=job.id
        AND attempt.workspace_id=job.workspace_id
       WHERE job.workspace_id=$1 AND job.id=$2::uuid
         AND attempt.id=$3::uuid
         AND ${expiredBatchClaimSqlWhere()}
       FOR UPDATE OF job,item,batch,attempt`,
      [
        input.workspaceId,
        input.jobId,
        input.attemptId,
        input.sourceNotionPageId,
        input.revision,
        JSON.stringify(LEGACY_READY_X3_LATE_FALLBACK_POLICY),
      ],
    );
    const row = locked.rows[0];
    if (!evaluateExpiredBatchClaimCandidate(row, input).eligible) {
      throw new LocalPublishJobError(
        'The expired claim is not an exact unexecuted misclassified bounded-batch attempt',
        'EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
        409,
      );
    }
    const attempt = await client.query<{ id: string }>(
      `UPDATE rednote_publish_attempts
       SET authorization_kind=NULL,late_fallback_policy=NULL,
           claim_token=NULL,claim_expires_at=NULL
       WHERE workspace_id=$1 AND id=$2::uuid
         AND source_local_publish_job_id=$3::uuid
         AND authorization_kind='ready_x3'
         AND active AND approved_at IS NOT NULL
         AND terminal_outcome IS NULL AND terminal_at IS NULL
         AND receipt_lookup_state='pending'
         AND dispatch_authorized_at IS NULL
         AND superseded_by_attempt_id IS NULL
         AND claim_token=$4::uuid
         AND claim_expires_at<=CURRENT_TIMESTAMP
       RETURNING id`,
      [input.workspaceId, input.attemptId, input.jobId, row.claim_token],
    );
    const job = await client.query<{ id: string }>(
      `UPDATE local_publish_jobs
       SET status='queued',claim_token=NULL,claimed_at=NULL,
           claim_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND id=$2::uuid
         AND status='claimed' AND claim_token=$4::uuid
         AND claim_expires_at<=CURRENT_TIMESTAMP
         AND error_code IS NULL AND error_message IS NULL
         AND dispatch_authorized_at IS NULL AND dispatched_at IS NULL
         AND EXISTS (
           SELECT 1 FROM rednote_publish_attempts attempt
           WHERE attempt.id=$3::uuid
             AND attempt.source_local_publish_job_id=local_publish_jobs.id
             AND attempt.workspace_id=local_publish_jobs.workspace_id
             AND attempt.authorization_kind IS NULL
             AND attempt.active AND attempt.terminal_outcome IS NULL
             AND attempt.claim_token IS NULL
             AND attempt.claim_expires_at IS NULL
         )
       RETURNING id`,
      [input.workspaceId, input.jobId, input.attemptId, row.claim_token],
    );
    if (!attempt.rows[0] || !job.rows[0]) {
      throw new LocalPublishJobError(
        'The expired bounded-batch claim changed during recovery',
        'EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
        409,
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id,event_type,occurred_at,actor_type,actor_id,diagnostics
       ) VALUES(
         $1::uuid,'administrative_recovery',CURRENT_TIMESTAMP,'admin',
         'expired_batch_claim_authorization_recovery',
         jsonb_build_object(
           'kind','expired_batch_claim_authorization_reclassified',
           'priorAuthorizationKind','ready_x3',
           'claimExpiredAt',$2::timestamptz
         )
       )`,
      [input.attemptId, row.claim_expires_at],
    );
    return {
      requeued: true,
      reclassifiedAuthorization: 'batch' as const,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false as const,
    };
  });
}

const TERMINAL_EXPIRED_BATCH_CLAIM_SQL_GUARDS = [
  ['jobPageMatches', 'job.notion_page_id=$4'],
  ['attemptPageMatches', 'attempt.source_notion_page_id=$4'],
  ['attemptRevisionMatchesInput', 'attempt.payload_revision=$5'],
  ['jobFailed', "job.status='failed'"],
  ['jobLeaseErrorCodeExact', "job.error_code='CLAIM_LEASE_EXPIRED'"],
  ['jobLeaseErrorMessageExact', 'job.error_message=$7'],
  ['jobClaimTokenCleared', 'job.claim_token IS NULL'],
  ['jobClaimAttemptExact', 'job.claim_attempts=1'],
  ['jobClaimedAtPresent', 'job.claimed_at IS NOT NULL'],
  ['jobLeaseTerminalized', 'job.claim_expires_at IS NOT NULL'],
  ['jobLeaseExpired', 'job.claim_expires_at<=CURRENT_TIMESTAMP'],
  ['jobCompletedAtMatchesLease', 'job.completed_at=job.claim_expires_at'],
  ['jobStagedAbsent', 'job.staged_at IS NULL'],
  ['jobDispatchAuthorizationAbsent', 'job.dispatch_authorized_at IS NULL'],
  ['jobDispatchedAbsent', 'job.dispatched_at IS NULL'],
  ['jobVerifiedAbsent', 'job.verified_at IS NULL'],
  ['jobReconciledAbsent', 'job.reconciled_at IS NULL'],
  ['jobNoteIdAbsent', 'job.note_id IS NULL'],
  ['jobShareUrlAbsent', 'job.share_url IS NULL'],
  ['jobSuccessAttestationAbsent', 'job.success_attestation_id IS NULL'],
  ['jobExternalDispositionAbsent', 'job.external_disposition_request_id IS NULL'],
  ['jobReceiptContractAbsent', 'job.receipt_contract_version IS NULL'],
  ['jobReceiptOutcomeAbsent', 'job.receipt_outcome IS NULL'],
  ['jobReceiptAcknowledgementAbsent', 'job.receipt_acknowledged_at IS NULL'],
  ['jobAuthenticatedAccountAbsent', 'job.authenticated_account_id IS NULL'],
  ['jobAuthenticatedAccountTimeAbsent', 'job.authenticated_account_at IS NULL'],
  ['jobXsecEvidenceAbsent', 'job.xsec_accessible_at IS NULL'],
  ['jobPublicIndexStatusAbsent', 'job.public_index_status IS NULL'],
  ['jobPublicIndexCheckAbsent', 'job.public_index_checked_at IS NULL'],
  ['jobProviderRestrictionAbsent', 'job.provider_restriction_status IS NULL'],
  ['jobProviderRestrictionReportAbsent', 'job.provider_restriction_reported_at IS NULL'],
  ['batchItemLinked', 'item.id=job.batch_item_id AND item.local_publish_job_id=job.id'],
  ['batchLinked', 'batch.id=item.batch_id'],
  ['batchItemQueued', "item.state='queued'"],
  ['batchDispatchScheduled', "item.dispatch_mode='scheduled'"],
  ['batchItemPageMatchesAttempt',
    'item.notion_page_id=attempt.source_notion_page_id'],
  ['batchSnapshotMatchesJob', 'item.snapshot=job.snapshot'],
  ['batchSnapshotPageMatchesAttempt',
    "item.snapshot->>'notionPageId'=attempt.source_notion_page_id"],
  ['batchSnapshotRevisionMatchesAttempt',
    "item.snapshot->>'notionLastEditedTime'=attempt.payload_revision"],
  ['batchItemDigestValidSql',
    'item.item_hash=terminal_expired_batch_claim_digest(item.snapshot)'],
  ['batchApproved', "batch.status IN ('approved','partially_approved')"],
  ['batchApprovalPresent', 'batch.approved_at IS NOT NULL'],
  ['batchSingleItem', `(SELECT count(*) FROM rednote_publish_batch_items sibling
    WHERE sibling.batch_id=batch.id)=1`],
  ['batchManifestDigestValidSql',
    `batch.manifest_hash=terminal_expired_batch_claim_manifest_digest(
      item.notion_page_id,item.item_hash,item.dispatch_mode,item.late_by_seconds
    )`],
  ['attemptRecordFound', 'attempt.id=$3::uuid'],
  ['attemptLinked', 'attempt.source_local_publish_job_id=job.id'],
  ['attemptWorkspaceMatches', 'attempt.workspace_id=job.workspace_id'],
  ['attemptReadyX3', "attempt.authorization_kind='ready_x3'"],
  ['legacyFallbackExact', 'attempt.late_fallback_policy=$6::jsonb'],
  ['attemptInactive', 'NOT attempt.active'],
  ['attemptApprovalPresent', 'attempt.approved_at IS NOT NULL'],
  ['attemptApprovalMatchesBatch', 'attempt.approved_at=batch.approved_at'],
  ['attemptTerminalKnownFailed', "attempt.terminal_outcome='known_failed'"],
  ['attemptTerminalTimeMatchesJobLease', 'attempt.terminal_at=job.claim_expires_at'],
  ['attemptReceiptNotRequired', "attempt.receipt_lookup_state='not_required'"],
  ['attemptReceiptLookupTimeMatchesJobLease',
    'attempt.receipt_lookup_updated_at=job.claim_expires_at'],
  ['attemptNotSuperseded', 'attempt.superseded_by_attempt_id IS NULL'],
  ['attemptDispatchAuthorizationAbsent', 'attempt.dispatch_authorized_at IS NULL'],
  ['workerRunAbsent', 'attempt.worker_run_id IS NULL'],
  ['playwrightRunAbsent', 'attempt.playwright_run_id IS NULL'],
  ['attemptClaimPresent', 'attempt.claim_token IS NOT NULL'],
  ['attemptLeaseMatchesJobLease', 'attempt.claim_expires_at=job.claim_expires_at'],
  ['attemptLeaseExpired', 'attempt.claim_expires_at<=CURRENT_TIMESTAMP'],
  ['frozenContractRevisionMatchesAttempt',
    "attempt.frozen_payload->>'contractRevision'=attempt.contract_revision"],
  ['frozenPageMatchesAttempt',
    "attempt.frozen_payload->>'sourceNotionPageId'=attempt.source_notion_page_id"],
  ['frozenJobMatchesAttempt',
    `attempt.frozen_payload->>'sourceLocalPublishJobId'=
      attempt.source_local_publish_job_id::text`],
  ['frozenRevisionMatchesAttemptSql',
    "attempt.frozen_payload->>'payloadRevision'=attempt.payload_revision"],
  ['frozenDigestFieldMatchesAttempt',
    "attempt.frozen_payload->>'payloadDigest'=attempt.payload_digest"],
  ['frozenPayloadDigestValidSql',
    `attempt.payload_digest=terminal_expired_batch_claim_digest(
      attempt.frozen_payload->'browserPayload'
    )`],
  ['browserSourcePageMatchesAttempt',
    `attempt.frozen_payload->'browserPayload'->>'sourcePostId'=
      attempt.source_notion_page_id`],
  ['browserExpectedAccountMatchesSnapshot',
    `attempt.frozen_payload->'browserPayload'->>'expectedAccountId'=
      item.snapshot->>'expectedAccountId'`],
  ['browserTitleMatchesSnapshot',
    "attempt.frozen_payload->'browserPayload'->>'title'=item.snapshot->>'title'"],
  ['browserCaptionMatchesSnapshot',
    `attempt.frozen_payload->'browserPayload'->>'caption'=
      item.snapshot->>'caption'`],
  ['browserTagsMatchSnapshot',
    "attempt.frozen_payload->'browserPayload'->'tags'=item.snapshot->'tags'"],
  ['browserPublishModeMatchesSnapshot',
    `attempt.frozen_payload->'browserPayload'->>'publishMode'=
      item.snapshot->>'mediaType'`],
  ['browserScheduledDateMatchesSnapshot',
    `attempt.frozen_payload->'browserPayload'->>'scheduledDate'=
      item.snapshot->>'publishAt'`],
  ['browserTargetPublishAtMatchesSnapshot',
    `attempt.frozen_payload->'browserPayload'->>'targetPublishAt'=
      item.snapshot->>'publishAt'`],
  ['browserTimingScheduled',
    "attempt.frozen_payload->'browserPayload'->>'timingMode'='scheduled'"],
  ['batchMediaCountValid', `CASE
    WHEN jsonb_typeof(item.snapshot->'media')='array'
    THEN jsonb_array_length(item.snapshot->'media') BETWEEN 1 AND 18
    ELSE FALSE
  END`],
  ['batchFirstMediaTypeMatches',
    "item.snapshot->'media'->0->>'type'=item.snapshot->>'mediaType'"],
  ['batchFirstMediaUrlMatches',
    "item.snapshot->'media'->0->>'url'=item.snapshot->>'mediaUrl'"],
  ['batchMediaTypesMatch', `CASE
    WHEN jsonb_typeof(item.snapshot->'media')='array'
    THEN NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(item.snapshot->'media') AS media(value)
      WHERE media.value->>'type' IS DISTINCT FROM item.snapshot->>'mediaType'
    )
    ELSE FALSE
  END`],
  ['browserMediaMatchesSnapshot', `CASE
    WHEN jsonb_typeof(
      attempt.frozen_payload->'browserPayload'->'mediaAssets'
    )='array'
      AND jsonb_typeof(item.snapshot->'media')='array'
    THEN (
      SELECT jsonb_agg(
        jsonb_build_object(
          'type',asset.value->>'mediaType',
          'url',asset.value->>'deliveryUrl'
        )
        ORDER BY asset.ordinality
      )
      FROM jsonb_array_elements(
        attempt.frozen_payload->'browserPayload'->'mediaAssets'
      ) WITH ORDINALITY AS asset(value,ordinality)
    )=(
      SELECT jsonb_agg(
        jsonb_build_object(
          'type',media.value->>'type',
          'url',media.value->>'url'
        )
        ORDER BY media.ordinality
      )
      FROM jsonb_array_elements(item.snapshot->'media')
        WITH ORDINALITY AS media(value,ordinality)
    )
    ELSE FALSE
  END`],
  ['batchMediaIdentitiesValid', `CASE
    WHEN jsonb_typeof(item.snapshot->'media')='array'
    THEN NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(item.snapshot->'media') AS media(value)
      WHERE media.value->>'identity' IS DISTINCT FROM
        terminal_expired_batch_claim_digest(
          jsonb_build_object(
            'type',media.value->>'type',
            'url',media.value->>'url'
          )
        )
    )
    ELSE FALSE
  END`],
  ['browserCoverMatchesVideoSnapshot', `(
    item.snapshot->>'mediaType'<>'video'
    OR attempt.frozen_payload->'browserPayload'->'coverAsset'->>'deliveryUrl'=
      item.snapshot->>'thumbnailUrl'
  )`],
  ['attemptCreatedEventExact', `(SELECT count(*) FROM rednote_publish_attempt_events event
    WHERE event.attempt_id=attempt.id AND event.event_type='attempt_created')=1`],
  ['workerClaimedEventExact', `(SELECT count(*) FROM rednote_publish_attempt_events event
    WHERE event.attempt_id=attempt.id AND event.event_type='worker_claimed')=1`],
  ['leaseExpiryEventExact', `(SELECT count(*) FROM rednote_publish_attempt_events event
    WHERE event.attempt_id=attempt.id
      AND event.event_type='terminal_outcome_recorded'
      AND event.actor_type='admin'
      AND event.actor_id='local_publish_lease_recovery'
      AND event.occurred_at=attempt.terminal_at)=1`],
  ['attemptEventCountExact', `(SELECT count(*) FROM rednote_publish_attempt_events event
    WHERE event.attempt_id=attempt.id)=3`],
  ['executionStartedAbsent', `NOT EXISTS (
    SELECT 1 FROM rednote_publish_attempt_events event
    WHERE event.attempt_id=attempt.id AND event.event_type='execution_started'
  )`],
  ['receiptAbsent', `NOT EXISTS (
    SELECT 1 FROM rednote_publish_attempt_receipts receipt
    WHERE receipt.attempt_id=attempt.id
  )`],
  ['publicationEvidenceAbsent', `NOT EXISTS (
    SELECT 1 FROM rednote_publication_evidence evidence
    WHERE evidence.workspace_id=job.workspace_id
      AND (evidence.local_publish_job_id=job.id OR evidence.attempt_id=attempt.id)
  )`],
  ['successAttestationRecordAbsent', `NOT EXISTS (
    SELECT 1 FROM local_publish_job_success_attestations attestation
    WHERE attestation.local_publish_job_id=job.id
  )`],
  ['successAttestationAckAbsent', `NOT EXISTS (
    SELECT 1
    FROM local_publish_job_success_attestation_release_acks acknowledgement
    JOIN local_publish_job_success_attestations attestation
      ON attestation.id=acknowledgement.success_attestation_id
    WHERE attestation.local_publish_job_id=job.id
  )`],
  ['manualReconciliationAbsent', `NOT EXISTS (
    SELECT 1 FROM manual_reconciliation_requests reconciliation
    WHERE reconciliation.workspace_id=job.workspace_id
      AND reconciliation.source_local_job_id=job.id
  )`],
  ['externalReconciliationAbsent', `NOT EXISTS (
    SELECT 1 FROM external_post_reconciliations reconciliation
    WHERE reconciliation.workspace_id=job.workspace_id
      AND reconciliation.notion_page_id=job.notion_page_id
  )`],
  ['operatorScheduleAbsent', `NOT EXISTS (
    SELECT 1 FROM plan_operator_scheduled_posts operator_post
    WHERE operator_post.workspace_id=job.workspace_id
      AND operator_post.notion_page_id=job.notion_page_id
  )`],
  ['jobRecoveryAbsent', `NOT EXISTS (
    SELECT 1 FROM rednote_publish_job_recoveries recovery
    WHERE recovery.local_publish_job_id=job.id
  )`],
  ['queueQuarantineAbsent', `NOT EXISTS (
    SELECT 1 FROM local_publish_queue_quarantine_items quarantine
    WHERE quarantine.local_publish_job_id=job.id
  )`],
  ['otherActiveJobAbsent', `NOT EXISTS (
    SELECT 1 FROM local_publish_jobs other_job
    WHERE other_job.workspace_id=job.workspace_id
      AND other_job.notion_page_id=job.notion_page_id
      AND other_job.id<>job.id
      AND other_job.status NOT IN ('reconciled','succeeded','failed')
  )`],
  ['otherAttemptForJobAbsent', `(SELECT count(*) FROM rednote_publish_attempts sibling_attempt
    WHERE sibling_attempt.workspace_id=job.workspace_id
      AND sibling_attempt.source_local_publish_job_id=job.id)=1`],
] as const;

type TerminalExpiredBatchClaimSqlCheck =
  typeof TERMINAL_EXPIRED_BATCH_CLAIM_SQL_GUARDS[number][0];
type TerminalExpiredBatchClaimCandidate = ExpiredBatchClaimCandidate & {
  terminal_at: Date | string;
  sql_checks?: Record<TerminalExpiredBatchClaimSqlCheck, boolean>;
};

function terminalExpiredBatchClaimSqlWhere() {
  return TERMINAL_EXPIRED_BATCH_CLAIM_SQL_GUARDS
    .map(([, expression]) => `(${expression})`)
    .join('\nAND ');
}

function terminalExpiredBatchClaimSqlChecks() {
  const chunks = [];
  for (let index = 0; index < TERMINAL_EXPIRED_BATCH_CLAIM_SQL_GUARDS.length; index += 20) {
    const entries = TERMINAL_EXPIRED_BATCH_CLAIM_SQL_GUARDS.slice(index, index + 20)
      .flatMap(([name, expression]) => [`'${name}'`, `COALESCE((${expression}),false)`]);
    chunks.push(`jsonb_build_object(${entries.join(',')})`);
  }
  return chunks.join(' || ');
}

function evaluateTerminalExpiredBatchClaimCandidate(
  row: TerminalExpiredBatchClaimCandidate | undefined,
  input: {
    jobId: string;
    sourceNotionPageId: string;
    revision: string;
  },
) {
  const payload = row?.frozen_payload;
  const check = (test: () => boolean) => {
    try {
      return Boolean(row && test());
    } catch {
      return false;
    }
  };
  const checks: ExpiredBatchClaimChecks = {
    recordFound: Boolean(row),
    ...Object.fromEntries(
      TERMINAL_EXPIRED_BATCH_CLAIM_SQL_GUARDS.map(([name]) => [name, Boolean(row)]),
    ),
    ...(row?.sql_checks ?? {}),
    ...evaluateMisclassifiedBatchPacket(row, input),
    batchExpectedAccountPresent: check(() =>
      typeof row!.batch_snapshot.expectedAccountId === 'string'),
    browserExpectedAccountPresent: check(() =>
      typeof payload!.browserPayload.expectedAccountId === 'string'),
    batchPublishAtPresent: check(() =>
      typeof row!.batch_snapshot.publishAt === 'string'),
    browserScheduledDatePresent: check(() =>
      typeof payload!.browserPayload.scheduledDate === 'string'),
    browserTargetPublishAtPresent: check(() =>
      typeof payload!.browserPayload.targetPublishAt === 'string'),
    videoThumbnailPresent: check(() =>
      row!.batch_snapshot.mediaType !== 'video' ||
      typeof row!.batch_snapshot.thumbnailUrl === 'string'),
    browserVideoCoverPresent: check(() =>
      row!.batch_snapshot.mediaType !== 'video' ||
      typeof payload!.browserPayload.coverAsset?.deliveryUrl === 'string'),
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return { eligible: failedChecks.length === 0, checks, failedChecks };
}

function validateRecoveryInput(input: Record<string, unknown>) {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new LocalPublishJobError(`${name} is required`, 'VALIDATION_ERROR', 400);
    }
  }
}

function terminalExpiredBatchClaimSelect(
  sqlChecks: string,
  joinKind: 'LEFT JOIN' | 'JOIN' = 'LEFT JOIN',
) {
  return `SELECT attempt.id,attempt.claim_token,attempt.claim_expires_at,
      attempt.terminal_at,attempt.payload_digest,attempt.payload_revision,
      attempt.frozen_payload,attempt.approved_at,
      attempt.late_fallback_policy,
      job.snapshot AS job_snapshot,item.snapshot AS batch_snapshot,
      item.dispatch_mode,item.item_hash,batch.manifest_hash,
      (
        SELECT json_agg(
          json_build_object(
            'notionPageId',manifest_item.notion_page_id,
            'itemHash',manifest_item.item_hash,
            'dispatchMode',manifest_item.dispatch_mode,
            'lateBySeconds',manifest_item.late_by_seconds
          )
          ORDER BY manifest_item.snapshot->>'publishAt' NULLS FIRST,
            manifest_item.created_at
        )
        FROM rednote_publish_batch_items manifest_item
        WHERE manifest_item.batch_id=batch.id
      ) AS batch_manifest,
      ${sqlChecks} AS sql_checks
    FROM local_publish_jobs job
    ${joinKind} rednote_publish_batch_items item
      ON item.id=job.batch_item_id
    ${joinKind} rednote_publish_batches batch
      ON batch.id=item.batch_id
    ${joinKind} rednote_publish_attempts attempt
      ON attempt.id=$3::uuid
    WHERE job.workspace_id=$1 AND job.id=$2::uuid`;
}

export async function diagnoseTerminalExpiredMisclassifiedBatchClaim(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}) {
  validateRecoveryInput(input);
  const result = await getPool().query<TerminalExpiredBatchClaimCandidate>(
    terminalExpiredBatchClaimSelect(terminalExpiredBatchClaimSqlChecks()),
    [
      input.workspaceId,
      input.jobId,
      input.attemptId,
      input.sourceNotionPageId,
      input.revision,
      JSON.stringify(LEGACY_READY_X3_LATE_FALLBACK_POLICY),
      CLAIM_LEASE_EXPIRED_MESSAGE,
    ],
  );
  return evaluateTerminalExpiredBatchClaimCandidate(result.rows[0], input);
}

export async function requeueTerminalExpiredMisclassifiedBatchClaim(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}) {
  validateRecoveryInput(input);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.workspaceId}:${input.sourceNotionPageId}`,
    ]);
    await assertNoCompetingPublishLifecycle(client, input);
    await client.query(
      `SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true)`,
    );
    await client.query(
      `SELECT set_config('app.terminal_expired_batch_claim_reclassification', 'on', true)`,
    );
    const locked = await client.query<TerminalExpiredBatchClaimCandidate>(
      `${terminalExpiredBatchClaimSelect("'{}'::jsonb", 'JOIN')}
       AND ${terminalExpiredBatchClaimSqlWhere()}
       FOR UPDATE OF job,attempt,item,batch`,
      [
        input.workspaceId,
        input.jobId,
        input.attemptId,
        input.sourceNotionPageId,
        input.revision,
        JSON.stringify(LEGACY_READY_X3_LATE_FALLBACK_POLICY),
        CLAIM_LEASE_EXPIRED_MESSAGE,
      ],
    );
    const row = locked.rows[0];
    if (!evaluateTerminalExpiredBatchClaimCandidate(row, input).eligible) {
      throw new LocalPublishJobError(
        'The terminal lease-expiry batch claim is not the exact unexecuted incident',
        'TERMINAL_EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
        409,
      );
    }
    const attempt = await client.query<{ id: string; approved_at: Date | string }>(
      `UPDATE rednote_publish_attempts
       SET authorization_kind=NULL,late_fallback_policy=NULL,
           active=true,terminal_outcome=NULL,terminal_at=NULL,
           receipt_lookup_state='pending',
           receipt_lookup_updated_at=CURRENT_TIMESTAMP,
           claim_token=NULL,claim_expires_at=NULL
       WHERE workspace_id=$1 AND id=$2::uuid
         AND source_local_publish_job_id=$3::uuid
         AND authorization_kind='ready_x3'
         AND late_fallback_policy=$5::jsonb
         AND NOT active AND approved_at=$6::timestamptz
         AND terminal_outcome='known_failed'
         AND terminal_at=$4::timestamptz
         AND receipt_lookup_state='not_required'
         AND receipt_lookup_updated_at=$4::timestamptz
         AND dispatch_authorized_at IS NULL
         AND superseded_by_attempt_id IS NULL
         AND worker_run_id IS NULL AND playwright_run_id IS NULL
         AND claim_token IS NOT NULL
         AND claim_expires_at=$4::timestamptz
       RETURNING id,approved_at`,
      [
        input.workspaceId,
        input.attemptId,
        input.jobId,
        row.terminal_at,
        JSON.stringify(LEGACY_READY_X3_LATE_FALLBACK_POLICY),
        row.approved_at,
      ],
    );
    const job = await client.query<{ id: string }>(
      `UPDATE local_publish_jobs
       SET status='queued',claim_token=NULL,claimed_at=NULL,
           claim_expires_at=NULL,error_code=NULL,error_message=NULL,
           completed_at=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND id=$2::uuid
         AND notion_page_id=$3
         AND status='failed'
         AND error_code='CLAIM_LEASE_EXPIRED'
         AND error_message=$5
         AND claim_token IS NULL
         AND claim_attempts=1
         AND claimed_at IS NOT NULL
         AND claim_expires_at=$4::timestamptz
         AND completed_at=$4::timestamptz
         AND staged_at IS NULL
         AND dispatch_authorized_at IS NULL
         AND dispatched_at IS NULL
         AND verified_at IS NULL
         AND reconciled_at IS NULL
         AND note_id IS NULL AND share_url IS NULL
         AND success_attestation_id IS NULL
         AND external_disposition_request_id IS NULL
         AND receipt_contract_version IS NULL
         AND receipt_outcome IS NULL
         AND receipt_acknowledged_at IS NULL
         AND authenticated_account_id IS NULL
         AND authenticated_account_at IS NULL
         AND xsec_accessible_at IS NULL
         AND public_index_status IS NULL
         AND public_index_checked_at IS NULL
         AND provider_restriction_status IS NULL
         AND provider_restriction_reported_at IS NULL
         AND EXISTS (
           SELECT 1 FROM rednote_publish_attempts current_attempt
           WHERE current_attempt.id=$6::uuid
             AND current_attempt.source_local_publish_job_id=local_publish_jobs.id
             AND current_attempt.workspace_id=local_publish_jobs.workspace_id
             AND current_attempt.authorization_kind IS NULL
             AND current_attempt.late_fallback_policy IS NULL
             AND current_attempt.active
             AND current_attempt.approved_at=$7::timestamptz
             AND current_attempt.terminal_outcome IS NULL
             AND current_attempt.terminal_at IS NULL
             AND current_attempt.receipt_lookup_state='pending'
             AND current_attempt.claim_token IS NULL
             AND current_attempt.claim_expires_at IS NULL
             AND current_attempt.dispatch_authorized_at IS NULL
         )
       RETURNING id`,
      [
        input.workspaceId,
        input.jobId,
        input.sourceNotionPageId,
        row.terminal_at,
        CLAIM_LEASE_EXPIRED_MESSAGE,
        input.attemptId,
        row.approved_at,
      ],
    );
    if (!attempt.rows[0] || !job.rows[0]) {
      throw new LocalPublishJobError(
        'The terminal lease-expiry batch claim changed during recovery',
        'TERMINAL_EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
        409,
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id,event_type,occurred_at,actor_type,actor_id,diagnostics
       ) VALUES(
         $1::uuid,'administrative_recovery',CURRENT_TIMESTAMP,'admin',
         'terminal_expired_batch_claim_recovery',
         jsonb_build_object(
           'kind','terminal_expired_batch_claim_authorization_reclassified',
           'priorAuthorizationKind','ready_x3',
           'terminalLeaseExpiredAt',$2::timestamptz
         )
       )`,
      [input.attemptId, row.terminal_at],
    );
    return {
      requeued: true,
      reclassifiedAuthorization: 'batch' as const,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false as const,
    };
  });
}

export async function requeueReadyX3NotLoggedInFailure(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}) {
  return requeueReadyX3PreproviderFailure(input, {
    errorCode: 'NOT_LOGGED_IN',
    actorId: 'ready_x3_not_logged_in_recovery',
    evidenceKind: 'not_logged_in_failure_requeued',
    unsafeMessage: 'The Ready x3 login failure is not safe to recover',
    unsafeCode: 'READY_X3_NOT_LOGGED_IN_RECOVERY_UNSAFE',
  });
}

export async function requeueReadyX3StaleBrowserFrameFailure(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}) {
  return requeueReadyX3PreproviderFailure(input, {
    errorCode: 'INTERNAL_ERROR',
    errorMessageLike:
      'page.goto: Protocol error (Page.navigate): No frame with given id found%',
    actorId: 'ready_x3_stale_browser_frame_recovery',
    evidenceKind: 'stale_browser_frame_failure_requeued',
    unsafeMessage: 'The Ready x3 stale browser frame failure is not safe to recover',
    unsafeCode: 'READY_X3_STALE_BROWSER_FRAME_RECOVERY_UNSAFE',
  });
}

export async function diagnoseReadyX3StaleBrowserFrameRecovery(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}) {
  return requeueReadyX3PreproviderFailure(input, {
    errorCode: 'INTERNAL_ERROR',
    errorMessageLike:
      'page.goto: Protocol error (Page.navigate): No frame with given id found%',
    actorId: 'ready_x3_stale_browser_frame_recovery_diagnostic',
    evidenceKind: 'stale_browser_frame_failure_recovery_diagnostic',
    unsafeMessage: 'The Ready x3 stale browser frame failure is not safe to recover',
    unsafeCode: 'READY_X3_STALE_BROWSER_FRAME_RECOVERY_UNSAFE',
  }, true);
}

export async function requeueReadyX3ScheduleReadbackMismatch(input: {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  sourceNotionPageId: string;
  revision: string;
}) {
  return requeueReadyX3PreproviderFailure(input, {
    errorCode: 'SCHEDULE_READBACK_MISMATCH',
    errorMessageLike:
      'Creator date-picker did not retain the scheduled time (got %',
    actorId: 'ready_x3_schedule_readback_recovery',
    evidenceKind: 'schedule_readback_mismatch_requeued_for_late_fallback',
    unsafeMessage: 'The Ready x3 schedule readback failure is not safe to recover',
    unsafeCode: 'READY_X3_SCHEDULE_READBACK_RECOVERY_UNSAFE',
  });
}

export async function recordLinkedAttemptOutcome(input: {
  workspaceId: string; localJobId: string; claimToken: string;
  outcome: RednoteTerminalAttemptOutcome;
  receipt?: { rednoteUrl?: string; rednoteNoteId: string; platformPublishTime: string; provenance: Record<string, unknown> };
}) {
  const found = await getPool().query<AttemptRow>(
    `SELECT * FROM rednote_publish_attempts WHERE workspace_id=$1
       AND source_local_publish_job_id=$2::uuid AND claim_token=$3::uuid`,
    [input.workspaceId, input.localJobId, input.claimToken],
  );
  if (!found.rows[0]) {
    const current = await getPool().query<AttemptRow>(
      `SELECT attempt.*
       FROM rednote_publish_attempts attempt
       JOIN local_publish_jobs job
         ON job.workspace_id=attempt.workspace_id
        AND job.id=attempt.source_local_publish_job_id
       WHERE attempt.workspace_id=$1
         AND attempt.source_local_publish_job_id=$2::uuid
         AND job.claim_token=$3::uuid
         AND job.claim_expires_at>CURRENT_TIMESTAMP
         AND (
           attempt.terminal_outcome=$4
           OR (
             $4='accepted'
             AND $5::boolean
             AND attempt.terminal_outcome='outcome_unknown'
           )
         )
       ORDER BY attempt.created_at DESC LIMIT 1`,
      [
        input.workspaceId,
        input.localJobId,
        input.claimToken,
        input.outcome,
        Boolean(input.receipt),
      ],
    );
    const attempt = current.rows[0];
    if (!attempt) {
      throw new LocalPublishJobError(
        'Linked attempt result is stale',
        'STALE_ATTEMPT_RESULT',
        409,
      );
    }
    if (
      input.outcome === 'accepted'
      && input.receipt
      && attempt.receipt_lookup_state !== 'found'
    ) {
      return resolveIdentityPendingReceipt({
        workspaceId: input.workspaceId,
        attemptId: attempt.id,
        actorId: attempt.executor_id,
        actorType: 'worker',
        receipt: input.receipt,
      });
    }
    if (input.outcome === 'accepted' && attempt.receipt_lookup_state === 'found') {
      if (!input.receipt) {
        throw new LocalPublishJobError(
          'The linked attempt already has an acknowledged publication receipt',
          'ATTEMPT_RECEIPT_CONFLICT',
          409,
        );
      }
      await assertAttemptReceiptMatches(
        () => getPool().query<AttemptReceiptRow>(
          `SELECT rednote_url, rednote_note_id
           FROM rednote_publish_attempt_receipts
           WHERE attempt_id=$1::uuid`,
          [attempt.id],
        ),
        input.receipt,
      );
    }
    return publicAttempt(attempt);
  }
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
  receipt?: { rednoteUrl?: string; rednoteNoteId: string; platformPublishTime: string; provenance: Record<string, unknown> };
}) {
  if (input.outcome === 'accepted' && input.receipt &&
      !input.receipt.rednoteNoteId) {
    throw new LocalPublishJobError('Receipt Note ID is required', 'INVALID_RECEIPT', 400);
  }
  return transaction(async (client) => {
    const state = input.outcome === 'accepted' || input.outcome === 'outcome_unknown'
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
      if (current.rows[0]?.terminal_outcome === input.outcome) {
        if (current.rows[0].receipt_lookup_state === 'found') {
          if (!input.receipt) {
            throw new LocalPublishJobError(
              'The publishing attempt already has a publication receipt',
              'ATTEMPT_RECEIPT_CONFLICT',
              409,
            );
          }
          await assertAttemptReceiptMatches(
            () => client.query<AttemptReceiptRow>(
              `SELECT rednote_url, rednote_note_id
               FROM rednote_publish_attempt_receipts
               WHERE attempt_id=$1::uuid`,
              [input.attemptId],
            ),
            input.receipt,
          );
        }
        return publicAttempt(current.rows[0]);
      }
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
      await assertAttemptReceiptMatches(
        () => client.query<AttemptReceiptRow>(
          `SELECT rednote_url, rednote_note_id
           FROM rednote_publish_attempt_receipts
           WHERE attempt_id=$1::uuid`,
          [input.attemptId],
        ),
        input.receipt,
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
  actorType?: 'operator' | 'worker';
  receipt?: { rednoteUrl?: string; rednoteNoteId: string; platformPublishTime: string; provenance: Record<string, unknown> };
}) {
  return transaction(async (client) => {
    const state = input.receipt ? 'found' : 'not_found';
    const result = await client.query<AttemptRow>(
      `UPDATE rednote_publish_attempts SET receipt_lookup_state=$3,
       receipt_lookup_updated_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND id=$2::uuid
         AND terminal_outcome IN ('accepted','outcome_unknown')
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
      await assertAttemptReceiptMatches(
        () => client.query<AttemptReceiptRow>(
          `SELECT rednote_url, rednote_note_id
           FROM rednote_publish_attempt_receipts
           WHERE attempt_id=$1::uuid`,
          [input.attemptId],
        ),
        input.receipt,
      );
    }

    await client.query(
      `INSERT INTO rednote_publish_attempt_events(attempt_id,event_type,occurred_at,actor_type,actor_id)
       VALUES($1,'receipt_lookup',CURRENT_TIMESTAMP,$2,$3)`,
      [input.attemptId, input.actorType ?? 'operator', input.actorId],
    );
    return publicAttempt(result.rows[0]);
  });
}

export async function readRednotePublishingOperational(workspaceId: string) {
  const [result, manual, workerHeartbeat] = await Promise.all([
    getPool().query<{
    id: string; notion_page_id: string; snapshot: Record<string, unknown>;
     status: string; updated_at: Date | string; attempt_id: string | null;
    job_created_at: Date | string; attempt_created_at: Date | string | null;
    active: boolean | null; payload_revision: string | null;
    terminal_outcome: string | null; receipt_lookup_state: string | null;
    terminal_at: Date | string | null; rednote_note_id: string | null;
     rednote_url: string | null; captured_at: Date | string | null; event_count: string;
     authorization_kind: string | null; approved_at: Date | string | null;
     claim_expires_at: Date | string | null; dispatch_authorized_at: Date | string | null;
    superseded_by_attempt_id: string | null;
  }>(
    `SELECT job.id,job.notion_page_id,job.snapshot,job.status,job.updated_at,
      job.created_at AS job_created_at,
      attempt.id AS attempt_id,attempt.active,attempt.payload_revision,
      attempt.created_at AS attempt_created_at,
      attempt.terminal_outcome,attempt.receipt_lookup_state,attempt.terminal_at,
       attempt.authorization_kind,attempt.approved_at,attempt.claim_expires_at,
       attempt.dispatch_authorized_at,attempt.superseded_by_attempt_id,
      receipt.rednote_note_id,receipt.rednote_url,receipt.captured_at,
      COALESCE((SELECT count(*) FROM rednote_publish_attempt_events e
        WHERE e.attempt_id=attempt.id),0)::text AS event_count
     FROM local_publish_jobs job
     LEFT JOIN rednote_publish_attempts attempt
       ON attempt.workspace_id=job.workspace_id
      AND attempt.source_local_publish_job_id=job.id
     LEFT JOIN rednote_publish_attempt_receipts receipt ON receipt.attempt_id=attempt.id
     WHERE job.workspace_id=$1
       AND job.id IN (
         SELECT recent.id
         FROM local_publish_jobs recent
         WHERE recent.workspace_id=$1
         ORDER BY recent.created_at DESC
         LIMIT 100
       )
     ORDER BY job.created_at DESC,attempt.active DESC,attempt.created_at DESC`,
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
         row.approved_at !== null && row.terminal_outcome === null &&
         row.dispatch_authorized_at === null &&
         row.superseded_by_attempt_id === null,
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
  const currentByJob = new Map<string, typeof result.rows[number]>();
  for (const row of result.rows) {
    if (!currentByJob.has(row.id)) currentByJob.set(row.id, row);
  }
  const currentRows = Array.from(currentByJob.values());
  const queue = currentRows.filter((row) =>
    !['reconciled', 'succeeded', 'failed'].includes(row.status) &&
    row.receipt_lookup_state !== 'identity_pending').map(item);
  const attempts = result.rows.filter((row) => row.attempt_id).map((row) => ({
    ...item(row),
    id: row.attempt_id!,
    eventCount: Number(row.event_count),
  }));
  const count = (predicate: (row: typeof result.rows[number]) => boolean) =>
    currentRows.filter(predicate).length;
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