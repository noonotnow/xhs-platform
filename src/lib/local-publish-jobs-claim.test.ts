import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
}));

vi.mock('@/lib/local-publish-job-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/local-publish-job-store')>();
  return {
    ...original,
    claimNextStoredLocalPublishJob: mocks.claim,
  };
});

import { claimNextLocalPublishJob } from '@/lib/local-publish-jobs';

const expectedJobId = '11111111-1111-4111-8111-111111111111';

describe('local publish exact claim service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('turns an absent exact candidate into a fail-closed conflict', async () => {
    mocks.claim.mockResolvedValue(null);

    await expect(claimNextLocalPublishJob(
      'verification',
      expectedJobId,
    )).rejects.toMatchObject({
      code: 'EXPECTED_JOB_NOT_CLAIMABLE',
      status: 409,
    });
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.any(Number),
      'verification',
      expectedJobId,
    );
  });

  it('preserves the untargeted no-work response', async () => {
    mocks.claim.mockResolvedValue(null);

    await expect(claimNextLocalPublishJob('verification')).resolves.toBeNull();
  });

  it('rejects malformed or unscoped exact selectors before storage access', async () => {
    await expect(claimNextLocalPublishJob(
      'verification',
      'not-a-uuid',
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    await expect(claimNextLocalPublishJob(
      'all',
      expectedJobId,
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });

    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
