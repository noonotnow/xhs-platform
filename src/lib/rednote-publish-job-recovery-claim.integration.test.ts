import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { rednotePublishMedia } from '@/lib/rednote-publish-authorization';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

let database: PGlite;
let failQueryContaining: string | null = null;

async function queryDatabase(text: string, params: unknown[] = []) {
  if (failQueryContaining && text.includes(failQueryContaining)) {
    throw new Error('forced recovery transaction failure');
  }
  if (
    text.includes('pg_advisory_xact_lock')
    || text.match(/^\s*LOCK TABLE /)
  ) {
    return { rows: [], rowCount: 0 };
  }
  const result = await database.query<Record<string, unknown>>(text, params);
  return {
    ...result,
    rows: result.rows,
    rowCount: result.affectedRows ?? result.rows.length,
  };
}

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: async () => ({
      query: queryDatabase,
      release: () => undefined,
    }),
    query: queryDatabase,
  }),
  sql: async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    let text = '';
    strings.forEach((part, index) => {
      text += part;
      if (index < values.length) text += `$${index + 1}`;
    });
    return queryDatabase(text, values);
  },
}));

import {
  submitLocalPublishJobResult,
} from '@/lib/local-publish-jobs';
import {
  claimNextStoredLocalPublishJob,
} from '@/lib/local-publish-job-store';
import {
  PublishJobRecoveryError,
  recoverStoredApprovedPublishJob,
} from '@/lib/rednote-publish-job-recovery-store';
import { listStoredPublishBatches } from '@/lib/rednote-publish-batch-store';
import {
  bindLinkedAttemptClaim,
  readRednotePublishingOperational,
  requeueReadyX3NotLoggedInFailure,
} from '@/lib/rednote-publishing-attempt-store';

const MIGRATIONS = [
  '002_xhs_publish_receipts.sql',
  '003_local_publish_jobs.sql',
  '004_external_post_reconciliations.sql',
  '005_local_publish_job_lifecycle.sql',
  '006_rednote_worker_lanes.sql',
  '007_manual_reconciliation_requests.sql',
  '008_rednote_publish_batches.sql',
  '009_superseded_rednote_publish_batches.sql',
  '010_plan_rednote_batch_handoff.sql',
  '010_rednote_publish_job_recoveries.sql',
  '011_generation_aware_rednote_publish_job_recoveries.sql',
  '012_recover_fixed_image_mode_hydration.sql',
  '013_targeted_external_job_dispositions.sql',
  '014_operator_success_attestations.sql',
  '015_manual_scheduling_attestations.sql',
  '016_plan_operator_scheduled_posts.sql',
  '017_manual_first_receipt_lane.sql',
  '018_rednote_publishing_attempts.sql',
  '019_plan_operator_scheduled_stable_link_capture.sql',
  '019_local_publish_job_workspaces.sql',
  '020_ready_x3_authorization.sql',
  '021_local_publish_worker_heartbeats.sql',
  '022_ready_x3_invalid_claim_recovery.sql',
  '023_rednote_worker_result_v2.sql',
  '024_local_publish_queue_quarantine.sql',
  '025_late_rednote_terminal_results.sql',
  '026_batch_authorization_reclassification.sql',
  '027_expired_batch_claim_reclassification.sql',
  '028_legacy_ready_x3_batch_fallback_reclassification.sql',
  '029_terminal_expired_batch_claim_reclassification.sql',
  '030_revision_aware_publish_lifecycle.sql',
  '031_recovery_attempt_generations.sql',
  '032_recover_creator_login_failure.sql',
  '033_rejected_worker_result_recovery_evidence.sql',
  '034_recover_schedule_readback_mismatch.sql',
] as const;

const EXACT_JOB_ID = 'c6203283-be7d-46ce-a38b-9a7f90eef75d';
const EXACT_BATCH_ITEM_ID = 'ce1ccb59-182e-4740-8ce6-37318dd6b1f0';
const EXACT_REVISION = '2026-09-08T23:36:00.000Z';
const EXACT_MANIFEST =
  '6b1e20c762ffb506ba24d977f48774c909a095894363f26da74ce891ec54dd1a';
const HISTORICAL_JOB_ID = 'a6cdfa8a-e840-4e48-9776-044a8cd2b093';
const FROZEN_DIGEST = 'a'.repeat(64);
const ITEM_HASH = 'b'.repeat(64);
const RECOVERED_BY = 'day-16-operator';
const ORIGINAL_AUDIT_ACTOR = 'Original.Operator@example.com';
const REPAIR_OPERATOR = 'repair.admin@example.com';

function frozenSnapshot(
  notionPageId: string,
  revision = EXACT_REVISION,
): LocalPublishSnapshot {
  const mediaUrl = 'https://example.com/recovery.png';
  return {
    notionPageId,
    notionLastEditedTime: revision,
    headline: 'Exact recovery invariant',
    title: 'Exact recovery invariant',
    caption: 'The frozen caption must survive recovery and claim.',
    tags: ['recovery', 'bounded'],
    platform: 'RedNote',
    mediaType: 'image',
    mediaIndex: 0,
    mediaUrl,
    media: [rednotePublishMedia('image', mediaUrl)],
    expectedAccountId: 'creator-account',
    publishAt: '2026-09-09T02:00:00.000Z',
  };
}

type RecoveryFixture = {
  batchId: string;
  batchItemId: string;
  jobId: string;
  sourceAttemptId: string;
  workspaceId: string;
  claimedAt: string;
  completedAt: string;
  terminalAt: string;
  input: {
    batchId: string;
    manifestHash: string;
    itemId: string;
    jobId: string;
    itemHash: string;
    snapshotRevision: string;
  };
};

