import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('manual-first receipt migration', () => {
  it('adds durable pending/reconciled identity and dispatch guards additively', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/016_manual_first_receipt_lane.sql'),
      'utf8',
    );
    expect(migration).toContain("handling_mode IN ('scheduled', 'published')");
    expect(migration).toContain("receipt_status IN ('pending', 'reconciled')");
    expect(migration).toContain('manual_reconciliation_id');
    expect(migration).toContain('manual_handling_id');
    expect(migration).toContain('xhs_publish_receipts');
    expect(migration).toContain('rednote_metric_collection_state');
    expect(migration).toContain("receipt_status = 'pending'");
    expect(migration).not.toContain('CREATE TYPE');
  });

  it('executes after every prior migration and blocks late work for a reconciled marker', async () => {
    const db = new PGlite();
    try {
      for (const filename of readdirSync(join(process.cwd(), 'migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        await db.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
      }

      await db.exec(`
        INSERT INTO local_publish_jobs (
          notion_page_id, snapshot, status, idempotency_key
        ) VALUES (
          'manual-page', '{}'::jsonb, 'failed',
          '11111111-1111-4111-8111-111111111111'
        );
        INSERT INTO manual_reconciliation_requests (
          id, notion_page_id, requested_note_id, requested_share_url,
          expected_snapshot, status, idempotency_key, completed_at
        ) VALUES (
          '22222222-2222-4222-8222-222222222222',
          'manual-page', 'note-1',
          'https://www.rednote.com/explore/note-1',
          '{}'::jsonb, 'reconciled',
          '33333333-3333-4333-8333-333333333333',
          CURRENT_TIMESTAMP
        );
        INSERT INTO plan_operator_scheduled_posts (
          notion_page_id, idempotency_key, notion_last_edited_time,
          recorded_by, reconciled_at, handling_mode, receipt_status,
          manual_reconciliation_id, note_id, share_url, published_at
        ) VALUES (
          'manual-page',
          '44444444-4444-4444-8444-444444444444',
          '2026-08-01T12:00:00.000Z', 'admin',
          CURRENT_TIMESTAMP, 'published', 'reconciled',
          '22222222-2222-4222-8222-222222222222',
          'note-1', 'https://www.rednote.com/explore/note-1',
          CURRENT_TIMESTAMP
        );
      `);

      await expect(db.exec(`
        UPDATE local_publish_jobs
        SET status = 'queued'
        WHERE notion_page_id = 'manual-page';
      `)).rejects.toThrow(/manually handled post manual-page is not dispatchable/);

      await db.exec(`
        INSERT INTO rednote_publish_batches (id, kind, manifest_hash)
        VALUES (
          '55555555-5555-4555-8555-555555555555',
          'bootstrap',
          '${'a'.repeat(64)}'
        );
      `);
      await expect(db.exec(`
        INSERT INTO rednote_publish_batch_items (
          batch_id, notion_page_id, snapshot, item_hash, dispatch_mode
        ) VALUES (
          '55555555-5555-4555-8555-555555555555',
          'manual-page',
          '{}'::jsonb,
          '${'b'.repeat(64)}',
          'post_now'
        );
      `)).rejects.toThrow(/manually handled post manual-page cannot enter a publish batch/);
    } finally {
      await db.close();
    }
  });
});
