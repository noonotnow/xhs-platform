import type { QueryResultRow } from 'pg';
import { isDeepStrictEqual } from 'util';
import { sql } from '@/lib/db';
import {
  LocalPublishJobError,
  normalizeLocalPublishTags,
} from '@/lib/local-publish-job-input';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';
import type {
  ClaimedLocalPublishJob,
  LocalPublishJobStatus,
  LocalPublishJobSummary,
  LocalPublishSnapshot,
  BatchAuthorization,
  LocalPublishWorkLane,
} from '@/types/local-publish-job';

interface LocalPublishJobRow extends QueryResultRow {
  id: string;
  notion_page_id: string;
  snapshot: LocalPublishSnapshot & { scheduledDate?: string };
  status: LocalPublishJobStatus | 'ambiguous' | 'succeeded';
  idempotency_key: string;
  claim_token: string | null;
  claim_attempts: number;
  claimed_at: Date | string | null;
  claim_expires_at: Date | string | null;
  verification_attempts?: number;
  next_verification_at?: Date | string | null;
  staged_at?: Date | string | null;
  dispatched_at?: Date | string | null;
  verified_at?: Date | string | null;
  reconciled_at?: Date | string | null;
  error_code: string | null;
  error_message: string | null;
  note_id: string | null;
  share_url: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  batch_item_id?: string | null;
  dispatch_authorized_at?: Date | string | null;
}

