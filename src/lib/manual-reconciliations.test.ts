import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  insert: vi.fn(),
  getPost: vi.fn(),
  assertSnapshot: vi.fn(),
  reconcile: vi.fn(),
  complete: vi.fn(),
  defer: vi.fn(),
  fail: vi.fn(),
  load: vi.fn(),
  reconcileDisposition: vi.fn(),
  retryDisposition: vi.fn(),
}));

vi.mock('@/lib/manual-reconciliation-store', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/manual-reconciliation-store')
  >();
  return {
    ...original,
    findManualReconciliationByIdempotencyKey: mocks.find,
    insertManualReconciliation: mocks.insert,
    assertManualVerifiedSnapshot: mocks.assertSnapshot,
    completeManualReconciliation: mocks.complete,
    deferManualReconciliation: mocks.defer,
    failManualReconciliation: mocks.fail,
    loadManualReconciliation: mocks.load,
  };
});
vi.mock('@/lib/notion-posts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/notion-posts')>();
  return { ...original, getReadyXhsPost: mocks.getPost };
});
vi.mock('@/lib/external-post-reconciliations', () => ({
  reconcileVerifiedExternalPost: mocks.reconcile,
}));
vi.mock('@/lib/external-job-dispositions', () => ({
  reconcileExternalJobDisposition: mocks.reconcileDisposition,
  retryFailedExternalJobDisposition: mocks.retryDisposition,
}));

import {
  createManualReconciliation,
  submitManualReconciliationResult,
} from '@/lib/manual-reconciliations';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';

const request = {
  id: '11111111-1111-4111-8111-111111111111',
  notionPageId: '22222222-2222-4222-8222-222222222222',
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
  expected: {
    title: 'Canonical title',
    caption: 'Canonical caption',
    mediaType: 'video' as const,
  },
  kind: 'notion_only' as const,
  status: 'verifying' as const,
  idempotencyKey: '33333333-3333-4333-8333-333333333333',
  claimToken: '44444444-4444-4444-8444-444444444444',
  claimExpiresAt: '2099-08-03T12:30:00.000Z',
  claimAttempts: 1,
  verificationAttempts: 0,
  createdAt: '2026-08-03T11:00:00.000Z',
  updatedAt: '2026-08-03T12:00:00.000Z',
};

const snapshot = {
  noteId: request.noteId,
  shareUrl: request.shareUrl,
  ...request.expected,
};

describe('manual reconciliation orchestration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('freezes expected metadata from Notion instead of the client', async () => {
    mocks.find.mockResolvedValue(null);
    mocks.getPost.mockResolvedValue({
      id: request.notionPageId,
      headline: request.expected.title,
      caption: request.expected.caption,
      hasVideo: true,
      candidateKind: 'packet_ready',
    });
    mocks.insert.mockResolvedValue({
      request: { ...request, status: 'queued' },
      created: true,
    });
    await expect(createManualReconciliation({
      notionPageId: request.notionPageId,
      publicPost: request.shareUrl,
      confirmed: true,
    }, request.idempotencyKey)).resolves.toMatchObject({ created: true });
    expect(mocks.insert).toHaveBeenCalledWith({
      notionPageId: request.notionPageId,
      noteId: request.noteId,
      shareUrl: request.shareUrl,
      expected: request.expected,
      idempotencyKey: request.idempotencyKey,
    });
  });

  it('rejects MOV compatibility trials before creating reconciliation work', async () => {
    mocks.find.mockResolvedValue(null);
    mocks.getPost.mockResolvedValue({
      id: request.notionPageId,
      headline: request.expected.title,
      caption: request.expected.caption,
      hasVideo: true,
      candidateKind: 'mov_compatibility_trial',
    });

    await expect(createManualReconciliation({
      notionPageId: request.notionPageId,
      publicPost: request.shareUrl,
      confirmed: true,
    }, request.idempotencyKey)).rejects.toMatchObject({
      code: 'MANUAL_RECONCILIATION_NOT_ALLOWED',
      status: 409,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('targets the exact canonical row and completes only after the external receipt', async () => {
    mocks.assertSnapshot.mockResolvedValue(request);
    mocks.reconcile.mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555',
      status: 'succeeded',
    });
    mocks.complete.mockResolvedValue({
      ...request,
      status: 'reconciled',
      externalReconciliationId: '55555555-5555-4555-8555-555555555555',
    });
    await expect(submitManualReconciliationResult(
      request.id,
      request.claimToken,
      { status: 'verified', snapshot },
    )).resolves.toMatchObject({ status: 'reconciled' });
    expect(mocks.reconcile).toHaveBeenCalledWith({
      snapshot,
      idempotencyKey: request.id,
      targetNotionPageId: request.notionPageId,
    });
    expect(mocks.complete.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.reconcile.mock.invocationCallOrder[0]);
  });

  it('routes targeted requests through verification-only job disposition', async () => {
    const targeted = {
      ...request,
      kind: 'targeted_local_job' as const,
      sourceLocalJobId: '66666666-6666-4666-8666-666666666666',
    };
    mocks.assertSnapshot.mockResolvedValue(targeted);
    mocks.reconcileDisposition.mockResolvedValue({
      id: targeted.id,
      localJobId: targeted.sourceLocalJobId,
      status: 'reconciled',
    });

    await expect(submitManualReconciliationResult(
      targeted.id,
      targeted.claimToken,
      { status: 'verified', snapshot },
    )).resolves.toMatchObject({
      localJobId: targeted.sourceLocalJobId,
      status: 'reconciled',
    });
    expect(mocks.reconcileDisposition).toHaveBeenCalledWith(
      targeted.id,
      targeted.claimToken,
      snapshot,
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('leaves a concurrent targeted reconciliation in progress', async () => {
    const targeted = {
      ...request,
      kind: 'targeted_local_job' as const,
      sourceLocalJobId: '66666666-6666-4666-8666-666666666666',
    };
    mocks.assertSnapshot.mockResolvedValue(targeted);
    mocks.reconcileDisposition.mockRejectedValue(new LocalPublishJobError(
      'This verified post is already being reconciled',
      'RECONCILIATION_IN_PROGRESS',
      409,
    ));
    mocks.load.mockResolvedValue(targeted);

    await expect(submitManualReconciliationResult(
      targeted.id,
      targeted.claimToken,
      { status: 'verified', snapshot },
    )).resolves.toMatchObject({ status: 'verifying' });
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.defer).not.toHaveBeenCalled();
  });
});
