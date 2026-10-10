import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), release: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  getPool: () => ({ connect: mocks.connect, query: vi.fn(() => {
    throw new Error('A locked source must not query through another connection');
  }) }),
  sql: vi.fn(() => { throw new Error('Unexpected independent query'); }),
}));

import {
  supersedeUnclaimedReadyX3Schedule,
  withReadyX3SourceLock,
} from '@/lib/rednote-publishing-attempt-store';
import { insertLocalPublishJob } from '@/lib/local-publish-job-store';
import { readyX3SourceTransactionContext } from './ready-x3-source-transaction';

const snapshot: LocalPublishSnapshot = {
  expectedAccountId: 'fixture-account',
  notionPageId: '11111111-1111-4111-8111-111111111111',
  headline: 'Test', title: 'Test', caption: 'Test', tags: [],
  platform: 'RedNote', mediaType: 'image', mediaIndex: 0,
  mediaUrl: 'https://fixture.invalid/test.png',
  notionLastEditedTime: '2026-10-08T17:23:00Z',
  publishAt: '2099-01-01T00:00:00Z',
};
const key = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockReset();
  mocks.connect.mockResolvedValueOnce({ query: mocks.query, release: mocks.release })
    .mockRejectedValue(new Error('Second connection deadlocks on the source lock'));
  mocks.query.mockImplementation(async (statement: string) => ({
    rows: statement.includes('INSERT INTO local_publish_jobs') ? [{
      id: key, workspace_id: 'fixture', notion_page_id: snapshot.notionPageId,
      snapshot, idempotency_key: key, status: 'queued', attempt_count: 0,
      created_at: '2026-10-08T17:23:00Z', updated_at: '2026-10-08T17:23:00Z',
    }] : [], rowCount: 1,
  }));
});

describe('Ready ×3 source transaction', () => {
  it('supersedes and inserts with the lock-holding client and only one commit', async () => {
    await withReadyX3SourceLock('fixture', snapshot.notionPageId, async () => {
      await supersedeUnclaimedReadyX3Schedule('fixture', snapshot, 'schedule');
      const result = await insertLocalPublishJob(snapshot, key, 'fixture');
      expect(result.created).toBe(true);
      expect(readyX3SourceTransactionContext.getStore()?.client.query).toBe(mocks.query);
    });
    const statements = mocks.query.mock.calls.map(([s]) => String(s));
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(statements.filter(s => s === 'BEGIN')).toHaveLength(1);
    expect(statements.filter(s => s === 'COMMIT')).toHaveLength(1);
    expect(statements.filter(s => s.includes('pg_advisory_xact_lock'))).toHaveLength(1);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(readyX3SourceTransactionContext.getStore()).toBeUndefined();
  });

  it('rolls the job back if subsequent attempt creation fails', async () => {
    await expect(withReadyX3SourceLock('fixture', snapshot.notionPageId, async () => {
      await insertLocalPublishJob(snapshot, key, 'fixture');
      throw new Error('Attempt write rejected');
    })).rejects.toThrow('Attempt write rejected');
    const statements = mocks.query.mock.calls.map(([s]) => String(s));
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(readyX3SourceTransactionContext.getStore()).toBeUndefined();
  });

  it('rejects inserting a different source under the existing lock', async () => {
    await expect(withReadyX3SourceLock('fixture', snapshot.notionPageId, () =>
      insertLocalPublishJob({ ...snapshot, notionPageId: 'another-source' }, key, 'fixture'),
    )).rejects.toMatchObject({ code: 'READY_X3_TRANSACTION_SOURCE_MISMATCH' });
    expect(mocks.query.mock.calls.some(([s]) => String(s).includes('INSERT INTO local_publish_jobs'))).toBe(false);
  });
});
