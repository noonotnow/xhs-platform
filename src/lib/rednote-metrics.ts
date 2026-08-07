import { sql } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { QueryResultRow } from 'pg';
import type {
  ClaimedRednoteMetricPost,
  RednoteMetricObservation,
  RednoteMetrics,
  RednoteWorkerRunSummary,
} from '@/types/rednote-metrics';

const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 20;
const DEFAULT_LEASE_SECONDS = 30 * 60;
const METRIC_KEYS = ['comments', 'likes', 'saves', 'shares', 'views'] as const;

interface MetricClaimRow extends QueryResultRow {
  notion_page_id: string;
  note_id: string;
  share_url: string;
  published_at: Date | string;
  claim_token: string;
  claim_expires_at: Date | string;
  latest_metrics: RednoteMetrics | null;
  last_observed_at: Date | string | null;
}

interface ObservationWriteRow extends QueryResultRow {
  snapshots_written: number;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseMetrics(value: unknown): RednoteMetrics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('metrics must be an object', 'VALIDATION_ERROR', 400);
  }
  const metrics = value as Record<string, unknown>;
  if (!exactKeys(metrics, METRIC_KEYS)) {
    throw new LocalPublishJobError(
      'metrics must contain only views, likes, comments, saves, and shares',
      'VALIDATION_ERROR',
      400,
    );
  }
  for (const key of METRIC_KEYS) {
    if (!Number.isSafeInteger(metrics[key]) || (metrics[key] as number) < 0) {
      throw new LocalPublishJobError(
        `${key} must be a non-negative integer`,
        'VALIDATION_ERROR',
        400,
      );
    }
  }
  return metrics as unknown as RednoteMetrics;
}

function parseUuid(value: unknown, field: string) {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new LocalPublishJobError(`${field} must be a UUID`, 'VALIDATION_ERROR', 400);
  }
  return value.toLowerCase();
}

export function parseMetricBatchLimit(value: string | null) {
  if (value === null || value === '') return DEFAULT_BATCH_SIZE;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new LocalPublishJobError(
      `limit must be between 1 and ${MAX_BATCH_SIZE}`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return parsed;
}

export function parseMetricObservations(value: unknown): RednoteMetricObservation[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('body must be an object', 'VALIDATION_ERROR', 400);
  }
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ['observations']) || !Array.isArray(body.observations)) {
    throw new LocalPublishJobError(
      'body must contain one observations array',
      'VALIDATION_ERROR',
      400,
    );
  }
  if (body.observations.length > MAX_BATCH_SIZE) {
    throw new LocalPublishJobError(
      `observations cannot contain more than ${MAX_BATCH_SIZE} posts`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return body.observations.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new LocalPublishJobError('observation must be an object', 'VALIDATION_ERROR', 400);
    }
    const observation = raw as Record<string, unknown>;
    if (!exactKeys(observation, ['claimToken', 'metrics', 'notionPageId', 'observedAt'])) {
      throw new LocalPublishJobError(
        'observation contains unsupported fields',
        'VALIDATION_ERROR',
        400,
      );
    }
    if (typeof observation.notionPageId !== 'string' || !observation.notionPageId.trim()) {
      throw new LocalPublishJobError(
        'notionPageId must be a non-empty string',
        'VALIDATION_ERROR',
        400,
      );
    }
    const observedAt = new Date(String(observation.observedAt));
    if (Number.isNaN(observedAt.getTime())) {
      throw new LocalPublishJobError(
        'observedAt must be an ISO timestamp',
        'VALIDATION_ERROR',
        400,
      );
    }
    return {
      notionPageId: observation.notionPageId.trim(),
      claimToken: parseUuid(observation.claimToken, 'claimToken'),
      observedAt: observedAt.toISOString(),
      metrics: parseMetrics(observation.metrics),
    };
  });
}

