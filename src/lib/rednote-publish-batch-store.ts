import type { PoolClient, QueryResultRow } from 'pg';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { getPool, sql } from '@/lib/db';
import {
  exactRecoverablePublishJobError,
  RECOVERABLE_AMBIGUOUS_CREATOR_ERROR,
} from '@/lib/rednote-publish-job-recovery';
import type {
  LocalPublishSnapshot,
  PublishBatch,
  PublishBatchBlockedCandidate,
  PublishBatchItem,
  PublishBatchItemState,
  PublishBatchKind,
  PublishBatchStatus,
} from '@/types/local-publish-job';

export interface NewPublishBatchItem {
  notionPageId: string;
  snapshot: LocalPublishSnapshot;
  itemHash: string;
  dispatchMode: 'scheduled' | 'post_now';
  lateBySeconds: number;
}

interface BatchRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  kind: PublishBatchKind;
  status: PublishBatchStatus;
  manifest_hash: string;
  candidate_report: PublishBatchBlockedCandidate[];
  window_start: Date | string | null;
  window_end: Date | string | null;
  approved_at: Date | string | null;
  approved_by: string | null;
  superseded_at: Date | string | null;
  superseded_by_batch_id: string | null;
  created_at: Date | string;
}

interface ItemRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  batch_id: string;
  notion_page_id: string;
  snapshot: LocalPublishSnapshot;
  item_hash: string;
  state: PublishBatchItemState;
  dispatch_mode: 'scheduled' | 'post_now';
  late_by_seconds: number;
  invalidation_reason: string | null;
  local_publish_job_id: string | null;
  recovery_job_id?: string | null;
  recovery_job_status?: string | null;
  recovery_job_error_code?: string | null;
  recovery_job_error_message?: string | null;
  recovery_job_snapshot?: LocalPublishSnapshot | null;
  recovery_claim_attempts?: number | null;
  recovery_claimed_at?: Date | string | null;
  recovery_claim_expires_at?: Date | string | null;
  recovery_completed_at?: Date | string | null;
  recovery_staged_at?: Date | string | null;
  recovery_dispatch_authorized_at?: Date | string | null;
  recovery_dispatched_at?: Date | string | null;
  recovery_note_id?: string | null;
  recovery_share_url?: string | null;
  recovery_next_verification_at?: Date | string | null;
  recovery_verified_at?: Date | string | null;
  recovery_reconciled_at?: Date | string | null;
  recovery_verification_attempts?: number | null;
  recovery_audit_id?: string | null;
  recovery_audit_batch_id?: string | null;
  recovery_audit_manifest_hash?: string | null;
  recovery_audit_item_id?: string | null;
  recovery_audit_item_hash?: string | null;
  recovery_audit_snapshot_revision?: string | null;
  recovery_audit_error_code?: string | null;
  recovery_audit_error_message?: string | null;
  recovery_audit_claim_attempts?: number | null;
  recovery_audit_completed_at?: Date | string | null;
  recovery_audit_recovered_at?: Date | string | null;
  recovery_audit_actor_available?: boolean;
  recovery_has_attempt_generation?: boolean;
  recovery_source_attempt_count?: number | null;
  recovery_no_active_ownership?: boolean;
}

interface LifecycleBlockerRow extends QueryResultRow {
  notion_page_id: string;
  lifecycle_id: string;
  lifecycle_state: string;
}

