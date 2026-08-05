import { isDeepStrictEqual } from 'util';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  loadManualReconciliation,
  type StoredManualReconciliation,
} from '@/lib/manual-reconciliation-store';
import { lockExternalReconciliationIdentity } from '@/lib/external-post-reconciliation-store';
import type {
  ExternalJobDispositionInput,
} from '@/lib/external-job-disposition-input';
import type {
  ExternalPostSnapshot,
  LocalPublishSnapshot,
  ManualReconciliationExpectedSnapshot,
} from '@/types/local-publish-job';

interface TargetJobRow extends QueryResultRow {
  id: string;
  notion_page_id: string;
  snapshot: LocalPublishSnapshot;
  status: string;
  claim_token: string | null;
  claim_expires_at: Date | string | null;
  claim_expired: boolean;
  staged_at: Date | string | null;
  dispatch_authorized_at: Date | string | null;
  dispatched_at: Date | string | null;
  note_id: string | null;
  share_url: string | null;
  verified_at: Date | string | null;
  reconciled_at: Date | string | null;
  completed_at: Date | string | null;
  batch_item_id: string | null;
  external_disposition_request_id: string | null;
  success_attestation_id: string | null;
}

interface RequestRow extends QueryResultRow {
  id: string;
  notion_page_id: string;
  source_local_job_id: string | null;
  requested_note_id: string;
  requested_share_url: string;
  expected_snapshot: ManualReconciliationExpectedSnapshot;
  request_kind: 'notion_only' | 'targeted_local_job';
  status: 'queued' | 'verifying' | 'reconciled' | 'failed';
  idempotency_key: string;
  claim_token: string | null;
  claim_valid: boolean;
  external_reconciliation_id: string | null;
}

interface ReceiptRow extends QueryResultRow {
  notion_page_id: string;
  status: 'publishing' | 'published';
  note_id: string | null;
  share_url: string | null;
}

function dispositionError(message: string, code: string) {
  return new LocalPublishJobError(message, code, 409);
}

function expectedSnapshot(job: TargetJobRow): ManualReconciliationExpectedSnapshot {
  return {
    title: job.snapshot.title,
    caption: job.snapshot.caption,
    mediaType: job.snapshot.mediaType,
  };
}

function verifiedSnapshot(request: RequestRow): ExternalPostSnapshot {
  return {
    noteId: request.requested_note_id,
    shareUrl: request.requested_share_url,
    ...request.expected_snapshot,
  };
}

function assertExactRequest(
  request: RequestRow,
  input: ExternalJobDispositionInput,
  idempotencyKey: string,
) {
  if (
    request.request_kind !== 'targeted_local_job' ||
    request.idempotency_key !== idempotencyKey ||
    request.notion_page_id !== input.notionPageId ||
    request.source_local_job_id !== input.localJobId ||
    request.requested_note_id !== input.noteId ||
    request.requested_share_url !== input.shareUrl
  ) {
    throw dispositionError(
      'Idempotency-Key was already used for a different disposition request',
      'IDEMPOTENCY_CONFLICT',
    );
  }
}

async function assertReleasedOperatorAttestedJob(
  client: PoolClient,
  job: TargetJobRow,
  input: ExternalJobDispositionInput,
) {
  if (
    job.status !== 'operator_attested' ||
    !job.success_attestation_id ||
    !job.batch_item_id ||
    job.notion_page_id !== input.notionPageId ||
    job.snapshot.notionPageId !== input.notionPageId ||
    job.note_id ||
    job.share_url ||
    job.verified_at ||
    job.reconciled_at ||
    job.completed_at ||
    job.dispatched_at
  ) {
    throw dispositionError(
      'Only an exact released operator-attested job may enter known-live disposition',
      'DISPOSITION_JOB_NOT_RELEASED',
    );
  }
  const released = await client.query(
    `SELECT 1
     FROM local_publish_job_success_attestations AS attestation
     JOIN local_publish_job_success_attestation_release_acks AS release_ack
       ON release_ack.success_attestation_id = attestation.id
     WHERE attestation.id = $1::uuid
       AND attestation.local_publish_job_id = $2::uuid
       AND attestation.batch_item_id = $3::uuid
       AND attestation.notion_page_id = $4`,
    [
      job.success_attestation_id,
      job.id,
      job.batch_item_id,
      input.notionPageId,
    ],
  );
  if (released.rowCount !== 1) {
    throw dispositionError(
      'The operator success attestation still requires release acknowledgement',
      'DISPOSITION_RELEASE_REQUIRED',
    );
  }
}

