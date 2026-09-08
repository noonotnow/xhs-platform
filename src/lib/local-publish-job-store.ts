import { createHash, randomUUID } from 'crypto';
import type { QueryResultRow } from 'pg';
import { isDeepStrictEqual } from 'util';
import { sql } from '@/lib/db';
import {
  LocalPublishJobError,
  normalizeLocalPublishTags,
} from '@/lib/local-publish-job-input';
import { snapshotPublishMedia } from '@/lib/rednote-publish-authorization';
import {
  acknowledgeOperatorSuccessAttestationRelease,
  loadOperatorSuccessAttestation,
} from '@/lib/operator-success-attestation-store';
import {
  ATTESTATION_RELEASE_CONSUMED_CODE,
  ATTESTATION_RELEASE_CONSUMED_MESSAGE,
} from '@/lib/operator-success-attestation-contract';
import type {
  ClaimedLocalPublishJob,
  LocalPublishJobStatus,
  LocalPublishJobSummary,
  LocalPublishSnapshot,
  BatchAuthorization,
  LocalPublishWorkLane,
  OperatorSuccessAttestationSummary,
} from '@/types/local-publish-job';

interface LocalPublishJobRow extends QueryResultRow {
  id: string;
  workspace_id: string;
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
  manual_handling_exists?: boolean;
  completed_at: Date | string | null;
  batch_item_id?: string | null;
  dispatch_authorized_at?: Date | string | null;
  success_attestation_id?: string | null;
  receipt_contract_version?: string | null;
  receipt_outcome?: 'acknowledged' | 'scheduled' | 'ambiguous' | 'rejected' | null;
  receipt_acknowledged_at?: Date | string | null;
  authenticated_account_id?: string | null;
  authenticated_account_at?: Date | string | null;
  xsec_accessible_at?: Date | string | null;
  public_index_status?: 'indexed' | 'pending' | 'not_found' | null;
  public_index_checked_at?: Date | string | null;
  provider_restriction_status?: 'removed' | 'restricted' | null;
  provider_restriction_reported_at?: Date | string | null;
}

export type LateStoredWorkerTerminalResult =
  | {
      contractVersion: 'rednote-worker-result/v2';
      outcome: 'scheduled';
      acknowledgedAt: string;
      scheduledFor: string;
      authenticatedAccount: {
        accountId: string;
        capturedAt: string;
        ownership: 'owned' | 'account_mismatch';
      };
      noteId?: string;
    }
  | {
      contractVersion: 'rednote-worker-result/v2';
      outcome: 'ambiguous' | 'rejected';
      occurredAt: string;
      code: string;
      message: string;
    };

interface LateTerminalCandidateRow extends LocalPublishJobRow {
  attempt_id: string;
  attempt_executor_id: string;
  attempt_terminal_outcome: 'accepted' | 'known_failed' | 'outcome_unknown' | null;
  attempt_dispatch_authorized_at: Date | string | null;
  frozen_timing_mode: 'scheduled' | 'post_now';
  frozen_target_publish_at: string;
  frozen_expected_account_id: string;
  attempt_receipt_note_id: string | null;
  canonical_account_ownership: 'owned' | 'account_mismatch' | null;
  late_result_digest: string | null;
  worker_terminal_event_exists: boolean;
}

export interface StoredLocalPublishJob {
  id: string;
  workspaceId: string;
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
  dispatchAuthorizedAt?: string;
  dispatchedAt?: string;
  verifiedAt?: string;
  reconciledAt?: string;
  completedAt?: string;
  batchAuthorization?: BatchAuthorization;
  successAttestation?: OperatorSuccessAttestationSummary;
  receiptContractVersion?: 'rednote-worker-result/v2';
  receiptOutcome?: 'acknowledged' | 'scheduled' | 'ambiguous' | 'rejected';
  receiptAcknowledgedAt?: string;
  authenticatedAccountId?: string;
  authenticatedAccountAt?: string;
  xsecAccessibleAt?: string;
  publicIndexStatus?: 'indexed' | 'pending' | 'not_found';
  publicIndexCheckedAt?: string;
  restrictionStatus?: 'removed' | 'restricted';
  restrictionReportedAt?: string;
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
  const normalized = {
    ...current,
    media: snapshotPublishMedia(current),
  };
  if (current.publishAt || !scheduledDate) return normalized;
  const legacyPublishAt = new Date(scheduledDate);
  if (Number.isNaN(legacyPublishAt.getTime())) {
    throw new LocalPublishJobError(
      'A stored local publish job has an invalid legacy schedule',
      'INVALID_LEGACY_PUBLISH_SCHEDULE',
      500,
    );
  }
  return { ...normalized, publishAt: legacyPublishAt.toISOString() };
}

function mapRow(row: LocalPublishJobRow): StoredLocalPublishJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
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
    ...(optionalTimestamp(row.dispatch_authorized_at ?? null)
      ? { dispatchAuthorizedAt: optionalTimestamp(row.dispatch_authorized_at ?? null) }
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
    ...(row.receipt_contract_version === 'rednote-worker-result/v2'
      ? { receiptContractVersion: row.receipt_contract_version }
      : {}),
    ...(row.receipt_outcome ? { receiptOutcome: row.receipt_outcome } : {}),
    ...(optionalTimestamp(row.receipt_acknowledged_at ?? null)
      ? { receiptAcknowledgedAt: optionalTimestamp(row.receipt_acknowledged_at ?? null) }
      : {}),
    ...(row.authenticated_account_id
      ? { authenticatedAccountId: row.authenticated_account_id }
      : {}),
    ...(optionalTimestamp(row.authenticated_account_at ?? null)
      ? { authenticatedAccountAt: optionalTimestamp(row.authenticated_account_at ?? null) }
      : {}),
    ...(optionalTimestamp(row.xsec_accessible_at ?? null)
      ? { xsecAccessibleAt: optionalTimestamp(row.xsec_accessible_at ?? null) }
      : {}),
    ...(row.public_index_status ? { publicIndexStatus: row.public_index_status } : {}),
    ...(optionalTimestamp(row.public_index_checked_at ?? null)
      ? { publicIndexCheckedAt: optionalTimestamp(row.public_index_checked_at ?? null) }
      : {}),
    ...(row.provider_restriction_status
      ? { restrictionStatus: row.provider_restriction_status }
      : {}),
    ...(optionalTimestamp(row.provider_restriction_reported_at ?? null)
      ? { restrictionReportedAt: optionalTimestamp(row.provider_restriction_reported_at ?? null) }
      : {}),
  };
}