function lifecycleBlockerReason(blocker: LifecycleBlockerRow) {
  if (blocker.lifecycle_state === 'candidate_revision:invalid') {
    return 'The Notion source revision is missing or malformed; automatic dispatch fails closed.';
  }
  const batchItemState = blocker.lifecycle_state.startsWith('batch_item:')
    ? blocker.lifecycle_state.slice('batch_item:'.length)
    : null;
  if (batchItemState) {
    return `Publish batch item ${blocker.lifecycle_id} is ${batchItemState}. ` +
      'Its frozen revision or linked lifecycle still owns this record; do not publish it again.';
  }
  const localJobState = blocker.lifecycle_state.startsWith('local_job:')
    ? blocker.lifecycle_state.slice('local_job:'.length)
    : null;
  return localJobState
    ? `Local publish job ${blocker.lifecycle_id} is ${localJobState}. ` +
      'The frozen revision or evidence-bearing lifecycle owns this record; do not publish it again.'
    : `Publish lifecycle ${blocker.lifecycle_id} is ${blocker.lifecycle_state}. ` +
      'Evidence for this record exists; do not publish it again.';
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isAfter(value: Date | string | null | undefined, earlier: Date | string | null | undefined) {
  return Boolean(value && earlier && new Date(value).getTime() > new Date(earlier).getTime());
}

export function storedManifestHash(
  items: ReadonlyArray<Pick<
    PublishBatchItem,
    'notionPageId' | 'itemHash' | 'dispatchMode' | 'lateBySeconds'
  >>,
) {
  const manifest = items.map((item) => ({
    notionPageId: item.notionPageId,
    itemHash: item.itemHash,
    dispatchMode: item.dispatchMode,
    lateBySeconds: item.lateBySeconds,
  }));
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function mapItem(row: ItemRow, batch?: BatchRow): PublishBatchItem {
  const firstRecovery = !row.recovery_audit_id;
  const matchingAuditEvidence = Boolean(
    row.recovery_audit_id &&
    batch &&
    row.recovery_audit_batch_id === batch.id &&
    row.recovery_audit_manifest_hash === batch.manifest_hash &&
    row.recovery_audit_item_id === row.id &&
    row.recovery_audit_item_hash === row.item_hash &&
    row.recovery_audit_snapshot_revision === row.snapshot.notionLastEditedTime &&
    row.recovery_audit_actor_available === true
  );
  const laterClaimGeneration = Boolean(
    row.recovery_claim_attempts !== null &&
    row.recovery_claim_attempts !== undefined &&
    row.recovery_audit_claim_attempts !== null &&
    row.recovery_audit_claim_attempts !== undefined &&
    (
      row.recovery_job_error_code === RECOVERABLE_AMBIGUOUS_CREATOR_ERROR
        ? row.recovery_claim_attempts === row.recovery_audit_claim_attempts + 1
        : row.recovery_claim_attempts > row.recovery_audit_claim_attempts
    )
  );
  const distinctRefailure = Boolean(
    matchingAuditEvidence &&
    laterClaimGeneration &&
    isAfter(row.recovery_claimed_at, row.recovery_audit_completed_at) &&
    isAfter(row.recovery_claimed_at, row.recovery_audit_recovered_at) &&
    isAfter(row.recovery_completed_at, row.recovery_claimed_at)
  );
  const exactRecoverableError = exactRecoverablePublishJobError(
    row.recovery_job_error_code,
    row.recovery_job_error_message,
  );
  const recoverableError = (
    exactRecoverableError &&
    (
      row.recovery_job_error_code !== RECOVERABLE_AMBIGUOUS_CREATOR_ERROR ||
      !firstRecovery
    )
  ) ? exactRecoverableError : null;
  const failedRecoveryEligible = Boolean(
    batch?.status === 'approved' &&
    batch.approved_at &&
    row.state === 'failed' &&
    row.local_publish_job_id &&
    row.recovery_job_id === row.local_publish_job_id &&
    row.recovery_job_status === 'failed' &&
    recoverableError &&
    row.recovery_job_snapshot &&
    row.recovery_claimed_at &&
    row.recovery_completed_at &&
    isDeepStrictEqual(row.snapshot, row.recovery_job_snapshot) &&
    row.snapshot.notionLastEditedTime ===
      row.recovery_job_snapshot.notionLastEditedTime &&
    !row.recovery_staged_at &&
    !row.recovery_dispatch_authorized_at &&
    !row.recovery_dispatched_at &&
    !row.recovery_note_id &&
    !row.recovery_share_url &&
    !row.recovery_next_verification_at &&
    !row.recovery_verified_at &&
    !row.recovery_reconciled_at &&
    row.recovery_verification_attempts === 0 &&
    (firstRecovery || distinctRefailure) &&
    row.recovery_source_attempt_count === 1 &&
    row.recovery_no_active_ownership === true
  );
  const queuedRepairError = matchingAuditEvidence
    ? exactRecoverablePublishJobError(
        row.recovery_audit_error_code,
        row.recovery_audit_error_message,
      )
    : null;
  const queuedRepairEligible = Boolean(
    batch?.status === 'approved' &&
    batch.approved_at &&
    row.state === 'queued' &&
    row.local_publish_job_id &&
    row.recovery_job_id === row.local_publish_job_id &&
    row.recovery_job_status === 'queued' &&
    !row.recovery_job_error_code &&
    !row.recovery_job_error_message &&
    row.recovery_job_snapshot &&
    row.recovery_claim_attempts !== null &&
    row.recovery_claim_attempts !== undefined &&
    row.recovery_claim_attempts === row.recovery_audit_claim_attempts &&
    !row.recovery_claimed_at &&
    !row.recovery_claim_expires_at &&
    !row.recovery_completed_at &&
    isDeepStrictEqual(row.snapshot, row.recovery_job_snapshot) &&
    row.snapshot.notionLastEditedTime ===
      row.recovery_job_snapshot.notionLastEditedTime &&
    !row.recovery_staged_at &&
    !row.recovery_dispatch_authorized_at &&
    !row.recovery_dispatched_at &&
    !row.recovery_note_id &&
    !row.recovery_share_url &&
    !row.recovery_next_verification_at &&
    !row.recovery_verified_at &&
    !row.recovery_reconciled_at &&
    row.recovery_verification_attempts === 0 &&
    queuedRepairError &&
    row.recovery_has_attempt_generation === false &&
    row.recovery_source_attempt_count === 1 &&
    row.recovery_no_active_ownership === true
  );
  const recoveryEligible = failedRecoveryEligible || queuedRepairEligible;
  const projectedError = queuedRepairEligible ? queuedRepairError : recoverableError;
  const projectedClaimAttempts = queuedRepairEligible
    ? row.recovery_audit_claim_attempts
    : row.recovery_claim_attempts;
  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    snapshot: row.snapshot,
    itemHash: row.item_hash,
    state: row.state,
    dispatchMode: row.dispatch_mode,
    lateBySeconds: row.late_by_seconds,
    ...(row.invalidation_reason ? { invalidationReason: row.invalidation_reason } : {}),
    ...(row.local_publish_job_id ? { localPublishJobId: row.local_publish_job_id } : {}),
    ...(recoveryEligible
      ? {
          recoveryEvidence: {
            batchId: batch!.id,
            manifestHash: batch!.manifest_hash,
            itemId: row.id,
            jobId: row.recovery_job_id!,
            itemHash: row.item_hash,
            snapshotRevision: row.snapshot.notionLastEditedTime,
            priorErrorCode: projectedError!,
            claimAttempts: projectedClaimAttempts!,
            ...(row.recovery_audit_claim_attempts !== null &&
                row.recovery_audit_claim_attempts !== undefined
              ? { latestAuditedClaimAttempts: row.recovery_audit_claim_attempts }
              : {}),
          },
        }
      : {}),
  };
}

function mapBatch(row: BatchRow, items: PublishBatchItem[]): PublishBatch {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    status: row.status,
    manifestHash: row.manifest_hash,
    ...(row.window_start ? { windowStart: timestamp(row.window_start) } : {}),
    ...(row.window_end ? { windowEnd: timestamp(row.window_end) } : {}),
    createdAt: timestamp(row.created_at),
    ...(row.approved_at ? { approvedAt: timestamp(row.approved_at) } : {}),
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(row.superseded_at ? { supersededAt: timestamp(row.superseded_at) } : {}),
    ...(row.superseded_by_batch_id
      ? { supersededByBatchId: row.superseded_by_batch_id }
      : {}),
    items,
    blockedCandidates: row.candidate_report ?? [],
  };
}

