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
  claimNextStoredLocalPublishJob,
} from '@/lib/local-publish-job-store';
import {
  PublishJobRecoveryError,
  recoverStoredApprovedPublishJob,
} from '@/lib/rednote-publish-job-recovery-store';
import { listStoredPublishBatches } from '@/lib/rednote-publish-batch-store';
import { readRednotePublishingOperational } from '@/lib/rednote-publishing-attempt-store';

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
}: {
  jobId?: string;
  batchItemId?: string;
  revision?: string;
  notionPageId?: string;
  workspaceId?: string;
  approvedSource?: boolean;
} = {}): Promise<RecoveryFixture> {
  const batchId = crypto.randomUUID();
  const sourceAttemptId = crypto.randomUUID();
  const sourceClaimToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const terminalBase = new Date(Date.now() - 60_000).toISOString();
  const completedAt = terminalBase.replace('Z', '900Z');
  const terminalAt = terminalBase.replace('Z', '400Z');
  const snapshot = frozenSnapshot(notionPageId, revision);

  await database.query(
    `INSERT INTO local_publish_jobs (
      id, workspace_id, notion_page_id, snapshot, status, claim_token,
      claim_attempts, claimed_at, claim_expires_at, completed_at,
      error_code, error_message, idempotency_key, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4::jsonb, 'failed', NULL,
      1, $5::timestamptz, $6::timestamptz, $6::timestamptz,
      'BOUNDED_BATCH_BYPASS_DISABLED', 'bounded batch enforcement',
      gen_random_uuid(), $5, $6
    )`,
    [
      jobId,
      workspaceId,
      notionPageId,
      JSON.stringify(snapshot),
      now,
      completedAt,
    ],
  );
  await database.query(
    `INSERT INTO rednote_publish_batches (
      id, workspace_id, kind, status, manifest_hash, created_at,
      approved_at, approved_by
    ) VALUES (
      $1, $2, 'bootstrap', 'approved', $3, $4, $4, 'day-16-operator'
    )`,
    [batchId, workspaceId, EXACT_MANIFEST, now],
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
      now,
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
      now,
      terminalAt,
      approvedSource ? now : null,
      approvedSource ? 'ready_x3' : null,
      approvedSource
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
    claimedAt: now,
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
  }: {
    manifestHash?: string;
    itemHash?: string;
    snapshotRevision?: string;
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
      'BOUNDED_BATCH_BYPASS_DISABLED', 'bounded batch enforcement',
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
      RECOVERED_BY,
      recoveredAt,
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
    expect(await countRows(
      'rednote_publish_attempt_events',
      'WHERE attempt_id IN ($1, $2)',
      [fixture.sourceAttemptId, replacement?.id],
    )).toBe(4);

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

  it('repairs a pre-031 queue-only recovery audit without creating duplicates', async () => {
    const fixture = await insertRecoverableFixture();
    await insertQueueOnlyRecoveryAudit(fixture);

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
      RECOVERED_BY,
    )).resolves.toMatchObject({
      jobId: fixture.jobId,
      priorClaimAttempts: 1,
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
    const after = await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    );
    expect(after[0].items[0].recoveryEvidence).toBeUndefined();
    await expect(recoverStoredApprovedPublishJob(
      fixture.input,
      RECOVERED_BY,
    )).resolves.toMatchObject({
      alreadyRecovered: true,
    });
    expect((await listStoredPublishBatches(
      fixture.workspaceId,
      fixture.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();
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

    const zero = await insertRecoverableFixture({ approvedSource: false });
    await insertQueueOnlyRecoveryAudit(zero);
    expect((await listStoredPublishBatches(
      zero.workspaceId,
      zero.batchId,
    ))[0].items[0].recoveryEvidence).toBeUndefined();

    const multiple = await insertRecoverableFixture();
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
    await insertQueueOnlyRecoveryAudit(multiple);
    const projected = await listStoredPublishBatches(
      multiple.workspaceId,
      multiple.batchId,
    );
    expect(projected).toHaveLength(1);
    expect(projected[0].items).toHaveLength(1);
    expect(projected[0].items[0].recoveryEvidence).toBeUndefined();
  });

  it('keeps the queued repair action visible when lineage creation rolls back', async () => {
    const fixture = await insertRecoverableFixture();
    await insertQueueOnlyRecoveryAudit(fixture);
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
      priorErrorCode: 'BOUNDED_BATCH_BYPASS_DISABLED',
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
    const fixture = await insertRecoverableFixture();
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
      error_code: 'BOUNDED_BATCH_BYPASS_DISABLED',
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
