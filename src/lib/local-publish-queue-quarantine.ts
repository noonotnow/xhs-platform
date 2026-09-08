import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';

const ACTIVE_STATUSES = [
  'queued',
  'claimed',
  'staged',
  'submitted',
  'scheduled',
  'operator_attested',
  'verification_pending',
  'verified',
] as const;

type QueueStatus = (typeof ACTIVE_STATUSES)[number];

interface InventoryRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  status: QueueStatus;
  claim_token: string | null;
  claim_expires_at: Date | string | null;
  has_dispatch_evidence: boolean;
}

export interface LocalPublishQueueInventory {
  total: number;
  priorStatusCounts: Partial<Record<QueueStatus, number>>;
  activeClaimCount: number;
  dispatchEvidenceCount: number;
  jobs: Array<{
    id: string;
    workspaceId: string;
    status: QueueStatus;
    claimExpiresAt?: string;
    hasDispatchEvidence: boolean;
  }>;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function summarize(rows: InventoryRow[]): LocalPublishQueueInventory {
  const priorStatusCounts: Partial<Record<QueueStatus, number>> = {};
  for (const row of rows) {
    priorStatusCounts[row.status] = (priorStatusCounts[row.status] ?? 0) + 1;
  }
  return {
    total: rows.length,
    priorStatusCounts,
    activeClaimCount: rows.filter((row) =>
      row.claim_token && row.claim_expires_at
      && new Date(row.claim_expires_at).getTime() > Date.now()).length,
    dispatchEvidenceCount: rows.filter((row) => row.has_dispatch_evidence).length,
    jobs: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      status: row.status,
      ...(row.claim_expires_at ? { claimExpiresAt: timestamp(row.claim_expires_at) } : {}),
      hasDispatchEvidence: row.has_dispatch_evidence,
    })),
  };
}

const INVENTORY_BASE_SQL = `
  SELECT id, workspace_id, status, claim_token, claim_expires_at,
    (
      staged_at IS NOT NULL
      OR dispatch_authorized_at IS NOT NULL
      OR dispatched_at IS NOT NULL
      OR note_id IS NOT NULL
      OR share_url IS NOT NULL
      OR receipt_acknowledged_at IS NOT NULL
    ) AS has_dispatch_evidence
  FROM local_publish_jobs
  WHERE status = ANY($1::text[])
`;

export async function inventoryLocalPublishQueue(
  queryable: Pick<PoolClient, 'query'> = getPool(),
) {
  const result = await queryable.query<InventoryRow>(
    `${INVENTORY_BASE_SQL} ORDER BY created_at, id`,
    [ACTIVE_STATUSES],
  );
  return summarize(result.rows);
}

