import type { QueryResultRow } from 'pg';
import { createHash } from 'crypto';
import { getPool, sql } from '@/lib/db';
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
  kind: PublishBatchKind;
  status: PublishBatchStatus;
  manifest_hash: string;
  candidate_report: PublishBatchBlockedCandidate[];
  window_start: Date | string | null;
  window_end: Date | string | null;
  approved_at: Date | string | null;
  approved_by: string | null;
  created_at: Date | string;
}

interface ItemRow extends QueryResultRow {
  id: string;
  batch_id: string;
  notion_page_id: string;
  snapshot: LocalPublishSnapshot;
  item_hash: string;
  state: PublishBatchItemState;
  dispatch_mode: 'scheduled' | 'post_now';
  late_by_seconds: number;
  invalidation_reason: string | null;
  local_publish_job_id: string | null;
}

interface OwningJobRow extends QueryResultRow {
  notion_page_id: string;
  id: string;
  status: string;
}

function owningJobReason(job: OwningJobRow) {
  return `Local publish job ${job.id} is ${job.status}. ` +
    'An existing active or post-dispatch lifecycle owns this record; do not publish it again.';
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function storedManifestHash(items: PublishBatchItem[]) {
  const manifest = items.map((item) => ({
    notionPageId: item.notionPageId,
    itemHash: item.itemHash,
    dispatchMode: item.dispatchMode,
    lateBySeconds: item.lateBySeconds,
  }));
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function mapItem(row: ItemRow): PublishBatchItem {
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
  };
}

function mapBatch(row: BatchRow, items: PublishBatchItem[]): PublishBatch {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    manifestHash: row.manifest_hash,
    ...(row.window_start ? { windowStart: timestamp(row.window_start) } : {}),
    ...(row.window_end ? { windowEnd: timestamp(row.window_end) } : {}),
    createdAt: timestamp(row.created_at),
    ...(row.approved_at ? { approvedAt: timestamp(row.approved_at) } : {}),
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    items,
    blockedCandidates: row.candidate_report ?? [],
  };
}

