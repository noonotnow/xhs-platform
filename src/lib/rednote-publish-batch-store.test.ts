import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResultRow } from 'pg';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: vi.fn().mockResolvedValue({
      query: mocks.query,
      release: mocks.release,
    }),
  }),
  sql: mocks.sql,
}));

import {
  approveStoredPublishBatch,
  createStoredPublishBatch,
} from '@/lib/rednote-publish-batch-store';
import type {
  LocalPublishSnapshot,
  PublishBatchStatus,
} from '@/types/local-publish-job';

const snapshot: LocalPublishSnapshot = {
  notionPageId: '11111111-1111-4111-8111-111111111111',
  headline: 'Replacement sibling',
  title: 'Replacement sibling',
  caption: 'Frozen caption',
  tags: ['FrozenTag'],
  platform: 'RedNote',
  mediaType: 'video',
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
  publishAt: '2026-08-04T18:00:00.000Z',
  notionLastEditedTime: '2026-08-04T12:00:00.000Z',
};

function batchRow(
  id: string,
  status: PublishBatchStatus,
  manifestHash: string,
): QueryResultRow {
  return {
    id,
    kind: 'bootstrap',
    status,
    manifest_hash: manifestHash,
    candidate_report: [],
    window_start: null,
    window_end: null,
    approved_at: null,
    approved_by: null,
    superseded_at: status === 'superseded'
      ? '2026-08-04T16:00:00.000Z'
      : null,
    superseded_by_batch_id: null,
    created_at: '2026-08-04T15:00:00.000Z',
  };
}

describe('stored RedNote bootstrap replacement', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
    mocks.sql.mockReset();
  });

  it('atomically supersedes the old audit row and creates a replacement manifest', async () => {
    const oldId = '22222222-2222-4222-8222-222222222222';
    const newId = '33333333-3333-4333-8333-333333333333';
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT DISTINCT ON')) return { rows: [] };
      if (statement.includes("SET status = 'superseded'")) {
        return { rows: [batchRow(oldId, 'superseded', oldHash)] };
      }
      if (statement.includes('INSERT INTO rednote_publish_batches')) {
        return { rows: [batchRow(newId, 'pending_approval', newHash)] };
      }
      if (statement.includes('INSERT INTO rednote_publish_batch_items')) {
        return {
          rows: [{
            id: '44444444-4444-4444-8444-444444444444',
            batch_id: newId,
            notion_page_id: snapshot.notionPageId,
            snapshot,
            item_hash: newHash,
            state: 'needs_approval',
            dispatch_mode: 'scheduled',
            late_by_seconds: 0,
            invalidation_reason: null,
            local_publish_job_id: null,
          }],
        };
      }
      if (statement.includes('SET manifest_hash = $1')) {
        return { rows: [batchRow(newId, 'pending_approval', 'c'.repeat(64))] };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await createStoredPublishBatch({
      kind: 'bootstrap',
      manifestHash: newHash,
      items: [{
        notionPageId: snapshot.notionPageId,
        snapshot,
        itemHash: newHash,
        dispatchMode: 'scheduled',
        lateBySeconds: 0,
      }],
      blockedCandidates: [],
    });

    expect(result).toMatchObject({
      id: newId,
      status: 'pending_approval',
      items: [expect.objectContaining({ notionPageId: snapshot.notionPageId })],
    });
    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining("SET status = 'superseded'"),
      expect.stringContaining('Batch superseded before approval'),
      expect.stringContaining('SET superseded_by_batch_id = $1::uuid'),
      'COMMIT',
    ]));
  });

  it('rejects a superseded manifest before changing any item', async () => {
    const oldHash = 'a'.repeat(64);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FOR UPDATE')) {
        return { rows: [batchRow('old', 'superseded', oldHash)] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(approveStoredPublishBatch(
      '22222222-2222-4222-8222-222222222222',
      oldHash,
      'operator@example.com',
      [],
    )).rejects.toThrow(/superseded and can never be approved/i);
    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).toContain('ROLLBACK');
    expect(statements.some((statement) =>
      statement.includes('INSERT INTO local_publish_jobs'))).toBe(false);
  });

  it('serializes approval on the bootstrap lock and commits atomically', async () => {
    const batchId = '22222222-2222-4222-8222-222222222222';
    const manifestHash = 'a'.repeat(64);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FOR UPDATE')) {
        return { rows: [batchRow(batchId, 'pending_approval', manifestHash)] };
      }
      if (statement.includes('UPDATE rednote_publish_batches AS batch')) {
        return { rows: [batchRow(batchId, 'approved', manifestHash)] };
      }
      return { rows: [], rowCount: 1 };
    });
    mocks.sql
      .mockResolvedValueOnce({
        rows: [batchRow(batchId, 'approved', manifestHash)],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(approveStoredPublishBatch(
      batchId,
      manifestHash,
      'operator@example.com',
      [{
        itemId: '44444444-4444-4444-8444-444444444444',
        approved: true,
      }],
    )).resolves.toMatchObject({ id: batchId, status: 'approved' });

    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining("hashtextextended('rednote-bootstrap-batch', 0)"),
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('INSERT INTO local_publish_jobs'),
      'COMMIT',
    ]));
  });

  it('still supersedes an unsafe old manifest when every current candidate is blocked', async () => {
    const oldId = '22222222-2222-4222-8222-222222222222';
    const newId = '33333333-3333-4333-8333-333333333333';
    const emptyHash =
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("SET status = 'superseded'")) {
        return { rows: [batchRow(oldId, 'superseded', 'a'.repeat(64))] };
      }
      if (statement.includes('INSERT INTO rednote_publish_batches')) {
        return { rows: [batchRow(newId, 'pending_approval', emptyHash)] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(createStoredPublishBatch({
      kind: 'bootstrap',
      manifestHash: emptyHash,
      items: [],
      blockedCandidates: [{
        notionPageId: snapshot.notionPageId,
        headline: snapshot.headline,
        reason: 'Existing scheduled job owns this post.',
      }],
    })).resolves.toMatchObject({
      id: newId,
      manifestHash: emptyHash,
      status: 'pending_approval',
      items: [],
    });
    expect(mocks.query.mock.calls.map(([statement]) => String(statement)))
      .toContain('COMMIT');
  });
});