export interface StoredLocalPublishJob {
  id: string;
  notionPageId: string;
  snapshot: LocalPublishSnapshot;
  status: LocalPublishJobStatus;
  claimToken?: string;
  errorCode?: string;
  errorMessage?: string;
  noteId?: string;
  shareUrl?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  verificationAttempts: number;
  nextVerificationAt?: string;
  stagedAt?: string;
  dispatchedAt?: string;
  verifiedAt?: string;
  reconciledAt?: string;
  completedAt?: string;
  batchAuthorization?: BatchAuthorization;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalTimestamp(value: Date | string | null) {
  return value ? timestamp(value) : undefined;
}

function canonicalStatus(status: LocalPublishJobRow['status']): LocalPublishJobStatus {
  if (status === 'ambiguous') return 'verified';
  if (status === 'succeeded') return 'reconciled';
  return status;
}

export function normalizeStoredLocalPublishSnapshot(
  snapshot: LocalPublishSnapshot & { scheduledDate?: string },
): LocalPublishSnapshot {
  const { scheduledDate, ...current } = snapshot;
  if (current.publishAt || !scheduledDate) return current;
  const legacyPublishAt = new Date(scheduledDate);
  if (Number.isNaN(legacyPublishAt.getTime())) {
    throw new LocalPublishJobError(
      'A stored local publish job has an invalid legacy schedule',
      'INVALID_LEGACY_PUBLISH_SCHEDULE',
      500,
    );
  }
  return { ...current, publishAt: legacyPublishAt.toISOString() };
}

function mapRow(row: LocalPublishJobRow): StoredLocalPublishJob {
  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    snapshot: normalizeStoredLocalPublishSnapshot(row.snapshot),
    status: canonicalStatus(row.status),
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    ...(row.note_id ? { noteId: row.note_id } : {}),
    ...(row.share_url ? { shareUrl: row.share_url } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(optionalTimestamp(row.claimed_at) ? { claimedAt: optionalTimestamp(row.claimed_at) } : {}),
    ...(optionalTimestamp(row.claim_expires_at)
      ? { claimExpiresAt: optionalTimestamp(row.claim_expires_at) }
      : {}),
    verificationAttempts: row.verification_attempts ?? 0,
    ...(optionalTimestamp(row.next_verification_at ?? null)
      ? { nextVerificationAt: optionalTimestamp(row.next_verification_at ?? null) }
      : {}),
    ...(optionalTimestamp(row.staged_at ?? null)
      ? { stagedAt: optionalTimestamp(row.staged_at ?? null) }
      : {}),
    ...(optionalTimestamp(row.dispatched_at ?? null)
      ? { dispatchedAt: optionalTimestamp(row.dispatched_at ?? null) }
      : {}),
    ...(optionalTimestamp(row.verified_at ?? null)
      ? { verifiedAt: optionalTimestamp(row.verified_at ?? null) }
      : {}),
    ...(optionalTimestamp(row.reconciled_at ?? null)
      ? { reconciledAt: optionalTimestamp(row.reconciled_at ?? null) }
      : {}),
    ...(optionalTimestamp(row.completed_at)
      ? { completedAt: optionalTimestamp(row.completed_at) }
      : {}),
  };
}

export function jobSummary(job: StoredLocalPublishJob): LocalPublishJobSummary {
  return {
    id: job.id,
    notionPageId: job.notionPageId,
    status: job.status,
    ...(job.snapshot.compatibilityTrial
      ? { compatibilityTrial: job.snapshot.compatibilityTrial }
      : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    ...(job.noteId ? { noteId: job.noteId } : {}),
    ...(job.shareUrl ? { shareUrl: job.shareUrl } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.claimedAt ? { claimedAt: job.claimedAt } : {}),
    ...(job.claimExpiresAt ? { claimExpiresAt: job.claimExpiresAt } : {}),
    verificationAttempts: job.verificationAttempts,
    ...(job.nextVerificationAt ? { nextVerificationAt: job.nextVerificationAt } : {}),
    ...(job.stagedAt ? { stagedAt: job.stagedAt } : {}),
    ...(job.dispatchedAt ? { dispatchedAt: job.dispatchedAt } : {}),
    ...(job.verifiedAt ? { verifiedAt: job.verifiedAt } : {}),
    ...(job.reconciledAt ? { reconciledAt: job.reconciledAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
  };
}

function sameSnapshot(left: LocalPublishSnapshot, right: LocalPublishSnapshot) {
  return isDeepStrictEqual(left, right);
}

export async function insertLocalPublishJob(
  snapshot: LocalPublishSnapshot,
  idempotencyKey: string,
) {
  const inserted = await sql<LocalPublishJobRow>`
    WITH page_lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${snapshot.notionPageId}, 0))
    )
    INSERT INTO local_publish_jobs (
      notion_page_id,
      snapshot,
      idempotency_key
    )
    SELECT
      ${snapshot.notionPageId},
      ${JSON.stringify(snapshot)}::jsonb,
      ${idempotencyKey}::uuid
    FROM page_lock
    WHERE NOT EXISTS (
      SELECT 1
      FROM manual_reconciliation_requests
      WHERE notion_page_id = ${snapshot.notionPageId}
        AND status IN ('queued', 'verifying')
    )
      AND NOT EXISTS (
        SELECT 1
        FROM local_publish_jobs existing
        WHERE existing.notion_page_id = ${snapshot.notionPageId}
          AND (
            existing.status NOT IN ('reconciled', 'succeeded', 'failed')
            OR existing.dispatch_authorized_at IS NOT NULL
            OR existing.dispatched_at IS NOT NULL
            OR existing.note_id IS NOT NULL
            OR existing.share_url IS NOT NULL
          )
      )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  if (inserted.rows[0]) {
    return { job: mapRow(inserted.rows[0]), created: true };
  }

  const existingKey = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE idempotency_key = ${idempotencyKey}::uuid
    LIMIT 1
  `;
  if (existingKey.rows[0]) {
    const job = mapRow(existingKey.rows[0]);
    if (!sameSnapshot(job.snapshot, snapshot)) {
      throw new LocalPublishJobError(
        'Idempotency-Key was already used for a different request',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return { job, created: false };
  }

  const active = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE notion_page_id = ${snapshot.notionPageId}
      AND (
        status NOT IN ('reconciled', 'succeeded', 'failed')
        OR dispatch_authorized_at IS NOT NULL
        OR dispatched_at IS NOT NULL
        OR note_id IS NOT NULL
        OR share_url IS NOT NULL
      )
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (active.rows[0]) {
    throw new LocalPublishJobError(
      'This Notion post already has an active local publish job',
      'ACTIVE_JOB_EXISTS',
      409,
    );
  }
  const activeReconciliation = await sql`
    SELECT id
    FROM manual_reconciliation_requests
    WHERE notion_page_id = ${snapshot.notionPageId}
      AND status IN ('queued', 'verifying')
    LIMIT 1
  `;
  if (activeReconciliation.rows[0]) {
    throw new LocalPublishJobError(
      'This Notion post already has an active manual reconciliation',
      'ACTIVE_RECONCILIATION_EXISTS',
      409,
    );
  }
  throw new LocalPublishJobError(
    'The local publish job could not be created',
    'QUEUE_WRITE_FAILED',
    503,
  );
}

export async function findLocalPublishJobByIdempotencyKey(idempotencyKey: string) {
  const result = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE idempotency_key = ${idempotencyKey}::uuid
    LIMIT 1
  `;
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listLocalPublishJobs() {
  const result = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return result.rows.map(mapRow);
}

export async function listPublishOwningLocalJobs(notionPageIds: string[]) {
  if (notionPageIds.length === 0) return [];
  const result = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE notion_page_id = ANY(${notionPageIds}::text[])
    ORDER BY created_at DESC
  `;
  return result.rows
    .filter((row) =>
      canonicalStatus(row.status) !== 'failed' ||
      Boolean(
        row.dispatch_authorized_at ||
        row.dispatched_at ||
        row.note_id ||
        row.share_url,
      ))
    .map(mapRow);
}

export async function claimNextStoredLocalPublishJob(
  leaseSeconds: number,
  lane: LocalPublishWorkLane = 'all',
): Promise<ClaimedLocalPublishJob | null> {
  const result = await sql<LocalPublishJobRow>`
    WITH candidate AS (
      SELECT id, status
      FROM local_publish_jobs
      WHERE (
        ${lane} IN ('all', 'dispatch')
        AND (
          status = 'queued'
          OR (status = 'claimed' AND claim_expires_at <= CURRENT_TIMESTAMP)
          OR (
            status = 'staged'
            AND dispatch_authorized_at IS NULL
            AND claim_expires_at <= CURRENT_TIMESTAMP
          )
        )
      )
        OR (
          ${lane} IN ('all', 'verification')
          AND (
            (
              status IN ('submitted', 'scheduled', 'verification_pending')
              AND next_verification_at <= CURRENT_TIMESTAMP
              AND (
                claim_expires_at IS NULL
                OR claim_expires_at <= CURRENT_TIMESTAMP
              )
            )
            OR (
              status = 'verified'
              AND (
                claim_expires_at IS NULL
                OR claim_expires_at <= CURRENT_TIMESTAMP
              )
            )
          )
        )
      ORDER BY COALESCE(next_verification_at, claim_expires_at, created_at), created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE local_publish_jobs AS job
    SET status = CASE
          WHEN candidate.status IN ('queued', 'claimed') THEN 'claimed'
          ELSE candidate.status
        END,
        claim_token = gen_random_uuid(),
        claim_attempts = claim_attempts + 1,
        claimed_at = CURRENT_TIMESTAMP,
        claim_expires_at = CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second'),
        error_code = CASE
          WHEN candidate.status IN ('queued', 'claimed', 'staged') THEN NULL
          ELSE job.error_code
        END,
        error_message = CASE
          WHEN candidate.status IN ('queued', 'claimed', 'staged') THEN NULL
          ELSE job.error_message
        END,
        updated_at = CURRENT_TIMESTAMP
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.*
  `;
  const row = result.rows[0];
  if (!row?.claim_token || !row.claim_expires_at) return null;
  return claimedResponse(row);
}

async function claimedResponse(row: LocalPublishJobRow): Promise<ClaimedLocalPublishJob> {
  if (!row.claim_token || !row.claim_expires_at) {
    throw new LocalPublishJobError(
      'The local publish job does not have a current claim',
      'STALE_CLAIM',
      409,
    );
  }
  const job = mapRow(row);
  if (row.batch_item_id) {
    const authorization = await sql<{
      batch_id: string;
      batch_item_id: string;
      manifest_hash: string;
      item_hash: string;
      approved_at: Date | string;
      dispatch_mode: 'scheduled' | 'post_now';
    }>`
      SELECT
        batch.id AS batch_id,
        item.id AS batch_item_id,
        batch.manifest_hash,
        item.item_hash,
        batch.approved_at,
        item.dispatch_mode
      FROM rednote_publish_batch_items AS item
      JOIN rednote_publish_batches AS batch ON batch.id = item.batch_id
      WHERE item.id = ${row.batch_item_id}::uuid
        AND item.state IN (
          'queued', 'claimed', 'staged', 'submitted', 'scheduled',
          'verification_pending', 'verified'
        )
        AND batch.approved_at IS NOT NULL
      LIMIT 1
    `;
    const approved = authorization.rows[0];
    if (!approved) {
      throw new LocalPublishJobError(
        'The bounded batch authorization is missing or invalid',
        'INVALID_BATCH_AUTHORIZATION',
        409,
      );
    }
    if (!job.snapshot.publishAt) {
      throw new LocalPublishJobError(
        'A bounded batch job is missing its frozen publish time',
        'INVALID_BATCH_AUTHORIZATION',
        409,
      );
    }
    job.batchAuthorization = {
      batchId: approved.batch_id,
      manifestHash: approved.manifest_hash,
      itemHash: approved.item_hash,
      snapshotRevision: job.snapshot.notionLastEditedTime,
      approvedState: 'approved',
      approvedAt: timestamp(approved.approved_at),
      media: {
        url: job.snapshot.mediaUrl,
        type: job.snapshot.mediaType,
        identity: rednoteMediaIdentity({
          type: job.snapshot.mediaType,
          url: job.snapshot.mediaUrl,
        }),
      },
      publishAt: job.snapshot.publishAt,
      lateAction: approved.dispatch_mode === 'post_now' ? 'post_now' : 'schedule',
    };
  }
  const base = {
    id: job.id,
    status: job.status,
    notionPageId: job.snapshot.notionPageId,
    headline: job.snapshot.headline,
    title: job.snapshot.title,
    caption: job.snapshot.caption,
    tags: row.batch_item_id
      ? job.snapshot.tags
      : normalizeLocalPublishTags(job.snapshot.tags),
    platform: job.snapshot.platform,
    mediaType: job.snapshot.mediaType,
    mediaUrl: job.snapshot.mediaUrl,
    ...(job.snapshot.compatibilityTrial
      ? { compatibilityTrial: job.snapshot.compatibilityTrial }
      : {}),
    ...(job.snapshot.thumbnailUrl ? { thumbnailUrl: job.snapshot.thumbnailUrl } : {}),
    ...(job.snapshot.publishAt ? { publishAt: job.snapshot.publishAt } : {}),
    claimToken: row.claim_token,
    claimExpiresAt: timestamp(row.claim_expires_at),
    ...(job.batchAuthorization ? { batchAuthorization: job.batchAuthorization } : {}),
  };
  if (
    job.status === 'submitted' ||
    job.status === 'scheduled' ||
    job.status === 'verification_pending'
  ) {
    if (!job.noteId || !job.shareUrl || !job.nextVerificationAt) {
      throw new LocalPublishJobError(
        'A verification job is missing durable publication identifiers',
        'INVALID_VERIFICATION_JOB',
        500,
      );
    }
    return {
      ...base,
      status: job.status,
      noteId: job.noteId,
      shareUrl: job.shareUrl,
      verificationAttempts: job.verificationAttempts,
      nextVerificationAt: job.nextVerificationAt,
    };
  }
  if (job.status === 'verified') {
    if (!job.noteId || !job.shareUrl) {
      throw new LocalPublishJobError(
        'A reconciliation job is missing durable publication identifiers',
        'INVALID_RECONCILIATION_JOB',
        500,
      );
    }
    return {
      ...base,
      status: job.status,
      noteId: job.noteId,
      shareUrl: job.shareUrl,
      verificationAttempts: job.verificationAttempts,
    };
  }
  return { ...base, status: job.status as 'claimed' | 'staged' };
}

export async function authorizeStoredLocalPublishJob(id: string, claimToken: string) {
  const result = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE id = ${id}::uuid
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND status IN (
        'claimed', 'staged', 'submitted', 'scheduled',
        'verification_pending', 'verified'
      )
    LIMIT 1
  `;
  if (result.rows[0]) return claimedResponse(result.rows[0]);
  await loadResultJob(id);
  throw new LocalPublishJobError(
    'The local publish claim is stale, expired, or revoked',
    'STALE_CLAIM',
    409,
  );
}

export async function consumeStoredDispatchAuthorization(id: string, claimToken: string) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET dispatch_authorized_at = COALESCE(dispatch_authorized_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND claim_token = ${claimToken}::uuid
      AND status = 'staged'
      AND claim_expires_at > CURRENT_TIMESTAMP
    RETURNING *
  `;
  if (result.rows[0]) return claimedResponse(result.rows[0]);
  await loadResultJob(id);
  throw new LocalPublishJobError(
    'The staged dispatch authorization is stale, expired, or revoked',
    'STALE_CLAIM',
    409,
  );
}

async function loadResultJob(id: string) {
  const result = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  const row = result.rows[0];
  if (!row) {
    throw new LocalPublishJobError('Local publish job was not found', 'JOB_NOT_FOUND', 404);
  }
  return mapRow(row);
}

function assertMatchingClaim(job: StoredLocalPublishJob, claimToken: string) {
  if (job.claimToken !== claimToken) {
    throw new LocalPublishJobError(
      'The local publish claim is no longer current',
      'STALE_CLAIM',
      409,
    );
  }
}

export async function stageStoredLocalPublishJob(id: string, claimToken: string) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'staged',
        staged_at = COALESCE(staged_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status = 'claimed'
      AND claim_token = ${claimToken}::uuid
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id);
  assertMatchingClaim(job, claimToken);
  if (job.status === 'staged') return job;
  throw new LocalPublishJobError(
    'The job cannot transition to staged from its current state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function recordStoredLocalPublishDispatch(
  id: string,
  claimToken: string,
  status: 'submitted' | 'scheduled',
  noteId: string,
  shareUrl: string,
  initialVerificationDelaySeconds: number,
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = ${status},
        note_id = ${noteId},
        share_url = ${shareUrl},
        dispatched_at = COALESCE(dispatched_at, CURRENT_TIMESTAMP),
        verification_attempts = 0,
        next_verification_at = GREATEST(
          CURRENT_TIMESTAMP,
          CASE
            WHEN ${status} = 'scheduled'
              AND COALESCE(
                snapshot->>'publishAt',
                snapshot->>'scheduledDate'
              ) IS NOT NULL
              THEN COALESCE(
                snapshot->>'publishAt',
                snapshot->>'scheduledDate'
              )::timestamptz
            ELSE CURRENT_TIMESTAMP
          END
        ) + (${initialVerificationDelaySeconds} * INTERVAL '1 second'),
        claim_expires_at = CURRENT_TIMESTAMP,
        error_code = NULL,
        error_message = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status IN ('claimed', 'staged')
      AND claim_token = ${claimToken}::uuid
      AND (
        (
          ${status} = 'scheduled'
          AND COALESCE(snapshot->>'publishAt', snapshot->>'scheduledDate') IS NOT NULL
        )
        OR (
          ${status} = 'submitted'
          AND COALESCE(snapshot->>'publishAt', snapshot->>'scheduledDate') IS NULL
        )
      )
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id);
  assertMatchingClaim(job, claimToken);
  if (
    ['submitted', 'scheduled', 'verification_pending', 'verified', 'reconciled']
      .includes(job.status) &&
    job.noteId === noteId &&
    job.shareUrl === shareUrl
  ) {
    return job;
  }
  throw new LocalPublishJobError(
    'The job cannot record this dispatch from its current state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function deferStoredLocalPublishVerification(
  id: string,
  claimToken: string,
  noteId: string,
  shareUrl: string,
  code: string,
  message: string,
  backoffSeconds: readonly [number, number, number, number],
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'verification_pending',
        verification_attempts = verification_attempts + 1,
        next_verification_at = CURRENT_TIMESTAMP + (
          CASE LEAST(verification_attempts, 3)
            WHEN 0 THEN ${backoffSeconds[1]}
            WHEN 1 THEN ${backoffSeconds[2]}
            ELSE ${backoffSeconds[3]}
          END * INTERVAL '1 second'
        ),
        error_code = ${code},
        error_message = ${message},
        claim_expires_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND claim_token = ${claimToken}::uuid
      AND note_id = ${noteId}
      AND share_url = ${shareUrl}
      AND (
        status IN ('submitted', 'scheduled')
        OR (
          status = 'verification_pending'
          AND next_verification_at <= claimed_at
        )
      )
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id);
  assertMatchingClaim(job, claimToken);
  if (
    job.status === 'verification_pending' &&
    job.noteId === noteId &&
    job.shareUrl === shareUrl &&
    job.errorCode === code &&
    job.errorMessage === message
  ) {
    return job;
  }
  throw new LocalPublishJobError(
    'The job cannot defer verification from its current state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function failStoredLocalPublishJob(
  id: string,
  claimToken: string,
  code: string,
  message: string,
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'failed',
        error_code = ${code},
        error_message = ${message},
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status IN ('claimed', 'staged')
      AND claim_token = ${claimToken}::uuid
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id);
  assertMatchingClaim(job, claimToken);
  if (job.status === 'failed' && job.errorCode === code && job.errorMessage === message) {
    return job;
  }
  throw new LocalPublishJobError(
    'The job cannot transition to failed from its current state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function prepareStoredLocalPublishVerification(
  id: string,
  claimToken: string,
  noteId: string,
  shareUrl: string,
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'verified',
        note_id = COALESCE(note_id, ${noteId}),
        share_url = COALESCE(share_url, ${shareUrl}),
        verified_at = COALESCE(verified_at, CURRENT_TIMESTAMP),
        next_verification_at = NULL,
        error_code = NULL,
        error_message = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status IN (
        'claimed',
        'staged',
        'submitted',
        'scheduled',
        'verification_pending'
      )
      AND claim_token = ${claimToken}::uuid
      AND (
        (
          status IN ('claimed', 'staged')
          AND (note_id IS NULL OR note_id = ${noteId})
          AND (share_url IS NULL OR share_url = ${shareUrl})
        )
        OR (
          status IN ('submitted', 'scheduled', 'verification_pending')
          AND note_id = ${noteId}
          AND share_url = ${shareUrl}
        )
      )
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id);
  assertMatchingClaim(job, claimToken);
  if (
    (job.status === 'verified' || job.status === 'reconciled') &&
    job.noteId === noteId &&
    job.shareUrl === shareUrl
  ) {
    return job;
  }
  throw new LocalPublishJobError(
    'The job cannot accept this success result from its current state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function completeStoredLocalPublishReconciliation(
  id: string,
  claimToken: string,
  noteId: string,
  shareUrl: string,
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'reconciled',
        reconciled_at = COALESCE(reconciled_at, CURRENT_TIMESTAMP),
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status = 'verified'
      AND claim_token = ${claimToken}::uuid
      AND note_id = ${noteId}
      AND share_url = ${shareUrl}
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id);
  assertMatchingClaim(job, claimToken);
  if (job.status === 'reconciled' && job.noteId === noteId && job.shareUrl === shareUrl) {
    return job;
  }
  throw new LocalPublishJobError(
    'The verified result could not be completed',
    'INVALID_JOB_TRANSITION',
    409,
  );
}