export async function claimDueRednoteMetricPosts(
  limit: number,
  onDemand: boolean,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<ClaimedRednoteMetricPost[]> {
  const result = await sql<MetricClaimRow>`
    WITH publication_sources AS (
      SELECT
        job.id AS source_job_id,
        NULL::uuid AS manual_handling_id,
        job.notion_page_id,
        job.note_id,
        job.share_url,
        CASE
          WHEN COALESCE(
            job.snapshot->>'publishAt',
            job.snapshot->>'scheduledDate'
          ) IS NOT NULL
            THEN COALESCE(
              job.snapshot->>'publishAt',
              job.snapshot->>'scheduledDate'
            )::timestamptz
          ELSE COALESCE(job.dispatched_at, job.verified_at, job.reconciled_at)
        END AS published_at
      FROM local_publish_jobs AS job
      WHERE job.status = 'reconciled'
        AND job.note_id IS NOT NULL
        AND job.share_url IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM plan_operator_scheduled_posts AS manual
          WHERE manual.notion_page_id = job.notion_page_id
            AND manual.receipt_status = 'reconciled'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM local_publish_jobs AS newer
          WHERE newer.notion_page_id = job.notion_page_id
            AND newer.status = 'reconciled'
            AND (newer.reconciled_at, newer.created_at, newer.id)
              > (job.reconciled_at, job.created_at, job.id)
        )
      UNION ALL
      SELECT
        NULL::uuid AS source_job_id,
        handling.id AS manual_handling_id,
        handling.notion_page_id,
        handling.note_id,
        handling.share_url,
        handling.published_at
      FROM plan_operator_scheduled_posts AS handling
      WHERE handling.receipt_status = 'reconciled'
        AND handling.note_id IS NOT NULL
        AND handling.share_url IS NOT NULL
        AND handling.published_at IS NOT NULL
    ),
    candidates AS (
      SELECT source.*
      FROM publication_sources AS source
      LEFT JOIN rednote_metric_collection_state AS state
        ON state.notion_page_id = source.notion_page_id
      WHERE (
          ${onDemand}
          OR source.published_at >= CURRENT_TIMESTAMP - INTERVAL '90 days'
        )
        AND (
          state.notion_page_id IS NULL
          OR (
            (
              state.claim_expires_at IS NULL
              OR state.claim_expires_at <= CURRENT_TIMESTAMP
            )
            AND (
              ${onDemand}
              OR state.last_observed_at IS NULL
              OR state.next_due_at <= CURRENT_TIMESTAMP
            )
          )
        )
      ORDER BY COALESCE(
        state.next_due_at,
        source.published_at
      ), source.notion_page_id
      LIMIT ${limit}
    ),
    claimed AS (
      INSERT INTO rednote_metric_collection_state (
        notion_page_id,
        source_job_id,
        manual_handling_id,
        claim_token,
        claimed_at,
        claim_expires_at
      )
      SELECT
        notion_page_id,
        source_job_id,
        manual_handling_id,
        gen_random_uuid(),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second')
      FROM candidates
      ON CONFLICT (notion_page_id) DO UPDATE
      SET source_job_id = EXCLUDED.source_job_id,
          manual_handling_id = EXCLUDED.manual_handling_id,
          claim_token = gen_random_uuid(),
          claimed_at = CURRENT_TIMESTAMP,
          claim_expires_at = CURRENT_TIMESTAMP + (${leaseSeconds} * INTERVAL '1 second'),
          updated_at = CURRENT_TIMESTAMP
      WHERE rednote_metric_collection_state.claim_expires_at IS NULL
        OR rednote_metric_collection_state.claim_expires_at <= CURRENT_TIMESTAMP
      RETURNING *
    )
    SELECT
      claimed.notion_page_id,
      candidates.note_id,
      candidates.share_url,
      candidates.published_at,
      claimed.claim_token,
      claimed.claim_expires_at,
      claimed.latest_metrics,
      claimed.last_observed_at
    FROM claimed
    JOIN candidates USING (notion_page_id)
    ORDER BY candidates.published_at, claimed.notion_page_id
  `;
  return result.rows.map((row) => ({
    notionPageId: row.notion_page_id,
    noteId: row.note_id,
    shareUrl: row.share_url,
    publishedAt: iso(row.published_at),
    claimToken: row.claim_token,
    claimExpiresAt: iso(row.claim_expires_at),
    ...(row.latest_metrics ? { previousMetrics: row.latest_metrics } : {}),
    ...(row.last_observed_at ? { lastObservedAt: iso(row.last_observed_at) } : {}),
  }));
}

async function writeMetricObservation(observation: RednoteMetricObservation) {
  const result = await sql<ObservationWriteRow>`
    WITH locked AS (
      SELECT *
      FROM rednote_metric_collection_state
      WHERE notion_page_id = ${observation.notionPageId}
        AND claim_token = ${observation.claimToken}::uuid
        AND (
          claim_expires_at > CURRENT_TIMESTAMP
          OR (
            last_observed_at = ${observation.observedAt}::timestamptz
            AND latest_metrics = ${JSON.stringify(observation.metrics)}::jsonb
          )
        )
      FOR UPDATE
    ),
    inserted AS (
      INSERT INTO post_performance_snapshots (
        notion_page_id,
        source_job_id,
        manual_handling_id,
        observed_at,
        metrics,
        write_reason
      )
      SELECT
        notion_page_id,
        source_job_id,
        manual_handling_id,
        ${observation.observedAt}::timestamptz,
        ${JSON.stringify(observation.metrics)}::jsonb,
        CASE
          WHEN latest_metrics IS DISTINCT FROM ${JSON.stringify(observation.metrics)}::jsonb
            THEN 'changed'
          ELSE 'checkpoint'
        END
      FROM locked
      WHERE latest_metrics IS DISTINCT FROM ${JSON.stringify(observation.metrics)}::jsonb
        OR last_snapshot_at IS NULL
        OR next_due_at <= ${observation.observedAt}::timestamptz
      ON CONFLICT (notion_page_id, observed_at) DO NOTHING
      RETURNING 1
    ),
    updated AS (
      UPDATE rednote_metric_collection_state AS state
      SET latest_metrics = ${JSON.stringify(observation.metrics)}::jsonb,
          last_observed_at = ${observation.observedAt}::timestamptz,
          last_snapshot_at = CASE
            WHEN EXISTS (SELECT 1 FROM inserted)
              THEN ${observation.observedAt}::timestamptz
            ELSE state.last_snapshot_at
          END,
          next_due_at = CASE
            WHEN ${observation.observedAt}::timestamptz
              <= publication.published_at + INTERVAL '48 hours'
              THEN ${observation.observedAt}::timestamptz + INTERVAL '6 hours'
            WHEN ${observation.observedAt}::timestamptz
              <= publication.published_at + INTERVAL '14 days'
              THEN ${observation.observedAt}::timestamptz + INTERVAL '1 day'
            WHEN ${observation.observedAt}::timestamptz
              <= publication.published_at + INTERVAL '90 days'
              THEN ${observation.observedAt}::timestamptz + INTERVAL '7 days'
            ELSE NULL
          END,
          claim_expires_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      FROM locked
      JOIN LATERAL (
        SELECT COALESCE(
          (
            SELECT CASE
              WHEN COALESCE(snapshot->>'publishAt', snapshot->>'scheduledDate') IS NOT NULL
                THEN COALESCE(
                  snapshot->>'publishAt',
                  snapshot->>'scheduledDate'
                )::timestamptz
              ELSE COALESCE(dispatched_at, verified_at, reconciled_at)
            END
            FROM local_publish_jobs
            WHERE id = locked.source_job_id
          ),
          (
            SELECT published_at
            FROM plan_operator_scheduled_posts
            WHERE id = locked.manual_handling_id
          )
        ) AS published_at
      ) AS publication ON true
      WHERE state.notion_page_id = locked.notion_page_id
        AND (
          state.last_observed_at IS DISTINCT FROM ${observation.observedAt}::timestamptz
          OR state.latest_metrics IS DISTINCT FROM ${JSON.stringify(observation.metrics)}::jsonb
          OR EXISTS (SELECT 1 FROM inserted)
        )
      RETURNING 1
    )
    SELECT
      CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN 1 ELSE 0 END AS snapshots_written
    FROM locked
  `;
  if (!result.rows[0]) {
    throw new LocalPublishJobError(
      'The metrics claim is stale or was not found',
      'STALE_CLAIM',
      409,
    );
  }
  return result.rows[0].snapshots_written;
}

export async function recordRednoteMetricObservations(
  observations: RednoteMetricObservation[],
) {
  const summary: RednoteWorkerRunSummary = {
    claimed: 0,
    verified: 0,
    measured: 0,
    snapshotsWritten: 0,
    failures: 0,
  };
  for (const observation of observations) {
    try {
      summary.snapshotsWritten += await writeMetricObservation(observation);
      summary.measured += 1;
    } catch (error) {
      if (error instanceof LocalPublishJobError) {
        summary.failures += 1;
      } else {
        throw error;
      }
    }
  }
  return summary;
}