function assertSafePreDispatchJob(job: TargetJobRow, input: ExternalJobDispositionInput) {
  if (
    job.notion_page_id !== input.notionPageId ||
    job.snapshot.notionPageId !== input.notionPageId
  ) {
    throw dispositionError(
      'The local job does not belong to the target Notion page',
      'DISPOSITION_JOB_PAGE_MISMATCH',
    );
  }

  if (
    job.staged_at ||
    job.dispatch_authorized_at ||
    job.dispatched_at ||
    job.note_id ||
    job.share_url ||
    job.verified_at ||
    job.reconciled_at ||
    job.completed_at
  ) {
    throw dispositionError(
      'The local job has durable dispatch or completion evidence',
      'DISPOSITION_ALREADY_DISPATCHED',
    );
  }

  if (job.status === 'queued') return;
  if (job.status === 'claimed' && job.claim_expired) return;
  if (job.status === 'claimed') {
    throw dispositionError(
      'The local job has active unexpired dispatch ownership',
      'ACTIVE_DISPATCH_OWNERSHIP',
    );
  }
  throw dispositionError(
    'Only queued or expired-claimed pre-dispatch jobs can be dispositioned',
    'UNSAFE_DISPOSITION_JOB',
  );
}

function assertDispositionOwnership(job: TargetJobRow, requestId: string) {
  if (job.external_disposition_request_id !== requestId) {
    throw dispositionError(
      'The local job is not quarantined by this disposition request',
      'DISPOSITION_REQUEST_CONFLICT',
    );
  }
}

async function assertBatchLinkage(
  client: PoolClient,
  job: TargetJobRow,
  allowedStates: string[],
) {
  if (!job.batch_item_id) return;
  const batch = await client.query<{
    id: string;
    notion_page_id: string;
    local_publish_job_id: string | null;
    state: string;
  }>(
    `SELECT id, notion_page_id, local_publish_job_id, state
     FROM rednote_publish_batch_items
     WHERE id = $1::uuid
     FOR UPDATE`,
    [job.batch_item_id],
  );
  const item = batch.rows[0];
  if (
    !item ||
    item.notion_page_id !== job.notion_page_id ||
    item.local_publish_job_id !== job.id ||
    !allowedStates.includes(item.state)
  ) {
    throw dispositionError(
      'The bounded batch item is missing, mismatched, or in an unsafe state',
      'DISPOSITION_BATCH_CONFLICT',
    );
  }
}

async function assertEligibleDispositionJob(
  client: PoolClient,
  job: TargetJobRow,
  input: ExternalJobDispositionInput,
) {
  if (job.status === 'operator_attested') {
    await assertReleasedOperatorAttestedJob(client, job, input);
    await assertBatchLinkage(client, job, ['operator_attested']);
    return;
  }
  assertSafePreDispatchJob(job, input);
  await assertBatchLinkage(client, job, ['queued', 'claimed']);
}

async function ensureVerifiedPublishedReceipt(
  client: PoolClient,
  job: TargetJobRow,
  request: RequestRow,
) {
  await lockExternalReconciliationIdentity(
    client,
    request.requested_note_id,
    request.requested_share_url,
  );
  const receipts = await client.query<ReceiptRow>(
    `SELECT notion_page_id, status, note_id, share_url
     FROM xhs_publish_receipts
     WHERE notion_page_id = $1
        OR note_id = $2
        OR share_url = $3
     FOR UPDATE`,
    [
      request.notion_page_id,
      request.requested_note_id,
      request.requested_share_url,
    ],
  );
  if (receipts.rows.length === 0) {
    await client.query(
      `INSERT INTO xhs_publish_receipts (
         notion_page_id, status, note_id, share_url
       ) VALUES ($1, 'published', $2, $3)`,
      [
        request.notion_page_id,
        request.requested_note_id,
        request.requested_share_url,
      ],
    );
    return;
  }
  if (
    receipts.rows.length !== 1 ||
    receipts.rows[0].notion_page_id !== job.notion_page_id ||
    receipts.rows[0].status !== 'published' ||
    receipts.rows[0].note_id !== request.requested_note_id ||
    receipts.rows[0].share_url !== request.requested_share_url
  ) {
    throw dispositionError(
      'The verified post conflicts with an existing publish receipt',
      'DISPOSITION_RECEIPT_CONFLICT',
    );
  }
}

