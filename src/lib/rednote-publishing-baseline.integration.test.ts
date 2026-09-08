import { readFile } from 'node:fs/promises';
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
         '{"action":"schedule","maxLateMinutes":30}'::jsonb
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