function lateTerminalResultDigest(result: LateStoredWorkerTerminalResult) {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

function assertLateTerminalReplayMatches(
  job: StoredLocalPublishJob,
  candidate: LateTerminalCandidateRow,
  result: LateStoredWorkerTerminalResult,
  digest: string,
) {
  if (candidate.late_result_digest) {
    if (candidate.late_result_digest !== digest) {
      throw new LocalPublishJobError(
        'The late worker result conflicts with the canonical terminal receipt',
        'LATE_RESULT_CONFLICT',
        409,
      );
    }
    return;
  }
  const timestampMatches = job.receiptAcknowledgedAt === (
    result.outcome === 'scheduled' ? result.acknowledgedAt : result.occurredAt
  );
  const commonMatches = job.receiptOutcome === result.outcome && timestampMatches;
  const scheduledMatches = result.outcome !== 'scheduled' || (
    job.authenticatedAccountId === result.authenticatedAccount.accountId
    && job.authenticatedAccountAt === result.authenticatedAccount.capturedAt
    && candidate.canonical_account_ownership
      === result.authenticatedAccount.ownership
    && (result.noteId ?? null) === (job.noteId ?? null)
    && candidate.frozen_target_publish_at != null
    && new Date(result.scheduledFor).getTime()
      === new Date(candidate.frozen_target_publish_at).getTime()
  );
  const failureMatches = result.outcome === 'scheduled' || (
    job.errorCode === result.code && job.errorMessage === result.message
  );
  if (!commonMatches || !scheduledMatches || !failureMatches) {
    throw new LocalPublishJobError(
      'The late worker result conflicts with the canonical terminal receipt',
      'LATE_RESULT_CONFLICT',
      409,
    );
  }
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
    ...(job.dispatchAuthorizedAt
      ? { dispatchAuthorizedAt: job.dispatchAuthorizedAt }
      : {}),
    ...(job.dispatchedAt ? { dispatchedAt: job.dispatchedAt } : {}),
    ...(job.verifiedAt ? { verifiedAt: job.verifiedAt } : {}),
    ...(job.reconciledAt ? { reconciledAt: job.reconciledAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.successAttestation ? { successAttestation: job.successAttestation } : {}),
    ...(job.receiptContractVersion
      ? { receiptContractVersion: job.receiptContractVersion }
      : {}),
    ...(job.receiptOutcome ? { receiptOutcome: job.receiptOutcome } : {}),
    ...(job.receiptAcknowledgedAt
      ? { receiptAcknowledgedAt: job.receiptAcknowledgedAt }
      : {}),
    ...(
      job.authenticatedAccountId && job.authenticatedAccountAt
        ? {
            evidence: {
              authenticatedAccount: {
                accountId: job.authenticatedAccountId,
                capturedAt: job.authenticatedAccountAt,
                ownership: job.snapshot.expectedAccountId === job.authenticatedAccountId
                  ? 'owned' as const
                  : 'account_mismatch' as const,
              },
              ...(job.xsecAccessibleAt
                ? { xsecAccess: { capturedAt: job.xsecAccessibleAt, accessible: true as const } }
                : {}),
              ...(job.publicIndexStatus && job.publicIndexCheckedAt
                ? {
                    publicIndex: {
                      status: job.publicIndexStatus,
                      checkedAt: job.publicIndexCheckedAt,
                      ...(job.shareUrl ? { publicUrl: job.shareUrl } : {}),
                    },
                  }
                : {}),
              ...(job.restrictionStatus && job.restrictionReportedAt
                ? {
                    restriction: {
                      status: job.restrictionStatus,
                      reportedAt: job.restrictionReportedAt,
                    },
                  }
                : {}),
            },
          }
        : {}
    ),
  };
}

function sameSnapshot(left: LocalPublishSnapshot, right: LocalPublishSnapshot) {
  return isDeepStrictEqual(
    normalizeStoredLocalPublishSnapshot(left),
    normalizeStoredLocalPublishSnapshot(right),
  );
}

export async function insertLocalPublishJob(
  snapshot: LocalPublishSnapshot,
  idempotencyKey: string,
  workspaceId = 'legacy-local-publish',
) {
  const inserted = await sql<LocalPublishJobRow>`
    WITH page_lock AS (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${workspaceId} || E'\x1f' || ${snapshot.notionPageId}, 0)
      )
    )
    INSERT INTO local_publish_jobs (
      notion_page_id,
      snapshot,
      idempotency_key,
      workspace_id
    )
    SELECT
      ${snapshot.notionPageId},
      ${JSON.stringify(snapshot)}::jsonb,
      ${idempotencyKey}::uuid,
      ${workspaceId}
    FROM page_lock
    WHERE NOT EXISTS (
      SELECT 1
      FROM plan_operator_scheduled_posts
      WHERE workspace_id = ${workspaceId}
        AND notion_page_id = ${snapshot.notionPageId}
    )
      AND NOT EXISTS (
      SELECT 1
      FROM manual_reconciliation_requests
      WHERE workspace_id = ${workspaceId}
        AND notion_page_id = ${snapshot.notionPageId}
        AND status IN ('queued', 'verifying')
    )
      AND NOT EXISTS (
        SELECT 1
        FROM local_publish_jobs existing
        WHERE existing.workspace_id = ${workspaceId}
          AND existing.notion_page_id = ${snapshot.notionPageId}
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
    WHERE workspace_id = ${workspaceId}
      AND idempotency_key = ${idempotencyKey}::uuid
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

  const operatorScheduled = await sql`
    SELECT id
    FROM plan_operator_scheduled_posts
    WHERE workspace_id = ${workspaceId}
      AND notion_page_id = ${snapshot.notionPageId}
    LIMIT 1
  `;
  if (operatorScheduled.rows[0]) {
    throw new LocalPublishJobError(
      'PLAN already recorded this post as operator scheduled',
      'OPERATOR_SCHEDULED_NON_DISPATCHABLE',
      409,
    );
  }

  const active = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE workspace_id = ${workspaceId}
      AND notion_page_id = ${snapshot.notionPageId}
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
    WHERE workspace_id = ${workspaceId}
      AND notion_page_id = ${snapshot.notionPageId}
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

export async function findLocalPublishJobByIdempotencyKey(idempotencyKey: string, workspaceId = 'legacy-local-publish') {
  const result = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE workspace_id = ${workspaceId}
      AND idempotency_key = ${idempotencyKey}::uuid
    LIMIT 1
  `;
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listLocalPublishJobs(workspaceId = 'legacy-local-publish') {
  const result = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return Promise.all(result.rows.map(async (row) => {
    const job = mapRow(row);
    if (job.status === 'operator_attested' && row.success_attestation_id) {
      job.successAttestation = await loadOperatorSuccessAttestation(
        row.success_attestation_id,
      );
    }
    return job;
  }));
}

export async function listPublishOwningLocalJobs(
  notionPageIds: string[],
  workspaceId = 'legacy-local-publish',
) {
  if (notionPageIds.length === 0) return [];
  const result = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE workspace_id = ${workspaceId}
      AND notion_page_id = ANY(${notionPageIds}::text[])
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
  expectedJobId?: string,
  workspaceId = 'legacy-local-publish',
  claimToken: string = randomUUID(),
): Promise<ClaimedLocalPublishJob | null> {
  const result = await sql<LocalPublishJobRow>`
    WITH candidate AS (
      SELECT id, status
      FROM local_publish_jobs
      WHERE workspace_id = ${workspaceId}
        AND (
        (
          ${lane} IN ('all', 'dispatch')
          AND status = 'claimed'
          AND claim_token = ${claimToken}::uuid
          AND claim_expires_at > CURRENT_TIMESTAMP
        )
        OR (
          ${lane} IN ('all', 'dispatch')
          AND status = 'queued'
          AND EXISTS (
            SELECT 1
            FROM rednote_publish_attempts AS dispatch_attempt
            WHERE dispatch_attempt.workspace_id = local_publish_jobs.workspace_id
              AND dispatch_attempt.source_local_publish_job_id = local_publish_jobs.id
              AND dispatch_attempt.executor_type = 'worker'
              AND dispatch_attempt.active
              AND dispatch_attempt.approved_at IS NOT NULL
              AND dispatch_attempt.terminal_outcome IS NULL
              AND dispatch_attempt.dispatch_authorized_at IS NULL
              AND dispatch_attempt.superseded_by_attempt_id IS NULL
              AND (
                 dispatch_attempt.claim_token IS NULL
                 OR dispatch_attempt.claim_expires_at <= CURRENT_TIMESTAMP
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
                status = 'operator_attested'
                AND EXISTS (
                  SELECT 1
                  FROM local_publish_job_success_attestations AS attestation
                  WHERE attestation.id =
                    local_publish_jobs.success_attestation_id
                    AND attestation.provenance = 'worker_ambiguous'
                )
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
      )
        AND (
          ${expectedJobId ?? null}::uuid IS NULL
          OR (
            local_publish_jobs.id = ${expectedJobId ?? null}::uuid
            AND local_publish_jobs.status = 'operator_attested'
            AND local_publish_jobs.success_attestation_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM local_publish_job_success_attestations AS attestation
              WHERE attestation.id =
                local_publish_jobs.success_attestation_id
                AND attestation.provenance = 'worker_ambiguous'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM local_publish_job_success_attestation_release_acks AS release_ack
              WHERE release_ack.success_attestation_id =
                local_publish_jobs.success_attestation_id
            )
          )
        )
        AND external_disposition_request_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM plan_operator_scheduled_posts AS operator_scheduled
          WHERE operator_scheduled.notion_page_id =
            local_publish_jobs.notion_page_id
            AND operator_scheduled.workspace_id = local_publish_jobs.workspace_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM manual_reconciliation_requests AS disposition
          WHERE disposition.request_kind = 'targeted_local_job'
            AND disposition.source_local_job_id = local_publish_jobs.id
            AND disposition.workspace_id = local_publish_jobs.workspace_id
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
        claim_token = ${claimToken}::uuid,
        claim_attempts = CASE
          WHEN candidate.status = 'claimed' THEN claim_attempts
          ELSE claim_attempts + 1
        END,
        claimed_at = CASE
          WHEN candidate.status = 'claimed' THEN claimed_at
          ELSE CURRENT_TIMESTAMP
        END,
        claim_expires_at = CASE
          WHEN candidate.status = 'claimed' THEN claim_expires_at
          ELSE CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second')
        END,
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
      AND job.workspace_id = ${workspaceId}
      AND job.external_disposition_request_id IS NULL
    RETURNING job.*
  `;
  const row = result.rows[0];
  if (!row?.claim_token || !row.claim_expires_at) return null;
  return claimedResponse(row);
}

export async function releaseExpiredStoredLocalPublishClaims() {
  const result = await sql<{ id: string }>`
    WITH released AS (
      UPDATE local_publish_jobs
      SET status = CASE
            WHEN EXISTS (
              SELECT 1
              FROM rednote_publish_attempts AS attempt
              JOIN rednote_publish_attempt_receipts AS receipt
                ON receipt.attempt_id = attempt.id
              WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                AND attempt.source_local_publish_job_id = local_publish_jobs.id
                AND attempt.receipt_lookup_state = 'found'
            ) THEN 'verification_pending'
            WHEN dispatch_authorized_at IS NOT NULL
              OR EXISTS (
                SELECT 1
                FROM rednote_publish_attempts AS attempt
                WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                  AND attempt.source_local_publish_job_id = local_publish_jobs.id
                  AND attempt.dispatch_authorized_at IS NOT NULL
                  AND attempt.terminal_outcome IS NULL
                  AND attempt.superseded_by_attempt_id IS NULL
              )
              THEN 'verification_pending'
            ELSE 'failed'
          END,
          claim_token = NULL,
          claim_expires_at = CURRENT_TIMESTAMP,
          error_code = CASE
            WHEN EXISTS (
              SELECT 1
              FROM rednote_publish_attempts AS attempt
              JOIN rednote_publish_attempt_receipts AS receipt
                ON receipt.attempt_id = attempt.id
              WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                AND attempt.source_local_publish_job_id = local_publish_jobs.id
                AND attempt.receipt_lookup_state = 'found'
            ) THEN 'RECEIPT_RECONCILIATION_REQUIRED'
            WHEN dispatch_authorized_at IS NOT NULL
              OR EXISTS (
                SELECT 1
                FROM rednote_publish_attempts AS attempt
                WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                  AND attempt.source_local_publish_job_id = local_publish_jobs.id
                  AND attempt.dispatch_authorized_at IS NOT NULL
                  AND attempt.terminal_outcome IS NULL
                  AND attempt.superseded_by_attempt_id IS NULL
              )
              THEN 'PUBLISH_ATTEMPT_OUTCOME_UNKNOWN'
            ELSE 'CLAIM_LEASE_EXPIRED'
          END,
          error_message = CASE
            WHEN EXISTS (
              SELECT 1
              FROM rednote_publish_attempts AS attempt
              JOIN rednote_publish_attempt_receipts AS receipt
                ON receipt.attempt_id = attempt.id
              WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                AND attempt.source_local_publish_job_id = local_publish_jobs.id
                AND attempt.receipt_lookup_state = 'found'
            ) THEN 'A durable RedNote receipt was recorded before the claim expired. Verify and reconcile that receipt; do not publish again.'
            WHEN dispatch_authorized_at IS NOT NULL
              OR EXISTS (
                SELECT 1
                FROM rednote_publish_attempts AS attempt
                WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                  AND attempt.source_local_publish_job_id = local_publish_jobs.id
                  AND attempt.dispatch_authorized_at IS NOT NULL
                  AND attempt.terminal_outcome IS NULL
                  AND attempt.superseded_by_attempt_id IS NULL
              )
              THEN 'The publish lease expired after dispatch authorization. Automatic dispatch is permanently closed; reconcile the existing post or record operator handling.'
            ELSE 'The publish lease expired without a terminal result. Automatic dispatch is permanently closed; review the frozen attempt before operator handling or reconciliation.'
          END,
          next_verification_at = CASE
            WHEN EXISTS (
              SELECT 1
              FROM rednote_publish_attempts AS attempt
              JOIN rednote_publish_attempt_receipts AS receipt
                ON receipt.attempt_id = attempt.id
              WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                AND attempt.source_local_publish_job_id = local_publish_jobs.id
                AND attempt.receipt_lookup_state = 'found'
            ) THEN CURRENT_TIMESTAMP
            WHEN dispatch_authorized_at IS NOT NULL
              OR EXISTS (
                SELECT 1
                FROM rednote_publish_attempts AS attempt
                WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                  AND attempt.source_local_publish_job_id = local_publish_jobs.id
                  AND attempt.dispatch_authorized_at IS NOT NULL
                  AND attempt.terminal_outcome IS NULL
                  AND attempt.superseded_by_attempt_id IS NULL
              )
              THEN CURRENT_TIMESTAMP
            ELSE next_verification_at
          END,
          completed_at = CASE
            WHEN EXISTS (
              SELECT 1
              FROM rednote_publish_attempts AS attempt
              JOIN rednote_publish_attempt_receipts AS receipt
                ON receipt.attempt_id = attempt.id
              WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                AND attempt.source_local_publish_job_id = local_publish_jobs.id
                AND attempt.receipt_lookup_state = 'found'
            ) THEN completed_at
            WHEN dispatch_authorized_at IS NOT NULL
              OR EXISTS (
                SELECT 1
                FROM rednote_publish_attempts AS attempt
                WHERE attempt.workspace_id = local_publish_jobs.workspace_id
                  AND attempt.source_local_publish_job_id = local_publish_jobs.id
                  AND attempt.dispatch_authorized_at IS NOT NULL
                  AND attempt.terminal_outcome IS NULL
                  AND attempt.superseded_by_attempt_id IS NULL
              )
              THEN completed_at
            ELSE COALESCE(completed_at, CURRENT_TIMESTAMP)
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('claimed', 'staged')
        AND claim_expires_at <= CURRENT_TIMESTAMP
        AND dispatched_at IS NULL
        AND note_id IS NULL
        AND share_url IS NULL
        AND verified_at IS NULL
        AND reconciled_at IS NULL
        AND success_attestation_id IS NULL
        AND external_disposition_request_id IS NULL
      RETURNING id, workspace_id, status
    ),
    released_attempts AS (
      UPDATE rednote_publish_attempts AS attempt
      SET active = false,
          terminal_outcome = CASE
            WHEN released.status = 'verification_pending'
              THEN 'outcome_unknown'
            ELSE 'known_failed'
          END,
          terminal_at = CURRENT_TIMESTAMP,
          receipt_lookup_state = CASE
            WHEN EXISTS (
              SELECT 1
              FROM rednote_publish_attempt_receipts AS receipt
              WHERE receipt.attempt_id = attempt.id
            ) THEN 'found'
            WHEN released.status = 'verification_pending'
              THEN 'identity_pending'
            ELSE 'not_required'
          END,
          receipt_lookup_updated_at = CURRENT_TIMESTAMP,
          claim_expires_at = CURRENT_TIMESTAMP
      FROM released
      WHERE attempt.workspace_id = released.workspace_id
        AND attempt.source_local_publish_job_id = released.id
        AND attempt.terminal_outcome IS NULL
        AND attempt.superseded_by_attempt_id IS NULL
      RETURNING attempt.id, attempt.terminal_outcome
    ),
    attempt_events AS (
      INSERT INTO rednote_publish_attempt_events(
        attempt_id, event_type, occurred_at, actor_type, actor_id
      )
      SELECT id, 'terminal_outcome_recorded', CURRENT_TIMESTAMP, 'admin',
        'local_publish_lease_recovery'
      FROM released_attempts
      RETURNING attempt_id
    ),
    released_items AS (
      UPDATE rednote_publish_batch_items
      SET state = released.status,
          updated_at = CURRENT_TIMESTAMP
      FROM released
      WHERE rednote_publish_batch_items.local_publish_job_id = released.id
        AND rednote_publish_batch_items.state IN ('claimed', 'staged')
      RETURNING local_publish_job_id
    )
    SELECT id FROM released
  `;
  return result.rows.map((row) => row.id);
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
        AND (
          (${job.status} = 'operator_attested' AND item.state = 'operator_attested')
          OR (
            ${job.status} <> 'operator_attested'
            AND item.state IN (
              'queued', 'claimed', 'staged', 'submitted', 'scheduled',
              'verification_pending', 'verified'
            )
          )
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
      media: snapshotPublishMedia(job.snapshot),
      publishAt: job.snapshot.publishAt,
      lateAction: approved.dispatch_mode === 'post_now' ? 'post_now' : 'schedule',
    };
  }
  const expectedAccountId = job.snapshot.expectedAccountId?.trim();
  if (!expectedAccountId) {
    throw new LocalPublishJobError(
      'The frozen job is missing expectedAccountId and cannot be claimed',
      'EXPECTED_ACCOUNT_NOT_CONFIGURED',
      409,
    );
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
    mediaIndex: job.snapshot.mediaIndex,
    mediaUrl: job.snapshot.mediaUrl,
    media: snapshotPublishMedia(job.snapshot),
    ...(job.snapshot.compatibilityTrial
      ? { compatibilityTrial: job.snapshot.compatibilityTrial }
      : {}),
    ...(job.snapshot.thumbnailUrl ? { thumbnailUrl: job.snapshot.thumbnailUrl } : {}),
    ...(job.snapshot.publishAt ? { publishAt: job.snapshot.publishAt } : {}),
    expectedAccountId,
    notionLastEditedTime: job.snapshot.notionLastEditedTime,
    claimToken: row.claim_token,
    claimExpiresAt: timestamp(row.claim_expires_at),
    ...(job.dispatchAuthorizedAt
      ? { dispatchAuthorizedAt: job.dispatchAuthorizedAt }
      : {}),
    ...(job.batchAuthorization ? { batchAuthorization: job.batchAuthorization } : {}),
  };
  if (job.status === 'operator_attested') {
    if (!row.success_attestation_id || !job.nextVerificationAt) {
      throw new LocalPublishJobError(
        'An operator-attested job is missing its durable receipt or verification time',
        'INVALID_OPERATOR_ATTESTED_JOB',
        500,
      );
    }
    const attestation = await loadOperatorSuccessAttestation(row.success_attestation_id);
    if (!attestation || attestation.jobId !== job.id) {
      throw new LocalPublishJobError(
        'The operator attestation does not match its local job',
        'INVALID_OPERATOR_ATTESTED_JOB',
        500,
      );
    }
    if (
      !job.batchAuthorization ||
      row.batch_item_id !== attestation.itemId ||
      job.snapshot.notionPageId !== attestation.notionPageId ||
      job.batchAuthorization.batchId !== attestation.batchId ||
      job.batchAuthorization.manifestHash !== attestation.manifestHash ||
      job.batchAuthorization.itemHash !== attestation.itemHash ||
      job.batchAuthorization.snapshotRevision !== attestation.snapshotRevision ||
      job.batchAuthorization.publishAt !== attestation.requestedPublishAt ||
      job.batchAuthorization.lateAction !== 'schedule'
    ) {
      throw new LocalPublishJobError(
        'The bounded batch authorization does not match its operator attestation',
        'INVALID_OPERATOR_ATTESTED_JOB',
        500,
      );
    }
    return {
      ...base,
      status: 'operator_attested',
      verificationAttempts: job.verificationAttempts,
      nextVerificationAt: job.nextVerificationAt,
      successAttestation: attestation,
    };
  }
  if (
    job.status === 'submitted' ||
    job.status === 'scheduled' ||
    job.status === 'verification_pending'
  ) {
    if (!job.nextVerificationAt) {
      throw new LocalPublishJobError(
        'A verification job is missing its next verification time',
        'INVALID_VERIFICATION_JOB',
        500,
      );
    }
    return {
      ...base,
      status: job.status,
      ...(job.noteId ? { noteId: job.noteId } : {}),
      ...(job.shareUrl ? { shareUrl: job.shareUrl } : {}),
      verificationAttempts: job.verificationAttempts,
      nextVerificationAt: job.nextVerificationAt,
    };
  }
  if (job.status === 'verified') {
    if (!job.noteId) {
      throw new LocalPublishJobError(
        'A reconciliation job is missing its durable Note ID',
        'INVALID_RECONCILIATION_JOB',
        500,
      );
    }
    return {
      ...base,
      status: job.status,
      noteId: job.noteId,
      ...(job.shareUrl ? { shareUrl: job.shareUrl } : {}),
      verificationAttempts: job.verificationAttempts,
    };
  }
  return { ...base, status: job.status as 'claimed' | 'staged' };
}

export async function authorizeStoredLocalPublishJob(id: string, claimToken: string, workspaceId = 'legacy-local-publish') {
  const result = await sql<LocalPublishJobRow>`
    SELECT *
    FROM local_publish_jobs
    WHERE id = ${id}::uuid
      AND workspace_id = ${workspaceId}
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND external_disposition_request_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM plan_operator_scheduled_posts AS manual_handling
        WHERE manual_handling.notion_page_id = local_publish_jobs.notion_page_id
          AND manual_handling.workspace_id = local_publish_jobs.workspace_id
      )
      AND status IN (
        'claimed', 'staged', 'submitted', 'scheduled',
        'verification_pending', 'verified'
      )
    LIMIT 1
  `;
  if (result.rows[0]) return claimedResponse(result.rows[0]);
  const job = await loadResultJob(id, workspaceId);
  if (job.status === 'operator_attested') {
    throw new LocalPublishJobError(
      'The exact local attempt was operator-attested; release it and do not dispatch again',
      'JOB_OPERATOR_ATTESTED',
      409,
    );
  }
  throw new LocalPublishJobError(
    'The local publish claim is stale, expired, or revoked',
    'STALE_CLAIM',
    409,
  );
}

export async function heartbeatStoredLocalPublishJob(
  id: string,
  claimToken: string,
  workspaceId: string,
  leaseSeconds: number,
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET claim_expires_at = CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND workspace_id = ${workspaceId}
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND status IN (
        'claimed',
        'staged',
        'submitted',
        'scheduled',
        'verification_pending'
      )
      AND external_disposition_request_id IS NULL
    RETURNING *
  `;
  if (!result.rows[0]) {
    await loadResultJob(id, workspaceId);
    throw new LocalPublishJobError('The local publish claim is stale, expired, or revoked', 'STALE_CLAIM', 409);
  }
  return claimedResponse(result.rows[0]);
}

export async function consumeStoredDispatchAuthorization(id: string, claimToken: string, workspaceId = 'legacy-local-publish') {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET dispatch_authorized_at = COALESCE(dispatch_authorized_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND workspace_id = ${workspaceId}
      AND claim_token = ${claimToken}::uuid
      AND status = 'staged'
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND external_disposition_request_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM plan_operator_scheduled_posts AS manual_handling
        WHERE manual_handling.notion_page_id = local_publish_jobs.notion_page_id
          AND manual_handling.workspace_id = local_publish_jobs.workspace_id
      )
    RETURNING *
  `;
  if (result.rows[0]) return claimedResponse(result.rows[0]);
  await loadResultJob(id, workspaceId);
  throw new LocalPublishJobError(
    'The staged dispatch authorization is stale, expired, or revoked',
    'STALE_CLAIM',
    409,
  );
}

async function loadResultJob(id: string, workspaceId: string) {
  const result = await sql<LocalPublishJobRow>`
    SELECT job.*,
           EXISTS (
             SELECT 1
             FROM plan_operator_scheduled_posts AS manual_handling
             WHERE manual_handling.notion_page_id = job.notion_page_id
                AND manual_handling.workspace_id = job.workspace_id
           ) AS manual_handling_exists
    FROM local_publish_jobs AS job
    WHERE job.id = ${id}::uuid
      AND job.workspace_id = ${workspaceId}
    LIMIT 1
  `;
  const row = result.rows[0];
  if (!row) {
    throw new LocalPublishJobError('Local publish job was not found', 'JOB_NOT_FOUND', 404);
  }
  if (row.manual_handling_exists) {
    throw new LocalPublishJobError(
      'Operator handling superseded this local publish attempt',
      'MANUAL_HANDLING_EXISTS',
      409,
    );
  }
  return mapRow(row);
}

function assertMatchingClaim(job: StoredLocalPublishJob, claimToken: string) {
  if (job.status === 'operator_attested') {
    throw new LocalPublishJobError(
      'The exact local attempt was operator-attested; release it and do not dispatch again',
      'JOB_OPERATOR_ATTESTED',
      409,
    );
  }
  if (job.claimToken !== claimToken) {
    throw new LocalPublishJobError(
      'The local publish claim is no longer current',
      'STALE_CLAIM',
      409,
    );
  }
}

function assertUnexpiredClaim(job: StoredLocalPublishJob) {
  if (
    !job.claimExpiresAt ||
    new Date(job.claimExpiresAt).getTime() <= Date.now()
  ) {
    throw new LocalPublishJobError(
      'The local publish claim is stale, expired, or revoked',
      'STALE_CLAIM',
      409,
    );
  }
}

export async function stageStoredLocalPublishJob(id: string, claimToken: string, workspaceId = 'legacy-local-publish') {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'staged',
        staged_at = COALESCE(staged_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND workspace_id = ${workspaceId}
      AND status = 'claimed'
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND external_disposition_request_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM plan_operator_scheduled_posts AS manual_handling
        WHERE manual_handling.notion_page_id = local_publish_jobs.notion_page_id
          AND manual_handling.workspace_id = local_publish_jobs.workspace_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM manual_reconciliation_requests AS disposition
        WHERE disposition.request_kind = 'targeted_local_job'
          AND disposition.source_local_job_id = local_publish_jobs.id
          AND disposition.workspace_id = local_publish_jobs.workspace_id
      )
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id, workspaceId);
  assertMatchingClaim(job, claimToken);
  if (job.status === 'staged') return job;
  if (job.status === 'claimed') assertUnexpiredClaim(job);
  throw new LocalPublishJobError(
    'The job cannot transition to staged from its current state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function recordStoredAcknowledgedPublication(
  id: string,
  claimToken: string,
  receipt: {
    noteId: string;
    acknowledgedAt: string;
    accountId: string;
    accountCapturedAt: string;
    ownership: 'owned' | 'account_mismatch';
    xsecCapturedAt?: string;
    publicIndexStatus?: 'indexed' | 'pending' | 'not_found';
    publicIndexCheckedAt?: string;
    publicUrl?: string;
  },
  workspaceId = 'legacy-local-publish',
  immediateOutcomeAllowed = true,
) {
  const expectedAccountMatches = receipt.ownership === 'owned';
  const result = await sql<LocalPublishJobRow>`
    WITH updated AS (
      UPDATE local_publish_jobs
      SET status = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${expectedAccountMatches}
              AND ${immediateOutcomeAllowed}
              THEN 'verified'
            ELSE 'verification_pending'
          END,
          note_id = ${receipt.noteId},
          share_url = ${receipt.publicUrl ?? null},
          dispatched_at = COALESCE(dispatched_at, ${receipt.acknowledgedAt}::timestamptz),
          verified_at = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${expectedAccountMatches}
              AND ${immediateOutcomeAllowed}
              THEN COALESCE(verified_at, ${receipt.accountCapturedAt}::timestamptz)
            ELSE verified_at
          END,
          verification_attempts = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${expectedAccountMatches}
              AND ${immediateOutcomeAllowed}
              THEN verification_attempts
            ELSE verification_attempts + 1
          END,
          next_verification_at = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${expectedAccountMatches}
              AND ${immediateOutcomeAllowed}
              THEN NULL
            ELSE CURRENT_TIMESTAMP + INTERVAL '15 minutes'
          END,
          receipt_contract_version = 'rednote-worker-result/v2',
          receipt_outcome = 'acknowledged',
          receipt_acknowledged_at = ${receipt.acknowledgedAt}::timestamptz,
          authenticated_account_id = ${receipt.accountId},
          authenticated_account_at = ${receipt.accountCapturedAt}::timestamptz,
          xsec_accessible_at = ${receipt.xsecCapturedAt ?? null}::timestamptz,
          public_index_status = ${receipt.publicIndexStatus ?? null},
          public_index_checked_at = ${receipt.publicIndexCheckedAt ?? null}::timestamptz,
          error_code = CASE
            WHEN NOT ${immediateOutcomeAllowed}
              THEN 'UNEXPECTED_IMMEDIATE_OUTCOME'
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${expectedAccountMatches}
              THEN NULL
            ELSE 'ACCOUNT_MISMATCH'
          END,
          error_message = CASE
            WHEN NOT ${immediateOutcomeAllowed}
              THEN 'A schedule-authorized attempt returned an immediate publication receipt. Automatic dispatch is permanently closed; verify and reconcile the existing post.'
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${expectedAccountMatches}
              THEN NULL
            ELSE 'Authenticated Creator account does not match the frozen expectedAccountId'
          END,
          claim_expires_at = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${expectedAccountMatches}
              AND ${immediateOutcomeAllowed}
              THEN claim_expires_at
            ELSE CURRENT_TIMESTAMP
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid
        AND workspace_id = ${workspaceId}
        AND status IN ('claimed', 'staged', 'submitted', 'scheduled', 'verification_pending')
        AND claim_token = ${claimToken}::uuid
        AND claim_expires_at > CURRENT_TIMESTAMP
        AND external_disposition_request_id IS NULL
      RETURNING *
    ),
    evidence AS (
      INSERT INTO rednote_publication_evidence(
        workspace_id, local_publish_job_id, attempt_id, note_id,
        evidence_kind, captured_at, account_id, evidence_status, public_url
      )
      SELECT workspace_id, id,
        (SELECT attempt.id FROM rednote_publish_attempts AS attempt
         WHERE attempt.workspace_id = updated.workspace_id
           AND attempt.source_local_publish_job_id = updated.id
         ORDER BY attempt.created_at DESC LIMIT 1),
        ${receipt.noteId}, 'authenticated_account',
        ${receipt.accountCapturedAt}::timestamptz, ${receipt.accountId},
        CASE
          WHEN updated.snapshot->>'expectedAccountId' = ${receipt.accountId}
            AND ${expectedAccountMatches}
            THEN 'owned'
          ELSE 'account_mismatch'
        END,
        NULL
      FROM updated
      UNION ALL
      SELECT workspace_id, id, NULL, ${receipt.noteId}, 'xsec_access',
        ${receipt.xsecCapturedAt ?? receipt.accountCapturedAt}::timestamptz,
        NULL, 'accessible', NULL
      FROM updated WHERE ${receipt.xsecCapturedAt ?? null}::timestamptz IS NOT NULL
      UNION ALL
      SELECT workspace_id, id, NULL, ${receipt.noteId}, 'public_index',
        ${receipt.publicIndexCheckedAt ?? receipt.accountCapturedAt}::timestamptz,
        NULL, ${receipt.publicIndexStatus ?? 'pending'}, ${receipt.publicUrl ?? null}
      FROM updated WHERE ${receipt.publicIndexStatus ?? null}::text IS NOT NULL
      RETURNING id
    )
    SELECT * FROM updated
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);
  const job = await loadResultJob(id, workspaceId);
  assertMatchingClaim(job, claimToken);
  if (
    ['verified', 'reconciled', 'verification_pending'].includes(job.status)
    && job.noteId === receipt.noteId
    && job.receiptOutcome === 'acknowledged'
  ) {
    return job;
  }
  if (job.status === 'claimed' || job.status === 'staged') assertUnexpiredClaim(job);
  throw new LocalPublishJobError(
    'The acknowledged result cannot be recorded from this state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function recordStoredScheduledAcknowledgement(
  id: string,
  claimToken: string,
  receipt: {
    acknowledgedAt: string;
    scheduledFor: string;
    accountId: string;
    accountCapturedAt: string;
    ownership: 'owned' | 'account_mismatch';
    noteId?: string;
  },
  workspaceId = 'legacy-local-publish',
  scheduleMatches = true,
) {
  const ownershipOwned = receipt.ownership === 'owned';
  const result = await sql<LocalPublishJobRow>`
    WITH updated AS (
      UPDATE local_publish_jobs
      SET status = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${ownershipOwned}
              AND ${scheduleMatches}
              THEN 'scheduled'
            ELSE 'verification_pending'
          END,
          note_id = COALESCE(note_id, ${receipt.noteId ?? null}),
          dispatched_at = COALESCE(
            dispatched_at,
            ${receipt.acknowledgedAt}::timestamptz
          ),
          receipt_contract_version = 'rednote-worker-result/v2',
          receipt_outcome = 'scheduled',
          receipt_acknowledged_at = ${receipt.acknowledgedAt}::timestamptz,
          authenticated_account_id = ${receipt.accountId},
          authenticated_account_at = ${receipt.accountCapturedAt}::timestamptz,
          verification_attempts = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${ownershipOwned}
              AND ${scheduleMatches}
              THEN 0
            ELSE verification_attempts + 1
          END,
          next_verification_at = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${ownershipOwned}
              AND ${scheduleMatches}
              THEN GREATEST(
                CURRENT_TIMESTAMP,
                ${receipt.scheduledFor}::timestamptz
              ) + INTERVAL '15 minutes'
            ELSE CURRENT_TIMESTAMP + INTERVAL '15 minutes'
          END,
          claim_expires_at = CURRENT_TIMESTAMP,
          error_code = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${ownershipOwned}
              AND ${scheduleMatches}
              THEN NULL
            WHEN NOT ${scheduleMatches}
              THEN 'SCHEDULE_READBACK_MISMATCH'
            ELSE 'ACCOUNT_MISMATCH'
          END,
          error_message = CASE
            WHEN snapshot->>'expectedAccountId' = ${receipt.accountId}
              AND ${ownershipOwned}
              AND ${scheduleMatches}
              THEN NULL
            WHEN NOT ${scheduleMatches}
              THEN 'RedNote scheduled the post for a different time than the frozen publishing packet'
            ELSE 'Authenticated Creator account does not match the frozen expectedAccountId'
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid
        AND workspace_id = ${workspaceId}
        AND status IN ('claimed', 'staged')
        AND claim_token = ${claimToken}::uuid
        AND claim_expires_at > CURRENT_TIMESTAMP
        AND external_disposition_request_id IS NULL
        AND (note_id IS NULL OR note_id = ${receipt.noteId ?? null})
      RETURNING *
    ),
    evidence AS (
      INSERT INTO rednote_publication_evidence(
        workspace_id, local_publish_job_id, attempt_id, note_id,
        evidence_kind, captured_at, account_id, evidence_status
      )
      SELECT workspace_id, id,
        (SELECT attempt.id FROM rednote_publish_attempts AS attempt
         WHERE attempt.workspace_id = updated.workspace_id
           AND attempt.source_local_publish_job_id = updated.id
         ORDER BY attempt.created_at DESC LIMIT 1),
        ${receipt.noteId ?? null}, 'authenticated_account',
        ${receipt.accountCapturedAt}::timestamptz, ${receipt.accountId},
        CASE
          WHEN updated.snapshot->>'expectedAccountId' = ${receipt.accountId}
            AND ${ownershipOwned}
            THEN 'owned'
          ELSE 'account_mismatch'
        END
      FROM updated
      RETURNING id
    )
    SELECT * FROM updated
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);
  const job = await loadResultJob(id, workspaceId);
  assertMatchingClaim(job, claimToken);
  if (
    ['scheduled', 'verification_pending'].includes(job.status)
    && job.receiptOutcome === 'scheduled'
    && job.authenticatedAccountId === receipt.accountId
    && (!receipt.noteId || !job.noteId || job.noteId === receipt.noteId)
  ) {
    return job;
  }
  if (job.status === 'claimed' || job.status === 'staged') assertUnexpiredClaim(job);
  throw new LocalPublishJobError(
    'The scheduled acknowledgement cannot be recorded from this state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function recordLateStoredWorkerTerminalResult(
  id: string,
  claimToken: string,
  result: LateStoredWorkerTerminalResult,
  workspaceId = 'legacy-local-publish',
): Promise<StoredLocalPublishJob | null> {
  const candidateResult = await sql<LateTerminalCandidateRow>`
    SELECT job.*,
      attempt.id AS attempt_id,
      attempt.executor_id AS attempt_executor_id,
      attempt.terminal_outcome AS attempt_terminal_outcome,
      attempt.dispatch_authorized_at AS attempt_dispatch_authorized_at,
      attempt.frozen_payload->'browserPayload'->>'timingMode'
        AS frozen_timing_mode,
      attempt.frozen_payload->'browserPayload'->>'targetPublishAt'
        AS frozen_target_publish_at,
      attempt.frozen_payload->'browserPayload'->>'expectedAccountId'
        AS frozen_expected_account_id,
      receipt.rednote_note_id AS attempt_receipt_note_id,
      (
        SELECT evidence.evidence_status
        FROM rednote_publication_evidence AS evidence
        WHERE evidence.attempt_id = attempt.id
          AND evidence.evidence_kind = 'authenticated_account'
          AND evidence.account_id = job.authenticated_account_id
        ORDER BY evidence.created_at DESC
        LIMIT 1
      ) AS canonical_account_ownership,
      (
        SELECT event.diagnostics->>'resultDigest'
        FROM rednote_publish_attempt_events AS event
        WHERE event.attempt_id = attempt.id
          AND event.event_type = 'execution_evidence'
          AND event.diagnostics->>'kind' = 'late_terminal_result_accepted'
        ORDER BY event.created_at DESC
        LIMIT 1
      ) AS late_result_digest,
      EXISTS (
        SELECT 1
        FROM rednote_publish_attempt_events AS event
        WHERE event.attempt_id = attempt.id
          AND event.event_type = 'terminal_outcome_recorded'
          AND event.actor_type = 'worker'
      ) AS worker_terminal_event_exists
    FROM local_publish_jobs AS job
    JOIN rednote_publish_attempts AS attempt
      ON attempt.workspace_id = job.workspace_id
      AND attempt.source_local_publish_job_id = job.id
      AND attempt.executor_type = 'worker'
      AND attempt.claim_token = ${claimToken}::uuid
      AND attempt.superseded_by_attempt_id IS NULL
    LEFT JOIN rednote_publish_attempt_receipts AS receipt
      ON receipt.attempt_id = attempt.id
    WHERE job.id = ${id}::uuid
      AND job.workspace_id = ${workspaceId}
      AND job.status IN (
        'claimed', 'staged', 'failed', 'submitted', 'scheduled',
        'verification_pending', 'verified', 'reconciled'
      )
      AND (
        job.claim_expires_at <= CURRENT_TIMESTAMP
        OR job.claim_token IS NULL
      )
      AND job.external_disposition_request_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM plan_operator_scheduled_posts AS manual_handling
        WHERE manual_handling.notion_page_id = job.notion_page_id
          AND manual_handling.workspace_id = job.workspace_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM manual_reconciliation_requests AS disposition
        WHERE disposition.request_kind = 'targeted_local_job'
          AND disposition.source_local_job_id = job.id
          AND disposition.workspace_id = job.workspace_id
      )
    ORDER BY attempt.created_at DESC
    LIMIT 1
  `;
  const candidate = candidateResult.rows[0];
  if (!candidate) {
    const current = await sql<LocalPublishJobRow>`
      SELECT *
      FROM local_publish_jobs
      WHERE id = ${id}::uuid
        AND workspace_id = ${workspaceId}
        AND status IN (
          'claimed', 'staged', 'failed', 'submitted', 'scheduled',
          'verification_pending', 'verified', 'reconciled'
        )
        AND (
          claim_expires_at <= CURRENT_TIMESTAMP
          OR claim_token IS NULL
        )
      LIMIT 1
    `;
    if (current.rows[0]) {
      throw new LocalPublishJobError(
        'The late worker result does not match the original claim token',
        'STALE_CLAIM',
        409,
      );
    }
    return null;
  }

  const job = mapRow(candidate);
  const digest = lateTerminalResultDigest(result);
  if (job.receiptOutcome) {
    assertLateTerminalReplayMatches(job, candidate, result, digest);
    return job;
  }
  if (candidate.worker_terminal_event_exists) {
    throw new LocalPublishJobError(
      'The linked attempt already has a worker terminal outcome without a canonical job receipt',
      'LATE_RESULT_CONFLICT',
      409,
    );
  }

  let attemptOutcome: 'accepted' | 'known_failed' | 'outcome_unknown';
  let jobStatus: 'failed' | 'scheduled' | 'verification_pending';
  let receiptState: 'found' | 'identity_pending' | 'not_required';
  let accountMatches = false;
  if (result.outcome === 'scheduled') {
    if (
      candidate.frozen_timing_mode !== 'scheduled'
      || new Date(result.scheduledFor).getTime()
        !== new Date(candidate.frozen_target_publish_at).getTime()
      || !candidate.attempt_dispatch_authorized_at
    ) {
      throw new LocalPublishJobError(
        'The late scheduled result does not match the frozen authorized schedule',
        'SCHEDULE_READBACK_MISMATCH',
        409,
      );
    }
    accountMatches = result.authenticatedAccount.ownership === 'owned'
      && result.authenticatedAccount.accountId
        === candidate.frozen_expected_account_id;
    attemptOutcome = accountMatches ? 'accepted' : 'outcome_unknown';
    jobStatus = accountMatches ? 'scheduled' : 'verification_pending';
    receiptState = result.noteId ? 'found' : 'identity_pending';
  } else if (result.outcome === 'ambiguous') {
    if (!candidate.attempt_dispatch_authorized_at) {
      throw new LocalPublishJobError(
        'An ambiguous late result requires durable dispatch authorization',
        'LATE_RESULT_CONFLICT',
        409,
      );
    }
    attemptOutcome = 'outcome_unknown';
    jobStatus = 'verification_pending';
    receiptState = 'identity_pending';
  } else {
    if (
      candidate.dispatched_at
      || candidate.note_id
      || candidate.share_url
      || candidate.attempt_receipt_note_id
      || candidate.attempt_terminal_outcome === 'accepted'
    ) {
      throw new LocalPublishJobError(
        'A rejected late result conflicts with durable dispatch or receipt evidence',
        'LATE_RESULT_CONFLICT',
        409,
      );
    }
    attemptOutcome = 'known_failed';
    jobStatus = 'failed';
    receiptState = 'not_required';
  }

  const acknowledgedAt = result.outcome === 'scheduled'
    ? result.acknowledgedAt
    : result.occurredAt;
  const accountId = result.outcome === 'scheduled'
    ? result.authenticatedAccount.accountId
    : null;
  const accountCapturedAt = result.outcome === 'scheduled'
    ? result.authenticatedAccount.capturedAt
    : null;
  const noteId = result.outcome === 'scheduled' ? result.noteId ?? null : null;
  const errorCode = result.outcome === 'scheduled'
    ? (accountMatches ? null : 'ACCOUNT_MISMATCH')
    : result.code;
  const errorMessage = result.outcome === 'scheduled'
    ? (
        accountMatches
          ? null
          : 'Authenticated Creator account does not match the frozen expectedAccountId'
      )
    : result.message;
  const scheduledFor = result.outcome === 'scheduled'
    ? result.scheduledFor
    : null;

  const recorded = await sql<LocalPublishJobRow>`
    WITH candidate AS MATERIALIZED (
      SELECT job.id AS job_id, attempt.id AS attempt_id,
        attempt.executor_id, job.batch_item_id
      FROM local_publish_jobs AS job
      JOIN rednote_publish_attempts AS attempt
        ON attempt.workspace_id = job.workspace_id
        AND attempt.source_local_publish_job_id = job.id
        AND attempt.executor_type = 'worker'
        AND attempt.claim_token = ${claimToken}::uuid
        AND attempt.superseded_by_attempt_id IS NULL
      WHERE job.id = ${id}::uuid
        AND job.workspace_id = ${workspaceId}
        AND job.status IN (
          'claimed', 'staged', 'failed', 'scheduled', 'verification_pending'
        )
        AND job.receipt_outcome IS NULL
        AND (
          job.claim_expires_at <= CURRENT_TIMESTAMP
          OR job.claim_token IS NULL
        )
        AND job.external_disposition_request_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM rednote_publish_attempt_events AS terminal_event
          WHERE terminal_event.attempt_id = attempt.id
            AND terminal_event.event_type = 'terminal_outcome_recorded'
            AND terminal_event.actor_type = 'worker'
        )
        AND (
          attempt.terminal_outcome IS NULL
          OR attempt.terminal_outcome = ${attemptOutcome}
          OR (
            attempt.terminal_outcome = 'outcome_unknown'
            AND ${attemptOutcome} IN ('accepted', 'known_failed')
          )
        )
        AND (
          ${result.outcome} <> 'rejected'
          OR (
            job.dispatched_at IS NULL
            AND job.note_id IS NULL
            AND job.share_url IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM rednote_publish_attempt_receipts AS receipt
              WHERE receipt.attempt_id = attempt.id
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM plan_operator_scheduled_posts AS manual_handling
          WHERE manual_handling.notion_page_id = job.notion_page_id
            AND manual_handling.workspace_id = job.workspace_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM manual_reconciliation_requests AS disposition
          WHERE disposition.request_kind = 'targeted_local_job'
            AND disposition.source_local_job_id = job.id
            AND disposition.workspace_id = job.workspace_id
        )
      FOR UPDATE OF job, attempt
    ),
    updated_attempt AS (
      UPDATE rednote_publish_attempts AS attempt
      SET active = false,
          terminal_outcome = ${attemptOutcome},
          terminal_at = COALESCE(terminal_at, CURRENT_TIMESTAMP),
          receipt_lookup_state = ${receiptState},
          receipt_lookup_updated_at = CURRENT_TIMESTAMP,
          claim_expires_at = CURRENT_TIMESTAMP
      FROM candidate
      WHERE attempt.id = candidate.attempt_id
      RETURNING attempt.id
    ),
    attempt_receipt AS (
      INSERT INTO rednote_publish_attempt_receipts(
        attempt_id, rednote_note_id, platform_publish_time, provenance
      )
      SELECT candidate.attempt_id, ${noteId},
        ${acknowledgedAt}::timestamptz,
        jsonb_build_object(
          'kind', 'late_rednote_worker_result_v2_scheduled',
          'scheduledFor', ${scheduledFor}::text,
          'authenticatedAccountId', ${accountId}::text,
          'authenticatedAccountCapturedAt', ${accountCapturedAt}::text
        )
      FROM candidate
      JOIN updated_attempt ON updated_attempt.id = candidate.attempt_id
      WHERE ${result.outcome} = 'scheduled'
        AND ${noteId}::text IS NOT NULL
      ON CONFLICT(attempt_id) DO NOTHING
      RETURNING attempt_id
    ),
    updated_job AS (
      UPDATE local_publish_jobs AS job
      SET status = ${jobStatus},
          claim_token = NULL,
          claim_expires_at = CURRENT_TIMESTAMP,
          dispatched_at = CASE
            WHEN ${result.outcome} IN ('scheduled', 'ambiguous')
              THEN COALESCE(dispatched_at, ${acknowledgedAt}::timestamptz)
            ELSE dispatched_at
          END,
          note_id = CASE
            WHEN ${result.outcome} = 'scheduled'
              THEN COALESCE(note_id, ${noteId})
            ELSE note_id
          END,
          receipt_contract_version = 'rednote-worker-result/v2',
          receipt_outcome = ${result.outcome},
          receipt_acknowledged_at = ${acknowledgedAt}::timestamptz,
          authenticated_account_id = ${accountId},
          authenticated_account_at = ${accountCapturedAt}::timestamptz,
          verification_attempts = CASE
            WHEN ${jobStatus} = 'scheduled' THEN 0
            WHEN ${jobStatus} = 'verification_pending'
              THEN verification_attempts + 1
            ELSE verification_attempts
          END,
          next_verification_at = CASE
            WHEN ${jobStatus} = 'scheduled'
              THEN GREATEST(
                CURRENT_TIMESTAMP,
                ${scheduledFor}::timestamptz
              ) + INTERVAL '15 minutes'
            WHEN ${jobStatus} = 'verification_pending'
              THEN CURRENT_TIMESTAMP + INTERVAL '15 minutes'
            ELSE next_verification_at
          END,
          error_code = ${errorCode},
          error_message = ${errorMessage},
          completed_at = CASE
            WHEN ${jobStatus} = 'failed'
              THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
            ELSE completed_at
          END,
          updated_at = CURRENT_TIMESTAMP
      FROM candidate
      JOIN updated_attempt ON updated_attempt.id = candidate.attempt_id
      WHERE job.id = candidate.job_id
      RETURNING job.*
    ),
    updated_item AS (
      UPDATE rednote_publish_batch_items AS item
      SET state = ${jobStatus},
          updated_at = CURRENT_TIMESTAMP
      FROM candidate
      JOIN updated_job ON updated_job.id = candidate.job_id
      WHERE item.local_publish_job_id = candidate.job_id
        AND item.state IN (
          'claimed', 'staged', 'failed', 'scheduled', 'verification_pending'
        )
      RETURNING item.id
    ),
    evidence AS (
      INSERT INTO rednote_publication_evidence(
        workspace_id, local_publish_job_id, attempt_id, note_id,
        evidence_kind, captured_at, account_id, evidence_status
      )
      SELECT ${workspaceId}, candidate.job_id, candidate.attempt_id,
        ${noteId}, 'authenticated_account',
        ${accountCapturedAt}::timestamptz, ${accountId},
        CASE WHEN ${accountMatches} THEN 'owned' ELSE 'account_mismatch' END
      FROM candidate
      JOIN updated_job ON updated_job.id = candidate.job_id
      WHERE ${result.outcome} = 'scheduled'
      RETURNING id
    ),
    audit_event AS (
      INSERT INTO rednote_publish_attempt_events(
        attempt_id, event_type, occurred_at, actor_type, actor_id, diagnostics
      )
      SELECT candidate.attempt_id, 'execution_evidence', CURRENT_TIMESTAMP,
        'worker', candidate.executor_id,
        jsonb_build_object(
          'kind', 'late_terminal_result_accepted',
          'contractVersion', 'rednote-worker-result/v2',
          'outcome', ${result.outcome}::text,
          'resultDigest', ${digest}::text
        )
      FROM candidate
      JOIN updated_job ON updated_job.id = candidate.job_id
      RETURNING attempt_id
    )
    SELECT * FROM updated_job
  `;
  if (recorded.rows[0]) return mapRow(recorded.rows[0]);

  const replayResult = await sql<LateTerminalCandidateRow>`
    SELECT job.*,
      attempt.id AS attempt_id,
      attempt.executor_id AS attempt_executor_id,
      attempt.terminal_outcome AS attempt_terminal_outcome,
      attempt.dispatch_authorized_at AS attempt_dispatch_authorized_at,
      attempt.frozen_payload->'browserPayload'->>'timingMode'
        AS frozen_timing_mode,
      attempt.frozen_payload->'browserPayload'->>'targetPublishAt'
        AS frozen_target_publish_at,
      attempt.frozen_payload->'browserPayload'->>'expectedAccountId'
        AS frozen_expected_account_id,
      receipt.rednote_note_id AS attempt_receipt_note_id,
      (
        SELECT evidence.evidence_status
        FROM rednote_publication_evidence AS evidence
        WHERE evidence.attempt_id = attempt.id
          AND evidence.evidence_kind = 'authenticated_account'
          AND evidence.account_id = job.authenticated_account_id
        ORDER BY evidence.created_at DESC
        LIMIT 1
      ) AS canonical_account_ownership,
      (
        SELECT event.diagnostics->>'resultDigest'
        FROM rednote_publish_attempt_events AS event
        WHERE event.attempt_id = attempt.id
          AND event.event_type = 'execution_evidence'
          AND event.diagnostics->>'kind' = 'late_terminal_result_accepted'
        ORDER BY event.created_at DESC
        LIMIT 1
      ) AS late_result_digest,
      false AS worker_terminal_event_exists
    FROM local_publish_jobs AS job
    JOIN rednote_publish_attempts AS attempt
      ON attempt.workspace_id = job.workspace_id
      AND attempt.source_local_publish_job_id = job.id
      AND attempt.claim_token = ${claimToken}::uuid
    LEFT JOIN rednote_publish_attempt_receipts AS receipt
      ON receipt.attempt_id = attempt.id
    WHERE job.id = ${id}::uuid
      AND job.workspace_id = ${workspaceId}
    ORDER BY attempt.created_at DESC
    LIMIT 1
  `;
  const replay = replayResult.rows[0];
  if (replay?.receipt_outcome) {
    assertLateTerminalReplayMatches(mapRow(replay), replay, result, digest);
    return mapRow(replay);
  }
  throw new LocalPublishJobError(
    'The late worker result is stale or conflicts with terminal state',
    'LATE_RESULT_CONFLICT',
    409,
  );
}

export async function recordStoredAmbiguousOutcome(
  id: string,
  claimToken: string,
  occurredAt: string,
  code: string,
  message: string,
  workspaceId = 'legacy-local-publish',
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'verification_pending',
        dispatched_at = COALESCE(dispatched_at, ${occurredAt}::timestamptz),
        receipt_contract_version = 'rednote-worker-result/v2',
        receipt_outcome = 'ambiguous',
        verification_attempts = verification_attempts + 1,
        next_verification_at = CURRENT_TIMESTAMP + INTERVAL '15 minutes',
        claim_expires_at = CURRENT_TIMESTAMP,
        error_code = ${code},
        error_message = ${message},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND workspace_id = ${workspaceId}
      AND status IN ('claimed', 'staged')
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND external_disposition_request_id IS NULL
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);
  const job = await loadResultJob(id, workspaceId);
  assertMatchingClaim(job, claimToken);
  if (
    job.status === 'verification_pending'
    && job.receiptOutcome === 'ambiguous'
    && job.errorCode === code
  ) {
    return job;
  }
  if (job.status === 'claimed' || job.status === 'staged') assertUnexpiredClaim(job);
  throw new LocalPublishJobError(
    'The ambiguous outcome cannot be recorded from this state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function recordStoredRejectedOutcome(
    id: string,
    claimToken: string,
    occurredAt: string,
    code: string,
    message: string,
    workspaceId = 'legacy-local-publish',
  ) {
    const result = await sql<LocalPublishJobRow>`
      WITH failed AS (
        UPDATE local_publish_jobs
        SET status = 'failed',
            receipt_contract_version = 'rednote-worker-result/v2',
            receipt_outcome = 'rejected',
            receipt_acknowledged_at = ${occurredAt}::timestamptz,
            claim_token = NULL,
            claim_expires_at = CURRENT_TIMESTAMP,
            error_code = ${code},
            error_message = ${message},
            completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}::uuid
          AND workspace_id = ${workspaceId}
          AND status IN ('claimed', 'staged')
          AND claim_token = ${claimToken}::uuid
          AND claim_expires_at > CURRENT_TIMESTAMP
          AND external_disposition_request_id IS NULL
        RETURNING *
      ),
      failed_items AS (
        UPDATE rednote_publish_batch_items
        SET state = 'failed',
            updated_at = CURRENT_TIMESTAMP
        WHERE local_publish_job_id IN (SELECT id FROM failed)
          AND state IN ('claimed', 'staged')
        RETURNING local_publish_job_id
      )
      SELECT * FROM failed
    `;
    if (result.rows[0]) return mapRow(result.rows[0]);
    const job = await loadResultJob(id, workspaceId);
    if (
      job.status === 'failed'
      && job.receiptOutcome === 'rejected'
      && job.errorCode === code
    ) {
      return job;
    }
    assertMatchingClaim(job, claimToken);
    if (job.status === 'claimed' || job.status === 'staged') assertUnexpiredClaim(job);
    throw new LocalPublishJobError(
      'The rejected outcome cannot be recorded from this state',
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
  workspaceId = 'legacy-local-publish',
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
      AND workspace_id = ${workspaceId}
      AND status IN ('claimed', 'staged')
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND external_disposition_request_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM plan_operator_scheduled_posts AS manual_handling
        WHERE manual_handling.notion_page_id = local_publish_jobs.notion_page_id
          AND manual_handling.workspace_id = local_publish_jobs.workspace_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM manual_reconciliation_requests AS disposition
        WHERE disposition.request_kind = 'targeted_local_job'
          AND disposition.source_local_job_id = local_publish_jobs.id
          AND disposition.workspace_id = local_publish_jobs.workspace_id
      )
      AND (
        (
          ${status} = 'scheduled'
          AND COALESCE(snapshot->>'publishAt', snapshot->>'scheduledDate') IS NOT NULL
        )
        OR (
          ${status} = 'submitted'
          AND (
            COALESCE(snapshot->>'publishAt', snapshot->>'scheduledDate') IS NULL
            OR EXISTS (
              SELECT 1
              FROM rednote_publish_attempts AS immediate_attempt
              WHERE immediate_attempt.workspace_id = local_publish_jobs.workspace_id
                AND immediate_attempt.source_local_publish_job_id = local_publish_jobs.id
                AND immediate_attempt.authorization_kind = 'ready_x3'
                AND immediate_attempt.frozen_payload->'browserPayload'->>'timingMode' = 'post_now'
            )
          )
        )
      )
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id, workspaceId);
  assertMatchingClaim(job, claimToken);
  if (
    ['submitted', 'scheduled', 'verification_pending', 'verified', 'reconciled']
      .includes(job.status) &&
    job.noteId === noteId &&
    job.shareUrl === shareUrl
  ) {
    return job;
  }
  if (job.status === 'claimed' || job.status === 'staged') {
    assertUnexpiredClaim(job);
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
  workspaceId = 'legacy-local-publish',
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'verification_pending',
        verification_attempts = verification_attempts + 1,
        next_verification_at = CURRENT_TIMESTAMP + (
          CASE LEAST(verification_attempts, 3)
            WHEN 0 THEN ${backoffSeconds[1]}::integer
            WHEN 1 THEN ${backoffSeconds[2]}::integer
            ELSE ${backoffSeconds[3]}::integer
          END * INTERVAL '1 second'
        ),
        error_code = ${code},
        error_message = ${message},
        claim_expires_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND workspace_id = ${workspaceId}
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND note_id = ${noteId}
      AND share_url = ${shareUrl}
      AND external_disposition_request_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM plan_operator_scheduled_posts AS manual_handling
        WHERE manual_handling.notion_page_id = local_publish_jobs.notion_page_id
          AND manual_handling.workspace_id = local_publish_jobs.workspace_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM manual_reconciliation_requests AS disposition
        WHERE disposition.request_kind = 'targeted_local_job'
          AND disposition.source_local_job_id = local_publish_jobs.id
          AND disposition.workspace_id = local_publish_jobs.workspace_id
      )
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

  const job = await loadResultJob(id, workspaceId);
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

  if (
    job.status === 'submitted' ||
    job.status === 'scheduled' ||
    (
      job.status === 'verification_pending' &&
      job.noteId === noteId &&
      job.shareUrl === shareUrl
    )
  ) {
    assertUnexpiredClaim(job);
  }
  throw new LocalPublishJobError(
    'The job cannot defer verification from its current state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function deferStoredOperatorAttestedVerification(
  id: string,
  claimToken: string,
  code: string,
  message: string,
  verificationBackoffSeconds: readonly [number, number, number, number],
  workspaceId = 'legacy-local-publish',
) {
  if (code === ATTESTATION_RELEASE_CONSUMED_CODE) {
    if (message !== ATTESTATION_RELEASE_CONSUMED_MESSAGE) {
      throw new LocalPublishJobError(
        'The attestation release acknowledgement message does not match the contract',
        'ATTESTATION_RELEASE_ACK_MISMATCH',
        409,
      );
    }
    await acknowledgeOperatorSuccessAttestationRelease(id, claimToken);
    return loadResultJob(id, workspaceId);
  }
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET verification_attempts = verification_attempts + 1,
        next_verification_at = CURRENT_TIMESTAMP + (
          CASE LEAST(verification_attempts, 3)
            WHEN 0 THEN ${verificationBackoffSeconds[1]}::integer
            WHEN 1 THEN ${verificationBackoffSeconds[2]}::integer
            ELSE ${verificationBackoffSeconds[3]}::integer
          END * INTERVAL '1 second'
        ),
        claim_expires_at = CURRENT_TIMESTAMP,
        error_code = ${code},
        error_message = ${message},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND workspace_id = ${workspaceId}
      AND status = 'operator_attested'
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND success_attestation_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM local_publish_job_success_attestation_release_acks AS release_ack
        WHERE release_ack.success_attestation_id =
          local_publish_jobs.success_attestation_id
      )
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);
  const job = await loadResultJob(id, workspaceId);
  if (job.status === 'operator_attested') {
    if (job.claimToken !== claimToken) {
      throw new LocalPublishJobError(
        'The operator-attested verification claim is no longer current',
        'STALE_CLAIM',
        409,
      );
    }
    assertUnexpiredClaim(job);
    throw new LocalPublishJobError(
      'The matching local slot must be durably released before receipt verification',
      'ATTESTATION_RELEASE_REQUIRED',
      409,
    );
  }
  assertMatchingClaim(job, claimToken);
  assertUnexpiredClaim(job);
  throw new LocalPublishJobError(
    'The operator-attested verification cannot be deferred from its current state',
    'INVALID_JOB_TRANSITION',
    409,
  );
}

