import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';

export interface MutationSafetyRow extends QueryResultRow {
  status: string;
  authorization_kind: string | null;
  active: boolean | null;
  terminal_outcome: string | null;
  receipt_lookup_state: string | null;
  job_dispatch_authorized_at: unknown;
  attempt_dispatch_authorized_at: unknown;
  dispatched_at: unknown;
  verified_at: unknown;
  reconciled_at: unknown;
  note_id: unknown;
  share_url: unknown;
  success_attestation_id: unknown;
  receipt_outcome: string | null;
  proven_no_submit?: boolean;
  has_receipt_evidence?: boolean;
}

// Editing/revoking an unconsumed authorization is not retrying a failed job.
// All historical jobs participate: an unrelated or unidentified operation
// cannot be hidden by a newer safe attempt.
export function assessReadyX3SourceMutation(
  rows: MutationSafetyRow[],
  orphanAttempts: boolean,
  orphanReadyX3Attempts: boolean,
) {
  const applicable = orphanReadyX3Attempts ||
    rows.some((row) => row.authorization_kind === 'ready_x3');
  const safe = applicable && !orphanAttempts && rows.length > 0 && rows.every((row) => {
    if (row.has_receipt_evidence === true) return false;
    // Only the database's exact acknowledged pre-submit predicate can prove
    // that a consumed activation never reached the provider submit control.
    // This permits source editing, never reusing or resetting the old consent.
    if (row.proven_no_submit === true &&
        row.authorization_kind === 'ready_x3' &&
        row.status === 'failed' && row.active === false &&
        row.terminal_outcome === 'known_failed' &&
        row.receipt_lookup_state === 'not_required' &&
        row.receipt_outcome === 'rejected' &&
        row.job_dispatch_authorized_at != null &&
        row.attempt_dispatch_authorized_at != null &&
        [row.dispatched_at, row.verified_at, row.reconciled_at,
          row.note_id, row.share_url, row.success_attestation_id]
          .every((value) => value === null)) return true;
    const noActivationOrReceipt = row.authorization_kind === 'ready_x3' &&
      (row.receipt_lookup_state === 'not_required' ||
        // A newly approved, unconsumed attempt starts at pending by schema
        // default. That placeholder is not an uncertain provider submission.
        (row.receipt_lookup_state === 'pending' &&
          row.has_receipt_evidence === false && row.active === true &&
          row.terminal_outcome === null && row.receipt_outcome === null &&
          ['queued', 'claimed', 'staged'].includes(row.status))) &&
      [
        row.job_dispatch_authorized_at, row.attempt_dispatch_authorized_at,
        row.dispatched_at, row.verified_at, row.reconciled_at,
        row.note_id, row.share_url, row.success_attestation_id,
      ].every((value) => value === null);
    if (!noActivationOrReceipt) return false;
    if (['queued', 'claimed', 'staged'].includes(row.status)) {
      return row.active === true && row.terminal_outcome === null &&
        row.receipt_outcome === null;
    }
    return ['failed', 'expired'].includes(row.status) &&
      row.active === false && row.terminal_outcome === 'known_failed' &&
      (row.receipt_outcome === null || row.receipt_outcome === 'rejected');
  });
  return { applicable, safe };
}

// The caller must hold the canonical workspace + source advisory transaction
// lock. Reuse its PoolClient, including inside the real fence/schedule hold.
export async function inspectReadyX3SourceMutation(
  client: PoolClient, workspaceId: string, sourceNotionPageId: string,
) {
  const jobs = await client.query<MutationSafetyRow>(
    `SELECT job.status, attempt.authorization_kind, attempt.active,
       attempt.terminal_outcome, attempt.receipt_lookup_state,
       job.dispatch_authorized_at AS job_dispatch_authorized_at,
       attempt.dispatch_authorized_at AS attempt_dispatch_authorized_at,
       job.dispatched_at, job.verified_at, job.reconciled_at,
       job.note_id, job.share_url, job.success_attestation_id, job.receipt_outcome,
       rednote_ready_x3_pre_submit_rejection_is_proven(
         job.workspace_id,job.id,attempt.id
       ) AS proven_no_submit,
       (EXISTS (SELECT 1 FROM rednote_publish_attempt_receipts receipt
          WHERE receipt.attempt_id=attempt.id)
        OR EXISTS (SELECT 1 FROM rednote_publication_evidence evidence
          WHERE evidence.workspace_id=job.workspace_id
            AND (evidence.local_publish_job_id=job.id OR evidence.attempt_id=attempt.id))
        OR EXISTS (SELECT 1 FROM local_publish_job_success_attestations attestation
          WHERE attestation.local_publish_job_id=job.id)) AS has_receipt_evidence
     FROM local_publish_jobs job
     LEFT JOIN rednote_publish_attempts attempt
       ON attempt.workspace_id=job.workspace_id
       AND attempt.source_local_publish_job_id=job.id
       AND attempt.source_notion_page_id=job.notion_page_id
     WHERE job.workspace_id=$1 AND job.notion_page_id=$2`,
    [workspaceId, sourceNotionPageId],
  );
  const orphan = await client.query<{ any_orphan: boolean; ready_x3_orphan: boolean }>(
    `SELECT COUNT(*)>0 AS any_orphan,
       COUNT(*) FILTER (WHERE attempt.authorization_kind='ready_x3')>0 AS ready_x3_orphan
     FROM rednote_publish_attempts attempt
     WHERE attempt.workspace_id=$1 AND attempt.source_notion_page_id=$2
       AND NOT EXISTS (
         SELECT 1 FROM local_publish_jobs job
         WHERE job.workspace_id=attempt.workspace_id
           AND job.id=attempt.source_local_publish_job_id
           AND job.notion_page_id=attempt.source_notion_page_id
       )`,
    [workspaceId, sourceNotionPageId],
  );
  return assessReadyX3SourceMutation(
    jobs.rows, orphan.rows[0]?.any_orphan ?? true, orphan.rows[0]?.ready_x3_orphan ?? true,
  );
}

export async function readReadyX3SourceMutationSafety(workspaceId: string, sourceNotionPageId: string) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${workspaceId}:${sourceNotionPageId}`,
    ]);
    const result = await inspectReadyX3SourceMutation(client, workspaceId, sourceNotionPageId);
    await client.query('COMMIT');
    return { ...result, checkedAt: new Date().toISOString() };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
