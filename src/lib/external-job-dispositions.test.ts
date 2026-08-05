import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  prepare: vi.fn(),
  reconcile: vi.fn(),
  complete: vi.fn(),
  retry: vi.fn(),
}));

vi.mock('@/lib/external-job-disposition-store', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/external-job-disposition-store')
  >();
  return {
    ...original,
    insertExternalJobDisposition: mocks.insert,
    prepareExternalJobDisposition: mocks.prepare,
    completeExternalJobDisposition: mocks.complete,
    retryExternalJobDisposition: mocks.retry,
  };
});
vi.mock('@/lib/external-post-reconciliations', () => ({
  reconcileVerifiedExternalPost: mocks.reconcile,
}));

import {
  createExternalJobDisposition,
  reconcileExternalJobDisposition,
} from '@/lib/external-job-dispositions';

const stored = {
  id: '11111111-1111-4111-8111-111111111111',
  notionPageId: 'notion-page',
  sourceLocalJobId: '22222222-2222-4222-8222-222222222222',
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
  expected: {
    title: 'Title',
    caption: 'Caption',
    mediaType: 'video' as const,
  },
  kind: 'targeted_local_job' as const,
  status: 'verifying' as const,
  idempotencyKey: '33333333-3333-4333-8333-333333333333',
  claimToken: '44444444-4444-4444-8444-444444444444',
  claimAttempts: 1,
  verificationAttempts: 0,
  createdAt: '2026-08-04T12:00:00.000Z',
  updatedAt: '2026-08-04T12:01:00.000Z',
};

const snapshot = {
  noteId: stored.noteId,
  shareUrl: stored.shareUrl,
  ...stored.expected,
};

describe('external job disposition orchestration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates one exact idempotent operator request', async () => {
    mocks.insert.mockResolvedValue({
      request: { ...stored, status: 'queued' },
      created: true,
    });
    const body = {
      notionPageId: stored.notionPageId,
      localJobId: stored.sourceLocalJobId,
      noteId: stored.noteId,
      shareUrl: stored.shareUrl,
      confirmed: true,
    };
    await expect(createExternalJobDisposition(
      body,
      stored.idempotencyKey,
    )).resolves.toMatchObject({
      created: true,
      disposition: {
        localJobId: stored.sourceLocalJobId,
        status: 'queued',
      },
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        localJobId: stored.sourceLocalJobId,
        shareUrl: stored.shareUrl,
      }),
      stored.idempotencyKey,
    );
  });

  it('commits verified state before Notion and reconciliation after Notion', async () => {
    mocks.prepare.mockResolvedValue(stored);
    mocks.reconcile.mockResolvedValue({ id: 'receipt-id', status: 'succeeded' });
    mocks.complete.mockResolvedValue({ ...stored, status: 'reconciled' });

    await expect(reconcileExternalJobDisposition(
      stored.id,
      stored.claimToken,
      snapshot,
    )).resolves.toMatchObject({ status: 'reconciled' });

    expect(mocks.prepare.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.reconcile.mock.invocationCallOrder[0]);
    expect(mocks.complete.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.reconcile.mock.invocationCallOrder[0]);
    expect(mocks.reconcile).toHaveBeenCalledWith({
      snapshot,
      idempotencyKey: stored.id,
      targetNotionPageId: stored.notionPageId,
      targetDispositionId: stored.id,
    });
  });

  it('leaves completion untouched when Notion fails after verified commit', async () => {
    mocks.prepare.mockResolvedValue(stored);
    mocks.reconcile.mockRejectedValue(new Error('Notion unavailable'));

    await expect(reconcileExternalJobDisposition(
      stored.id,
      stored.claimToken,
      snapshot,
    )).rejects.toThrow('Notion unavailable');
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('returns an already reconciled request without another Notion write', async () => {
    mocks.prepare.mockResolvedValue({ ...stored, status: 'reconciled' });
    await expect(reconcileExternalJobDisposition(
      stored.id,
      stored.claimToken,
      snapshot,
    )).resolves.toMatchObject({ status: 'reconciled' });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
