import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  diagnoseExpiredBatchClaim: vi.fn(),
  expiredBatchClaim: vi.fn(),
  diagnoseTerminalExpiredBatchClaim: vi.fn(),
  terminalExpiredBatchClaim: vi.fn(),
}));

vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));
vi.mock('@/lib/rednote-publishing-attempt-store', () => ({
  diagnoseExpiredMisclassifiedBatchClaim: mocks.diagnoseExpiredBatchClaim,
  diagnoseTerminalExpiredMisclassifiedBatchClaim:
    mocks.diagnoseTerminalExpiredBatchClaim,
  diagnoseReadyX3StaleBrowserFrameRecovery: vi.fn(),
  requeueExpiredMisclassifiedBatchClaim: mocks.expiredBatchClaim,
  requeueMisclassifiedBatchInvalidClaimFailure: vi.fn(),
  requeueReadyX3InvalidClaimFailure: vi.fn(),
  requeueReadyX3NotLoggedInFailure: vi.fn(),
  requeueReadyX3ScheduleReadbackMismatch: vi.fn(),
  requeueReadyX3StaleBrowserFrameFailure: vi.fn(),
  requeueReadyX3PrestageClaim: vi.fn(),
  requeueTerminalExpiredMisclassifiedBatchClaim:
    mocks.terminalExpiredBatchClaim,
}));

import { POST } from './route';

describe('expired misclassified batch claim recovery route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOperator.mockResolvedValue(null);
    mocks.expiredBatchClaim.mockResolvedValue({
      requeued: true,
      reclassifiedAuthorization: 'batch',
      publicationMayHaveStarted: false,
    });
    mocks.diagnoseExpiredBatchClaim.mockResolvedValue({
      eligible: false,
      checks: { batchItemClaimed: false },
      failedChecks: ['batchItemClaimed'],
    });
    mocks.diagnoseTerminalExpiredBatchClaim.mockResolvedValue({
      eligible: true,
      checks: { jobLeaseErrorCodeExact: true },
      failedChecks: [],
    });
    mocks.terminalExpiredBatchClaim.mockResolvedValue({
      requeued: true,
      reclassifiedAuthorization: 'batch',
      publicationMayHaveStarted: false,
    });
  });

  it('requires a distinct confirmation and forwards the exact workspace identity', async () => {
    const body = {
      confirm: 'REQUEUE_EXACT_EXPIRED_MISCLASSIFIED_BATCH_CLAIM',
      jobId: 'a6cdfa8a-e840-4e48-9776-044a8cd2b093',
      attemptId: '22222222-2222-4222-8222-222222222222',
      sourceNotionPageId: 'notion-day-16',
      revision: '2026-08-31T15:56:00.000Z',
    };
    const response = await POST(new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-jobs/prestage-claim-recovery',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': 'legacy-local-publish',
        },
        body: JSON.stringify(body),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.expiredBatchClaim).toHaveBeenCalledWith({
      workspaceId: 'legacy-local-publish',
      jobId: body.jobId,
      attemptId: body.attemptId,
      sourceNotionPageId: body.sourceNotionPageId,
      revision: body.revision,
    });
  });

  it('authenticates and forwards the exact read-only diagnostic request', async () => {
    const body = {
      confirm: 'DIAGNOSE_EXACT_EXPIRED_MISCLASSIFIED_BATCH_CLAIM',
      jobId: 'a6cdfa8a-e840-4e48-9776-044a8cd2b093',
      attemptId: 'ef4a1d51-01eb-4499-a596-4aefefb59de8',
      sourceNotionPageId: '432411de-071a-498e-9833-ff7b6c238374',
      revision: '2026-09-08T16:37:00.000Z',
    };
    const response = await POST(new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-jobs/prestage-claim-recovery',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': 'legacy-local-publish',
        },
        body: JSON.stringify(body),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      eligible: false,
      checks: { batchItemClaimed: false },
      failedChecks: ['batchItemClaimed'],
    });
    expect(mocks.diagnoseExpiredBatchClaim).toHaveBeenCalledWith({
      workspaceId: 'legacy-local-publish',
      jobId: body.jobId,
      attemptId: body.attemptId,
      sourceNotionPageId: body.sourceNotionPageId,
      revision: body.revision,
    });
    expect(mocks.expiredBatchClaim).not.toHaveBeenCalled();
  });

  it('does not diagnose when operator authentication fails', async () => {
    mocks.requireOperator.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );
    const response = await POST(new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-jobs/prestage-claim-recovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: 'DIAGNOSE_EXACT_EXPIRED_MISCLASSIFIED_BATCH_CLAIM',
        }),
      },
    ));

    expect(response.status).toBe(401);
    expect(mocks.diagnoseExpiredBatchClaim).not.toHaveBeenCalled();
    expect(mocks.expiredBatchClaim).not.toHaveBeenCalled();
  });

  it('routes the distinct terminal lease-expiry diagnostic without mutation', async () => {
    const body = {
      confirm: 'DIAGNOSE_EXACT_TERMINAL_EXPIRED_MISCLASSIFIED_BATCH_CLAIM',
      jobId: 'a6cdfa8a-e840-4e48-9776-044a8cd2b093',
      attemptId: 'ef4a1d51-01eb-4499-a596-4aefefb59de8',
      sourceNotionPageId: '432411de-071a-498e-9833-ff7b6c238374',
      revision: '2026-09-08T16:37:00.000Z',
    };
    const response = await POST(new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-jobs/prestage-claim-recovery',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': 'legacy-local-publish',
        },
        body: JSON.stringify(body),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.diagnoseTerminalExpiredBatchClaim).toHaveBeenCalledWith({
      workspaceId: 'legacy-local-publish',
      jobId: body.jobId,
      attemptId: body.attemptId,
      sourceNotionPageId: body.sourceNotionPageId,
      revision: body.revision,
    });
    expect(mocks.terminalExpiredBatchClaim).not.toHaveBeenCalled();
  });

  it('routes the distinct terminal lease-expiry recovery confirmation', async () => {
    const body = {
      confirm: 'REQUEUE_EXACT_TERMINAL_EXPIRED_MISCLASSIFIED_BATCH_CLAIM',
      jobId: 'a6cdfa8a-e840-4e48-9776-044a8cd2b093',
      attemptId: 'ef4a1d51-01eb-4499-a596-4aefefb59de8',
      sourceNotionPageId: '432411de-071a-498e-9833-ff7b6c238374',
      revision: '2026-09-08T16:37:00.000Z',
    };
    const response = await POST(new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-jobs/prestage-claim-recovery',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': 'legacy-local-publish',
        },
        body: JSON.stringify(body),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.terminalExpiredBatchClaim).toHaveBeenCalledWith({
      workspaceId: 'legacy-local-publish',
      jobId: body.jobId,
      attemptId: body.attemptId,
      sourceNotionPageId: body.sourceNotionPageId,
      revision: body.revision,
    });
  });
});
