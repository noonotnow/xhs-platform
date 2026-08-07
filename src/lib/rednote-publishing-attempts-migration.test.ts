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
    id, contract_revision, source_notion_page_id, source_post_revision, frozen_payload,
    payload_digest, payload_revision, executor_type, executor_kind, executor_id,
    target_publish_at, requested_at, active
  ) VALUES (
    '${id}', 'rednote-publishing/v1', '${pageId}', '2026-08-07T15:00:00.000Z',
    '{}'::jsonb, '${'a'.repeat(64)}', 'rednote-browser-payload/v1',
    'worker', 'playwright', 'worker-1',
    '2026-08-08T16:00:00Z', '2026-08-07T16:00:00Z', ${active}
  );
`;

const operatorAttempt = (
  id: string,
  pageId: string,
  supersedesAttemptId: string,
) => `
  INSERT INTO rednote_publish_attempts (
    id, contract_revision, source_notion_page_id, source_post_revision, frozen_payload,
    payload_digest, payload_revision, executor_type, executor_kind, executor_id,
    target_publish_at, requested_at, active, supersedes_attempt_id,
    receipt_lookup_state
  ) VALUES (
    '${id}', 'rednote-publishing/v1', '${pageId}', '2026-08-08T15:00:00.000Z',
    '{}'::jsonb, '${'b'.repeat(64)}', 'rednote-browser-payload/v1',
    'operator', 'operator', 'operator-1',
    '2026-08-09T16:00:00Z', '2026-08-08T16:00:00Z', FALSE,
    '${supersedesAttemptId}', 'not_required'
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
      await db.exec(`
        UPDATE rednote_publish_attempts
        SET worker_run_id = 'worker-run-1',
            playwright_run_id = 'playwright-run-1'
        WHERE id = '11111111-1111-4111-8111-111111111111';
      `);
      const boundIdentity = await db.query<{
        executor_kind: string;
        worker_run_id: string;
        playwright_run_id: string;
      }>(`
        SELECT executor_kind, worker_run_id, playwright_run_id
        FROM rednote_publish_attempts
        WHERE id = '11111111-1111-4111-8111-111111111111'
      `);
      expect(boundIdentity.rows[0]).toEqual({
        executor_kind: 'playwright',
        worker_run_id: 'worker-run-1',
        playwright_run_id: 'playwright-run-1',
      });
      await expect(db.exec(`
        UPDATE rednote_publish_attempts
        SET worker_run_id = 'worker-run-2'
        WHERE id = '11111111-1111-4111-8111-111111111111';
      `)).rejects.toThrow(/run identities are immutable once bound/);
      await expect(db.exec(`
        UPDATE rednote_publish_attempts
        SET playwright_run_id = 'playwright-run-2'
        WHERE id = '11111111-1111-4111-8111-111111111111';
      `)).rejects.toThrow(/run identities are immutable once bound/);
      await expect(db.exec(`
        INSERT INTO rednote_publish_attempts (
          contract_revision, source_notion_page_id, source_post_revision,
          frozen_payload,
          payload_digest, payload_revision, executor_type, executor_kind,
          executor_id, playwright_run_id, requested_at
        ) VALUES (
          'rednote-publishing/v1', 'invalid-executor', 'source-revision',
          '{}'::jsonb, '${'c'.repeat(64)}', 'rednote-browser-payload/v1',
          'worker-2', 'not-a-microservice-identity', CURRENT_TIMESTAMP
        );
      `)).rejects.toThrow();
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

  it('captures an accepted receipt while keeping requested intent separate from platform reality', async () => {
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

  it('records known_failed only with a cleared active pointer and no receipt work', async () => {
    const db = await migratedDatabase();
    try {
      await db.exec(workerAttempt(
        '44444444-4444-4444-8444-444444444444',
        'page-3',
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
      await db.exec(`
        UPDATE rednote_publish_attempts
        SET terminal_outcome = 'known_failed',
            terminal_at = CURRENT_TIMESTAMP,
            receipt_lookup_state = 'not_required',
            receipt_lookup_updated_at = CURRENT_TIMESTAMP,
            active = FALSE
        WHERE id = '44444444-4444-4444-8444-444444444444';
      `);
      const result = await db.query<{
        terminal_outcome: string;
        receipt_lookup_state: string;
        active: boolean;
      }>(`
        SELECT terminal_outcome, receipt_lookup_state, active
        FROM rednote_publish_attempts
        WHERE id = '44444444-4444-4444-8444-444444444444'
      `);
      expect(result.rows[0]).toMatchObject({
        terminal_outcome: 'known_failed',
        receipt_lookup_state: 'not_required',
        active: false,
      });
    } finally {
      await db.close();
    }
  });

  it('preserves outcome_unknown evidence through operator supersession and rejects stale results', async () => {
    const db = await migratedDatabase();
    const workerId = '55555555-5555-4555-8555-555555555555';
    const operatorId = '66666666-6666-4666-8666-666666666666';
    try {
      await db.exec(workerAttempt(workerId, 'page-4'));
      await db.exec(operatorAttempt(operatorId, 'page-4', workerId));
      await db.exec(`
        UPDATE rednote_publish_attempts
        SET terminal_outcome = 'outcome_unknown',
            terminal_at = CURRENT_TIMESTAMP,
            receipt_lookup_state = 'not_required',
            receipt_lookup_updated_at = CURRENT_TIMESTAMP,
            active = FALSE,
            superseded_by_attempt_id = '${operatorId}'
        WHERE id = '${workerId}';
        INSERT INTO rednote_publish_attempt_events (
          attempt_id, event_type, occurred_at, actor_type, actor_id, evidence
        ) VALUES (
          '${workerId}', 'superseded', CURRENT_TIMESTAMP, 'operator', 'operator-1',
          '[{"kind":"operator_supersession","reference":"${operatorId}"}]'::jsonb
        );
      `);
      const attempts = await db.query<{
        id: string;
        terminal_outcome: string | null;
        active: boolean;
      }>(`
        SELECT id, terminal_outcome, active
        FROM rednote_publish_attempts
        WHERE source_notion_page_id = 'page-4'
        ORDER BY requested_at
      `);
      expect(attempts.rows).toEqual([
        { id: workerId, terminal_outcome: 'outcome_unknown', active: false },
        { id: operatorId, terminal_outcome: null, active: false },
      ]);
      await expect(db.exec(`
        UPDATE rednote_publish_attempts
        SET terminal_outcome = 'accepted'
        WHERE id = '${workerId}';
      `)).rejects.toThrow(/terminal outcome is immutable/);
      const events = await db.query<{ event_type: string }>(`
        SELECT event_type
        FROM rednote_publish_attempt_events
        WHERE attempt_id = '${workerId}'
      `);
      expect(events.rows).toEqual([{ event_type: 'superseded' }]);
    } finally {
      await db.close();
    }
  });

  it('requires receipt URL and Note ID together', async () => {
    const db = await migratedDatabase();
    try {
      await db.exec(workerAttempt(
        '77777777-7777-4777-8777-777777777777',
        'page-5',
        false,
      ));
      await expect(db.exec(`
        INSERT INTO rednote_publish_attempt_receipts (
          attempt_id, rednote_url, platform_publish_time, provenance
        ) VALUES (
          '77777777-7777-4777-8777-777777777777',
          'https://www.rednote.com/explore/note-5',
          CURRENT_TIMESTAMP, '{}'::jsonb
        );
      `)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('activates a worker once and keeps operator ownership through receipt insertion', async () => {
    const db = await migratedDatabase();
    const workerId = '88888888-8888-4888-8888-888888888888';
    const operatorId = '99999999-9999-4999-8999-999999999999';
    try {
      await db.exec(workerAttempt(workerId, 'page-6', false));
      await db.exec(`
        UPDATE rednote_publish_attempts
        SET active = TRUE, activated_at = CURRENT_TIMESTAMP
        WHERE id = '${workerId}';
        INSERT INTO rednote_publish_attempts (
          id, contract_revision, source_notion_page_id, source_post_revision,
          frozen_payload, payload_digest, payload_revision,
          executor_type, executor_kind, executor_id, requested_at,
          terminal_outcome, terminal_at, receipt_lookup_state,
          supersedes_attempt_id, operator_resolution_started_at
        ) VALUES (
          '${operatorId}', 'rednote-publishing/v1', 'page-6', 'source-revision',
          '{}'::jsonb, '${'d'.repeat(64)}', 'rednote-browser-payload/v1',
          'operator', 'operator', 'operator-2', CURRENT_TIMESTAMP,
          'accepted', CURRENT_TIMESTAMP, 'pending',
          '${workerId}', CURRENT_TIMESTAMP
        );
        UPDATE rednote_publish_attempts
        SET terminal_outcome = 'outcome_unknown',
            terminal_at = CURRENT_TIMESTAMP,
            receipt_lookup_state = 'not_required',
            receipt_lookup_updated_at = CURRENT_TIMESTAMP,
            active = FALSE,
            superseded_by_attempt_id = '${operatorId}'
        WHERE id = '${workerId}';
      `);
      await expect(db.exec(`
        UPDATE rednote_publish_attempts
        SET active = TRUE
        WHERE id = '${workerId}';
      `)).rejects.toThrow(/cannot be reactivated/);

      await db.exec(`
        UPDATE rednote_publish_attempts
        SET receipt_lookup_state = 'found',
            receipt_lookup_updated_at = CURRENT_TIMESTAMP
        WHERE id = '${operatorId}';
        INSERT INTO rednote_publish_attempt_receipts (
          attempt_id, rednote_url, rednote_note_id,
          platform_publish_time, provenance
        ) VALUES (
          '${operatorId}', 'https://www.rednote.com/explore/operator-note',
          'operator-note', CURRENT_TIMESTAMP, '{"source":"operator"}'::jsonb
        );
      `);
      const current = await db.query<{
        operator_resolution_started_at: string;
        operator_resolution_completed_at: string | null;
      }>(`
        SELECT operator_resolution_started_at, operator_resolution_completed_at
        FROM rednote_publish_attempts
        WHERE id = '${operatorId}'
      `);
      expect(current.rows[0].operator_resolution_started_at).toBeTruthy();
      expect(current.rows[0].operator_resolution_completed_at).toBeNull();

      await expect(db.exec(`
        INSERT INTO rednote_publish_attempts (
          contract_revision, source_notion_page_id, source_post_revision,
          frozen_payload, payload_digest, payload_revision,
          executor_type, executor_kind, executor_id, requested_at,
          terminal_outcome, terminal_at, operator_resolution_started_at
        ) VALUES (
          'rednote-publishing/v1', 'page-6', 'source-revision-2',
          '{}'::jsonb, '${'e'.repeat(64)}', 'rednote-browser-payload/v1',
          'operator', 'operator', 'operator-3', CURRENT_TIMESTAMP,
          'accepted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `)).rejects.toThrow();

      await db.exec(`
        UPDATE rednote_publish_attempts
        SET operator_resolution_completed_at = CURRENT_TIMESTAMP
        WHERE id = '${operatorId}';
      `);
      await expect(db.exec(`
        UPDATE rednote_publish_attempts
        SET operator_resolution_completed_at = NULL
        WHERE id = '${operatorId}';
      `)).rejects.toThrow(/cannot be reactivated/);
    } finally {
      await db.close();
    }
  });

  it('keeps request and Posts mutation intent identity immutable', async () => {
    const db = await migratedDatabase();
    const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      await db.exec(workerAttempt(attemptId, 'page-7', false));
      await db.exec(`
        INSERT INTO rednote_publish_attempt_requests (
          requester, idempotency_key, raw_request_digest, attempt_id
        ) VALUES (
          'create', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          '${'f'.repeat(64)}', '${attemptId}'
        );
        INSERT INTO rednote_publish_post_mutations (
          attempt_id, source_notion_page_id, mutation_kind,
          expected_active_attempt_id, desired_active_attempt_id,
          desired_publish_execution, desired_next_action
        ) VALUES (
          '${attemptId}', 'page-7', 'worker_claim', NULL, '${attemptId}',
          'Worker claimed', 'Resolve attempt'
        );
      `);
      await expect(db.exec(`
        UPDATE rednote_publish_attempt_requests
        SET raw_request_digest = '${'0'.repeat(64)}';
      `)).rejects.toThrow(/immutable/);
      await expect(db.exec(`
        UPDATE rednote_publish_post_mutations
        SET desired_active_attempt_id = 'changed';
      `)).rejects.toThrow(/immutable/);
    } finally {
      await db.close();
    }
  });
});
