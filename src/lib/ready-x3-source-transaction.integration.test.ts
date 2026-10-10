import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, sql } from './db';
import { readyX3SourceTransactionContext } from './ready-x3-source-transaction';
import { withReadyX3SourceLock } from './rednote-publishing-attempt-store';
import { insertLocalPublishJob } from './local-publish-job-store';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

// Disposable LOCAL PostgreSQL only. This fixture is not production DDL.
const databaseUrl = process.env.READY_X3_TEST_DATABASE_URL;
const snapshot: LocalPublishSnapshot = {
  expectedAccountId: 'fixture-account',
  notionPageId: '11111111-1111-4111-8111-111111111111',
  headline: 'Test', title: 'Test', caption: 'Test', tags: [],
  platform: 'RedNote', mediaType: 'image', mediaIndex: 0,
  mediaUrl: 'https://fixture.invalid/test.png',
  notionLastEditedTime: '2026-10-08T17:23:00Z',
};
const key = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!databaseUrl)('Ready ×3 physical PostgreSQL transaction', () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) ||
        !url.pathname.startsWith('/ready_x3_disposable')) {
      throw new Error('This fixture requires a dedicated local disposable database');
    }
    process.env.XHS_DATABASE_URL = databaseUrl;
    await getPool().query(`
      CREATE TABLE local_publish_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL,
        notion_page_id text NOT NULL, snapshot jsonb NOT NULL,
        idempotency_key uuid NOT NULL, status text NOT NULL DEFAULT 'queued',
        attempt_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, idempotency_key)
      );
      CREATE FUNCTION rednote_publish_revision_blockers(text,text,text)
      RETURNS TABLE (reason text) LANGUAGE sql AS
      $$ SELECT NULL::text WHERE false $$;
    `);
  });
  beforeEach(async () => { await getPool().query('TRUNCATE local_publish_jobs'); });
  afterAll(async () => { await getPool().end(); });

  it('uses the same physical backend for the lock, tagged reads, and job write', async () => {
    await withReadyX3SourceLock('fixture', snapshot.notionPageId, async () => {
      const client = readyX3SourceTransactionContext.getStore()!.client;
      const owner = await client.query('SELECT pg_backend_pid() AS pid');
      const reader = await sql`SELECT pg_backend_pid() AS pid`;
      expect(reader.rows[0].pid).toBe(owner.rows[0].pid);
      await insertLocalPublishJob(snapshot, key, 'fixture');
      const inside = await client.query('SELECT count(*)::int AS count FROM local_publish_jobs');
      expect(inside.rows[0].count).toBe(1);
    });
    const committed = await getPool().query('SELECT count(*)::int AS count FROM local_publish_jobs');
    expect(committed.rows[0].count).toBe(1);
  });

  it('rolls back a job if the authorization step fails and permits a safe retry', async () => {
    await expect(withReadyX3SourceLock('fixture', snapshot.notionPageId, async () => {
      await insertLocalPublishJob(snapshot, key, 'fixture');
      throw new Error('Authorization rejected');
    })).rejects.toThrow('Authorization rejected');
    const rolledBack = await getPool().query('SELECT count(*)::int AS count FROM local_publish_jobs');
    expect(rolledBack.rows[0].count).toBe(0);
    const retry = await withReadyX3SourceLock('fixture', snapshot.notionPageId,
      () => insertLocalPublishJob(snapshot, key, 'fixture'));
    expect(retry.created).toBe(true);
  });

  it('serializes simultaneous retries without creating another job', async () => {
    const results = await Promise.all([1, 2, 3].map(() =>
      withReadyX3SourceLock('fixture', snapshot.notionPageId,
        () => insertLocalPublishJob(snapshot, key, 'fixture')),
    ));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.job.id)).size).toBe(1);
  });
});
