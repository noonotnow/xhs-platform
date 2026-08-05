import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { OPERATOR_SUCCESS_ATTESTATION_OWNERSHIP_SQL } from '@/lib/operator-success-attestation-store';

const targetPageId = '44444444-4444-4444-8444-444444444444';
const unrelatedPageId = '55555555-5555-4555-8555-555555555555';
const jobId = '33333333-3333-4333-8333-333333333333';
const itemId = '22222222-2222-4222-8222-222222222222';

function database() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE local_publish_jobs (
      id uuid PRIMARY KEY,
      notion_page_id text NOT NULL,
      status text NOT NULL,
      dispatch_authorized_at timestamp,
      dispatched_at timestamp,
      note_id text,
      share_url text,
      success_attestation_id uuid
    );
    CREATE TABLE rednote_publish_batch_items (
      id uuid PRIMARY KEY,
      notion_page_id text NOT NULL,
      state text NOT NULL
    );
    CREATE TABLE manual_reconciliation_requests (notion_page_id text NOT NULL);
    CREATE TABLE external_post_reconciliations (
      notion_page_id text,
      status text NOT NULL
    );
    CREATE TABLE xhs_publish_receipts (notion_page_id text NOT NULL);
  `);
  return db;
}

async function hasConflict(db: ReturnType<typeof database>) {
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const result = await pool.query(
    OPERATOR_SUCCESS_ATTESTATION_OWNERSHIP_SQL,
    [targetPageId, jobId, itemId],
  );
  await pool.end();
  return result.rows[0]?.conflict;
}

describe('operator success attestation ownership SQL', () => {
  it('does not treat an unrelated processing reconciliation as target ownership', async () => {
    const db = database();
    db.public.none(
      `INSERT INTO external_post_reconciliations (notion_page_id, status)
       VALUES ('${unrelatedPageId}', 'processing')`,
    );

    await expect(hasConflict(db)).resolves.toBe(false);
  });

  it('detects reconciliation ownership for the exact target page', async () => {
    const db = database();
    db.public.none(
      `INSERT INTO external_post_reconciliations (notion_page_id, status)
       VALUES ('${targetPageId}', 'processing')`,
    );

    await expect(hasConflict(db)).resolves.toBe(true);
  });
});
