import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  reconcileNotion: vi.fn(),
}));

vi.mock('@/lib/external-post-reconciliation-store', () => ({
  beginExternalReconciliation: mocks.begin,
  completeExternalReconciliation: mocks.complete,
  failExternalReconciliation: mocks.fail,
}));
vi.mock('@/lib/notion-posts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/notion-posts')>();
  return { ...original, reconcileExternalXhsPost: mocks.reconcileNotion };
});

import { reconcileVerifiedExternalPost } from '@/lib/external-post-reconciliations';
import { NotionPostsError } from '@/lib/notion-posts';

const snapshot = {
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
  title: 'Final title',
  caption: 'Final caption',
  mediaType: 'video' as const,
};
const idempotencyKey = '33333333-3333-4333-8333-333333333333';
const processing = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'processing',
  createdAt: '2026-08-04T12:00:00.000Z',
};
const succeeded = {
  ...processing,
  status: 'succeeded',
  notionPageId: 'notion-page',
  outcome: 'created',
};

describe('external reconciliation orchestration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates or creates Notion once and persists the successful outcome', async () => {
    mocks.begin.mockResolvedValue({ record: processing, acquired: true });
    mocks.reconcileNotion.mockResolvedValue({
      notionPageId: 'notion-page',
      outcome: 'created',
    });
    mocks.complete.mockResolvedValue(succeeded);

    await expect(reconcileVerifiedExternalPost({ snapshot, idempotencyKey }))
      .resolves.toMatchObject({
        status: 'succeeded',
        notionPageId: 'notion-page',
        outcome: 'created',
      });
    expect(mocks.complete).toHaveBeenCalledWith(
      processing.id,
      'notion-page',
      'created',
    );
    expect(mocks.reconcileNotion).toHaveBeenCalledWith(
      snapshot,
      processing.createdAt,
    );
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it('returns a stored success for an idempotent retry', async () => {
    mocks.begin.mockResolvedValue({ record: succeeded, acquired: false });
    await expect(reconcileVerifiedExternalPost({ snapshot, idempotencyKey }))
      .resolves.toMatchObject({ status: 'succeeded', notionPageId: 'notion-page' });
    expect(mocks.reconcileNotion).not.toHaveBeenCalled();
  });

  it('passes an explicit canonical target for manual reconciliation', async () => {
    mocks.begin.mockResolvedValue({ record: processing, acquired: true });
    mocks.reconcileNotion.mockResolvedValue({
      notionPageId: 'target-page',
      outcome: 'targeted_page',
    });
    mocks.complete.mockResolvedValue({
      ...succeeded,
      notionPageId: 'target-page',
      outcome: 'targeted_page',
    });
    await reconcileVerifiedExternalPost({
      snapshot,
      idempotencyKey,
      targetNotionPageId: 'target-page',
    });
    expect(mocks.reconcileNotion).toHaveBeenCalledWith(
      snapshot,
      processing.createdAt,
      'target-page',
    );
  });

  it('records safe Notion failures and never returns a success-shaped fallback', async () => {
    mocks.begin.mockResolvedValue({ record: processing, acquired: true });
    mocks.reconcileNotion.mockRejectedValue(
      new NotionPostsError('RedNote identity is ambiguous', 'NOTION_CONFLICT', 409),
    );

    await expect(reconcileVerifiedExternalPost({ snapshot, idempotencyKey }))
      .rejects.toMatchObject({ code: 'NOTION_CONFLICT', status: 409 });
    expect(mocks.fail).toHaveBeenCalledWith(
      processing.id,
      'NOTION_CONFLICT',
      'RedNote identity is ambiguous',
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
