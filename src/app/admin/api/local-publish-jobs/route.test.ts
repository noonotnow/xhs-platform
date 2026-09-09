import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  readOperational: vi.fn(),
  getSummaries: vi.fn(),
  listAttestations: vi.fn(),
}));

vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));
vi.mock('@/lib/rednote-publishing-attempt-store', () => ({
  readRednotePublishingOperational: mocks.readOperational,
}));
vi.mock('@/lib/local-publish-jobs', () => ({
  getLocalPublishJobSummaries: mocks.getSummaries,
  normalizeLocalPublishJobError: (error: Error) => ({
    message: error.message,
    code: 'TEST_ERROR',
    status: 500,
  }),
  queueLocalPublishJob: vi.fn(),
}));
vi.mock('@/lib/operator-success-attestation-store', () => ({
  listOperatorSuccessAttestationEvidence: mocks.listAttestations,
}));

import { GET } from '@/app/admin/api/local-publish-jobs/route';

describe('admin local publish jobs route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOperator.mockResolvedValue(null);
    mocks.readOperational.mockResolvedValue({
      contractVersion: 'publishing-v1',
      queue: [],
      attempts: [],
    });
    mocks.getSummaries.mockResolvedValue([{
      id: '11111111-1111-4111-8111-111111111111',
      notionPageId: 'legacy-post',
      status: 'failed',
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T13:00:00.000Z',
      verificationAttempts: 0,
    }]);
    mocks.listAttestations.mockResolvedValue([]);
  });

  it('keeps legacy job arrays beside the operational contract', async () => {
    const response = await GET(new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-jobs',
      { headers: { 'X-Workspace-Id': 'legacy-local-publish' } },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contractVersion: 'publishing-v1',
      jobs: [expect.objectContaining({
        notionPageId: 'legacy-post',
        status: 'failed',
      })],
      successAttestationCandidates: [],
    });
    expect(mocks.readOperational).toHaveBeenCalledWith('legacy-local-publish');
    expect(mocks.getSummaries).toHaveBeenCalledWith('legacy-local-publish');
    expect(mocks.listAttestations).toHaveBeenCalledWith('legacy-local-publish');
  });
});
