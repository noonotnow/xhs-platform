import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationFiles = [
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
] as const;

describe('canonical local publishing migration chain', () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    for (const file of migrationFiles) {
      const sql = await readFile(path.join(process.cwd(), 'migrations', file), 'utf8');
      await database.exec(sql);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  async function insertExpiredClaimWithFallback(
    lateFallbackPolicy: Record<string, unknown>,
  ) {
    const batchId = randomUUID();
    const itemId = randomUUID();
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const claimToken = randomUUID();
    const pageId = `expired-fallback-${attemptId}`;
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, CURRENT_TIMESTAMP)`,
      [batchId, 'a'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES ($1, $2, $3, '{}'::jsonb, $4, 'claimed', 'scheduled')`,
      [itemId, batchId, pageId, 'b'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, claim_token, claimed_at, claim_expires_at
       ) VALUES (
         $1, $2, '{}'::jsonb, 'claimed', $3, 'workspace-1', $4, $5,
         CURRENT_TIMESTAMP - INTERVAL '2 minutes', '2026-01-01T00:00:00Z'
       )`,
      [jobId, pageId, randomUUID(), itemId, claimToken],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, receipt_lookup_state, active, approved_at,
         claim_token, claim_expires_at, authorization_kind,
         late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         $3, $4, '{}'::jsonb, $5, 'batch-revision',
         'worker', 'playwright', 'worker-test', CURRENT_TIMESTAMP + INTERVAL '1 day',
         CURRENT_TIMESTAMP, 'pending', true, CURRENT_TIMESTAMP,
         $6, '2026-01-01T00:00:00Z', 'ready_x3', $7::jsonb
       )`,
      [
        attemptId,
        randomUUID(),
        pageId,
        jobId,
        'c'.repeat(64),
        claimToken,
        JSON.stringify(lateFallbackPolicy),
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id, event_type, occurred_at, actor_type, actor_id
       ) VALUES ($1, 'worker_claimed', CURRENT_TIMESTAMP, 'worker', 'worker-test')`,
      [attemptId],
    );
    return attemptId;
  }

  async function insertTerminalExpiredBatchClaim(options: {
    fallback?: Record<string, unknown>;
    errorMessage?: string;
    addExecutionEvidence?: boolean;
  } = {}) {
    const batchId = randomUUID();
    const itemId = randomUUID();
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const claimToken = randomUUID();
    const pageId = `terminal-expired-${attemptId}`;
    const approval = '2026-09-08T17:08:23.346Z';
    const terminal = '2026-09-08T20:19:53.817Z';
    const fallback = options.fallback ?? {
      action: 'post_now',
      maxLateMinutes: 30,
    };
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, $3)`,
      [batchId, 'a'.repeat(64), approval],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES ($1, $2, $3, '{}'::jsonb, $4, 'queued', 'scheduled')`,
      [itemId, batchId, pageId, 'b'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, claim_attempts, claimed_at, claim_expires_at,
         completed_at, error_code, error_message
       ) VALUES (
         $1, $2, '{}'::jsonb, 'failed', $3, 'workspace-1', $4, 1,
         '2026-09-08T19:15:12.818Z', $5, $5, 'CLAIM_LEASE_EXPIRED', $6
       )`,
      [
        jobId,
        pageId,
        randomUUID(),
        itemId,
        terminal,
        options.errorMessage ??
          'The publish lease expired without a terminal result. Automatic dispatch is permanently closed; review the frozen attempt before operator handling or reconciliation.',
      ],
    );
    await database.query(
      `UPDATE rednote_publish_batch_items
       SET local_publish_job_id=$1,state='queued'
       WHERE id=$2`,
      [jobId, itemId],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, receipt_lookup_state, receipt_lookup_updated_at,
         active, approved_at, terminal_outcome, terminal_at,
         claim_token, claim_expires_at, authorization_kind,
         late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         $3, $4, '{}'::jsonb, $5, 'batch-revision',
         'worker', 'playwright', 'worker-test', '2026-09-08T23:20:00Z',
         $6, 'not_required', $7, false, $6, 'known_failed', $7,
         $8, $7, 'ready_x3', $9::jsonb
       )`,
      [
        attemptId,
        randomUUID(),
        pageId,
        jobId,
        'c'.repeat(64),
        approval,
        terminal,
        claimToken,
        JSON.stringify(fallback),
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id, event_type, occurred_at, actor_type, actor_id
       ) VALUES
         ($1, 'attempt_created', $2, 'admin', 'batch-approval'),
         ($1, 'worker_claimed', '2026-09-08T19:15:12.818Z', 'worker', 'worker-test'),
         ($1, 'terminal_outcome_recorded', $3, 'admin', 'local_publish_lease_recovery')`,
      [attemptId, approval, terminal],
    );
    if (options.addExecutionEvidence) {
      await database.query(
        `INSERT INTO rednote_publish_attempt_events(
           attempt_id, event_type, occurred_at, actor_type, actor_id
         ) VALUES ($1, 'execution_started', $2, 'worker', 'worker-test')`,
        [attemptId, terminal],
      );
    }
    return { attemptId, approvedAt: approval };
  }

  it('installs every baseline and RedNote worker table in order', async () => {
    const result = await database.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [[
        'local_publish_jobs',
        'manual_reconciliation_requests',
        'plan_operator_scheduled_posts',
        'rednote_publish_attempts',
        'rednote_publish_attempt_events',
        'rednote_publish_attempt_receipts',
        'rednote_publication_evidence',
        'local_publish_worker_heartbeats',
      ]],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'local_publish_jobs',
      'local_publish_worker_heartbeats',
      'manual_reconciliation_requests',
      'plan_operator_scheduled_posts',
      'rednote_publication_evidence',
      'rednote_publish_attempt_events',
      'rednote_publish_attempt_receipts',
      'rednote_publish_attempts',
    ]);
  });

  it('replaces the legacy receipt primary key with workspace identity', async () => {
    await database.query(
      `INSERT INTO xhs_publish_receipts (
         notion_page_id, workspace_id, status
       ) VALUES
         ('same-page', 'workspace-a', 'publishing'),
         ('same-page', 'workspace-b', 'publishing')`,
    );
    const result = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM xhs_publish_receipts
       WHERE notion_page_id = 'same-page'`,
    );
    expect(result.rows[0]?.count).toBe('2');
  });

  it('installs stable-link capture and immutable Ready x3 authorization', async () => {
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'plan_operator_scheduled_posts'
             AND column_name = 'stable_link_captured_at')
           OR
           (table_name = 'rednote_publish_attempts'
             AND column_name = 'authorization_kind')
         )
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'authorization_kind',
      'stable_link_captured_at',
    ]);
  });

  it('preserves Ready x3 invalid-claim recovery after migration 025', async () => {
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, idempotency_key, contract_revision, source_notion_page_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at,
         terminal_outcome, terminal_at, receipt_lookup_state,
         active, approved_at, authorization_kind, late_fallback_policy
       ) VALUES (
         '11111111-1111-4111-8111-111111111111',
         '22222222-2222-4222-8222-222222222222',
         'rednote-publishing/v1', 'ready-x3-recovery',
         '{}'::jsonb, $1, 'test-revision',
         'worker', 'playwright', 'worker-test',
         CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP,
         'known_failed', CURRENT_TIMESTAMP, 'not_required',
         false, CURRENT_TIMESTAMP, 'ready_x3',
         '{"action":"post_now","maxLateMinutes":30}'::jsonb
       )`,
      ['a'.repeat(64)],
    );
    await database.exec(`
      BEGIN;
      SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true);
      UPDATE rednote_publish_attempts
      SET active = true,
          terminal_outcome = NULL,
          terminal_at = NULL,
          receipt_lookup_state = 'pending',
          receipt_lookup_updated_at = CURRENT_TIMESTAMP,
          claim_token = NULL,
          claim_expires_at = NULL
      WHERE id = '11111111-1111-4111-8111-111111111111';
      COMMIT;
    `);
    await expect(database.query<{
      active: boolean;
      terminal_outcome: string | null;
      receipt_lookup_state: string;
    }>(
      `SELECT active, terminal_outcome, receipt_lookup_state
       FROM rednote_publish_attempts
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    )).resolves.toMatchObject({
      rows: [{
        active: true,
        terminal_outcome: null,
        receipt_lookup_state: 'pending',
      }],
    });
  });

  it('permits only an approved pre-browser batch failure to shed Ready x3 authorization', async () => {
    const batchId = '55555555-5555-4555-8555-555555555555';
    const itemId = '66666666-6666-4666-8666-666666666666';
    const jobId = '77777777-7777-4777-8777-777777777777';
    const attemptId = '88888888-8888-4888-8888-888888888888';
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, CURRENT_TIMESTAMP)`,
      [batchId, 'b'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES ($1, $2, 'batch-recovery-page', '{}'::jsonb, $3, 'approved', 'scheduled')`,
      [itemId, batchId, 'c'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, error_code, error_message
       ) VALUES (
         $1, 'batch-recovery-page', '{}'::jsonb, 'failed', $2,
         'workspace-1', $3, 'INVALID_CLAIM',
         'readyX3Authorization: must exactly match the frozen packet revision, schedule, and media fields'
       )`,
      [
        jobId,
        '99999999-9999-4999-8999-999999999999',
        itemId,
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, terminal_outcome, terminal_at, receipt_lookup_state,
         active, approved_at, authorization_kind, late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         'batch-recovery-page', $3, '{}'::jsonb, $4, 'batch-revision',
         'worker', 'playwright', 'worker-test', CURRENT_TIMESTAMP + INTERVAL '1 day',
         CURRENT_TIMESTAMP, 'known_failed', CURRENT_TIMESTAMP, 'not_required',
         false, CURRENT_TIMESTAMP, 'ready_x3',
         '{"action":"post_now","maxLateMinutes":30}'::jsonb
       )`,
      [
        attemptId,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        jobId,
        'd'.repeat(64),
      ],
    );

    await database.exec(`
      BEGIN;
      SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true);
      SELECT set_config('app.batch_authorization_reclassification', 'on', true);
      UPDATE rednote_publish_attempts
      SET authorization_kind = NULL,
          late_fallback_policy = NULL,
          active = true,
          terminal_outcome = NULL,
          terminal_at = NULL,
          receipt_lookup_state = 'pending',
          receipt_lookup_updated_at = CURRENT_TIMESTAMP,
          claim_token = NULL,
          claim_expires_at = NULL
      WHERE id = '${attemptId}';
      COMMIT;
    `);

    await expect(database.query<{
      active: boolean;
      authorization_kind: string | null;
      terminal_outcome: string | null;
    }>(
      `SELECT active, authorization_kind, terminal_outcome
       FROM rednote_publish_attempts
       WHERE id = $1`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        active: true,
        authorization_kind: null,
        terminal_outcome: null,
      }],
    });
  });

  it('reclassifies only an expired unexecuted batch claim and preserves its approval', async () => {
    const batchId = '11111111-aaaa-4111-8111-111111111111';
    const itemId = '22222222-aaaa-4222-8222-222222222222';
    const jobId = '33333333-aaaa-4333-8333-333333333333';
    const attemptId = '44444444-aaaa-4444-8444-444444444444';
    const claimToken = '55555555-aaaa-4555-8555-555555555555';
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, CURRENT_TIMESTAMP)`,
      [batchId, 'e'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES (
         $1, $2, 'expired-claim-page',
         '{"notionPageId":"expired-claim-page","notionLastEditedTime":"batch-revision","publishAt":"2026-09-08T23:20:00.000Z"}'::jsonb,
         $3, 'approved', 'scheduled'
       )`,
      [itemId, batchId, 'f'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, claim_token, claimed_at, claim_expires_at
       ) VALUES (
       $1, 'expired-claim-page',
       '{"notionPageId":"expired-claim-page","notionLastEditedTime":"batch-revision","publishAt":"2026-09-08T23:20:00.000Z"}'::jsonb,
       'claimed', $2,
         'workspace-1', $3, $4, CURRENT_TIMESTAMP - INTERVAL '2 minutes',
         '2026-01-01T00:00:00Z'
       )`,
      [
        jobId,
        '66666666-aaaa-4666-8666-666666666666',
        itemId,
        claimToken,
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, receipt_lookup_state, active, approved_at,
         claim_token, claim_expires_at, authorization_kind,
         late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         'expired-claim-page', $3,
         '{"payloadRevision":"batch-revision","browserPayload":{"sourcePostId":"expired-claim-page","timingMode":"scheduled","scheduledDate":"2026-09-08T23:20:00.000Z","targetPublishAt":"2026-09-08T23:20:00.000Z"}}'::jsonb,
         $4, 'batch-revision',
         'worker', 'playwright', 'worker-test', '2026-09-08T23:20:00.000Z',
         CURRENT_TIMESTAMP, 'pending', true, '2026-08-31T14:00:00Z',
         $5, '2026-01-01T00:00:00Z', 'ready_x3',
         '{"action":"post_now","maxLateMinutes":30}'::jsonb
       )`,
      [
        attemptId,
        '77777777-aaaa-4777-8777-777777777777',
        jobId,
        '1'.repeat(64),
        claimToken,
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id, event_type, occurred_at, actor_type, actor_id
       ) VALUES ($1, 'worker_claimed', CURRENT_TIMESTAMP, 'worker', 'worker-test')`,
      [attemptId],
    );

    await expect(database.query(
      `SELECT
         attempt.late_fallback_policy =
           '{"action":"post_now","maxLateMinutes":30}'::jsonb AS fallback_matches,
         item.state AS item_state,
         item.dispatch_mode,
         item.local_publish_job_id = job.id AS item_job_matches,
         job.status AS job_status,
         job.claim_expires_at <= CURRENT_TIMESTAMP AS job_lease_expired,
         attempt.claim_expires_at <= CURRENT_TIMESTAMP AS attempt_lease_expired
       FROM rednote_publish_attempts attempt
       JOIN local_publish_jobs job ON job.id = attempt.source_local_publish_job_id
       JOIN rednote_publish_batch_items item ON item.id = job.batch_item_id
       WHERE attempt.id = $1`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        fallback_matches: true,
        item_state: 'claimed',
        dispatch_mode: 'scheduled',
        item_job_matches: true,
        job_status: 'claimed',
        job_lease_expired: true,
        attempt_lease_expired: true,
      }],
    });

    await database.exec(`
      BEGIN;
      SELECT set_config('app.expired_batch_claim_reclassification', 'on', true);
      UPDATE rednote_publish_attempts
      SET authorization_kind = NULL,
          late_fallback_policy = NULL,
          claim_token = NULL,
          claim_expires_at = NULL
      WHERE id = '${attemptId}';
      UPDATE local_publish_jobs
      SET status = 'queued',
          claim_token = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL
      WHERE id = '${jobId}';
      COMMIT;
    `);

    await expect(database.query<{
      active: boolean;
      approved_at: string;
      authorization_kind: string | null;
      terminal_outcome: string | null;
      claim_token: string | null;
    }>(
      `SELECT active, approved_at::text, authorization_kind,
          terminal_outcome, claim_token
       FROM rednote_publish_attempts
       WHERE id = $1`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        active: true,
        approved_at: '2026-08-31 14:00:00+00',
        authorization_kind: null,
        terminal_outcome: null,
        claim_token: null,
      }],
    });
    await expect(database.query<{ status: string }>(
      'SELECT status FROM local_publish_jobs WHERE id = $1',
      [jobId],
    )).resolves.toMatchObject({ rows: [{ status: 'queued' }] });
  });

  it('rejects expired-claim reclassification with a changed legacy fallback action', async () => {
    const attemptId = await insertExpiredClaimWithFallback({
      action: 'schedule',
      maxLateMinutes: 30,
    });
    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.expired_batch_claim_reclassification', 'on', true)`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET authorization_kind = NULL,
             late_fallback_policy = NULL,
             claim_token = NULL,
             claim_expires_at = NULL
         WHERE id = $1`,
        [attemptId],
      )).rejects.toThrow(/Ready x3 authorization is immutable/);
    } finally {
      await database.exec('ROLLBACK');
    }
  });

  it.each([
    ['changed timeout', { action: 'post_now', maxLateMinutes: 31 }],
    ['extra field', { action: 'post_now', maxLateMinutes: 30, revision: 'unexpected' }],
  ])('rejects inserting a legacy fallback with a %s', async (_, lateFallbackPolicy) => {
    await expect(insertExpiredClaimWithFallback(lateFallbackPolicy))
      .rejects.toThrow(/rednote_publish_attempts_late_fallback_policy_check/);
  });

  it('rejects expired-claim reclassification while the lease is still live', async () => {
    const batchId = '88888888-aaaa-4888-8888-888888888888';
    const itemId = '99999999-aaaa-4999-8999-999999999999';
    const jobId = 'aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa';
    const attemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const claimToken = 'cccccccc-bbbb-4ccc-8ccc-cccccccccccc';
    await database.query(
      `INSERT INTO rednote_publish_batches(
         id, kind, status, manifest_hash, approved_at
       ) VALUES ($1, 'bootstrap', 'approved', $2, CURRENT_TIMESTAMP)`,
      [batchId, '2'.repeat(64)],
    );
    await database.query(
      `INSERT INTO rednote_publish_batch_items(
         id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode
       ) VALUES ($1, $2, 'live-claim-page', '{}'::jsonb, $3, 'approved', 'scheduled')`,
      [itemId, batchId, '3'.repeat(64)],
    );
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id,
         batch_item_id, claim_token, claimed_at, claim_expires_at
       ) VALUES (
         $1, 'live-claim-page', '{}'::jsonb, 'claimed', $2,
         'workspace-1', $3, $4, CURRENT_TIMESTAMP,
         '2099-01-01T00:00:00Z'
       )`,
      [jobId, 'dddddddd-bbbb-4ddd-8ddd-dddddddddddd', itemId, claimToken],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, target_publish_at,
         requested_at, receipt_lookup_state, active, approved_at,
         claim_token, claim_expires_at, authorization_kind,
         late_fallback_policy
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         'live-claim-page', $3, '{}'::jsonb, $4, 'batch-revision',
         'worker', 'playwright', 'worker-test', CURRENT_TIMESTAMP + INTERVAL '1 day',
         CURRENT_TIMESTAMP, 'pending', true, CURRENT_TIMESTAMP,
         $5, '2099-01-01T00:00:00Z', 'ready_x3',
         '{"action":"post_now","maxLateMinutes":30}'::jsonb
       )`,
      [
        attemptId,
        'eeeeeeee-bbbb-4eee-8eee-eeeeeeeeeeee',
        jobId,
        '4'.repeat(64),
        claimToken,
      ],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempt_events(
         attempt_id, event_type, occurred_at, actor_type, actor_id
       ) VALUES ($1, 'worker_claimed', CURRENT_TIMESTAMP, 'worker', 'worker-test')`,
      [attemptId],
    );

    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.expired_batch_claim_reclassification', 'on', true)`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET authorization_kind = NULL,
             late_fallback_policy = NULL,
             claim_token = NULL,
             claim_expires_at = NULL
         WHERE id = $1`,
        [attemptId],
      )).rejects.toThrow(/Ready x3 authorization is immutable/);
    } finally {
      await database.exec('ROLLBACK');
    }
  });

  it('permits only the exact terminal lease-expiry reclassification transition', async () => {
    const { attemptId, approvedAt } = await insertTerminalExpiredBatchClaim();
    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true);
         SELECT set_config(
           'app.terminal_expired_batch_claim_reclassification',
           'on',
           true
         )`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET authorization_kind=NULL,late_fallback_policy=NULL,
             active=true,terminal_outcome=NULL,terminal_at=NULL,
             receipt_lookup_state='pending',
             receipt_lookup_updated_at=CURRENT_TIMESTAMP,
             claim_token=NULL,claim_expires_at=NULL
         WHERE id=$1`,
        [attemptId],
      )).resolves.toBeDefined();
      const result = await database.query<{
        active: boolean;
        approved_at: string;
        authorization_kind: string | null;
        terminal_outcome: string | null;
        claim_token: string | null;
      }>(
        `SELECT active,approved_at::text,authorization_kind,
            terminal_outcome,claim_token
         FROM rednote_publish_attempts
         WHERE id=$1`,
        [attemptId],
      );
      expect(result.rows[0]).toMatchObject({
        active: true,
        approved_at: '2026-09-08 17:08:23.346+00',
        authorization_kind: null,
        terminal_outcome: null,
        claim_token: null,
      });
      expect(new Date(result.rows[0]?.approved_at ?? '').toISOString())
        .toBe(new Date(approvedAt).toISOString());
    } finally {
      await database.exec('ROLLBACK');
    }
  });

  it.each([
    ['altered fallback', { fallback: { action: 'schedule', maxLateMinutes: 30 } }],
    ['altered lease error', { errorMessage: 'Different lease failure' }],
    ['execution evidence', { addExecutionEvidence: true }],
  ])('rejects terminal lease-expiry reclassification with %s', async (_, options) => {
    const { attemptId } = await insertTerminalExpiredBatchClaim(options);
    await database.exec('BEGIN');
    try {
      await database.exec(
        `SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true);
         SELECT set_config(
           'app.terminal_expired_batch_claim_reclassification',
           'on',
           true
         )`,
      );
      await expect(database.query(
        `UPDATE rednote_publish_attempts
         SET authorization_kind=NULL,late_fallback_policy=NULL,
             active=true,terminal_outcome=NULL,terminal_at=NULL,
             receipt_lookup_state='pending',
             receipt_lookup_updated_at=CURRENT_TIMESTAMP,
             claim_token=NULL,claim_expires_at=NULL
         WHERE id=$1`,
        [attemptId],
      )).rejects.toThrow(/Ready x3 authorization is immutable/);
    } finally {
      await database.exec('ROLLBACK');
    }
  });

  it('supports Note ID-only receipts and append-only renewable evidence', async () => {
    const columns = await database.query<{ is_nullable: string }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'rednote_publish_attempt_receipts'
         AND column_name = 'rednote_url'`,
    );
    expect(columns.rows[0]?.is_nullable).toBe('YES');

    const jobId = '11111111-1111-4111-8111-111111111111';
    await database.query(
      `INSERT INTO local_publish_jobs(
         id, notion_page_id, snapshot, status, idempotency_key, workspace_id
       ) VALUES ($1, 'notion-page-1', $2::jsonb, 'verified', $3, 'workspace-1')`,
      [
        jobId,
        JSON.stringify({ expectedAccountId: 'creator-account-1' }),
        '22222222-2222-4222-8222-222222222222',
      ],
    );
    const evidence = await database.query<{ id: string }>(
      `INSERT INTO rednote_publication_evidence(
         workspace_id, local_publish_job_id, note_id, evidence_kind,
         captured_at, evidence_status
       ) VALUES (
         'workspace-1', $1, 'note_123', 'xsec_access',
         '2026-08-02T12:00:00Z', 'accessible'
       ) RETURNING id`,
      [jobId],
    );
    await expect(database.query(
      `UPDATE rednote_publication_evidence
       SET captured_at = '2026-08-03T12:00:00Z'
       WHERE id = $1`,
      [evidence.rows[0]?.id],
    )).rejects.toThrow(/append-only/);
    await expect(database.query(
      `INSERT INTO rednote_publication_evidence(
         workspace_id, local_publish_job_id, note_id, evidence_kind,
         captured_at, evidence_status, public_url
       ) VALUES (
         'workspace-1', $1, 'note_123', 'public_index',
         '2026-08-03T12:00:00Z', 'pending',
         'https://www.rednote.com/explore/note_123'
       )`,
      [jobId],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO rednote_publication_evidence(
         workspace_id, local_publish_job_id, note_id, evidence_kind,
         captured_at, account_id, evidence_status
       ) VALUES (
         'workspace-1', $1, NULL, 'authenticated_account',
         '2026-08-02T12:05:00Z', 'creator-account-1', 'owned'
       )`,
      [jobId],
    )).resolves.toMatchObject({ affectedRows: 1 });
    await expect(database.query(
      `INSERT INTO rednote_publication_evidence(
         workspace_id, local_publish_job_id, note_id, evidence_kind,
         captured_at, evidence_status
       ) VALUES (
         'workspace-1', $1, NULL, 'xsec_access',
         '2026-08-02T12:06:00Z', 'accessible'
       )`,
      [jobId],
    )).rejects.toThrow();

    const attemptId = '33333333-3333-4333-8333-333333333333';
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, idempotency_key, contract_revision,
         source_notion_page_id, source_local_publish_job_id,
         frozen_payload, payload_digest, payload_revision,
         executor_type, executor_kind, executor_id, requested_at,
         terminal_outcome, terminal_at, receipt_lookup_state, active
       ) VALUES (
         $1, 'workspace-1', $2, 'rednote-publishing/v1',
         'notion-page-1', $3, '{}'::jsonb, $4, 'revision-1',
         'worker', 'playwright', 'worker-1', '2026-08-02T11:00:00Z',
         'outcome_unknown', '2026-08-02T12:00:00Z', 'found', false
       )`,
      [
        attemptId,
        '44444444-4444-4444-8444-444444444444',
        jobId,
        'a'.repeat(64),
      ],
    );
    await expect(database.query(
      `INSERT INTO rednote_publish_attempt_receipts(
         attempt_id, rednote_note_id, platform_publish_time, provenance
       ) VALUES (
         $1, 'note_ambiguous', '2026-08-02T12:00:00Z',
         '{"kind":"rednote_worker_result_v2"}'::jsonb
       )`,
      [attemptId],
    )).resolves.toBeDefined();
  });
});