async function assertExactPublishedReceipt(
  client: PoolClient,
  job: TargetJobRow,
  request: RequestRow,
) {
  const receipt = await client.query<ReceiptRow>(
    `SELECT notion_page_id, status, note_id, share_url
     FROM xhs_publish_receipts
     WHERE notion_page_id = $1
     FOR SHARE`,
    [request.notion_page_id],
  );
  if (
    receipt.rowCount !== 1 ||
    receipt.rows[0].notion_page_id !== job.notion_page_id ||
    receipt.rows[0].status !== 'published' ||
    receipt.rows[0].note_id !== request.requested_note_id ||
    receipt.rows[0].share_url !== request.requested_share_url
  ) {
    throw dispositionError(
      'The verified disposition is missing its exact published receipt',
      'DISPOSITION_RECEIPT_MISSING',
    );
  }
}

async function assertReceiptAndIdentitySafety(
  client: PoolClient,
  job: TargetJobRow,
  input: ExternalJobDispositionInput,
  snapshot: ExternalPostSnapshot,
) {
  const receipts = await client.query<{
    notion_page_id: string;
    status: 'publishing' | 'published';
    note_id: string | null;
    share_url: string | null;
  }>(
    `SELECT notion_page_id, status, note_id, share_url
     FROM xhs_publish_receipts
     WHERE notion_page_id = $1
        OR note_id = $2
        OR share_url = $3
     FOR UPDATE`,
    [input.notionPageId, input.noteId, input.shareUrl],
  );
  if (job.status === 'operator_attested' && receipts.rows.length > 0) {
    throw dispositionError(
      'A released operator-attested job must not already have receipt identity',
      'DISPOSITION_RECEIPT_CONFLICT',
    );
  }
  for (const receipt of receipts.rows) {
    const exact = receipt.status === 'published' &&
      receipt.notion_page_id === input.notionPageId &&
      receipt.note_id === input.noteId &&
      receipt.share_url === input.shareUrl;
    if (!exact) {
      throw dispositionError(
        'A conflicting durable publish receipt already exists',
        'DISPOSITION_RECEIPT_CONFLICT',
      );
    }
  }

  const localIdentity = await client.query<{ id: string }>(
    `SELECT id
     FROM local_publish_jobs
     WHERE id <> $1::uuid
       AND (note_id = $2 OR share_url = $3)
     LIMIT 1
     FOR UPDATE`,
    [job.id, input.noteId, input.shareUrl],
  );
  if (localIdentity.rows[0]) {
    throw dispositionError(
      'The RedNote identity belongs to another local publish job',
      'DISPOSITION_IDENTITY_CONFLICT',
    );
  }

  const requests = await client.query<{ id: string }>(
    `SELECT id
     FROM manual_reconciliation_requests
     WHERE (
         notion_page_id = $1
         AND status IN ('queued', 'verifying')
       )
       OR (
         request_kind = 'targeted_local_job'
         AND (
           source_local_job_id = $2::uuid
           OR requested_note_id = $3
           OR requested_share_url = $4
         )
       )
     LIMIT 1
     FOR UPDATE`,
    [input.notionPageId, job.id, input.noteId, input.shareUrl],
  );
  if (requests.rows[0]) {
    throw dispositionError(
      'The target job, page, or RedNote identity already has reconciliation ownership',
      'DISPOSITION_REQUEST_CONFLICT',
    );
  }

  const external = await client.query<{
    status: 'processing' | 'succeeded' | 'failed';
    notion_page_id: string | null;
    snapshot: ExternalPostSnapshot;
  }>(
    `SELECT status, notion_page_id, snapshot
     FROM external_post_reconciliations
     WHERE note_id = $1 OR share_url = $2
     ORDER BY created_at
     FOR UPDATE`,
    [input.noteId, input.shareUrl],
  );
  if (external.rows.length > 1) {
    throw dispositionError(
      'The RedNote identity has multiple durable reconciliation records',
      'DISPOSITION_IDENTITY_CONFLICT',
    );
  }
  const existing = external.rows[0];
  if (!existing) return;
  const reusable = isDeepStrictEqual(existing.snapshot, snapshot) &&
    (
      existing.status === 'failed' ||
      (
        existing.status === 'succeeded' &&
        existing.notion_page_id === input.notionPageId
      )
    );
  if (!reusable) {
    throw dispositionError(
      'The RedNote identity has conflicting reconciliation ownership',
      'DISPOSITION_IDENTITY_CONFLICT',
    );
  }
}

