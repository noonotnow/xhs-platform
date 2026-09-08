import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  expiredBatchClaim: vi.fn(),
}));

vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));
vi.mock('@/lib/rednote-publishing-attempt-store', () => ({
  diagnoseReadyX3StaleBrowserFrameRecovery: vi.fn(),
  requeueExpiredMisclassifiedBatchClaim: mocks.expiredBatchClaim,
  requeueMisclassifiedBatchInvalidClaimFailure: vi.fn(),
  requeueReadyX3InvalidClaimFailure: vi.fn(),
  requeueReadyX3NotLoggedInFailure: vi.fn(),
  requeueReadyX3ScheduleReadbackMismatch: vi.fn(),
  requeueReadyX3StaleBrowserFrameFailure: vi.fn(),
  requeueReadyX3PrestageClaim: vi.fn(),
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
});