export async function quarantineLocalPublishQueue(idempotencyKey: string) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
        'local-publish-queue-quarantine', 0
      ))`,
    );
    const existing = await client.query<{
      id: string;
      cutoff_at: Date | string;
      completed_at: Date | string | null;
      active_claim_count: number;
      dispatch_evidence_count: number;
      prior_status_counts: Partial<Record<QueueStatus, number>>;
    } & QueryResultRow>(
      `SELECT id, cutoff_at, completed_at, active_claim_count,
         dispatch_evidence_count, prior_status_counts
       FROM local_publish_queue_quarantines
       WHERE idempotency_key = $1::uuid
       FOR UPDATE`,
      [idempotencyKey],
    );
    if (existing.rows[0]) {
      const inventory = await quarantineInventory(client, existing.rows[0].id);
      await client.query('COMMIT');
      return {
        quarantineId: existing.rows[0].id,
        cutoffAt: timestamp(existing.rows[0].cutoff_at),
        inventory: {
          ...inventory,
          activeClaimCount: existing.rows[0].active_claim_count,
          dispatchEvidenceCount: existing.rows[0].dispatch_evidence_count,
          priorStatusCounts: existing.rows[0].prior_status_counts,
        },
        created: false,
      };
    }

    await client.query('LOCK TABLE local_publish_jobs IN SHARE ROW EXCLUSIVE MODE');
    const cutoff = await client.query<{ cutoff_at: Date | string } & QueryResultRow>(
      'SELECT statement_timestamp() AS cutoff_at',
    );
    const cutoffAt = cutoff.rows[0].cutoff_at;
    const rows = await client.query<InventoryRow>(
      `${INVENTORY_BASE_SQL}
       AND created_at <= $2::timestamptz
       ORDER BY created_at, id
       FOR UPDATE`,
      [ACTIVE_STATUSES, timestamp(cutoffAt)],
    );
    const inventory = summarize(rows.rows);
    const operation = await client.query<{ id: string } & QueryResultRow>(
      `INSERT INTO local_publish_queue_quarantines (
         idempotency_key, cutoff_at, job_count, active_claim_count,
         dispatch_evidence_count, prior_status_counts
       ) VALUES ($1::uuid, $2::timestamptz, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        idempotencyKey,
        timestamp(cutoffAt),
        inventory.total,
        inventory.activeClaimCount,
        inventory.dispatchEvidenceCount,
        JSON.stringify(inventory.priorStatusCounts),
      ],
    );
    const quarantineId = operation.rows[0].id;

    if (inventory.total > 0) {
      const jobIds = inventory.jobs.map((job) => job.id);
      await client.query(
        `INSERT INTO local_publish_queue_quarantine_items (
           quarantine_id, local_publish_job_id, workspace_id, prior_status,
           prior_claim_token, prior_claimed_at, prior_claim_expires_at,
           prior_batch_item_state, had_dispatch_evidence
         )
         SELECT $1::uuid, id, workspace_id, status, claim_token, claimed_at,
           claim_expires_at,
           (
             SELECT state
             FROM rednote_publish_batch_items
             WHERE id = local_publish_jobs.batch_item_id
           ),
           (
             staged_at IS NOT NULL
             OR dispatch_authorized_at IS NOT NULL
             OR dispatched_at IS NOT NULL
             OR note_id IS NOT NULL
             OR share_url IS NOT NULL
             OR receipt_acknowledged_at IS NOT NULL
           )
         FROM local_publish_jobs
         WHERE id = ANY($2::uuid[])`,
        [quarantineId, jobIds],
      );
      await client.query(
        `WITH changed AS (
           UPDATE rednote_publish_attempts
           SET active = FALSE,
               claim_token = NULL,
               claim_expires_at = CURRENT_TIMESTAMP,
               terminal_outcome = COALESCE(
                 terminal_outcome,
                 CASE
                   WHEN dispatch_authorized_at IS NOT NULL
                     OR receipt_lookup_state <> 'pending'
                   THEN 'outcome_unknown'
                   ELSE 'known_failed'
                 END
               ),
               terminal_at = COALESCE(terminal_at, CURRENT_TIMESTAMP),
               receipt_lookup_state = CASE
                 WHEN terminal_outcome IS NULL
                   AND dispatch_authorized_at IS NULL
                   AND receipt_lookup_state = 'pending'
                 THEN 'not_required'
                 ELSE receipt_lookup_state
               END,
               receipt_lookup_updated_at = CURRENT_TIMESTAMP
           WHERE source_local_publish_job_id = ANY($1::uuid[])
             AND superseded_by_attempt_id IS NULL
             AND (
               active
               OR claim_token IS NOT NULL
               OR terminal_outcome IS NULL
             )
           RETURNING id
         )
         INSERT INTO rednote_publish_attempt_events (
           attempt_id, event_type, occurred_at, actor_type, actor_id, diagnostics
         )
         SELECT id, 'queue_quarantined', CURRENT_TIMESTAMP, 'admin',
           $2, jsonb_build_object('quarantineId', $3::text)
         FROM changed`,
        [jobIds, `queue-reset:${quarantineId}`, quarantineId],
      );
      await client.query(
        `UPDATE rednote_publish_batch_items
         SET state = 'failed', updated_at = CURRENT_TIMESTAMP
         WHERE local_publish_job_id = ANY($1::uuid[])
           AND state NOT IN ('invalidated', 'failed')`,
        [jobIds],
      );
      await client.query(
        `UPDATE local_publish_jobs
         SET status = 'failed',
             claim_token = NULL,
             claim_expires_at = CURRENT_TIMESTAMP,
             error_code = CASE
               WHEN staged_at IS NOT NULL
                 OR dispatch_authorized_at IS NOT NULL
                 OR dispatched_at IS NOT NULL
                 OR note_id IS NOT NULL
                 OR share_url IS NOT NULL
                 OR receipt_acknowledged_at IS NOT NULL
               THEN 'QUEUE_RESET_QUARANTINED_REVIEW_REQUIRED'
               ELSE 'QUEUE_RESET_QUARANTINED'
             END,
             error_message = CASE
               WHEN staged_at IS NOT NULL
                 OR dispatch_authorized_at IS NOT NULL
                 OR dispatched_at IS NOT NULL
                 OR note_id IS NOT NULL
                 OR share_url IS NOT NULL
                 OR receipt_acknowledged_at IS NOT NULL
               THEN 'Quarantined by an operator queue reset. Preserve and review existing dispatch evidence; do not republish this job.'
               ELSE 'Quarantined by an operator queue reset. This job must not be published.'
             END,
             completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1::uuid[])`,
        [jobIds],
      );
    }
    await client.query(
      `UPDATE local_publish_queue_quarantines
       SET completed_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid`,
      [quarantineId],
    );
    await client.query('COMMIT');
    return {
      quarantineId,
      cutoffAt: timestamp(cutoffAt),
      inventory,
      created: true,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function quarantineInventory(client: PoolClient, quarantineId: string) {
  const result = await client.query<InventoryRow>(
    `SELECT item.local_publish_job_id AS id, item.workspace_id,
       item.prior_status AS status, item.prior_claim_token AS claim_token,
       item.prior_claim_expires_at AS claim_expires_at,
       item.had_dispatch_evidence AS has_dispatch_evidence
     FROM local_publish_queue_quarantine_items AS item
     WHERE item.quarantine_id = $1::uuid
     ORDER BY item.created_at, item.local_publish_job_id`,
    [quarantineId],
  );
  return summarize(result.rows);
}
