import type { QueryResultRow } from 'pg';
import { isDeepStrictEqual } from 'util';
import { sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type {
  ClaimedLocalPublishJob,
  LocalPublishJobStatus,
  LocalPublishJobSummary,
  LocalPublishSnapshot,
} from '@/types/local-publish-job';

interface LocalPublishJobRow extends QueryResultRow {
  id: string;
  notion_page_id: string;
  snapshot: LocalPublishSnapshot & { scheduledDate?: string };
  status: LocalPublishJobStatus;
  idempotency_key: string;
  claim_token: string | null;
  claim_attempts: number;
  claimed_at: Date | string | null;
  claim_expires_at: Date | string | null;
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
  completedAt?: string;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalTimestamp(value: Date | string | null) {
  return value ? timestamp(value) : undefined;
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
    status: row.status,
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
      AND status IN ('queued', 'claimed', 'ambiguous')
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
): Promise<ClaimedLocalPublishJob | null> {
  const result = await sql<LocalPublishJobRow>`
    WITH candidate AS (
      SELECT id
      FROM local_publish_jobs
      WHERE status = 'queued'
        OR (status = 'claimed' AND claim_expires_at <= CURRENT_TIMESTAMP)
      ORDER BY COALESCE(claim_expires_at, created_at), created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE local_publish_jobs AS job
    SET status = 'claimed',
        claim_token = gen_random_uuid(),
        claim_attempts = claim_attempts + 1,
        claimed_at = CURRENT_TIMESTAMP,
        claim_expires_at = CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second'),
        error_code = NULL,
        error_message = NULL,
        updated_at = CURRENT_TIMESTAMP
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.*
  `;
  const row = result.rows[0];
  if (!row?.claim_token || !row.claim_expires_at) return null;
  const job = mapRow(row);
  return {
    id: job.id,
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
      AND status = 'claimed'
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

export async function prepareStoredLocalPublishSuccess(
  id: string,
  claimToken: string,
  noteId: string,
  shareUrl: string,
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'ambiguous',
        note_id = ${noteId},
        share_url = ${shareUrl},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status = 'claimed'
      AND claim_token = ${claimToken}::uuid
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id);
  assertMatchingClaim(job, claimToken);
  if (
    (job.status === 'ambiguous' || job.status === 'succeeded') &&
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

export async function completeStoredLocalPublishSuccess(
  id: string,
  claimToken: string,
  noteId: string,
  shareUrl: string,
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'succeeded',
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status = 'ambiguous'
      AND claim_token = ${claimToken}::uuid
      AND note_id = ${noteId}
      AND share_url = ${shareUrl}
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id);
  assertMatchingClaim(job, claimToken);
  if (job.status === 'succeeded' && job.noteId === noteId && job.shareUrl === shareUrl) {
    return job;
  }
  throw new LocalPublishJobError(
    'The verified result could not be completed',
    'INVALID_JOB_TRANSITION',
    409,
  );
}