export async function failStoredLocalPublishJob(
  id: string,
  claimToken: string,
  code: string,
  message: string,
  workspaceId = 'legacy-local-publish',
) {
  const result = await sql<LocalPublishJobRow>`
    WITH failed AS (
      UPDATE local_publish_jobs
      SET status = 'failed',
          claim_token = NULL,
          claim_expires_at = CURRENT_TIMESTAMP,
          error_code = ${code},
          error_message = ${message},
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid
        AND workspace_id = ${workspaceId}
        AND status IN ('claimed', 'staged')
        AND claim_token = ${claimToken}::uuid
        AND claim_expires_at > CURRENT_TIMESTAMP
        AND external_disposition_request_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM plan_operator_scheduled_posts AS manual_handling
          WHERE manual_handling.notion_page_id = local_publish_jobs.notion_page_id
            AND manual_handling.workspace_id = local_publish_jobs.workspace_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM manual_reconciliation_requests AS disposition
          WHERE disposition.request_kind = 'targeted_local_job'
            AND disposition.source_local_job_id = local_publish_jobs.id
            AND disposition.workspace_id = local_publish_jobs.workspace_id
        )
      RETURNING *
    ),
    failed_items AS (
      UPDATE rednote_publish_batch_items
      SET state = 'failed',
          updated_at = CURRENT_TIMESTAMP
      WHERE local_publish_job_id IN (SELECT id FROM failed)
        AND state IN ('claimed', 'staged')
      RETURNING local_publish_job_id
    )
    SELECT * FROM failed
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id, workspaceId);
  if (job.status === 'failed' && job.errorCode === code && job.errorMessage === message) {
    return job;
  }
  assertMatchingClaim(job, claimToken);
  if (job.status === 'claimed' || job.status === 'staged') {
    assertUnexpiredClaim(job);
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
  workspaceId = 'legacy-local-publish',
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
      AND workspace_id = ${workspaceId}
      AND status IN (
        'claimed',
        'staged',
        'submitted',
        'scheduled',
        'operator_attested',
        'verification_pending'
      )
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND external_disposition_request_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM plan_operator_scheduled_posts AS manual_handling
        WHERE manual_handling.notion_page_id = local_publish_jobs.notion_page_id
          AND manual_handling.workspace_id = local_publish_jobs.workspace_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM manual_reconciliation_requests AS disposition
        WHERE disposition.request_kind = 'targeted_local_job'
          AND disposition.source_local_job_id = local_publish_jobs.id
          AND disposition.workspace_id = local_publish_jobs.workspace_id
      )
      AND (
        (
          status IN ('claimed', 'staged', 'operator_attested')
          AND (note_id IS NULL OR note_id = ${noteId})
          AND (share_url IS NULL OR share_url = ${shareUrl})
          AND (
            status <> 'operator_attested'
            OR EXISTS (
              SELECT 1
              FROM local_publish_job_success_attestation_release_acks AS release_ack
              WHERE release_ack.success_attestation_id =
                local_publish_jobs.success_attestation_id
            )
          )
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

  const job = await loadResultJob(id, workspaceId);
  if (job.status === 'operator_attested' && job.claimToken === claimToken) {
    assertUnexpiredClaim(job);
    throw new LocalPublishJobError(
      'The matching local slot must be durably released before receipt verification',
      'ATTESTATION_RELEASE_REQUIRED',
      409,
    );
  }
  assertMatchingClaim(job, claimToken);
  if (
    (job.status === 'verified' || job.status === 'reconciled') &&
    job.noteId === noteId &&
    job.shareUrl === shareUrl
  ) {
    return job;
  }
  if (
    (
      job.status === 'claimed' ||
      job.status === 'staged' ||
      job.status === 'operator_attested'
    ) &&
    !job.noteId &&
    !job.shareUrl
  ) {
    assertUnexpiredClaim(job);
  }
  if (
    (
      job.status === 'submitted' ||
      job.status === 'scheduled' ||
      job.status === 'verification_pending'
    ) &&
    job.noteId === noteId &&
    job.shareUrl === shareUrl
  ) {
    assertUnexpiredClaim(job);
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
  shareUrl: string | undefined,
  workspaceId = 'legacy-local-publish',
) {
  const result = await sql<LocalPublishJobRow>`
    UPDATE local_publish_jobs
    SET status = 'reconciled',
        reconciled_at = COALESCE(reconciled_at, CURRENT_TIMESTAMP),
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
      AND workspace_id = ${workspaceId}
      AND status = 'verified'
      AND claim_token = ${claimToken}::uuid
      AND claim_expires_at > CURRENT_TIMESTAMP
      AND note_id = ${noteId}
      AND share_url IS NOT DISTINCT FROM ${shareUrl ?? null}
      AND external_disposition_request_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM plan_operator_scheduled_posts AS manual_handling
        WHERE manual_handling.notion_page_id = local_publish_jobs.notion_page_id
          AND manual_handling.workspace_id = local_publish_jobs.workspace_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM manual_reconciliation_requests AS disposition
        WHERE disposition.request_kind = 'targeted_local_job'
          AND disposition.source_local_job_id = local_publish_jobs.id
          AND disposition.workspace_id = local_publish_jobs.workspace_id
      )
    RETURNING *
  `;
  if (result.rows[0]) return mapRow(result.rows[0]);

  const job = await loadResultJob(id, workspaceId);
  assertMatchingClaim(job, claimToken);
  if (
    job.status === 'reconciled'
    && job.noteId === noteId
    && job.shareUrl === shareUrl
  ) {
    return job;
  }
  assertUnexpiredClaim(job);
  throw new LocalPublishJobError(
    'The verified result could not be completed',
    'INVALID_JOB_TRANSITION',
    409,
  );
}
