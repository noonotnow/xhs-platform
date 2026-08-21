import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  insert: vi.fn(),
  getPost: vi.fn(),
  getManualPost: vi.fn(),
  loadHandling: vi.fn(),
  assertSnapshot: vi.fn(),
  reconcile: vi.fn(),
  complete: vi.fn(),
  defer: vi.fn(),
  fail: vi.fn(),
  load: vi.fn(),
  reconcileDisposition: vi.fn(),
  retryDisposition: vi.fn(),
  markAwaitingReceipt: vi.fn(),
  syncPlanProvenance: vi.fn(),
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
  return {
    ...original,
    getReadyXhsPost: mocks.getPost,
    getXhsPostForManualHandling: mocks.getManualPost,
    markXhsPostAwaitingReceipt: mocks.markAwaitingReceipt,
  };
});
vi.mock('@/lib/manual-post-handling-store', () => ({
  loadManualPostHandlingByPage: mocks.loadHandling,
}));
vi.mock('@/lib/plan-reconciliation-sync', () => ({
  syncReconciledPlanProvenance: mocks.syncPlanProvenance,
}));
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadHandling.mockResolvedValue(null);
  });

  it('freezes expected metadata from Notion instead of the client', async () => {
    mocks.find.mockResolvedValue(null);
    mocks.getPost.mockResolvedValue({
      id: request.notionPageId,
      headline: request.expected.title,
      caption: request.expected.caption,
      hasVideo: true,
      candidateKind: 'packet_ready',
      manualWarnings: [],
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

  it('returns an exact notion-only idempotent replay', async () => {
    mocks.find.mockResolvedValue(request);

    await expect(createManualReconciliation({
      notionPageId: request.notionPageId,
      publicPost: request.shareUrl,
      confirmed: true,
    }, request.idempotencyKey)).resolves.toMatchObject({
      created: false,
      reconciliation: { id: request.id },
    });
    expect(mocks.getPost).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('rejects a targeted disposition key reused for notion-only reconciliation', async () => {
    mocks.find.mockResolvedValue({
      ...request,
      kind: 'targeted_local_job',
      sourceLocalJobId: '66666666-6666-4666-8666-666666666666',
    });

    await expect(createManualReconciliation({
      notionPageId: request.notionPageId,
      publicPost: request.shareUrl,
      confirmed: true,
    }, request.idempotencyKey)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
    expect(mocks.getPost).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('rejects MOV compatibility trials before creating reconciliation work', async () => {
    mocks.find.mockResolvedValue(null);
    mocks.getPost.mockResolvedValue({
      id: request.notionPageId,
      headline: request.expected.title,
      caption: request.expected.caption,
      hasVideo: true,
      candidateKind: 'mov_compatibility_trial',
      manualWarnings: [],
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

  it('allows a pending handled post to verify despite later CREATE edits', async () => {
    mocks.find.mockResolvedValue(null);
    mocks.loadHandling.mockResolvedValue({
      notionPageId: request.notionPageId,
      notionVersion: '2026-08-03T12:00:00.000Z',
      receiptStatus: 'pending',
    });
    mocks.getManualPost.mockResolvedValue({
      id: request.notionPageId,
      headline: request.expected.title,
      caption: request.expected.caption,
      status: 'Ready',
      lastEditedTime: '2026-08-03T13:00:00.000Z',
      hasVideo: true,
      manualWarnings: [
        'Needs media is still checked',
        'MOV media requires the CapCut compatibility workflow',
      ],
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
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      expected: expect.objectContaining({
        matchFields: [],
      }),
    }));
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
      source: 'manual',
    });
    expect(mocks.complete.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.reconcile.mock.invocationCallOrder[0]);
  });

  it('syncs PLAN provenance after the operator receipt is durably reconciled', async () => {
      mocks.assertSnapshot.mockResolvedValue(request);
      mocks.reconcile.mockResolvedValue({
        id: '55555555-5555-4555-8555-555555555555',
        status: 'succeeded',
      });
      mocks.complete.mockResolvedValue({ ...request, status: 'reconciled' });
      mocks.loadHandling.mockResolvedValue({
        mode: 'scheduled',
        recordedBy: 'plan',
        receiptStatus: 'reconciled',
      });
      mocks.syncPlanProvenance.mockResolvedValue({
        status: 'synced',
        enrichment: { enriched: true },
      });

      await expect(submitManualReconciliationResult(
        request.id,
        request.claimToken,
        { status: 'verified', snapshot },
      )).resolves.toMatchObject({
        status: 'reconciled',
        planProvenanceSync: { status: 'synced', enrichment: { enriched: true } },
      });
      expect(mocks.syncPlanProvenance).toHaveBeenCalledWith(request.notionPageId);
      expect(mocks.syncPlanProvenance.mock.invocationCallOrder[0])
        .toBeGreaterThan(mocks.complete.mock.invocationCallOrder[0]);
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
    mocks.load.mockResolvedValue({
      ...targeted,
      status: 'reconciled',
    });

    await expect(submitManualReconciliationResult(
      targeted.id,
      targeted.claimToken,
      { status: 'verified', snapshot },
    )).resolves.toMatchObject({
      sourceLocalJobId: targeted.sourceLocalJobId,
      kind: 'targeted_local_job',
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
