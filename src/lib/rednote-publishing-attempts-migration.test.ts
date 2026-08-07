import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(process.cwd(), 'migrations');

async function migratedDatabase() {
  const db = new PGlite();
  for (const filename of readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await db.exec(readFileSync(join(migrationsDir, filename), 'utf8'));
  }
  return db;
}

const workerAttempt = (id: string, pageId: string, active = true) => `
  INSERT INTO rednote_publish_attempts (
    id, contract_revision, source_notion_page_id, frozen_payload,
    payload_digest, payload_revision, executor_type, executor_id,
    worker_run_id, target_publish_at, requested_at, active
  ) VALUES (
    '${id}', 'rednote-publishing/v1', '${pageId}', '{}'::jsonb,
    '${'a'.repeat(64)}', 'post-snapshot/v1', 'worker', 'worker-1',
    'run-1', '2026-08-08T16:00:00Z', '2026-08-07T16:00:00Z', ${active}
  );
`;

describe('rednote publishing attempt migration', () => {
  it('is additive and declares immutable shadow tables without data backfill', () => {
    const migration = readFileSync(
      join(migrationsDir, '017_rednote_publishing_attempts.sql'),
      'utf8',
    );
    expect(migration).toContain('rednote_publish_attempts');
    expect(migration).toContain('rednote_publish_attempt_events');
    expect(migration).toContain('rednote_publish_attempt_receipts');
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).toContain('rednote_publish_attempt_single_execution_idx');
    expect(migration).not.toMatch(/\bINSERT INTO\b|\bUPDATE\s+local_publish_jobs\b/i);
  });

  it('enforces one active worker attempt, immutable history, and no same-attempt retry', async () => {
    const db = await migratedDatabase();
    try {
      await db.exec(workerAttempt(
        '11111111-1111-4111-8111-111111111111',
        'page-1',
      ));
      await expect(db.exec(workerAttempt(
        '22222222-2222-4222-8222-222222222222',
        'page-1',
      ))).rejects.toThrow();

      await db.exec(`
        INSERT INTO rednote_publish_attempt_events (
          attempt_id, event_type, occurred_at, actor_type, actor_id
        ) VALUES (
          '11111111-1111-4111-8111-111111111111',
          'execution_started', CURRENT_TIMESTAMP, 'worker', 'worker-1'
        );
      `);
      await expect(db.exec(`
        INSERT INTO rednote_publish_attempt_events (
          attempt_id, event_type, occurred_at, actor_type, actor_id
        ) VALUES (
          '11111111-1111-4111-8111-111111111111',
          'execution_started', CURRENT_TIMESTAMP, 'worker', 'worker-1'
        );
      `)).rejects.toThrow();
      await expect(db.exec(`
        UPDATE rednote_publish_attempt_events SET actor_id = 'changed';
      `)).rejects.toThrow(/append-only/);
      await expect(db.exec(`
        UPDATE rednote_publish_attempts
        SET frozen_payload = '{"changed":true}'::jsonb
        WHERE id = '11111111-1111-4111-8111-111111111111';
      `)).rejects.toThrow(/immutable fields/);
      await expect(db.exec(`
        UPDATE rednote_publish_attempts
        SET active = FALSE
        WHERE id = '11111111-1111-4111-8111-111111111111';
        UPDATE rednote_publish_attempts
        SET active = TRUE
        WHERE id = '11111111-1111-4111-8111-111111111111';
      `)).rejects.toThrow(/cannot be reactivated/);
    } finally {
      await db.close();
    }
  });

  it('keeps requested intent separate from immutable receipt reality', async () => {
    const db = await migratedDatabase();
    try {
      await db.exec(workerAttempt(
        '33333333-3333-4333-8333-333333333333',
        'page-2',
      ));
      await db.exec(`
        UPDATE rednote_publish_attempts
        SET terminal_outcome = 'accepted',
            terminal_at = CURRENT_TIMESTAMP,
            receipt_lookup_state = 'found',
            receipt_lookup_updated_at = CURRENT_TIMESTAMP,
            active = FALSE
        WHERE id = '33333333-3333-4333-8333-333333333333';
        INSERT INTO rednote_publish_attempt_receipts (
          attempt_id, rednote_url, rednote_note_id,
          platform_publish_time, provenance
        ) VALUES (
          '33333333-3333-4333-8333-333333333333',
          'https://www.rednote.com/explore/note-2', 'note-2',
          '2026-08-08T16:04:00Z', '{"source":"operator_capture"}'::jsonb
        );
      `);
      const result = await db.query<{
        target_publish_at: string;
        platform_publish_time: string;
      }>(`
        SELECT attempt.target_publish_at, receipt.platform_publish_time
        FROM rednote_publish_attempts attempt
        JOIN rednote_publish_attempt_receipts receipt
          ON receipt.attempt_id = attempt.id
      `);
      expect(result.rows[0].target_publish_at)
        .not.toEqual(result.rows[0].platform_publish_time);
      await expect(db.exec(`
        UPDATE rednote_publish_attempt_receipts
        SET rednote_note_id = 'changed';
      `)).rejects.toThrow(/append-only/);
      await expect(db.exec(`
        DELETE FROM rednote_publish_attempts
        WHERE id = '33333333-3333-4333-8333-333333333333';
      `)).rejects.toThrow(/cannot be deleted/);
    } finally {
      await db.close();
    }
  });

  it('requires receipt URL and Note ID together', async () => {
    const db = await migratedDatabase();
    try {
      await db.exec(workerAttempt(
        '44444444-4444-4444-8444-444444444444',
        'page-3',
        false,
      ));
      await expect(db.exec(`
        INSERT INTO rednote_publish_attempt_receipts (
          attempt_id, rednote_url, platform_publish_time, provenance
        ) VALUES (
          '44444444-4444-4444-8444-444444444444',
          'https://www.rednote.com/explore/note-3',
          CURRENT_TIMESTAMP, '{}'::jsonb
        );
      `)).rejects.toThrow();
      await expect(db.exec(`
        UPDATE rednote_publish_attempts
        SET terminal_outcome = 'known_failed',
            terminal_at = CURRENT_TIMESTAMP,
            active = FALSE
        WHERE id = '44444444-4444-4444-8444-444444444444';
      `)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