export async function createStoredPublishBatch(input: {
  kind: PublishBatchKind;
  manifestHash: string;
  windowStart?: string;
  windowEnd?: string;
  items: NewPublishBatchItem[];
  blockedCandidates: PublishBatchBlockedCandidate[];
}) {
  if (input.items.length === 0) return null;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const pageIds = Array.from(
      new Set(input.items.map((item) => item.notionPageId)),
    ).sort();
    for (const pageId of pageIds) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [pageId],
      );
    }
    const owningJobs = pageIds.length === 0
      ? { rows: [] as OwningJobRow[] }
      : await client.query<OwningJobRow>(
          `SELECT DISTINCT ON (notion_page_id) notion_page_id, id, status
           FROM local_publish_jobs
           WHERE notion_page_id = ANY($1::text[])
             AND (
               status <> 'failed'
               OR dispatch_authorized_at IS NOT NULL
               OR dispatched_at IS NOT NULL
               OR note_id IS NOT NULL
               OR share_url IS NOT NULL
             )
           ORDER BY notion_page_id, created_at DESC`,
          [pageIds],
        );
    const ownershipByPage = new Map(
      owningJobs.rows.map((job) => [job.notion_page_id, job]),
    );
    const items = input.items.filter((item) => !ownershipByPage.has(item.notionPageId));
    const blockedCandidates = [
      ...input.blockedCandidates,
      ...input.items.flatMap((item): PublishBatchBlockedCandidate[] => {
        const job = ownershipByPage.get(item.notionPageId);
        return job
          ? [{
              notionPageId: item.notionPageId,
              headline: item.snapshot.headline,
              ...(item.snapshot.publishAt ? { publishAt: item.snapshot.publishAt } : {}),
              reason: owningJobReason(job),
            }]
          : [];
      }),
    ];
    if (items.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const batch = await client.query<BatchRow>(
      `INSERT INTO rednote_publish_batches (
        kind, manifest_hash, candidate_report, window_start, window_end
      ) VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
       RETURNING *`,
      [
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
           batch_id, notion_page_id, snapshot, item_hash, dispatch_mode, late_by_seconds
         ) VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          row.id,
          item.notionPageId,
          JSON.stringify(item.snapshot),
          item.itemHash,
          item.dispatchMode,
          item.lateBySeconds,
        ],
      );
      if (inserted.rows[0]) storedItems.push(mapItem(inserted.rows[0]));
    }
    if (storedItems.length === 0) {
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
    await client.query('COMMIT');
    return mapBatch(row, storedItems);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listStoredPublishBatches(batchId?: string) {
  const batches = await sql<BatchRow>`
    SELECT *
    FROM rednote_publish_batches
    WHERE (${batchId ?? null}::uuid IS NULL OR id = ${batchId ?? null}::uuid)
    ORDER BY created_at DESC
    LIMIT 20
  `;
  const output: PublishBatch[] = [];
  for (const batch of batches.rows) {
    const items = await sql<ItemRow>`
      SELECT *
      FROM rednote_publish_batch_items
      WHERE batch_id = ${batch.id}::uuid
      ORDER BY snapshot->>'publishAt' NULLS FIRST, created_at
    `;
    output.push(mapBatch(batch, items.rows.map(mapItem)));
  }
  return output;
}

export async function approveStoredPublishBatch(
  batchId: string,
  manifestHash: string,
  approvedBy: string,
  decisions: Array<{ itemId: string; approved: boolean; reason?: string }>,
) {
  for (const decision of decisions) {
    if (!decision.approved) {
      await sql`
        UPDATE rednote_publish_batch_items
        SET state = 'invalidated',
            invalidation_reason = ${decision.reason ?? 'Source changed before approval'},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${decision.itemId}::uuid
          AND batch_id = ${batchId}::uuid
          AND state = 'needs_approval'
      `;
      continue;
    }
    await sql`
      WITH approved_item AS (
        UPDATE rednote_publish_batch_items
        SET state = 'approved',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${decision.itemId}::uuid
          AND batch_id = ${batchId}::uuid
          AND state = 'needs_approval'
        RETURNING *
      ), page_lock AS (
        SELECT approved_item.*,
               pg_advisory_xact_lock(hashtextextended(approved_item.notion_page_id, 0))
        FROM approved_item
      ), inserted_job AS (
        INSERT INTO local_publish_jobs (
          notion_page_id, snapshot, idempotency_key, batch_item_id
        )
        SELECT
          notion_page_id,
          snapshot,
          gen_random_uuid(),
          id
        FROM page_lock
        WHERE NOT EXISTS (
          SELECT 1
          FROM local_publish_jobs existing
          WHERE existing.notion_page_id = page_lock.notion_page_id
            AND (
              existing.status <> 'failed'
              OR existing.dispatch_authorized_at IS NOT NULL
              OR existing.dispatched_at IS NOT NULL
              OR existing.note_id IS NOT NULL
              OR existing.share_url IS NOT NULL
            )
        )
          AND NOT EXISTS (
            SELECT 1
            FROM manual_reconciliation_requests reconciliation
            WHERE reconciliation.notion_page_id = page_lock.notion_page_id
              AND reconciliation.status IN ('queued', 'verifying')
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
    `;
    await sql`
      UPDATE rednote_publish_batch_items
      SET state = 'invalidated',
          invalidation_reason =
            'An existing publish or reconciliation lifecycle already owns this post.',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${decision.itemId}::uuid
        AND batch_id = ${batchId}::uuid
        AND state = 'approved'
        AND local_publish_job_id IS NULL
    `;
  }
  await sql`
    UPDATE rednote_publish_batches AS batch
    SET status = CASE
          WHEN EXISTS (
            SELECT 1 FROM rednote_publish_batch_items
            WHERE batch_id = batch.id AND state = 'invalidated'
          ) THEN 'partially_approved'
          ELSE 'approved'
        END,
        approved_at = CURRENT_TIMESTAMP,
        approved_by = ${approvedBy}
    WHERE id = ${batchId}::uuid
      AND manifest_hash = ${manifestHash}
      AND status = 'pending_approval'
  `;
  return (await listStoredPublishBatches(batchId))[0];
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