export async function createStoredPublishBatch(input: {
  workspaceId: string;
  kind: PublishBatchKind;
  manifestHash: string;
  windowStart?: string;
  windowEnd?: string;
  items: NewPublishBatchItem[];
  blockedCandidates: PublishBatchBlockedCandidate[];
}) {
  if (input.items.length === 0 && input.kind !== 'bootstrap') return null;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (input.kind === 'bootstrap') {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('rednote-bootstrap-batch', 0))",
      );
    }
    const pageIds = Array.from(
      new Set(input.items.map((item) => item.notionPageId)),
    ).sort();
    for (const pageId of pageIds) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${input.workspaceId}:${pageId}`],
      );
    }
    const lifecycleBlockers = pageIds.length === 0
      ? { rows: [] as LifecycleBlockerRow[] }
      : await client.query<LifecycleBlockerRow>(
         `SELECT blocker.*
          FROM jsonb_to_recordset($1::jsonb) AS candidate(
            "notionPageId" text,
            "notionLastEditedTime" text
          )
          CROSS JOIN LATERAL rednote_publish_revision_blockers(
            $2,
            candidate."notionPageId",
            candidate."notionLastEditedTime"
          ) blocker`,
         [
           JSON.stringify(input.items.map((item) => ({
             notionPageId: item.notionPageId,
             notionLastEditedTime: item.snapshot.notionLastEditedTime,
           }))),
           input.workspaceId,
         ],
        );
    const blockerByPage = new Map<string, LifecycleBlockerRow>();
    for (const blocker of lifecycleBlockers.rows) {
      if (!blockerByPage.has(blocker.notion_page_id)) {
        blockerByPage.set(blocker.notion_page_id, blocker);
      }
    }
    const items = input.items.filter((item) =>
      !blockerByPage.has(item.notionPageId));
    const blockedCandidates = [
      ...input.blockedCandidates,
      ...input.items.flatMap((item): PublishBatchBlockedCandidate[] => {
        const blocker = blockerByPage.get(item.notionPageId);
        return blocker
          ? [{
              notionPageId: item.notionPageId,
              headline: item.snapshot.headline,
              ...(item.snapshot.publishAt ? { publishAt: item.snapshot.publishAt } : {}),
              reason: lifecycleBlockerReason(blocker),
            }]
          : [];
      }),
    ];
    if (items.length === 0 && input.kind !== 'bootstrap') {
      await client.query('ROLLBACK');
      return null;
    }
    const superseded = input.kind === 'bootstrap'
      ? await client.query<BatchRow>(
          `UPDATE rednote_publish_batches
           SET status = 'superseded',
               superseded_at = CURRENT_TIMESTAMP
           WHERE kind = 'bootstrap'
             AND workspace_id = $1
             AND status = 'pending_approval'
             AND NOT EXISTS (
               SELECT 1
               FROM rednote_publish_batch_items item
               WHERE item.batch_id = rednote_publish_batches.id
                 AND item.state NOT IN ('needs_approval', 'invalidated')
             )
           RETURNING *`,
          [input.workspaceId],
        )
      : { rows: [] as BatchRow[] };
    if (superseded.rows.length > 0) {
      await client.query(
        `UPDATE rednote_publish_batch_items
         SET state = 'invalidated',
             invalidation_reason =
               'Batch superseded before approval by a newly computed bootstrap manifest.',
             updated_at = CURRENT_TIMESTAMP
         WHERE batch_id = ANY($1::uuid[])
           AND state = 'needs_approval'`,
        [superseded.rows.map((batch) => batch.id)],
      );
    }
    const batch = await client.query<BatchRow>(
      `INSERT INTO rednote_publish_batches (
        workspace_id, kind, manifest_hash, candidate_report, window_start, window_end
      ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
       RETURNING *`,
      [
       input.workspaceId,
       input.kind,
       input.manifestHash,
       JSON.stringify(blockedCandidates),
       input.windowStart ?? null,
       input.windowEnd ?? null,
      ],
    );
    let row = batch.rows[0];
    const storedItems: PublishBatchItem[] = [];
    for (const item of items) {
      const inserted = await client.query<ItemRow>(
        `INSERT INTO rednote_publish_batch_items (
           batch_id, workspace_id, notion_page_id, snapshot, item_hash,
           dispatch_mode, late_by_seconds
         ) VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7)
           RETURNING *`,
        [
          row.id,
          input.workspaceId,
          item.notionPageId,
          JSON.stringify(item.snapshot),
          item.itemHash,
          item.dispatchMode,
          item.lateBySeconds,
        ],
      );
      storedItems.push(mapItem(inserted.rows[0]));
    }
    if (storedItems.length === 0 && input.kind !== 'bootstrap') {
      await client.query('ROLLBACK');
      return null;
    }
    const actualHash = storedManifestHash(storedItems);
    if (actualHash !== row.manifest_hash) {
      const updated = await client.query<BatchRow>(
        `UPDATE rednote_publish_batches
         SET manifest_hash = $1
         WHERE id = $2::uuid
         RETURNING *`,
        [actualHash, row.id],
      );
      row = updated.rows[0];
    }
    if (superseded.rows.length > 0) {
      await client.query(
        `UPDATE rednote_publish_batches
         SET superseded_by_batch_id = $1::uuid
         WHERE id = ANY($2::uuid[])
           AND status = 'superseded'`,
        [row.id, superseded.rows.map((batch) => batch.id)],
      );
    }
    await client.query('COMMIT');
    return mapBatch(row, storedItems);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listStoredPublishBatches(workspaceId: string, batchId?: string) {
  const batches = await sql<BatchRow>`
    SELECT *
    FROM rednote_publish_batches
    WHERE workspace_id = ${workspaceId}
      AND (${batchId ?? null}::uuid IS NULL OR id = ${batchId ?? null}::uuid)
    ORDER BY created_at DESC
    LIMIT 20
  `;
  const output: PublishBatch[] = [];
  for (const batch of batches.rows) {
    const items = await sql<ItemRow>`
      SELECT
        item.*,
        job.id AS recovery_job_id,
        job.status AS recovery_job_status,
        job.error_code AS recovery_job_error_code,
        job.error_message AS recovery_job_error_message,
        job.snapshot AS recovery_job_snapshot,
        job.claim_attempts AS recovery_claim_attempts,
        job.claimed_at AS recovery_claimed_at,
        job.claim_expires_at AS recovery_claim_expires_at,
        job.completed_at AS recovery_completed_at,
        job.staged_at AS recovery_staged_at,
        job.dispatch_authorized_at AS recovery_dispatch_authorized_at,
        job.dispatched_at AS recovery_dispatched_at,
        job.note_id AS recovery_note_id,
        job.share_url AS recovery_share_url,
        job.next_verification_at AS recovery_next_verification_at,
        job.verified_at AS recovery_verified_at,
        job.reconciled_at AS recovery_reconciled_at,
        job.verification_attempts AS recovery_verification_attempts,
        recovery.id AS recovery_audit_id,
        recovery.batch_id AS recovery_audit_batch_id,
        recovery.manifest_hash AS recovery_audit_manifest_hash,
        recovery.batch_item_id AS recovery_audit_item_id,
        recovery.item_hash AS recovery_audit_item_hash,
        recovery.snapshot_revision AS recovery_audit_snapshot_revision,
        recovery.prior_error_code AS recovery_audit_error_code,
        recovery.prior_error_message AS recovery_audit_error_message,
        recovery.prior_claim_attempts AS recovery_audit_claim_attempts,
        recovery.prior_completed_at AS recovery_audit_completed_at,
        recovery.recovered_at AS recovery_audit_recovered_at,
        COALESCE(
          char_length(btrim(recovery.recovered_by)) BETWEEN 1 AND 320,
          false
        ) AS recovery_audit_actor_available,
        generation.recovery_id IS NOT NULL AS recovery_has_attempt_generation,
        source_attempts.source_count AS recovery_source_attempt_count,
        NOT EXISTS (
          SELECT 1
          FROM rednote_publish_recovery_revision_blockers(
            item.workspace_id,
            item.notion_page_id,
            item.snapshot->>'notionLastEditedTime',
            item.id,
            job.id,
            NULL::uuid
          )
        ) AS recovery_no_active_ownership
      FROM rednote_publish_batch_items AS item
      LEFT JOIN local_publish_jobs AS job
        ON job.id = item.local_publish_job_id
       AND job.workspace_id = item.workspace_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM rednote_publish_job_recoveries
        WHERE local_publish_job_id = job.id
        ORDER BY prior_claim_attempts DESC, recovered_at DESC
        LIMIT 1
      ) AS recovery ON TRUE
      LEFT JOIN rednote_publish_recovery_attempt_generations AS generation
        ON generation.recovery_id = recovery.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer AS source_count
        FROM rednote_publish_attempts AS source
        WHERE source.workspace_id = item.workspace_id
          AND source.source_local_publish_job_id = job.id
          AND source.executor_type = 'worker'
          AND source.approved_at IS NOT NULL
          AND NOT source.active
          AND source.terminal_outcome = 'known_failed'
          AND source.terminal_at <= COALESCE(
            job.completed_at,
            recovery.prior_completed_at
          )
          AND source.receipt_lookup_state = 'not_required'
          AND source.dispatch_authorized_at IS NULL
          AND source.superseded_by_attempt_id IS NULL
          AND source.payload_revision =
            item.snapshot->>'notionLastEditedTime'
      ) AS source_attempts ON TRUE
      WHERE item.batch_id = ${batch.id}::uuid
        AND item.workspace_id = ${workspaceId}
      ORDER BY item.snapshot->>'publishAt' NULLS FIRST, item.created_at
    `;
    output.push(mapBatch(batch, items.rows.map((item) => mapItem(item, batch))));
  }
  return output;
}

export async function approveStoredPublishBatchTransaction(
  client: Pick<PoolClient, 'query'>,
  batchId: string,
  manifestHash: string,
  approvedBy: string,
  decisions: Array<{ itemId: string; approved: boolean; reason?: string }>,
  workspaceId: string,
) {
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('rednote-bootstrap-batch', 0))",
    );
    const observed = await client.query<BatchRow>(
      `SELECT *
       FROM rednote_publish_batches
       WHERE id = $1::uuid
         AND manifest_hash = $2
         AND workspace_id = $3`,
      [batchId, manifestHash, workspaceId],
    );
    const observedBatch = observed.rows[0];
    if (!observedBatch || observedBatch.status !== 'pending_approval') {
      throw new Error(
        observedBatch?.status === 'superseded'
          ? 'This batch was superseded and can never be approved. Refresh to review its replacement manifest.'
          : 'The batch is no longer pending approval; refresh before approving.',
      );
    }
    const approvedItemIds = Array.from(
      new Set(
        decisions
          .filter((decision) => decision.approved)
          .map((decision) => decision.itemId),
      ),
    );
    if (approvedItemIds.length > 0) {
      const approvedPages = await client.query<{ notion_page_id: string }>(
        `SELECT notion_page_id
         FROM rednote_publish_batch_items
         WHERE id = ANY($1::uuid[])
           AND batch_id = $2::uuid
           AND workspace_id = $3
           AND state = 'needs_approval'
         ORDER BY notion_page_id`,
        [approvedItemIds, batchId, workspaceId],
      );
      let previousPageId: string | undefined;
      for (const { notion_page_id: pageId } of approvedPages.rows) {
        if (pageId === previousPageId) continue;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`${workspaceId}:${pageId}`],
        );
        previousPageId = pageId;
      }
    }
    const locked = await client.query<BatchRow>(
      `SELECT *
       FROM rednote_publish_batches
       WHERE id = $1::uuid
         AND manifest_hash = $2
         AND workspace_id = $3
       FOR UPDATE`,
      [batchId, manifestHash, workspaceId],
    );
    const current = locked.rows[0];
    if (!current || current.status !== 'pending_approval') {
      throw new Error(
        current?.status === 'superseded'
          ? 'This batch was superseded and can never be approved. Refresh to review its replacement manifest.'
          : 'The batch is no longer pending approval; refresh before approving.',
      );
    }
    for (const decision of decisions) {
      if (!decision.approved) {
        await client.query(
          `
        UPDATE rednote_publish_batch_items
        SET state = 'invalidated',
            invalidation_reason = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2::uuid
          AND batch_id = $3::uuid
          AND state = 'needs_approval'
          `,
          [
            decision.reason ?? 'Source changed before approval',
            decision.itemId,
            batchId,
          ],
        );
        continue;
      }
      await client.query(
        `
      WITH approved_item AS (
        UPDATE rednote_publish_batch_items
        SET state = 'approved',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
          AND batch_id = $2::uuid
          AND workspace_id = $3
          AND state = 'needs_approval'
        RETURNING *
      ), inserted_job AS (
        INSERT INTO local_publish_jobs (
          workspace_id, notion_page_id, snapshot, idempotency_key, batch_item_id
        )
        SELECT
          $3,
          notion_page_id,
          snapshot,
          gen_random_uuid(),
          id
        FROM approved_item
        WHERE NOT EXISTS (
          SELECT 1
          FROM rednote_publish_revision_blockers(
            $3,
            approved_item.notion_page_id,
            approved_item.snapshot->>'notionLastEditedTime',
            approved_item.id
          )
          )
        ON CONFLICT DO NOTHING
        RETURNING id, batch_item_id
      )
      UPDATE rednote_publish_batch_items AS item
      SET state = 'queued',
          local_publish_job_id = inserted_job.id,
          updated_at = CURRENT_TIMESTAMP
      FROM inserted_job
      WHERE item.id = inserted_job.batch_item_id
        `,
        [decision.itemId, batchId, workspaceId],
      );
      await client.query(
        `
      UPDATE rednote_publish_batch_items
      SET state = 'invalidated',
          invalidation_reason =
            'An existing publish or reconciliation lifecycle already owns this post.',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid
        AND batch_id = $2::uuid
        AND state IN ('needs_approval', 'approved')
        AND local_publish_job_id IS NULL
        `,
        [decision.itemId, batchId],
      );
    }
    const approved = await client.query<BatchRow>(
      `
    UPDATE rednote_publish_batches AS batch
    SET status = CASE
          WHEN EXISTS (
            SELECT 1 FROM rednote_publish_batch_items
            WHERE batch_id = batch.id AND state = 'invalidated'
          ) THEN 'partially_approved'
          ELSE 'approved'
        END,
        approved_at = CURRENT_TIMESTAMP,
        approved_by = $1
    WHERE id = $2::uuid
      AND manifest_hash = $3
      AND status = 'pending_approval'
    RETURNING *
      `,
      [approvedBy, batchId, manifestHash],
    );
    if (!approved.rows[0]) {
      throw new Error('The batch could not be approved because it is no longer pending.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function approveStoredPublishBatch(
  batchId: string,
  manifestHash: string,
  approvedBy: string,
  decisions: Array<{ itemId: string; approved: boolean; reason?: string }>,
  workspaceId: string,
) {
  const client = await getPool().connect();
  try {
    await approveStoredPublishBatchTransaction(
      client,
      batchId,
      manifestHash,
      approvedBy,
      decisions,
      workspaceId,
    );
  } finally {
    client.release();
  }
  return (await listStoredPublishBatches(workspaceId, batchId))[0];
}

export async function invalidateStoredBatchItem(
  jobId: string,
  claimToken: string,
  reason: string,
) {
  await sql`
    WITH current_claim AS (
      SELECT id, batch_item_id
      FROM local_publish_jobs
      WHERE id = ${jobId}::uuid
        AND claim_token = ${claimToken}::uuid
        AND claim_expires_at > CURRENT_TIMESTAMP
        AND external_disposition_request_id IS NULL
        AND batch_item_id IS NOT NULL
        AND status IN ('claimed', 'staged')
    ), invalidated AS (
      UPDATE rednote_publish_batch_items
      SET state = 'invalidated',
          invalidation_reason = ${reason},
          updated_at = CURRENT_TIMESTAMP
      FROM current_claim
      WHERE rednote_publish_batch_items.id = current_claim.batch_item_id
        AND local_publish_job_id = current_claim.id
        AND state IN ('queued', 'claimed', 'staged')
      RETURNING rednote_publish_batch_items.id
    )
    UPDATE local_publish_jobs
    SET status = 'failed',
        error_code = 'BATCH_SOURCE_CHANGED',
        error_message = ${reason},
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    FROM invalidated
    WHERE local_publish_jobs.id = ${jobId}::uuid
      AND local_publish_jobs.batch_item_id = invalidated.id
  `;
}
