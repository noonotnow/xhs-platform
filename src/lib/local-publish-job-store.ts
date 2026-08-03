import type { QueryResultRow } from 'pg';
import { isDeepStrictEqual } from 'util';
import { sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type {
  ClaimedLocalPublishJob,
  LocalPublishJobStatus,
  LocalPublishJobSummary,
  LocalPublishSnapshot,
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
    INSERT INTO local_publish_jobs (
      notion_page_id,
      snapshot,
      idempotency_key
    )
    VALUES (
      ${snapshot.notionPageId},
      ${JSON.stringify(snapshot)}::jsonb,
      ${idempotencyKey}::uuid
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
      AND status NOT IN ('reconciled', 'succeeded', 'failed')
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
          OR (status = 'staged' AND claim_expires_at <= CURRENT_TIMESTAMP)
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
  const job = mapRow(row);
  const base = {
    id: job.id,
    status: job.status,
    notionPageId: job.snapshot.notionPageId,
    headline: job.snapshot.headline,
    title: job.snapshot.title,
    caption: job.snapshot.caption,
    tags: job.snapshot.tags,
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
            WHEN 0 THEN ${backoffSeconds[0]}
            WHEN 1 THEN ${backoffSeconds[1]}
            WHEN 2 THEN ${backoffSeconds[2]}
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
