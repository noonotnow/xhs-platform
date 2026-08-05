import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  getPool: () => ({ connect: mocks.connect }),
  sql: mocks.sql,
}));

import { beginExternalReconciliation } from '@/lib/external-post-reconciliation-store';

const snapshot = {
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
  title: 'Final title',
  caption: 'Final caption',
  mediaType: 'video' as const,
};
const idempotencyKey = '33333333-3333-4333-8333-333333333333';

function row(status: 'processing' | 'succeeded' | 'failed', updatedAt: string) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    note_id: snapshot.noteId,
    share_url: snapshot.shareUrl,
    snapshot,
    status,
    idempotency_key: idempotencyKey,
    outcome: status === 'succeeded' ? 'created' : null,
    notion_page_id: status === 'succeeded' ? 'notion-page' : null,
    error_code: status === 'failed' ? 'NOTION_ERROR' : null,
    error_message: status === 'failed' ? 'Notion failed' : null,
    created_at: '2026-08-04T10:00:00.000Z',
    updated_at: updatedAt,
    completed_at: status === 'processing' ? null : updatedAt,
  };
}

describe('external reconciliation persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({
      query: mocks.query,
      release: mocks.release,
    });
  });

  it('returns a prior success idempotently without touching Notion again', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row('succeeded', new Date().toISOString())] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(beginExternalReconciliation(snapshot, idempotencyKey))
      .resolves.toMatchObject({
        acquired: false,
        record: { status: 'succeeded', outcome: 'created' },
      });
    expect(mocks.query).toHaveBeenCalledTimes(7);
    expect(mocks.query.mock.calls[0][0]).toBe('BEGIN');
    expect(mocks.query.mock.calls[1][1]).toEqual([
      `rednote-note:${snapshot.noteId}`,
    ]);
    expect(mocks.query.mock.calls[2][1]).toEqual([
      `rednote-share-url:${snapshot.shareUrl}`,
    ]);
    expect(mocks.query.mock.calls[6][0]).toBe('COMMIT');
    expect(mocks.query.mock.calls.some(([query]) =>
      String(query).includes('LOCK TABLE')
    )).toBe(false);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('does not create a conflicting receipt owned by a targeted disposition', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'target-request',
        requested_note_id: snapshot.noteId,
        requested_share_url: snapshot.shareUrl,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(beginExternalReconciliation(snapshot, idempotencyKey))
      .rejects.toMatchObject({ code: 'RECONCILIATION_CONFLICT', status: 409 });
    expect(mocks.query.mock.calls[5][0]).toBe('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledOnce();
    const insert = String(mocks.query.mock.calls[3][0]);
    expect(insert).toContain("request_kind = 'targeted_local_job'");
    expect(insert).toContain('disposition.id =');
    expect(insert).toContain('IS NOT NULL');
  });

  it('refuses a live processing lease and reclaims a stale one atomically', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row('processing', new Date().toISOString())] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(beginExternalReconciliation(snapshot, idempotencyKey))
      .rejects.toMatchObject({ code: 'RECONCILIATION_IN_PROGRESS', status: 409 });

    vi.clearAllMocks();
    const stale = row('processing', '2026-01-01T00:00:00.000Z');
    const reclaimed = row('processing', new Date().toISOString());
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stale] })
      .mockResolvedValueOnce({ rows: [reclaimed] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(beginExternalReconciliation(snapshot, idempotencyKey))
      .resolves.toMatchObject({ acquired: true, record: { status: 'processing' } });
    const update = String(mocks.query.mock.calls[6][0]);
    expect(update).toContain("status = 'failed'");
    expect(update).toContain("updated_at <= CURRENT_TIMESTAMP - INTERVAL '5 minutes'");
  });

  it('reclaims a failed receipt for an identical retry', async () => {
    const failed = row('failed', '2026-08-04T10:00:00.000Z');
    const reclaimed = row('processing', new Date().toISOString());
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [failed] })
      .mockResolvedValueOnce({ rows: [reclaimed] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(beginExternalReconciliation(snapshot, idempotencyKey))
      .resolves.toMatchObject({ acquired: true, record: { status: 'processing' } });
  });

  it('does not reclaim a failed record owned by a targeted disposition', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'target-request',
        requested_note_id: snapshot.noteId,
        requested_share_url: snapshot.shareUrl,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(beginExternalReconciliation(snapshot, idempotencyKey))
      .rejects.toMatchObject({ code: 'RECONCILIATION_CONFLICT', status: 409 });
    expect(mocks.query).toHaveBeenCalledTimes(6);
  });

  it('rejects conflicting natural keys instead of creating duplicate Notion rows', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          row('succeeded', '2026-08-04T10:00:00.000Z'),
          { ...row('succeeded', '2026-08-04T10:01:00.000Z'), id: 'other' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    await expect(beginExternalReconciliation(snapshot, idempotencyKey))
      .rejects.toMatchObject({ code: 'RECONCILIATION_CONFLICT', status: 409 });
  });
});