async function lockedRequest(
  client: PoolClient,
  id: string,
): Promise<RequestRow> {
  const result = await client.query<RequestRow>(
    `SELECT *,
       claim_expires_at > CURRENT_TIMESTAMP AS claim_valid
     FROM manual_reconciliation_requests
     WHERE id = $1::uuid
     FOR UPDATE`,
    [id],
  );
  const request = result.rows[0];
  if (!request) {
    throw new LocalPublishJobError(
      'Manual reconciliation request was not found',
      'RECONCILIATION_NOT_FOUND',
      404,
    );
  }
  if (
    request.request_kind !== 'targeted_local_job' ||
    !request.source_local_job_id
  ) {
    throw dispositionError(
      'The reconciliation request is not a targeted local job disposition',
      'INVALID_RECONCILIATION_TRANSITION',
    );
  }
  return request;
}

async function dispositionJobId(client: PoolClient, id: string) {
  const result = await client.query<{
    request_kind: 'notion_only' | 'targeted_local_job';
    source_local_job_id: string | null;
  }>(
    `SELECT request_kind, source_local_job_id
     FROM manual_reconciliation_requests
     WHERE id = $1::uuid`,
    [id],
  );
  const request = result.rows[0];
  if (!request) {
    throw new LocalPublishJobError(
      'Manual reconciliation request was not found',
      'RECONCILIATION_NOT_FOUND',
      404,
    );
  }
  if (
    request.request_kind !== 'targeted_local_job' ||
    !request.source_local_job_id
  ) {
    throw dispositionError(
      'The reconciliation request is not a targeted local job disposition',
      'INVALID_RECONCILIATION_TRANSITION',
    );
  }
  return request.source_local_job_id;
}

async function lockedJob(client: PoolClient, id: string) {
  const result = await client.query<TargetJobRow>(
    `SELECT *,
       claim_expires_at IS NOT NULL
         AND claim_expires_at <= CURRENT_TIMESTAMP AS claim_expired
     FROM local_publish_jobs
     WHERE id = $1::uuid
     FOR UPDATE`,
    [id],
  );
  const job = result.rows[0];
  if (!job) {
    throw new LocalPublishJobError(
      'Local publish job was not found',
      'JOB_NOT_FOUND',
      404,
    );
  }
  return job;
}

function assertCurrentRequestClaim(request: RequestRow, claimToken: string) {
  if (
    request.status !== 'verifying' ||
    request.claim_token !== claimToken ||
    !request.claim_valid
  ) {
    throw dispositionError(
      'The targeted reconciliation claim is stale, expired, or revoked',
      'STALE_CLAIM',
    );
  }
}

export async function insertExternalJobDisposition(
  input: ExternalJobDispositionInput,
  idempotencyKey: string,
) {
  const client = await getPool().connect();
  let existingId: string | undefined;
  let createdId: string | undefined;
  try {
    await client.query('BEGIN');
    const job = await lockedJob(client, input.localJobId);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [input.notionPageId],
    );
    const existing = await client.query<RequestRow>(
      `SELECT *,
         claim_expires_at > CURRENT_TIMESTAMP AS claim_valid
       FROM manual_reconciliation_requests
       WHERE idempotency_key = $1::uuid
       FOR UPDATE`,
      [idempotencyKey],
    );
    if (existing.rows[0]) {
      assertExactRequest(existing.rows[0], input, idempotencyKey);
      assertDispositionOwnership(job, existing.rows[0].id);
      existingId = existing.rows[0].id;
      await client.query('COMMIT');
    } else {
      await assertEligibleDispositionJob(client, job, input);
      await lockExternalReconciliationIdentity(
        client,
        input.noteId,
        input.shareUrl,
      );
      const expected = expectedSnapshot(job);
      const snapshot = {
        noteId: input.noteId,
        shareUrl: input.shareUrl,
        ...expected,
      };
      await assertReceiptAndIdentitySafety(client, job, input, snapshot);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO manual_reconciliation_requests (
           notion_page_id,
           source_local_job_id,
           requested_note_id,
           requested_share_url,
           expected_snapshot,
           request_kind,
           idempotency_key
         ) VALUES ($1, $2::uuid, $3, $4, $5::jsonb, 'targeted_local_job', $6::uuid)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          input.notionPageId,
          input.localJobId,
          input.noteId,
          input.shareUrl,
          JSON.stringify(expected),
          idempotencyKey,
        ],
      );
      if (!inserted.rows[0]) {
        throw dispositionError(
          'The targeted disposition conflicted with existing durable ownership',
          'DISPOSITION_REQUEST_CONFLICT',
        );
      }
      createdId = inserted.rows[0].id;
      const quarantined = await client.query(
        `UPDATE local_publish_jobs
         SET external_disposition_request_id = $1::uuid,
             claim_token = NULL,
             claim_expires_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2::uuid
           AND external_disposition_request_id IS NULL
         RETURNING id`,
        [createdId, job.id],
      );
      if (quarantined.rowCount !== 1) {
        throw dispositionError(
          'The local job could not be quarantined from dispatch',
          'DISPOSITION_REQUEST_CONFLICT',
        );
      }
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const request = await loadManualReconciliation(existingId ?? createdId!);
  return { request, created: Boolean(createdId) };
}

