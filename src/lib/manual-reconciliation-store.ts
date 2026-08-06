import { isDeepStrictEqual } from 'util';
import type { QueryResultRow } from 'pg';
import { getPool, sql } from '@/lib/db';
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
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [input.notionPageId],
    );
    const jobs = await client.query<{
      id: string;
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
      success_attestation_id: string | null;
      external_disposition_request_id: string | null;
    }>(
      `SELECT id, status, claim_token, claimed_at, staged_at,
              dispatch_authorized_at, dispatched_at, note_id, share_url,
              verified_at, reconciled_at, success_attestation_id,
              external_disposition_request_id
       FROM local_publish_jobs
       WHERE notion_page_id = $1
       ORDER BY created_at DESC
       FOR UPDATE`,
      [input.notionPageId],
    );
    const active = jobs.rows.filter((job) =>
      !['reconciled', 'succeeded', 'failed'].includes(job.status));
    if (active.length > 1) {
      throw new LocalPublishJobError(
        'This post has multiple active local publish jobs and needs review',
        'ACTIVE_JOB_EXISTS',
        409,
      );
    }
    const source = active[0] ?? jobs.rows.find((job) => job.status === 'failed');
    if (source && source.status !== 'failed') {
      const pristineQueued =
        source.status === 'queued' &&
        !source.claim_token &&
        !source.claimed_at &&
        !source.staged_at &&
        !source.dispatch_authorized_at &&
        !source.dispatched_at &&
        !source.note_id &&
        !source.share_url &&
        !source.verified_at &&
        !source.reconciled_at &&
        !source.success_attestation_id &&
        !source.external_disposition_request_id;
      if (!pristineQueued) {
        throw new LocalPublishJobError(
          'A worker already owns or advanced this local publish job',
          'ACTIVE_JOB_EXISTS',
          409,
        );
      }
    }
    const inserted = await client.query<ManualReconciliationRow>(
      `INSERT INTO manual_reconciliation_requests (
         notion_page_id, source_local_job_id, requested_note_id,
         requested_share_url, expected_snapshot, idempotency_key
       ) VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6::uuid)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        input.notionPageId,
        source?.id ?? null,
        input.noteId,
        input.shareUrl,
        JSON.stringify(input.expected),
        input.idempotencyKey,
      ],
    );
    if (inserted.rows[0]) {
      if (source?.status === 'queued') {
        const stopped = await client.query(
          `UPDATE local_publish_jobs
           SET status = 'failed',
               error_code = 'MANUAL_PUBLICATION_ATTESTED',
               error_message = 'Operator reported an existing public post; dispatch is closed pending verification',
               completed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1::uuid
             AND status = 'queued'
             AND claim_token IS NULL
             AND claimed_at IS NULL
             AND staged_at IS NULL
             AND dispatch_authorized_at IS NULL
             AND dispatched_at IS NULL
             AND note_id IS NULL
             AND share_url IS NULL
             AND verified_at IS NULL
             AND reconciled_at IS NULL
             AND success_attestation_id IS NULL
             AND external_disposition_request_id IS NULL
           RETURNING id`,
          [source.id],
        );
        if (stopped.rowCount !== 1) {
          throw new LocalPublishJobError(
            'The local publish job changed before dispatch could be closed',
            'ACTIVE_JOB_EXISTS',
            409,
          );
        }
      }
      await client.query('COMMIT');
      return { request: mapRow(inserted.rows[0]), created: true };
    }
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
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
  const matchFields = request.expected.matchFields ?? [
    'title',
    'caption',
    'mediaType',
  ];
  const mismatch =
    snapshot.noteId !== request.noteId
    || snapshot.shareUrl !== request.shareUrl
    || matchFields.some((field) => snapshot[field] !== request.expected[field]);
  if (mismatch) {
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
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const requestResult = await client.query<ManualReconciliationRow>(
      `SELECT *
       FROM manual_reconciliation_requests
       WHERE id = $1::uuid
       FOR UPDATE`,
      [id],
    );
    if (!requestResult.rows[0]) {
      throw new LocalPublishJobError(
        'Manual reconciliation request was not found',
        'RECONCILIATION_NOT_FOUND',
        404,
      );
    }
    const request = mapRow(requestResult.rows[0]);
    if (
      request.status === 'reconciled'
      && request.externalReconciliationId === externalReconciliationId
    ) {
      await client.query('COMMIT');
      return request;
    }
    assertCurrentClaim(request, claimToken);
    if (request.status !== 'verifying') {
      throw new LocalPublishJobError(
        'The manual reconciliation is not currently claimed',
        'INVALID_RECONCILIATION_TRANSITION',
        409,
      );
    }

    const external = await client.query<{
      note_id: string;
      share_url: string;
      completed_at: Date | string;
      notion_page_id: string;
    }>(
      `SELECT note_id, share_url, completed_at, notion_page_id
       FROM external_post_reconciliations
       WHERE id = $1::uuid
         AND status = 'succeeded'
       FOR UPDATE`,
      [externalReconciliationId],
    );
    const receipt = external.rows[0];
    if (
      !receipt
      || receipt.note_id !== request.noteId
      || receipt.share_url !== request.shareUrl
      || receipt.notion_page_id !== request.notionPageId
    ) {
      throw new LocalPublishJobError(
        'The exact verified publication receipt does not match this request',
        'RECONCILIATION_CONFLICT',
        409,
      );
    }

    const handling = await client.query<{ id: string; receipt_status: string }>(
      `SELECT id, receipt_status
       FROM plan_operator_scheduled_posts
       WHERE notion_page_id = $1
       FOR UPDATE`,
      [request.notionPageId],
    );
    if (handling.rows[0]?.receipt_status === 'reconciled') {
      throw new LocalPublishJobError(
        'The manual handling is already reconciled to another request',
        'RECONCILIATION_CONFLICT',
        409,
      );
    }

    const publishedReceipt = await client.query(
      `INSERT INTO xhs_publish_receipts (
         notion_page_id,
         status,
         note_id,
         share_url,
         source,
         manual_handling_id,
         updated_at
       ) VALUES ($1, 'published', $2, $3, 'manual', $4::uuid, CURRENT_TIMESTAMP)
       ON CONFLICT (notion_page_id) DO UPDATE
       SET status = 'published',
           note_id = EXCLUDED.note_id,
           share_url = EXCLUDED.share_url,
           source = 'manual',
           manual_handling_id = EXCLUDED.manual_handling_id,
           updated_at = CURRENT_TIMESTAMP
       WHERE (
         xhs_publish_receipts.note_id IS NULL
         OR xhs_publish_receipts.note_id = EXCLUDED.note_id
       )
         AND (
           xhs_publish_receipts.share_url IS NULL
           OR xhs_publish_receipts.share_url = EXCLUDED.share_url
         )
       RETURNING notion_page_id`,
      [
        request.notionPageId,
        request.noteId,
        request.shareUrl,
        handling.rows[0]?.id ?? null,
      ],
    );
    if (publishedReceipt.rowCount !== 1) {
      throw new LocalPublishJobError(
        'A different exact publication receipt already owns this post',
        'RECONCILIATION_CONFLICT',
        409,
      );
    }

    if (handling.rows[0]) {
      const reconciledHandling = await client.query(
        `UPDATE plan_operator_scheduled_posts
         SET receipt_status = 'reconciled',
             manual_reconciliation_id = $2::uuid,
             note_id = $3,
             share_url = $4,
             published_at = $5::timestamptz,
             reconciled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1::uuid
           AND receipt_status = 'pending'`,
        [
          handling.rows[0].id,
          request.id,
          request.noteId,
          request.shareUrl,
          timestamp(receipt.completed_at),
        ],
      );
      if (reconciledHandling.rowCount !== 1) {
        throw new LocalPublishJobError(
          'The durable manual handling changed before reconciliation completed',
          'RECONCILIATION_CONFLICT',
          409,
        );
      }
    }

    const completed = await client.query<ManualReconciliationRow>(
      `UPDATE manual_reconciliation_requests
       SET status = 'reconciled',
           external_reconciliation_id = $2::uuid,
           error_code = NULL,
           error_message = NULL,
           claim_expires_at = CURRENT_TIMESTAMP,
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid
       RETURNING *`,
      [request.id, externalReconciliationId],
    );
    await client.query('COMMIT');
    return mapRow(completed.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
