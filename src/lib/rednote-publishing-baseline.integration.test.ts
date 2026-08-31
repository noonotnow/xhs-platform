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
        'local_publish_worker_heartbeats',
      ]],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'local_publish_jobs',
      'local_publish_worker_heartbeats',
      'manual_reconciliation_requests',
      'plan_operator_scheduled_posts',
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
});