export async function prepareExternalJobDisposition(
  id: string,
  claimToken: string,
  snapshot: ExternalPostSnapshot,
) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const job = await lockedJob(client, await dispositionJobId(client, id));
    const request = await lockedRequest(client, id);
    assertDispositionOwnership(job, request.id);
    if (request.source_local_job_id !== job.id) {
      throw dispositionError(
        'The disposition request no longer matches its local job',
        'DISPOSITION_REQUEST_CONFLICT',
      );
    }
    if (request.status === 'reconciled') {
      await client.query('COMMIT');
      return loadManualReconciliation(id);
    }
    assertCurrentRequestClaim(request, claimToken);
    if (!isDeepStrictEqual(snapshot, verifiedSnapshot(request))) {
      throw dispositionError(
        'The verified RedNote snapshot does not match the durable disposition request',
        'VERIFIED_POST_MISMATCH',
      );
    }
    if (job.notion_page_id !== request.notion_page_id) {
      throw dispositionError(
        'The disposition request no longer matches its local job',
        'DISPOSITION_JOB_PAGE_MISMATCH',
      );
    }
    if (job.status === 'verified') {
      if (
        job.note_id !== request.requested_note_id ||
        job.share_url !== request.requested_share_url
      ) {
        throw dispositionError(
          'The verified local job has conflicting RedNote identity',
          'DISPOSITION_IDENTITY_CONFLICT',
        );
      }
      await assertBatchLinkage(client, job, ['verified']);
    } else {
      await assertEligibleDispositionJob(client, job, {
        notionPageId: request.notion_page_id,
        localJobId: job.id,
        noteId: request.requested_note_id,
        shareUrl: request.requested_share_url,
      });
      await client.query(
        `UPDATE local_publish_jobs
         SET status = 'verified',
             note_id = $1,
             share_url = $2,
             verified_at = COALESCE(verified_at, CURRENT_TIMESTAMP),
             next_verification_at = NULL,
             claim_token = NULL,
             claim_expires_at = CURRENT_TIMESTAMP,
             error_code = NULL,
             error_message = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3::uuid`,
        [request.requested_note_id, request.requested_share_url, job.id],
      );
      if (job.batch_item_id) {
        const batch = await client.query(
          `UPDATE rednote_publish_batch_items
           SET state = 'verified',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1::uuid
             AND local_publish_job_id = $2::uuid
             AND state IN ('queued', 'claimed', 'operator_attested', 'verified')
           RETURNING id`,
          [job.batch_item_id, job.id],
        );
        if (batch.rowCount !== 1) {
          throw dispositionError(
            'The linked batch item could not be marked verified',
            'DISPOSITION_BATCH_CONFLICT',
          );
        }
      }
    }
    await ensureVerifiedPublishedReceipt(client, job, request);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return loadManualReconciliation(id);
}