async function insertRecoverableFixture({
  jobId = crypto.randomUUID(),
  batchItemId = crypto.randomUUID(),
  revision = new Date().toISOString(),
  notionPageId = `page-${crypto.randomUUID()}`,
  workspaceId = `workspace-${crypto.randomUUID()}`,
  approvedSource = true,
  readyX3Authorization = true,
  errorCode = 'BOUNDED_BATCH_BYPASS_DISABLED',
  errorMessage = 'bounded batch enforcement',
}: {
  jobId?: string;
  batchItemId?: string;
  revision?: string;
  notionPageId?: string;
  workspaceId?: string;
  approvedSource?: boolean;
  readyX3Authorization?: boolean;
  errorCode?: string;
  errorMessage?: string;
} = {}): Promise<RecoveryFixture> {
  const batchId = crypto.randomUUID();
  const sourceAttemptId = crypto.randomUUID();
  const sourceClaimToken = crypto.randomUUID();
  const approvedAt = new Date(Date.now() - 120_000).toISOString();
  const claimedAt = new Date(Date.now() - 60_000).toISOString();
  const terminalAt = new Date(Date.now() - 59_500).toISOString();
  const completedAt = new Date(Date.now() - 59_000).toISOString();
  const snapshot = frozenSnapshot(notionPageId, revision);

  await database.query(
    `INSERT INTO local_publish_jobs (
      id, workspace_id, notion_page_id, snapshot, status, claim_token,
      claim_attempts, claimed_at, claim_expires_at, completed_at,
      error_code, error_message, idempotency_key, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4::jsonb, 'failed', NULL,
      1, $5::timestamptz, $6::timestamptz, $6::timestamptz,
      $7, $8,
      gen_random_uuid(), $5, $6
    )`,
    [
      jobId,
      workspaceId,
      notionPageId,
      JSON.stringify(snapshot),
      claimedAt,
      completedAt,
      errorCode,
      errorMessage,
    ],
  );
  await database.query(
    `INSERT INTO rednote_publish_batches (
      id, workspace_id, kind, status, manifest_hash, created_at,
      approved_at, approved_by
    ) VALUES (
      $1, $2, 'bootstrap', 'approved', $3, $4, $4, 'day-16-operator'
    )`,
    [batchId, workspaceId, EXACT_MANIFEST, approvedAt],
  );
  await database.query(
    `INSERT INTO rednote_publish_batch_items (
      id, workspace_id, batch_id, notion_page_id, snapshot, item_hash,
      state, dispatch_mode, local_publish_job_id, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5::jsonb, $6,
      'failed', 'scheduled', $7, $8, $8
    )`,
    [
      batchItemId,
      workspaceId,
      batchId,
      notionPageId,
      JSON.stringify(snapshot),
      ITEM_HASH,
      jobId,
      approvedAt,
    ],
  );
  await database.query(
    `UPDATE local_publish_jobs SET batch_item_id = $2 WHERE id = $1`,
    [jobId, batchItemId],
  );
  await database.query(
    `INSERT INTO rednote_publish_attempts (
      id, workspace_id, idempotency_key, contract_revision,
      source_notion_page_id, source_local_publish_job_id,
      frozen_payload, payload_digest, payload_revision,
      executor_type, executor_kind, executor_id, worker_run_id,
      playwright_run_id, target_publish_at, requested_at,
      terminal_outcome, terminal_at, receipt_lookup_state,
      receipt_lookup_updated_at, active, diagnostics, approved_at,
      authorization_kind, late_fallback_policy, claim_token
    ) VALUES (
      $1, $2, gen_random_uuid(), 'rednote-publishing/v1',
      $3, $4, $5::jsonb, $6, $7,
      'worker', 'playwright', 'local-publisher',
      NULL, NULL,
      $8::timestamptz, $9::timestamptz,
      'known_failed', $10::timestamptz, 'not_required',
      $10::timestamptz, FALSE, '{"preserved":true}'::jsonb,
      $11::timestamptz, $12, $13::jsonb, $14::uuid
    )`,
    [
      sourceAttemptId,
      workspaceId,
      notionPageId,
      jobId,
      JSON.stringify(snapshot),
      FROZEN_DIGEST,
      revision,
      snapshot.publishAt,
      approvedAt,
      terminalAt,
      approvedSource ? approvedAt : null,
      approvedSource && readyX3Authorization ? 'ready_x3' : null,
      approvedSource && readyX3Authorization
        ? JSON.stringify({ action: 'schedule', maxLateMinutes: 30 })
        : null,
      sourceClaimToken,
    ],
  );
  await database.query(
    `INSERT INTO rednote_publish_attempt_events (
      attempt_id, event_type, actor_type, actor_id, occurred_at, diagnostics
    ) VALUES (
      $1, 'terminal_outcome_recorded', 'worker', 'historical-worker',
      $2, '{"preserved":true}'::jsonb
    )`,
    [sourceAttemptId, terminalAt],
  );

  return {
    batchId,
    batchItemId,
    jobId,
    sourceAttemptId,
    workspaceId,
    claimedAt,
    completedAt,
    terminalAt,
    input: {
      batchId,
      manifestHash: EXACT_MANIFEST,
      itemId: batchItemId,
      jobId,
      itemHash: ITEM_HASH,
      snapshotRevision: revision,
    },
  };
}

async function insertQueueOnlyRecoveryAudit(
  fixture: RecoveryFixture,
  {
    manifestHash = EXACT_MANIFEST,
    itemHash = ITEM_HASH,
    snapshotRevision = fixture.input.snapshotRevision,
    recoveredBy = RECOVERED_BY,
    priorErrorCode = 'BOUNDED_BATCH_BYPASS_DISABLED',
    priorErrorMessage = 'bounded batch enforcement',
  }: {
    manifestHash?: string;
    itemHash?: string;
    snapshotRevision?: string;
    recoveredBy?: string;
    priorErrorCode?: string;
    priorErrorMessage?: string;
  } = {},
) {
  const recoveredAt = new Date().toISOString();
  const inserted = await database.query<{ id: string }>(
    `INSERT INTO rednote_publish_job_recoveries (
      local_publish_job_id, batch_id, batch_item_id, manifest_hash,
      item_hash, snapshot_revision, prior_error_code,
      prior_error_message, prior_claim_attempts, prior_claimed_at,
      prior_completed_at, recovered_by, recovered_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $11, $12,
      1, $7, $8, $9, $10
    )
    RETURNING id`,
    [
      fixture.jobId,
      fixture.batchId,
      fixture.batchItemId,
      manifestHash,
      itemHash,
      snapshotRevision,
      fixture.claimedAt,
      fixture.completedAt,
      recoveredBy,
      recoveredAt,
      priorErrorCode,
      priorErrorMessage,
    ],
  );
  await database.query(
    `UPDATE local_publish_jobs
     SET status = 'queued', claim_token = NULL, claimed_at = NULL,
         claim_expires_at = NULL, completed_at = NULL,
         error_code = NULL, error_message = NULL, updated_at = $2
     WHERE id = $1`,
    [fixture.jobId, recoveredAt],
  );
  await database.query(
    `UPDATE rednote_publish_batch_items
     SET state = 'queued', updated_at = $2
     WHERE id = $1`,
    [fixture.batchItemId, recoveredAt],
  );
  return inserted.rows[0]!.id;
}

