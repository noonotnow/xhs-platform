import { isDeepStrictEqual } from 'util';
import type { QueryResultRow } from 'pg';
import { sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type {
  ClaimedManualReconciliation,
  ExternalPostSnapshot,
  ManualReconciliationKind,
  ManualReconciliationExpectedSnapshot,
  ManualReconciliationStatus,
  ManualReconciliationSummary,
} from '@/types/local-publish-job';

interface ManualReconciliationRow extends QueryResultRow {
  id: string;
  notion_page_id: string;
  source_local_job_id: string | null;
  requested_note_id: string;
  requested_share_url: string;
  expected_snapshot: ManualReconciliationExpectedSnapshot;
  request_kind?: ManualReconciliationKind;
  status: ManualReconciliationStatus;
  idempotency_key: string;
  claim_token: string | null;
  claim_attempts: number;
  claimed_at: Date | string | null;
  claim_expires_at: Date | string | null;
  verification_attempts: number;
  next_attempt_at: Date | string | null;
  external_reconciliation_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

export interface StoredManualReconciliation {
  id: string;
  notionPageId: string;
  sourceLocalJobId?: string;
  noteId: string;
  shareUrl: string;
  expected: ManualReconciliationExpectedSnapshot;
  kind: ManualReconciliationKind;
  status: ManualReconciliationStatus;
  idempotencyKey: string;
  claimToken?: string;
  claimAttempts: number;
  claimedAt?: string;
  claimExpiresAt?: string;
  verificationAttempts: number;
  nextAttemptAt?: string;
  externalReconciliationId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalTimestamp(value: Date | string | null) {
  return value ? timestamp(value) : undefined;
}

function mapRow(row: ManualReconciliationRow): StoredManualReconciliation {
  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    ...(row.source_local_job_id ? { sourceLocalJobId: row.source_local_job_id } : {}),
    noteId: row.requested_note_id,
    shareUrl: row.requested_share_url,
    expected: row.expected_snapshot,
    kind: row.request_kind ?? 'notion_only',
    status: row.status,
    idempotencyKey: row.idempotency_key,
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    claimAttempts: row.claim_attempts,
    ...(optionalTimestamp(row.claimed_at) ? { claimedAt: optionalTimestamp(row.claimed_at) } : {}),
    ...(optionalTimestamp(row.claim_expires_at)
      ? { claimExpiresAt: optionalTimestamp(row.claim_expires_at) }
      : {}),
    verificationAttempts: row.verification_attempts,
    ...(optionalTimestamp(row.next_attempt_at)
      ? { nextAttemptAt: optionalTimestamp(row.next_attempt_at) }
      : {}),
    ...(row.external_reconciliation_id
      ? { externalReconciliationId: row.external_reconciliation_id }
      : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(optionalTimestamp(row.completed_at)
      ? { completedAt: optionalTimestamp(row.completed_at) }
      : {}),
  };
}

export function manualReconciliationSummary(
  record: StoredManualReconciliation,
): ManualReconciliationSummary {
  return {
    id: record.id,
    notionPageId: record.notionPageId,
    kind: record.kind,
    ...(record.sourceLocalJobId ? { sourceLocalJobId: record.sourceLocalJobId } : {}),
    noteId: record.noteId,
    shareUrl: record.shareUrl,
    status: record.status,
    verificationAttempts: record.verificationAttempts,
    ...(record.nextAttemptAt ? { nextAttemptAt: record.nextAttemptAt } : {}),
    ...(record.externalReconciliationId
      ? { externalReconciliationId: record.externalReconciliationId }
      : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  };
}

export async function findManualReconciliationByIdempotencyKey(
  idempotencyKey: string,
) {
  const result = await sql<ManualReconciliationRow>`
    SELECT *
    FROM manual_reconciliation_requests
    WHERE idempotency_key = ${idempotencyKey}::uuid
    LIMIT 1
  `;
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function loadManualReconciliation(id: string) {
  const result = await sql<ManualReconciliationRow>`
    SELECT *
    FROM manual_reconciliation_requests
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  if (!result.rows[0]) {
    throw new LocalPublishJobError(
      'Manual reconciliation request was not found',
      'RECONCILIATION_NOT_FOUND',
      404,
    );
  }
  return mapRow(result.rows[0]);
}

export async function insertManualReconciliation(input: {
  notionPageId: string;
  noteId: string;
  shareUrl: string;
  expected: ManualReconciliationExpectedSnapshot;
  idempotencyKey: string;
}) {
  const inserted = await sql<ManualReconciliationRow>`
    WITH page_lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.notionPageId}, 0))
    ),
    source_job AS (
      SELECT id
      FROM local_publish_jobs
      WHERE notion_page_id = ${input.notionPageId}
        AND status = 'failed'
      ORDER BY created_at DESC
      LIMIT 1
    )
    INSERT INTO manual_reconciliation_requests (
      notion_page_id,
      source_local_job_id,
      requested_note_id,
      requested_share_url,
      expected_snapshot,
      idempotency_key
    )
    SELECT
      ${input.notionPageId},
      source_job.id,
      ${input.noteId},
      ${input.shareUrl},
      ${JSON.stringify(input.expected)}::jsonb,
      ${input.idempotencyKey}::uuid
    FROM page_lock
    LEFT JOIN source_job ON TRUE
    WHERE NOT EXISTS (
      SELECT 1
      FROM local_publish_jobs
      WHERE notion_page_id = ${input.notionPageId}
        AND status NOT IN ('reconciled', 'succeeded', 'failed')
    )
      AND NOT EXISTS (
        SELECT 1
        FROM manual_reconciliation_requests
        WHERE notion_page_id = ${input.notionPageId}
          AND status IN ('queued', 'verifying')
      )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  if (inserted.rows[0]) {
    return { request: mapRow(inserted.rows[0]), created: true };
  }

  const existingKey = await findManualReconciliationByIdempotencyKey(
    input.idempotencyKey,
  );
  if (existingKey) {
    const matches =
      existingKey.notionPageId === input.notionPageId &&
      existingKey.noteId === input.noteId &&
      existingKey.shareUrl === input.shareUrl &&
      isDeepStrictEqual(existingKey.expected, input.expected);
    if (!matches) {
      throw new LocalPublishJobError(
        'Idempotency-Key was already used for a different reconciliation request',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return { request: existingKey, created: false };
  }

  const conflict = await sql<{ kind: 'local' | 'manual' | 'same' }>`
    SELECT 'local'::text AS kind
    FROM local_publish_jobs
    WHERE notion_page_id = ${input.notionPageId}
      AND status NOT IN ('reconciled', 'succeeded', 'failed')
    UNION ALL
    SELECT
      CASE
        WHEN requested_note_id = ${input.noteId} THEN 'same'::text
        ELSE 'manual'::text
      END AS kind
    FROM manual_reconciliation_requests
    WHERE notion_page_id = ${input.notionPageId}
      AND (
        status IN ('queued', 'verifying')
        OR requested_note_id = ${input.noteId}
      )
    ORDER BY kind
    LIMIT 1
  `;
  const kind = conflict.rows[0]?.kind;
  if (kind === 'local') {
    throw new LocalPublishJobError(
      'This post has an active local publish job',
      'ACTIVE_JOB_EXISTS',
      409,
    );
  }
  if (kind === 'same') {
    throw new LocalPublishJobError(
      'This exact manual reconciliation already exists; retry its existing request',
      'RECONCILIATION_EXISTS',
      409,
    );
  }
  if (kind === 'manual') {
    throw new LocalPublishJobError(
      'This post already has an active manual reconciliation',
      'ACTIVE_RECONCILIATION_EXISTS',
      409,
    );
  }
  throw new LocalPublishJobError(
    'The manual reconciliation request could not be created',
    'QUEUE_WRITE_FAILED',
    503,
  );
}

export async function listManualReconciliations() {
  const result = await sql<ManualReconciliationRow>`
    SELECT *
    FROM manual_reconciliation_requests
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return result.rows.map(mapRow);
}

export async function claimDueManualReconciliations(
  limit: number,
  leaseSeconds: number,
): Promise<ClaimedManualReconciliation[]> {
  const result = await sql<ManualReconciliationRow>`
    WITH exhausted AS (
      UPDATE manual_reconciliation_requests
      SET status = 'failed',
          error_code = 'RECONCILIATION_WORKER_UNAVAILABLE',
          error_message = 'Verification was repeatedly claimed but not completed',
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'verifying'
        AND claim_expires_at <= CURRENT_TIMESTAMP
        AND claim_attempts >= 12
      RETURNING id
    ),
    candidates AS (
      SELECT id
      FROM manual_reconciliation_requests
      WHERE (
        status = 'queued'
        AND next_attempt_at <= CURRENT_TIMESTAMP
      )
        OR (
          status = 'verifying'
          AND claim_expires_at <= CURRENT_TIMESTAMP
        )
        AND id NOT IN (SELECT id FROM exhausted)
      ORDER BY next_attempt_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE manual_reconciliation_requests AS request
    SET status = 'verifying',
        claim_token = gen_random_uuid(),
        claim_attempts = claim_attempts + 1,
        claimed_at = CURRENT_TIMESTAMP,
        claim_expires_at = CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second'),
        updated_at = CURRENT_TIMESTAMP
    FROM candidates
    WHERE request.id = candidates.id
    RETURNING request.*
  `;
  return result.rows.map((row) => {
    const request = mapRow(row);
    if (!request.claimToken || !request.claimExpiresAt) {
      throw new LocalPublishJobError(
        'A manual reconciliation claim is missing its lease',
        'INVALID_RECONCILIATION_CLAIM',
        500,
      );
    }
    return {
      id: request.id,
      notionPageId: request.notionPageId,
      kind: request.kind,
      ...(request.kind === 'targeted_local_job' && request.sourceLocalJobId
        ? { sourceLocalJobId: request.sourceLocalJobId }
        : {}),
      noteId: request.noteId,
      shareUrl: request.shareUrl,
      expected: request.expected,
      verificationAttempts: request.verificationAttempts,
      claimToken: request.claimToken,
      claimExpiresAt: request.claimExpiresAt,
    };
  });
}

function assertCurrentClaim(
  request: StoredManualReconciliation,
  claimToken: string,
) {
  if (
    request.claimToken !== claimToken ||
    !request.claimExpiresAt ||
    new Date(request.claimExpiresAt).getTime() <= Date.now()
  ) {
    throw new LocalPublishJobError(
      'The manual reconciliation claim is stale, expired, or revoked',
      'STALE_CLAIM',
      409,
    );
  }
}

export async function assertManualVerifiedSnapshot(
  id: string,
  claimToken: string,
  snapshot: ExternalPostSnapshot,
) {
  const request = await loadManualReconciliation(id);
  if (request.status === 'reconciled') return request;
  assertCurrentClaim(request, claimToken);
  if (request.status !== 'verifying') {
    throw new LocalPublishJobError(
      'The manual reconciliation is not currently claimed',
      'INVALID_RECONCILIATION_TRANSITION',
      409,
    );
  }
  const expectedSnapshot: ExternalPostSnapshot = {
    noteId: request.noteId,
    shareUrl: request.shareUrl,
    ...request.expected,
  };
  if (!isDeepStrictEqual(snapshot, expectedSnapshot)) {
    throw new LocalPublishJobError(
      'The verified RedNote snapshot does not match the durable reconciliation request',
      'VERIFIED_POST_MISMATCH',
      409,
    );
  }
  return request;
}

export async function deferManualReconciliation(
  id: string,
  claimToken: string,
  code: string,
  message: string,
  backoffSeconds: readonly [number, number, number, number],
) {
  const result = await sql<ManualReconciliationRow>`
    UPDATE manual_reconciliation_requests
    SET status = CASE
          WHEN verification_attempts + 1 >= 4 THEN 'failed'
          ELSE 'queued'
        END,
        verification_attempts = verification_attempts + 1,
        next_attempt_at = CASE
          WHEN verification_attempts + 1 >= 4 THEN next_attempt_at
          ELSE CURRENT_TIMESTAMP + (
            CASE LEAST(verification_attempts, 3)
              WHEN 0 THEN ${backoffSeconds[0]}
              WHEN 1 THEN ${backoffSeconds[1]}
              WHEN 2 THEN ${backoffSeconds[2]}
              ELSE ${backoffSeconds[3]}
            END * INTERVAL '1 second'
          )
        END,
        error_code = ${code},
        error_message = ${message},
        claim_expires_at = CURRENT_TIMESTAMP,
        completed_at = CASE
          WHEN verification_attempts + 1 >= 4 THEN CURRENT_TIMESTAMP
          ELSE NULL
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status = 'verifying'
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);
  const request = await loadManualReconciliation(id);
  if (
    request.claimToken === claimToken &&
    request.errorCode === code &&
    request.errorMessage === message &&
    (request.status === 'queued' || request.status === 'failed')
  ) {
    return request;
  }
  assertCurrentClaim(request, claimToken);
  throw new LocalPublishJobError(
    'The manual reconciliation could not be deferred',
    'INVALID_RECONCILIATION_TRANSITION',
    409,
  );
}

export async function failManualReconciliation(
  id: string,
  claimToken: string,
  code: string,
  message: string,
) {
  const result = await sql<ManualReconciliationRow>`
    UPDATE manual_reconciliation_requests
    SET status = 'failed',
        error_code = ${code},
        error_message = ${message},
        claim_expires_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status = 'verifying'
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);
  const request = await loadManualReconciliation(id);
  if (
    request.claimToken === claimToken &&
    request.status === 'failed' &&
    request.errorCode === code &&
    request.errorMessage === message
  ) {
    return request;
  }
  assertCurrentClaim(request, claimToken);
  throw new LocalPublishJobError(
    'The manual reconciliation could not be failed',
    'INVALID_RECONCILIATION_TRANSITION',
    409,
  );
}

export async function completeManualReconciliation(
  id: string,
  claimToken: string,
  externalReconciliationId: string,
) {
  const result = await sql<ManualReconciliationRow>`
    UPDATE manual_reconciliation_requests
    SET status = 'reconciled',
        external_reconciliation_id = ${externalReconciliationId}::uuid,
        error_code = NULL,
        error_message = NULL,
        claim_expires_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND status = 'verifying'
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);
  const request = await loadManualReconciliation(id);
  if (
    request.status === 'reconciled' &&
    request.externalReconciliationId === externalReconciliationId
  ) {
    return request;
  }
  assertCurrentClaim(request, claimToken);
  throw new LocalPublishJobError(
    'The manual reconciliation could not be completed',
    'INVALID_RECONCILIATION_TRANSITION',
    409,
  );
}

export async function retryManualReconciliation(
  id: string,
  expected: ManualReconciliationExpectedSnapshot,
) {
  const result = await sql<ManualReconciliationRow>`
    WITH target AS (
      SELECT notion_page_id
      FROM manual_reconciliation_requests
      WHERE id = ${id}::uuid
    ),
    page_lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(target.notion_page_id, 0))
      FROM target
    )
    UPDATE manual_reconciliation_requests AS request
    SET status = 'queued',
        expected_snapshot = ${JSON.stringify(expected)}::jsonb,
        claim_token = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        verification_attempts = 0,
        next_attempt_at = CURRENT_TIMESTAMP,
        error_code = NULL,
        error_message = NULL,
        completed_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    FROM page_lock
    WHERE request.id = ${id}::uuid
      AND request.status = 'failed'
      AND NOT EXISTS (
        SELECT 1
        FROM local_publish_jobs
        WHERE notion_page_id = request.notion_page_id
          AND status NOT IN ('reconciled', 'succeeded', 'failed')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM manual_reconciliation_requests AS active
        WHERE active.notion_page_id = request.notion_page_id
          AND active.status IN ('queued', 'verifying')
          AND active.id != request.id
      )
    RETURNING request.*
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);
  const request = await loadManualReconciliation(id);
  if (request.status === 'reconciled') return request;
  if (request.status !== 'failed') {
    throw new LocalPublishJobError(
      'Only a failed manual reconciliation can be retried',
      'INVALID_RECONCILIATION_TRANSITION',
      409,
    );
  }
  const activeReconciliation = await sql`
    SELECT id
    FROM manual_reconciliation_requests
    WHERE notion_page_id = ${request.notionPageId}
      AND status IN ('queued', 'verifying')
      AND id != ${request.id}::uuid
    LIMIT 1
  `;
  if (activeReconciliation.rows[0]) {
    throw new LocalPublishJobError(
      'This post already has an active manual reconciliation',
      'ACTIVE_RECONCILIATION_EXISTS',
      409,
    );
  }
  throw new LocalPublishJobError(
    'This post has an active local publish job',
    'ACTIVE_JOB_EXISTS',
    409,
  );
}