export async function completeExternalJobDisposition(
  id: string,
  claimToken: string,
  externalReconciliationId: string,
) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const job = await lockedJob(client, await dispositionJobId(client, id));
    const request = await lockedRequest(client, id);
    assertDispositionOwnership(job, request.id);
    if (request.source_local_job_id !== job.id) {
      throw dispositionError(
        'The disposition request no longer matches its local job',
        'DISPOSITION_REQUEST_CONFLICT',
      );
    }
    if (
      request.status === 'reconciled' &&
      request.external_reconciliation_id === externalReconciliationId
    ) {
      await client.query('COMMIT');
      return loadManualReconciliation(id);
    }
    assertCurrentRequestClaim(request, claimToken);
    if (
      job.notion_page_id !== request.notion_page_id ||
      !['verified', 'reconciled'].includes(job.status) ||
      job.note_id !== request.requested_note_id ||
      job.share_url !== request.requested_share_url
    ) {
      throw dispositionError(
        'The verified local job no longer matches its disposition request',
        'INVALID_RECONCILIATION_TRANSITION',
      );
    }
    await assertBatchLinkage(client, job, [job.status]);
    await assertExactPublishedReceipt(client, job, request);
    if (job.status === 'verified') {
      await client.query(
        `UPDATE local_publish_jobs
         SET status = 'reconciled',
             reconciled_at = COALESCE(reconciled_at, CURRENT_TIMESTAMP),
             completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1::uuid`,
        [job.id],
      );
      if (job.batch_item_id) {
        const batch = await client.query(
          `UPDATE rednote_publish_batch_items
           SET state = 'reconciled',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1::uuid
             AND local_publish_job_id = $2::uuid
             AND state IN ('verified', 'reconciled')
           RETURNING id`,
          [job.batch_item_id, job.id],
        );
        if (batch.rowCount !== 1) {
          throw dispositionError(
            'The linked batch item could not be marked reconciled',
            'DISPOSITION_BATCH_CONFLICT',
          );
        }
      }
    }
    const completed = await client.query(
      `UPDATE manual_reconciliation_requests
       SET status = 'reconciled',
           external_reconciliation_id = $1::uuid,
           error_code = NULL,
           error_message = NULL,
           claim_expires_at = CURRENT_TIMESTAMP,
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid
         AND status = 'verifying'
         AND claim_token = $3::uuid
       RETURNING id`,
      [externalReconciliationId, id, claimToken],
    );
    if (completed.rowCount !== 1) {
      throw dispositionError(
        'The targeted disposition could not be completed',
        'INVALID_RECONCILIATION_TRANSITION',
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return loadManualReconciliation(id);
}

export async function retryExternalJobDisposition(id: string) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const job = await lockedJob(client, await dispositionJobId(client, id));
    const request = await lockedRequest(client, id);
    assertDispositionOwnership(job, request.id);
    if (request.source_local_job_id !== job.id) {
      throw dispositionError(
        'The disposition request no longer matches its local job',
        'DISPOSITION_REQUEST_CONFLICT',
      );
    }
    if (request.status === 'reconciled') {
      await client.query('COMMIT');
      return loadManualReconciliation(id);
    }
    if (request.status !== 'failed') {
      throw dispositionError(
        'Only a failed targeted disposition can be retried',
        'INVALID_RECONCILIATION_TRANSITION',
      );
    }
    const identityMatches = job.note_id === request.requested_note_id &&
      job.share_url === request.requested_share_url;
    if (job.status === 'operator_attested') {
      await assertReleasedOperatorAttestedJob(client, job, {
        notionPageId: request.notion_page_id,
        localJobId: job.id,
        noteId: request.requested_note_id,
        shareUrl: request.requested_share_url,
      });
    } else if (
      !(
        (
          job.status === 'queued' &&
          !job.note_id &&
          !job.share_url
        ) ||
        (
          job.status === 'claimed' &&
          job.claim_expired &&
          !job.note_id &&
          !job.share_url
        ) ||
        (job.status === 'verified' && identityMatches)
      )
    ) {
      throw dispositionError(
        'The target job is no longer safe for disposition retry',
        'UNSAFE_DISPOSITION_JOB',
      );
    }
    await assertBatchLinkage(client, job, [job.status]);
    await client.query(
      `UPDATE manual_reconciliation_requests
       SET status = 'queued',
           claim_token = NULL,
           claimed_at = NULL,
           claim_expires_at = NULL,
           verification_attempts = 0,
           next_attempt_at = CURRENT_TIMESTAMP,
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid`,
      [id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return loadManualReconciliation(id);
}

export function externalJobDispositionSummary(
  request: StoredManualReconciliation,
) {
  return {
    id: request.id,
    notionPageId: request.notionPageId,
    localJobId: request.sourceLocalJobId!,
    noteId: request.noteId,
    shareUrl: request.shareUrl,
    status: request.status,
    verificationAttempts: request.verificationAttempts,
    ...(request.externalReconciliationId
      ? { externalReconciliationId: request.externalReconciliationId }
      : {}),
    ...(request.errorCode ? { errorCode: request.errorCode } : {}),
    ...(request.errorMessage ? { errorMessage: request.errorMessage } : {}),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    ...(request.completedAt ? { completedAt: request.completedAt } : {}),
  };
}