async function countRows(table: string, where = '', params: unknown[] = []) {
  const result = await database.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${table} ${where}`,
    params,
  );
  return result.rows[0]?.count ?? 0;
}

async function readRecoveryMutationState(jobId: string) {
  const [job, attempts, recoveries, generations, events, publicationEvidence] = await Promise.all([
    database.query<Record<string, unknown>>(
      'SELECT * FROM local_publish_jobs WHERE id = $1',
      [jobId],
    ),
    database.query<Record<string, unknown>>(
      `SELECT * FROM rednote_publish_attempts
       WHERE source_local_publish_job_id = $1
       ORDER BY created_at, id`,
      [jobId],
    ),
    database.query<Record<string, unknown>>(
      `SELECT * FROM rednote_publish_job_recoveries
       WHERE local_publish_job_id = $1
       ORDER BY recovered_at, id`,
      [jobId],
    ),
    database.query<Record<string, unknown>>(
      `SELECT generation.*
       FROM rednote_publish_recovery_attempt_generations generation
       JOIN rednote_publish_job_recoveries recovery
         ON recovery.id = generation.recovery_id
       WHERE recovery.local_publish_job_id = $1
       ORDER BY generation.created_at, generation.recovery_id`,
      [jobId],
    ),
    database.query<Record<string, unknown>>(
      `SELECT event.*
       FROM rednote_publish_attempt_events event
       JOIN rednote_publish_attempts attempt ON attempt.id = event.attempt_id
       WHERE attempt.source_local_publish_job_id = $1
       ORDER BY event.occurred_at, event.id`,
      [jobId],
    ),
    database.query<Record<string, unknown>>(
      `SELECT *
       FROM rednote_publication_evidence
       WHERE local_publish_job_id = $1
       ORDER BY captured_at, id`,
      [jobId],
    ),
  ]);
  return {
    job: job.rows,
    attempts: attempts.rows,
    recoveries: recoveries.rows,
    generations: generations.rows,
    events: events.rows,
    publicationEvidence: publicationEvidence.rows,
  };
}

async function insertHistoricalEvidenceFixture() {
  const attemptId = crypto.randomUUID();
  const notionPageId = 'page-historical-sep-8';
  const revision = '2026-09-08T12:00:00.000Z';
  const snapshot = frozenSnapshot(notionPageId, revision);

  await database.query(
    `INSERT INTO local_publish_jobs (
      id, workspace_id, notion_page_id, snapshot, status, note_id, share_url,
      claim_attempts, idempotency_key, created_at, updated_at, completed_at
    ) VALUES (
      $1, 'historical', $2, $3::jsonb, 'reconciled', 'historical-note',
      'https://www.xiaohongshu.com/explore/historical-note',
      1, gen_random_uuid(), $4, $4, $4
    )`,
    [HISTORICAL_JOB_ID, notionPageId, JSON.stringify(snapshot), revision],
  );
  await database.query(
    `INSERT INTO rednote_publish_attempts (
      id, workspace_id, idempotency_key, contract_revision,
      source_notion_page_id, source_local_publish_job_id,
      frozen_payload, payload_digest, payload_revision,
      executor_type, executor_kind, executor_id, worker_run_id,
      playwright_run_id, target_publish_at, requested_at,
      terminal_outcome, terminal_at,
      receipt_lookup_state, receipt_lookup_updated_at, active,
      diagnostics, approved_at, authorization_kind, late_fallback_policy
    ) VALUES (
      $1, 'historical', gen_random_uuid(), 'rednote-publishing/v1',
      $2, $3, $4::jsonb, $5, $6::text,
      'worker', 'playwright', 'historical-worker', 'preserved-worker-run',
      'preserved-playwright-run', $6::timestamptz, $6::timestamptz, 'accepted',
      $6::timestamptz, 'found', $6::timestamptz,
      FALSE, '{"preserved":true}'::jsonb, $6::timestamptz, 'ready_x3',
      '{"action":"schedule","maxLateMinutes":30}'::jsonb
    )`,
    [
      attemptId,
      notionPageId,
      HISTORICAL_JOB_ID,
      JSON.stringify(snapshot),
      'c'.repeat(64),
      revision,
    ],
  );
  await database.query(
    `INSERT INTO rednote_publish_attempt_receipts (
      attempt_id, rednote_url, rednote_note_id, platform_publish_time,
      captured_at, provenance
    ) VALUES (
      $1, 'https://www.xiaohongshu.com/explore/historical-note',
      'historical-note', $2, $2, '{"preserved":true}'::jsonb
    )`,
    [attemptId, revision],
  );
  await database.query(
    `INSERT INTO rednote_publication_evidence (
      workspace_id, local_publish_job_id, attempt_id, note_id,
      evidence_kind, captured_at, evidence_status, public_url, details
    ) VALUES (
      'historical', $1, $2, 'historical-note', 'public_index', $3,
      'indexed', 'https://www.xiaohongshu.com/explore/historical-note',
      '{"preserved":true}'::jsonb
    )`,
    [HISTORICAL_JOB_ID, attemptId, revision],
  );
  return attemptId;
}

describe.sequential('exact publish-job recovery to claim invariant', () => {
  beforeAll(async () => {
    database = new PGlite();
    for (const migration of MIGRATIONS) {
      const sql = await readFile(
        path.join(process.cwd(), 'migrations', migration),
        'utf8',
      );
      await database.exec(sql);
    }
  }, 120_000);

  beforeEach(() => {
    failQueryContaining = null;
  });

  afterAll(async () => {
    await database.close();
  });

  it('creates one immutable generation and makes the exact job claimable exactly once', async () => {
    const fixture = await insertRecoverableFixture({
      jobId: EXACT_JOB_ID,
      batchItemId: EXACT_BATCH_ITEM_ID,
      revision: EXACT_REVISION,
      notionPageId: 'page-day-16-exact-recovery',
      workspaceId: 'default',
      errorCode: 'NOT_LOGGED_IN',
      errorMessage: 'RedNote creator login is required in the persistent browser profile',
    });
    const historicalAttemptId = await insertHistoricalEvidenceFixture();
    const historicalBefore = await database.query<Record<string, unknown>>(
      `SELECT * FROM rednote_publish_attempts WHERE id = $1`,
      [historicalAttemptId],
    );
    const receiptBefore = await database.query<Record<string, unknown>>(
      `SELECT * FROM rednote_publish_attempt_receipts WHERE attempt_id = $1`,
      [historicalAttemptId],
    );
    const evidenceBefore = await database.query<Record<string, unknown>>(
      `SELECT * FROM rednote_publication_evidence WHERE attempt_id = $1`,
      [historicalAttemptId],
    );
    const beforeRecovery = await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    );
    expect(beforeRecovery[0].items[0].recoveryEvidence).toEqual({
      ...fixture.input,
      priorErrorCode: 'NOT_LOGGED_IN',
      claimAttempts: 1,
    });
    expect(beforeRecovery[0].items[0].recoveryEvidence)
      .not.toHaveProperty('recoveredBy');
    await expect(listStoredPublishBatches(
      'wrong-workspace',
      fixture.batchId,
    )).resolves.toEqual([]);
    expect(await database.query<{ claim_attempts: number }>(
      `SELECT claim_attempts FROM local_publish_jobs WHERE id = $1`,
      [EXACT_JOB_ID],
    )).toMatchObject({ rows: [{ claim_attempts: 1 }] });

    const recovered = await recoverStoredApprovedPublishJob(
      fixture.input,
      RECOVERED_BY,
    );

    expect(fixture.terminalAt).not.toBe(fixture.completedAt);
    expect(recovered).toMatchObject({
      jobId: EXACT_JOB_ID,
      itemId: EXACT_BATCH_ITEM_ID,
      snapshotRevision: EXACT_REVISION,
      priorClaimAttempts: 1,
      alreadyRecovered: false,
    });
    const generations = await database.query<{
      id: string;
      frozen_payload: LocalPublishSnapshot;
      payload_digest: string;
      payload_revision: string;
      target_publish_at: string;
      approved_at: string;
      authorization_kind: string;
      late_fallback_policy: unknown;
      terminal_outcome: string | null;
      receipt_lookup_state: string;
      active: boolean;
      claim_token: string | null;
      dispatch_authorized_at: string | null;
      worker_run_id: string | null;
      playwright_run_id: string | null;
      supersedes_attempt_id: string | null;
      superseded_by_attempt_id: string | null;
    }>(
      `SELECT * FROM rednote_publish_attempts
       WHERE source_local_publish_job_id = $1
       ORDER BY created_at, id`,
      [EXACT_JOB_ID],
    );
    expect(generations.rows).toHaveLength(2);
    const source = generations.rows.find(({ id }) => id === fixture.sourceAttemptId);
    const replacement = generations.rows.find(({ id }) => id !== fixture.sourceAttemptId);
    expect(source).toMatchObject({
      terminal_outcome: 'known_failed',
      receipt_lookup_state: 'not_required',
      active: false,
      worker_run_id: null,
      playwright_run_id: null,
      superseded_by_attempt_id: replacement?.id,
    });
    expect(replacement).toMatchObject({
      frozen_payload: source?.frozen_payload,
      payload_digest: source?.payload_digest,
      payload_revision: EXACT_REVISION,
      target_publish_at: source?.target_publish_at,
      approved_at: source?.approved_at,
      authorization_kind: source?.authorization_kind,
      late_fallback_policy: source?.late_fallback_policy,
      terminal_outcome: null,
      receipt_lookup_state: 'pending',
      active: true,
      claim_token: null,
      dispatch_authorized_at: null,
      worker_run_id: null,
      playwright_run_id: null,
      supersedes_attempt_id: fixture.sourceAttemptId,
      superseded_by_attempt_id: null,
    });
    expect(await countRows('rednote_publish_recovery_attempt_generations')).toBe(1);
    expect(await countRows('rednote_publish_job_recoveries')).toBe(1);
    expect(await database.query<{
      prior_error_code: string;
      prior_error_message: string;
    }>(
      `SELECT prior_error_code, prior_error_message
       FROM rednote_publish_job_recoveries
       WHERE local_publish_job_id = $1`,
      [EXACT_JOB_ID],
    )).toMatchObject({
      rows: [{
        prior_error_code: 'NOT_LOGGED_IN',
        prior_error_message:
          'RedNote creator login is required in the persistent browser profile',
      }],
    });
    expect(await countRows(
      'rednote_publish_attempt_events',
      'WHERE attempt_id IN ($1, $2)',
      [fixture.sourceAttemptId, replacement?.id],
    )).toBe(4);
    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();
    expect(await database.query<{ claim_attempts: number }>(
      `SELECT claim_attempts FROM local_publish_jobs WHERE id = $1`,
      [EXACT_JOB_ID],
    )).toMatchObject({ rows: [{ claim_attempts: 1 }] });

    const projected = await readRednotePublishingOperational(fixture.workspaceId);
    expect(projected.queue.filter(({ id }) => id === EXACT_JOB_ID)).toHaveLength(1);
    expect(projected.queue.find(({ id }) => id === EXACT_JOB_ID)).toMatchObject({
      state: 'queued',
      eligible: true,
      activeAttempt: true,
      authorization: {
        kind: 'ready_x3',
        state: 'ready',
      },
      receipt: {
        attemptId: replacement?.id,
        state: 'pending',
      },
    });
    expect(projected.summary).toMatchObject({
      queued: 1,
      active: 1,
      failed: 0,
    });
    expect(projected.attempts
      .filter(({ id }) => [fixture.sourceAttemptId, replacement?.id].includes(id))
      .map(({ id }) => id)
      .sort()).toEqual([fixture.sourceAttemptId, replacement?.id].sort());

    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      RECOVERED_BY,
    )).resolves.toMatchObject({
      jobId: EXACT_JOB_ID,
      priorClaimAttempts: 1,
      alreadyRecovered: true,
    });
    expect(await countRows(
      'rednote_publish_attempts',
      'WHERE source_local_publish_job_id = $1',
      [EXACT_JOB_ID],
    )).toBe(2);
    expect(await countRows('rednote_publish_recovery_attempt_generations')).toBe(1);
    expect(await countRows('rednote_publish_job_recoveries')).toBe(1);
    expect(await countRows(
      'rednote_publish_attempt_events',
      'WHERE attempt_id IN ($1, $2)',
      [fixture.sourceAttemptId, replacement?.id],
    )).toBe(4);

    const claimToken = crypto.randomUUID();
    const claimed = await claimNextStoredLocalPublishJob(
      300,
      'dispatch',
      undefined,
      fixture.workspaceId,
      claimToken,
    );
    expect(claimed).toMatchObject({
      id: EXACT_JOB_ID,
      status: 'claimed',
      claimToken,
      expectedAccountId: 'creator-account',
      publishAt: '2026-09-09T02:00:00.000Z',
      batchAuthorization: {
        batchId: fixture.batchId,
        manifestHash: EXACT_MANIFEST,
        itemHash: ITEM_HASH,
        snapshotRevision: EXACT_REVISION,
        lateAction: 'schedule',
      },
    });
    const claimedJob = await database.query<{
      claim_attempts: number;
      snapshot: LocalPublishSnapshot;
    }>(
      `SELECT claim_attempts, snapshot
       FROM local_publish_jobs WHERE id = $1`,
      [EXACT_JOB_ID],
    );
    expect(claimedJob.rows[0]).toMatchObject({
      claim_attempts: 2,
      snapshot: frozenSnapshot('page-day-16-exact-recovery'),
    });
    const claimedAttempt = await database.query<{
      id: string;
      claim_token: string;
      dispatch_authorized_at: string | null;
    }>(
      `SELECT id, claim_token, dispatch_authorized_at
       FROM rednote_publish_attempts
       WHERE source_local_publish_job_id = $1 AND active`,
      [EXACT_JOB_ID],
    );
    expect(claimedAttempt.rows).toEqual([{
      id: replacement?.id,
      claim_token: null,
      dispatch_authorized_at: null,
    }]);

    const replayedClaim = await claimNextStoredLocalPublishJob(
      300,
      'dispatch',
      undefined,
      fixture.workspaceId,
      claimToken,
    );
    expect(replayedClaim?.id).toBe(EXACT_JOB_ID);
    expect(await database.query<{ claim_attempts: number }>(
      `SELECT claim_attempts FROM local_publish_jobs WHERE id = $1`,
      [EXACT_JOB_ID],
    )).toMatchObject({ rows: [{ claim_attempts: 2 }] });
    await expect(claimNextStoredLocalPublishJob(
      300,
      'dispatch',
      undefined,
      fixture.workspaceId,
      crypto.randomUUID(),
    )).resolves.toBeNull();

    expect((await database.query<Record<string, unknown>>(
      `SELECT * FROM rednote_publish_attempts WHERE id = $1`,
      [historicalAttemptId],
    )).rows).toEqual(historicalBefore.rows);
    expect((await database.query<Record<string, unknown>>(
      `SELECT * FROM rednote_publish_attempt_receipts WHERE attempt_id = $1`,
      [historicalAttemptId],
    )).rows).toEqual(receiptBefore.rows);
    expect((await database.query<Record<string, unknown>>(
      `SELECT * FROM rednote_publication_evidence WHERE attempt_id = $1`,
      [historicalAttemptId],
    )).rows).toEqual(evidenceBefore.rows);
  }, 30_000);

  it('projects and recovers an exact pre-dispatch schedule readback mismatch', async () => {
    const fixture = await insertRecoverableFixture({
      errorCode: 'SCHEDULE_READBACK_MISMATCH',
      errorMessage:
        'Creator date-picker did not retain the scheduled time (got "2026-09-10 17:20", expected "2026-09-12 07:20")',
    });

    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toEqual({
      ...fixture.input,
      priorErrorCode: 'SCHEDULE_READBACK_MISMATCH',
      claimAttempts: 1,
    });

    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      RECOVERED_BY,
    )).resolves.toMatchObject({
      jobId: fixture.jobId,
      priorClaimAttempts: 1,
      alreadyRecovered: false,
    });
    expect(await database.query<{
      status: string;
      error_code: string | null;
      error_message: string | null;
    }>(
      `SELECT status, error_code, error_message
       FROM local_publish_jobs
       WHERE id = $1`,
      [fixture.jobId],
    )).toMatchObject({
      rows: [{
        status: 'queued',
        error_code: null,
        error_message: null,
      }],
    });
    expect(await database.query<{
      prior_error_code: string;
      prior_error_message: string;
    }>(
      `SELECT prior_error_code, prior_error_message
       FROM rednote_publish_job_recoveries
       WHERE local_publish_job_id = $1`,
      [fixture.jobId],
    )).toMatchObject({
      rows: [{
        prior_error_code: 'SCHEDULE_READBACK_MISMATCH',
        prior_error_message:
          'Creator date-picker did not retain the scheduled time (got "2026-09-10 17:20", expected "2026-09-12 07:20")',
      }],
    });
  });

  it('rejects malformed schedule readback failures without mutating recovery state', async () => {
    const fixture = await insertRecoverableFixture({
      errorCode: 'SCHEDULE_READBACK_MISMATCH',
      errorMessage:
        'Creator date-picker did not retain the scheduled time (got "2026-09-10 17:20", expected "2026-09-12 7:20")',
    });
    const before = await readRecoveryMutationState(fixture.jobId);

    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();
    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      RECOVERED_BY,
    )).rejects.toMatchObject({
      code: 'RECOVERY_PRECONDITION_FAILED',
      status: 409,
    } satisfies Partial<PublishJobRecoveryError>);
    expect(await readRecoveryMutationState(fixture.jobId)).toEqual(before);
  });

  it('keeps schedule readback recovery blocked without mutation once lifecycle or publication evidence exists', async () => {
    const fixture = await insertRecoverableFixture({
      errorCode: 'SCHEDULE_READBACK_MISMATCH',
      errorMessage:
        'Creator date-picker did not retain the scheduled time (got "2026-09-10 17:20", expected "2026-09-12 07:20")',
    });
    const blockingEvidence = [
      {
        set: "staged_at = '2026-09-10T17:20:00.000Z'",
        clear: 'staged_at = NULL',
      },
      {
        set: "dispatch_authorized_at = '2026-09-10T17:20:00.000Z'",
        clear: 'dispatch_authorized_at = NULL',
      },
      {
        set: "dispatched_at = '2026-09-10T17:20:00.000Z'",
        clear: 'dispatched_at = NULL',
      },
      {
        set: "note_id = 'rednote-note-id'",
        clear: 'note_id = NULL',
      },
      {
        set: "share_url = 'https://www.rednote.com/explore/rednote-note-id'",
        clear: 'share_url = NULL',
      },
      {
        set: "next_verification_at = '2026-09-10T17:20:00.000Z'",
        clear: 'next_verification_at = NULL',
      },
      {
        set: 'verification_attempts = 1',
        clear: 'verification_attempts = 0',
      },
      {
        set: "verified_at = '2026-09-10T17:20:00.000Z'",
        clear: 'verified_at = NULL',
      },
      {
        set: "reconciled_at = '2026-09-10T17:20:00.000Z'",
        clear: 'reconciled_at = NULL',
      },
    ] as const;

    for (const evidence of blockingEvidence) {
      await database.query(
        `UPDATE local_publish_jobs SET ${evidence.set} WHERE id = $1`,
        [fixture.jobId],
      );
      const before = await readRecoveryMutationState(fixture.jobId);
      expect((await listStoredPublishBatches(
        fixture.workspaceId,
        fixture.batchId,
      ))[0].items[0].recoveryEvidence).toBeUndefined();
      await expect(recoverStoredApprovedPublishJob(
        fixture.input,
        RECOVERED_BY,
      )).rejects.toMatchObject({
        code: 'RECOVERY_PRECONDITION_FAILED',
        status: 409,
      } satisfies Partial<PublishJobRecoveryError>);
      expect(await readRecoveryMutationState(fixture.jobId)).toEqual(before);
      await database.query(
        `UPDATE local_publish_jobs SET ${evidence.clear} WHERE id = $1`,
        [fixture.jobId],
      );
    }

    await database.query(
      `INSERT INTO rednote_publication_evidence (
        workspace_id, local_publish_job_id, note_id, evidence_kind,
        captured_at, account_id, evidence_status
      ) VALUES (
        $1, $2, 'rednote-note-id', 'authenticated_account',
        '2026-09-10T17:20:00.000Z', 'creator-account', 'owned'
      )`,
      [fixture.workspaceId, fixture.jobId],
    );
    const beforePublicationEvidence = await readRecoveryMutationState(fixture.jobId);
    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      RECOVERED_BY,
    )).rejects.toMatchObject({
      code: 'RECOVERY_PRECONDITION_FAILED',
      status: 409,
    } satisfies Partial<PublishJobRecoveryError>);
    expect(await readRecoveryMutationState(fixture.jobId))
      .toEqual(beforePublicationEvidence);
  });

  it('projects a prior recovery after a second bound claim ends in a canonical login rejection', async () => {
    const notionPageId = 'page-day-16-login-refailure';
    const fixture = await insertRecoverableFixture({
      revision: EXACT_REVISION,
      notionPageId,
      readyX3Authorization: false,
      errorCode: 'NOT_LOGGED_IN',
      errorMessage:
        'RedNote creator login is required in the persistent browser profile',
    });
    await insertQueueOnlyRecoveryAudit(fixture, {
      recoveredBy: ORIGINAL_AUDIT_ACTOR,
      priorErrorCode: 'NOT_LOGGED_IN',
      priorErrorMessage:
        'RedNote creator login is required in the persistent browser profile',
    });

    const repaired = await recoverStoredApprovedPublishJob(
      fixture.input,
      REPAIR_OPERATOR,
    );
    expect(repaired).toMatchObject({
      jobId: fixture.jobId,
      priorClaimAttempts: 1,
      alreadyRecovered: true,
    });

    const claimToken = crypto.randomUUID();
    const claimed = await claimNextStoredLocalPublishJob(
      300,
      'dispatch',
      undefined,
      fixture.workspaceId,
      claimToken,
    );
    expect(claimed).toMatchObject({
      id: fixture.jobId,
      status: 'claimed',
      claimToken,
    });
    await bindLinkedAttemptClaim(
      fixture.workspaceId,
      fixture.jobId,
      claimToken,
      claimed!.claimExpiresAt!,
    );

    await expect(submitLocalPublishJobResult(
      fixture.jobId,
      claimToken,
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: 'rejected',
        occurredAt: new Date().toISOString(),
        code: 'NOT_LOGGED_IN',
        message:
          'RedNote creator login is required in the persistent browser profile',
      },
      fixture.workspaceId,
    )).resolves.toMatchObject({
      id: fixture.jobId,
      status: 'failed',
      errorCode: 'NOT_LOGGED_IN',
    });

    const failedJob = await database.query<{
      claim_attempts: number;
      claimed_at: string;
      completed_at: string;
      receipt_contract_version: string;
      receipt_outcome: string;
      receipt_acknowledged_at: string;
      verification_attempts: number;
    }>(
      `SELECT
         claim_attempts,
         claimed_at,
         completed_at,
         receipt_contract_version,
         receipt_outcome,
         receipt_acknowledged_at,
         verification_attempts
       FROM local_publish_jobs
       WHERE id = $1`,
      [fixture.jobId],
    );
    expect(failedJob.rows[0]).toMatchObject({
      claim_attempts: 2,
      receipt_contract_version: 'rednote-worker-result/v2',
      receipt_outcome: 'rejected',
      verification_attempts: 0,
    });
    expect(new Date(failedJob.rows[0]!.completed_at).getTime())
      .toBeGreaterThan(new Date(failedJob.rows[0]!.claimed_at).getTime());
    expect(failedJob.rows[0]!.receipt_acknowledged_at).toBeTruthy();

    const attempts = await database.query<{
      id: string;
      active: boolean;
      terminal_outcome: string;
      terminal_at: string;
      receipt_lookup_state: string;
      dispatch_authorized_at: string | null;
      supersedes_attempt_id: string | null;
      superseded_by_attempt_id: string | null;
      claim_token: string | null;
    }>(
      `SELECT
         id,
         active,
         terminal_outcome,
         terminal_at,
         receipt_lookup_state,
         dispatch_authorized_at,
         supersedes_attempt_id,
         superseded_by_attempt_id,
         claim_token
       FROM rednote_publish_attempts
       WHERE source_local_publish_job_id = $1
       ORDER BY created_at, id`,
      [fixture.jobId],
    );
    expect(attempts.rows).toHaveLength(2);
    const source = attempts.rows.find(({ id }) => id === fixture.sourceAttemptId);
    const replacement = attempts.rows.find(({ id }) => id !== fixture.sourceAttemptId);
    if (!replacement) throw new Error('Expected a repaired replacement attempt');
    expect(source).toMatchObject({
      active: false,
      terminal_outcome: 'known_failed',
      receipt_lookup_state: 'not_required',
      superseded_by_attempt_id: replacement.id,
    });
    expect(replacement).toMatchObject({
      active: false,
      terminal_outcome: 'known_failed',
      receipt_lookup_state: 'not_required',
      dispatch_authorized_at: null,
      supersedes_attempt_id: fixture.sourceAttemptId,
      superseded_by_attempt_id: null,
      claim_token: claimToken,
    });

    const genericBlockers = await database.query<{ lifecycle_state: string }>(
      `SELECT lifecycle_state
       FROM rednote_publish_revision_blockers($1, $2, $3, $4, $5, $6)`,
      [
        fixture.workspaceId,
        notionPageId,
        EXACT_REVISION,
        fixture.batchItemId,
        fixture.jobId,
        replacement.id,
      ],
    );
    expect(genericBlockers.rows.map(({ lifecycle_state }) => lifecycle_state))
      .toContain('excluded_local_job:evidence');
    const recoveryBlockers = await database.query<{ lifecycle_state: string }>(
      `SELECT lifecycle_state
       FROM rednote_publish_recovery_revision_blockers(
         $1, $2, $3, $4, $5, $6
       )`,
      [
        fixture.workspaceId,
        notionPageId,
        EXACT_REVISION,
        fixture.batchItemId,
        fixture.jobId,
        replacement.id,
      ],
    );
    expect(recoveryBlockers.rows).toEqual([]);

    const batches = await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    );
    expect(batches[0].items[0].recoveryEvidence).toEqual({
      ...fixture.input,
      priorErrorCode: 'NOT_LOGGED_IN',
      claimAttempts: 2,
      latestAuditedClaimAttempts: 1,
    });
    expect(batches[0].items[0].recoveryEvidence)
      .not.toHaveProperty('recoveredBy');

    const immutableState = await readRecoveryMutationState(fixture.jobId);
    await expect(requeueReadyX3NotLoggedInFailure({
      workspaceId: fixture.workspaceId,
      jobId: fixture.jobId,
      attemptId: replacement.id,
      sourceNotionPageId: notionPageId,
      revision: EXACT_REVISION,
    })).rejects.toMatchObject({
      code: 'PUBLISH_LIFECYCLE_RECOVERY_CONFLICT',
      status: 409,
    });
    expect(await readRecoveryMutationState(fixture.jobId)).toEqual(immutableState);

    const blockingReceiptShapes = [
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: 'rejected',
        acknowledgedAt: null,
      },
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: 'acknowledged',
        acknowledgedAt: '2026-09-09T23:13:54.148Z',
      },
      {
        contractVersion: 'rednote-worker-result/v1',
        outcome: 'rejected',
        acknowledgedAt: '2026-09-09T23:13:54.148Z',
      },
      {
        contractVersion: null,
        outcome: 'rejected',
        acknowledgedAt: '2026-09-09T23:13:54.148Z',
      },
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: null,
        acknowledgedAt: '2026-09-09T23:13:54.148Z',
      },
    ] as const;
    for (const receipt of blockingReceiptShapes) {
      await database.query(
        `UPDATE local_publish_jobs
         SET receipt_contract_version = $2,
             receipt_outcome = $3,
             receipt_acknowledged_at = $4
         WHERE id = $1`,
        [
          fixture.jobId,
          receipt.contractVersion,
          receipt.outcome,
          receipt.acknowledgedAt,
        ],
      );
      expect((await listStoredPublishBatches(
        fixture.workspaceId,
        fixture.batchId,
      ))[0].items[0].recoveryEvidence).toBeUndefined();
    }
    await database.query(
      `UPDATE local_publish_jobs
       SET receipt_contract_version = 'rednote-worker-result/v2',
           receipt_outcome = 'rejected',
           receipt_acknowledged_at = $2
       WHERE id = $1`,
      [fixture.jobId, failedJob.rows[0]!.receipt_acknowledged_at],
    );

    const evidenceCases = [
      {
        set: "authenticated_account_id = 'creator-account'",
        clear: 'authenticated_account_id = NULL',
      },
      {
        set: "authenticated_account_at = '2026-09-09T23:13:54.148Z'",
        clear: 'authenticated_account_at = NULL',
      },
      {
        set: "xsec_accessible_at = '2026-09-09T23:13:54.148Z'",
        clear: 'xsec_accessible_at = NULL',
      },
      {
        set: "public_index_status = 'not_found'",
        clear: 'public_index_status = NULL',
      },
      {
        set: "public_index_checked_at = '2026-09-09T23:13:54.148Z'",
        clear: 'public_index_checked_at = NULL',
      },
      {
        set: "provider_restriction_status = 'restricted'",
        clear: 'provider_restriction_status = NULL',
      },
      {
        set: "provider_restriction_reported_at = '2026-09-09T23:13:54.148Z'",
        clear: 'provider_restriction_reported_at = NULL',
      },
      {
        set: `public_index_status = 'not_found',
              public_index_checked_at = '2026-09-09T23:13:54.148Z'`,
        clear: 'public_index_status = NULL, public_index_checked_at = NULL',
      },
      {
        set: `provider_restriction_status = 'removed',
              provider_restriction_reported_at = '2026-09-09T23:13:54.148Z'`,
        clear: `provider_restriction_status = NULL,
                provider_restriction_reported_at = NULL`,
      },
    ] as const;
    for (const evidence of evidenceCases) {
      await database.query(
        `UPDATE local_publish_jobs SET ${evidence.set} WHERE id = $1`,
        [fixture.jobId],
      );
      expect((await listStoredPublishBatches(
        fixture.workspaceId,
        fixture.batchId,
      ))[0].items[0].recoveryEvidence).toBeUndefined();
      await expect(recoverStoredApprovedPublishJob(
        fixture.input,
        ORIGINAL_AUDIT_ACTOR,
      )).rejects.toMatchObject({
        code: 'RECOVERY_PRECONDITION_FAILED',
        status: 409,
      });
      await database.query(
        `UPDATE local_publish_jobs SET ${evidence.clear} WHERE id = $1`,
        [fixture.jobId],
      );
      expect(await readRecoveryMutationState(fixture.jobId)).toEqual(immutableState);
    }
    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toEqual({
      ...fixture.input,
      priorErrorCode: 'NOT_LOGGED_IN',
      claimAttempts: 2,
      latestAuditedClaimAttempts: 1,
    });

    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      ORIGINAL_AUDIT_ACTOR,
    )).resolves.toMatchObject({
      jobId: fixture.jobId,
      priorClaimAttempts: 2,
      alreadyRecovered: false,
    });
    expect(await countRows(
      'rednote_publish_recovery_attempt_generations',
      `WHERE recovery_id IN (
         SELECT id
         FROM rednote_publish_job_recoveries
         WHERE local_publish_job_id = $1
       )`,
      [fixture.jobId],
    )).toBe(2);
    expect(await countRows(
      'rednote_publish_job_recoveries',
      'WHERE local_publish_job_id = $1',
      [fixture.jobId],
    )).toBe(2);

    const requeuedJob = await database.query<{
      status: string;
      claim_attempts: number;
      claimed_at: string | null;
      completed_at: string | null;
      receipt_contract_version: string | null;
      receipt_outcome: string | null;
      receipt_acknowledged_at: string | null;
    }>(
      `SELECT
         status,
         claim_attempts,
         claimed_at,
         completed_at,
         receipt_contract_version,
         receipt_outcome,
         receipt_acknowledged_at
       FROM local_publish_jobs
       WHERE id = $1`,
      [fixture.jobId],
    );
    expect(requeuedJob.rows[0]).toEqual({
      status: 'queued',
      claim_attempts: 2,
      claimed_at: null,
      completed_at: null,
      receipt_contract_version: null,
      receipt_outcome: null,
      receipt_acknowledged_at: null,
    });

    const lateClaimToken = crypto.randomUUID();
    const lateClaim = await claimNextStoredLocalPublishJob(
      0,
      'dispatch',
      undefined,
      fixture.workspaceId,
      lateClaimToken,
    );
    expect(lateClaim).toMatchObject({
      id: fixture.jobId,
      status: 'claimed',
      claimToken: lateClaimToken,
    });
    await bindLinkedAttemptClaim(
      fixture.workspaceId,
      fixture.jobId,
      lateClaimToken,
      lateClaim!.claimExpiresAt!,
    );
    await expect(submitLocalPublishJobResult(
      fixture.jobId,
      lateClaimToken,
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: 'rejected',
        occurredAt: new Date().toISOString(),
        code: 'NOT_LOGGED_IN',
        message:
          'RedNote creator login is required in the persistent browser profile',
      },
      fixture.workspaceId,
    )).resolves.toMatchObject({
      id: fixture.jobId,
      status: 'failed',
      receiptOutcome: 'rejected',
      errorCode: 'NOT_LOGGED_IN',
    });
    expect((await database.query<{ claim_attempts: number }>(
      'SELECT claim_attempts FROM local_publish_jobs WHERE id = $1',
      [fixture.jobId],
    )).rows[0]?.claim_attempts).toBe(3);
    expect(await countRows(
      'rednote_publish_attempts',
      'WHERE source_local_publish_job_id = $1',
      [fixture.jobId],
    )).toBe(3);
    expect(await countRows(
      'rednote_publish_attempt_events',
      `WHERE attempt_id IN (
         SELECT id
         FROM rednote_publish_attempts
         WHERE source_local_publish_job_id = $1
       )
       AND event_type = 'execution_evidence'
       AND diagnostics->>'kind' = 'late_terminal_result_accepted'`,
      [fixture.jobId],
    )).toBe(1);
    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();
  }, 30_000);

  it('hides and rejects a spoofed NOT_LOGGED_IN message', async () => {
    const fixture = await insertRecoverableFixture({
      errorCode: 'NOT_LOGGED_IN',
      errorMessage: 'Login required',
    });

    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();
    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      RECOVERED_BY,
    )).rejects.toMatchObject({
      code: 'RECOVERY_PRECONDITION_FAILED',
      status: 409,
    } satisfies Partial<PublishJobRecoveryError>);
    expect(await countRows(
      'rednote_publish_job_recoveries',
      'WHERE local_publish_job_id = $1',
      [fixture.jobId],
    )).toBe(0);
    expect(await database.query<{ status: string; claim_attempts: number }>(
      `SELECT status, claim_attempts FROM local_publish_jobs WHERE id = $1`,
      [fixture.jobId],
    )).toMatchObject({ rows: [{ status: 'failed', claim_attempts: 1 }] });
  });

  it('repairs a pre-031 queue-only recovery audit without creating duplicates', async () => {
    const fixture = await insertRecoverableFixture();
    await insertQueueOnlyRecoveryAudit(fixture, {
      recoveredBy: ORIGINAL_AUDIT_ACTOR,
    });
    const auditBefore = await database.query<{
      id: string;
      recovered_by: string;
    }>(
      `SELECT id, recovered_by
       FROM rednote_publish_job_recoveries
       WHERE local_publish_job_id = $1`,
      [fixture.input.jobId],
    );

    const before = await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    );
    expect(before).toHaveLength(1);
    expect(before[0].items).toHaveLength(1);
    expect(before[0].items[0].recoveryEvidence).toEqual({
      ...fixture.input,
      priorErrorCode: 'BOUNDED_BATCH_BYPASS_DISABLED',
      claimAttempts: 1,
      latestAuditedClaimAttempts: 1,
    });
    expect(before.flatMap(({ items }) => items)
      .filter(({ recoveryEvidence }) => recoveryEvidence)).toHaveLength(1);
    await expect(listStoredPublishBatches(
      'wrong-workspace',
      fixture.batchId,
    )).resolves.toEqual([]);

    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      REPAIR_OPERATOR,
    )).resolves.toMatchObject({
      jobId: fixture.jobId,
      priorClaimAttempts: 1,
      recoveredBy: ORIGINAL_AUDIT_ACTOR,
      alreadyRecovered: true,
    });
    expect(await countRows(
      'rednote_publish_attempts',
      'WHERE source_local_publish_job_id = $1',
      [fixture.jobId],
    )).toBe(2);
    expect(await countRows(
      'rednote_publish_job_recoveries',
      'WHERE local_publish_job_id = $1',
      [fixture.jobId],
    )).toBe(1);
    expect(await countRows(
      'rednote_publish_recovery_attempt_generations',
      'WHERE source_attempt_id = $1',
      [fixture.sourceAttemptId],
    )).toBe(1);
    const lineage = await database.query<{
      recovery_attempt_id: string;
    }>(
      `SELECT recovery_attempt_id
       FROM rednote_publish_recovery_attempt_generations
       WHERE source_attempt_id = $1`,
      [fixture.sourceAttemptId],
    );
    const recoveryEvent = await database.query<{
      actor_type: string;
      actor_id: string;
      diagnostics: Record<string, unknown>;
    }>(
      `SELECT actor_type, actor_id, diagnostics
       FROM rednote_publish_attempt_events
       WHERE attempt_id = $1
         AND event_type = 'administrative_recovery'`,
      [lineage.rows[0].recovery_attempt_id],
    );
    expect(recoveryEvent.rows).toEqual([{
      actor_type: 'admin',
      actor_id: REPAIR_OPERATOR,
      diagnostics: expect.objectContaining({
        operation: 'repair_missing_attempt_lineage',
        recoveryId: auditBefore.rows[0].id,
        sourceAttemptId: fixture.sourceAttemptId,
        priorClaimAttempts: 1,
        auditRecoveredBy: ORIGINAL_AUDIT_ACTOR,
      }),
    }]);
    const auditAfter = await database.query<{
      id: string;
      recovered_by: string;
    }>(
      `SELECT id, recovered_by
       FROM rednote_publish_job_recoveries
       WHERE local_publish_job_id = $1`,
      [fixture.input.jobId],
    );
    expect(auditAfter.rows).toEqual(auditBefore.rows);
    await expect(database.query(
      `UPDATE rednote_publish_job_recoveries
       SET recovered_by = $2
       WHERE id = $1`,
      [auditBefore.rows[0].id, REPAIR_OPERATOR],
    )).rejects.toThrow(/append-only/i);
    const after = await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    );
    expect(after[0].items[0].recoveryEvidence).toBeUndefined();
    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      'third.admin@example.com',
    )).resolves.toMatchObject({
      recoveredBy: ORIGINAL_AUDIT_ACTOR,
      alreadyRecovered: true,
    });
    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();
    const claimToken = crypto.randomUUID();
    await expect(claimNextStoredLocalPublishJob(
      300,
      'dispatch',
      undefined,
      fixture.workspaceId,
      claimToken,
    )).resolves.toMatchObject({
      id: fixture.jobId,
      status: 'claimed',
      claimToken,
    });
    await expect(claimNextStoredLocalPublishJob(
      300,
      'dispatch',
      undefined,
      fixture.workspaceId,
      crypto.randomUUID(),
    )).resolves.toBeNull();
  });

  it('repairs queued lineage after an audit actor case change', async () => {
    const fixture = await insertRecoverableFixture({
      jobId: crypto.randomUUID(),
      batchItemId: crypto.randomUUID(),
      notionPageId: `page-actor-case-${crypto.randomUUID()}`,
      workspaceId: `workspace-${crypto.randomUUID()}`,
    });
    await insertQueueOnlyRecoveryAudit(fixture, {
      recoveredBy: 'Operator@Example.com',
    });

    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      'operator@example.com',
    )).resolves.toMatchObject({
      recoveredBy: 'Operator@Example.com',
      alreadyRecovered: true,
    });
    const attributed = await database.query<{
      actor_id: string;
      operation: string;
    }>(
      `SELECT event.actor_id,
              event.diagnostics ->> 'operation' AS operation
       FROM rednote_publish_attempt_events event
       JOIN rednote_publish_recovery_attempt_generations generation
         ON generation.recovery_attempt_id = event.attempt_id
       JOIN rednote_publish_job_recoveries recovery
         ON recovery.id = generation.recovery_id
       WHERE recovery.local_publish_job_id = $1
         AND event.event_type = 'administrative_recovery'`,
      [fixture.input.jobId],
    );
    expect(attributed.rows).toEqual([{
      actor_id: 'operator@example.com',
      operation: 'repair_missing_attempt_lineage',
    }]);
  });

  it('rejects recovery audits without an available immutable actor', async () => {
    const fixture = await insertRecoverableFixture({
      jobId: crypto.randomUUID(),
      batchItemId: crypto.randomUUID(),
      notionPageId: `page-missing-actor-${crypto.randomUUID()}`,
      workspaceId: `workspace-${crypto.randomUUID()}`,
    });

    await insertQueueOnlyRecoveryAudit(fixture, { recoveredBy: ' ' });
    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();
    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      REPAIR_OPERATOR,
    )).rejects.toMatchObject({
      code: 'RECOVERY_PRECONDITION_FAILED',
    });
    expect(await countRows(
      'rednote_publish_job_recoveries',
      'WHERE local_publish_job_id = $1',
      [fixture.input.jobId],
    )).toBe(1);
    expect(await countRows(
      'rednote_publish_recovery_attempt_generations',
      `WHERE recovery_id IN (
         SELECT id FROM rednote_publish_job_recoveries
         WHERE local_publish_job_id = $1
       )`,
      [fixture.input.jobId],
    )).toBe(0);
    expect(await countRows(
       'rednote_publish_attempts',
       'WHERE source_local_publish_job_id = $1',
       [fixture.input.jobId],
    )).toBe(1);
  });

  it('hides queued repair actions for mismatched or ambiguous source lineage', async () => {
    const mismatchedAudit = await insertRecoverableFixture();
    await insertQueueOnlyRecoveryAudit(mismatchedAudit, {
      manifestHash: 'd'.repeat(64),
    });
    expect((await listStoredPublishBatches(
      mismatchedAudit.workspaceId,
      mismatchedAudit.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();

    const zero = await insertRecoverableFixture({
      approvedSource: false,
      errorCode: 'NOT_LOGGED_IN',
      errorMessage: 'RedNote creator login is required in the persistent browser profile',
    });
    await insertQueueOnlyRecoveryAudit(zero, {
      priorErrorCode: 'NOT_LOGGED_IN',
      priorErrorMessage:
        'RedNote creator login is required in the persistent browser profile',
    });
    expect((await listStoredPublishBatches(
      zero.workspaceId,
      zero.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();

    const multiple = await insertRecoverableFixture({
      errorCode: 'NOT_LOGGED_IN',
      errorMessage: 'RedNote creator login is required in the persistent browser profile',
    });
    await database.query(
      `INSERT INTO rednote_publish_attempts (
        id, workspace_id, idempotency_key, contract_revision,
        source_notion_page_id, source_local_publish_job_id,
        frozen_payload, payload_digest, payload_revision,
        executor_type, executor_kind, executor_id, target_publish_at,
        requested_at, terminal_outcome, terminal_at, receipt_lookup_state,
        receipt_lookup_updated_at, active, diagnostics, approved_at,
        authorization_kind, late_fallback_policy, claim_token
      )
      SELECT
        $1, workspace_id, gen_random_uuid(), contract_revision,
        source_notion_page_id, source_local_publish_job_id,
        frozen_payload, payload_digest, payload_revision,
        executor_type, executor_kind, executor_id, target_publish_at,
        requested_at, terminal_outcome, terminal_at, receipt_lookup_state,
        receipt_lookup_updated_at, active, '{"second":true}'::jsonb, approved_at,
        authorization_kind, late_fallback_policy, claim_token
      FROM rednote_publish_attempts WHERE id = $2`,
      [crypto.randomUUID(), multiple.sourceAttemptId],
    );
    await insertQueueOnlyRecoveryAudit(multiple, {
      priorErrorCode: 'NOT_LOGGED_IN',
      priorErrorMessage:
        'RedNote creator login is required in the persistent browser profile',
    });
    const projected = await listStoredPublishBatches(
      multiple.workspaceId,
      multiple.batchId,
    );
    expect(projected).toHaveLength(1);
    expect(projected[0].items).toHaveLength(1);
    expect(projected[0].items[0].recoveryEvidence).toBeUndefined();
  });

  it('keeps the queued repair action visible when lineage creation rolls back', async () => {
    const fixture = await insertRecoverableFixture({
      errorCode: 'NOT_LOGGED_IN',
      errorMessage: 'RedNote creator login is required in the persistent browser profile',
    });
    await insertQueueOnlyRecoveryAudit(fixture, {
      priorErrorCode: 'NOT_LOGGED_IN',
      priorErrorMessage:
        'RedNote creator login is required in the persistent browser profile',
    });
    failQueryContaining = 'INSERT INTO rednote_publish_attempt_events';

    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      RECOVERED_BY,
    )).rejects.toThrow('forced recovery transaction failure');
    failQueryContaining = null;

    expect(await countRows(
      'rednote_publish_attempts',
      'WHERE source_local_publish_job_id = $1',
      [fixture.jobId],
    )).toBe(1);
    expect(await countRows(
      'rednote_publish_recovery_attempt_generations',
      'WHERE source_attempt_id = $1',
      [fixture.sourceAttemptId],
    )).toBe(0);
    const source = await database.query<{
      superseded_by_attempt_id: string | null;
    }>(
      `SELECT superseded_by_attempt_id
       FROM rednote_publish_attempts WHERE id = $1`,
      [fixture.sourceAttemptId],
    );
    expect(source.rows).toEqual([{ superseded_by_attempt_id: null }]);
    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toEqual({
      ...fixture.input,
      priorErrorCode: 'NOT_LOGGED_IN',
      claimAttempts: 1,
      latestAuditedClaimAttempts: 1,
    });
  });

  it('fails closed for zero and multiple lifecycle sources without cardinality errors', async () => {
    const zero = await insertRecoverableFixture({ approvedSource: false });
    await expect(recoverStoredApprovedPublishJob(
      zero.input,
      RECOVERED_BY,
    )).rejects.toMatchObject({
      code: 'RECOVERY_PRECONDITION_FAILED',
      status: 409,
    } satisfies Partial<PublishJobRecoveryError>);

    const multiple = await insertRecoverableFixture();
    const secondAttemptId = crypto.randomUUID();
    await database.query(
      `INSERT INTO rednote_publish_attempts (
        id, workspace_id, idempotency_key, contract_revision,
        source_notion_page_id, source_local_publish_job_id,
        frozen_payload, payload_digest, payload_revision,
        executor_type, executor_kind, executor_id, target_publish_at,
        requested_at, terminal_outcome, terminal_at, receipt_lookup_state,
        receipt_lookup_updated_at, active, diagnostics, approved_at,
        authorization_kind, late_fallback_policy, claim_token
      )
      SELECT
        $1, workspace_id, gen_random_uuid(), contract_revision,
        source_notion_page_id, source_local_publish_job_id,
        frozen_payload, payload_digest, payload_revision,
        executor_type, executor_kind, executor_id, target_publish_at,
        requested_at, terminal_outcome, terminal_at, receipt_lookup_state,
        receipt_lookup_updated_at, active, '{"second":true}'::jsonb, approved_at,
        authorization_kind, late_fallback_policy, claim_token
      FROM rednote_publish_attempts WHERE id = $2`,
      [secondAttemptId, multiple.sourceAttemptId],
    );
    await expect(recoverStoredApprovedPublishJob(
      multiple.input,
      RECOVERED_BY,
    )).rejects.toMatchObject({
      code: 'RECOVERY_PRECONDITION_FAILED',
      status: 409,
    } satisfies Partial<PublishJobRecoveryError>);

    for (const fixture of [zero, multiple]) {
      expect(await countRows(
        'rednote_publish_job_recoveries',
        'WHERE local_publish_job_id = $1',
        [fixture.jobId],
      )).toBe(0);
      const job = await database.query<{ status: string; claim_attempts: number }>(
        `SELECT status, claim_attempts FROM local_publish_jobs WHERE id = $1`,
        [fixture.jobId],
      );
      expect(job.rows).toEqual([{ status: 'failed', claim_attempts: 1 }]);
    }
  });

  it('rolls back the audit, generation, supersession, events, and requeue together', async () => {
    const fixture = await insertRecoverableFixture({
      errorCode: 'NOT_LOGGED_IN',
      errorMessage: 'RedNote creator login is required in the persistent browser profile',
    });
    failQueryContaining = 'INSERT INTO rednote_publish_attempt_events';

    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      RECOVERED_BY,
    )).rejects.toThrow('forced recovery transaction failure');
    failQueryContaining = null;

    expect(await countRows(
      'rednote_publish_job_recoveries',
      'WHERE local_publish_job_id = $1',
      [fixture.jobId],
    )).toBe(0);
    expect(await countRows(
      'rednote_publish_recovery_attempt_generations',
      'WHERE source_attempt_id = $1',
      [fixture.sourceAttemptId],
    )).toBe(0);
    expect(await countRows(
      'rednote_publish_attempts',
      'WHERE source_local_publish_job_id = $1',
      [fixture.jobId],
    )).toBe(1);
    const source = await database.query<{
      superseded_by_attempt_id: string | null;
      terminal_outcome: string;
      active: boolean;
    }>(
      `SELECT superseded_by_attempt_id, terminal_outcome, active
       FROM rednote_publish_attempts WHERE id = $1`,
      [fixture.sourceAttemptId],
    );
    expect(source.rows).toEqual([{
      superseded_by_attempt_id: null,
      terminal_outcome: 'known_failed',
      active: false,
    }]);
    const job = await database.query<{
      status: string;
      error_code: string;
      claim_attempts: number;
    }>(
      `SELECT status, error_code, claim_attempts
       FROM local_publish_jobs WHERE id = $1`,
      [fixture.jobId],
    );
    expect(job.rows).toEqual([{
      status: 'failed',
      error_code: 'NOT_LOGGED_IN',
      claim_attempts: 1,
    }]);
  });

  it('does not claim a recovered job without its sole active lifecycle', async () => {
    const fixture = await insertRecoverableFixture();
    await recoverStoredApprovedPublishJob(fixture.input, RECOVERED_BY);
    await database.query(
      `UPDATE rednote_publish_attempts
       SET active = FALSE, terminal_outcome = 'known_failed',
           terminal_at = CURRENT_TIMESTAMP, receipt_lookup_state = 'not_required',
           receipt_lookup_updated_at = CURRENT_TIMESTAMP
       WHERE source_local_publish_job_id = $1 AND active`,
      [fixture.jobId],
    );

    await expect(claimNextStoredLocalPublishJob(
      300,
      'dispatch',
      undefined,
      fixture.workspaceId,
      crypto.randomUUID(),
    )).resolves.toBeNull();
    await expect(claimNextStoredLocalPublishJob(
      300,
      'dispatch',
      undefined,
      'missing-workspace',
      crypto.randomUUID(),
    )).resolves.toBeNull();
  });
});
