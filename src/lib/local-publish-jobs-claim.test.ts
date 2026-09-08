import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  releaseExpiredClaims: vi.fn(),
  bindAttempt: vi.fn(),
  getAttempt: vi.fn(),
  getPost: vi.fn(),
}));

vi.mock('@/lib/local-publish-job-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/local-publish-job-store')>();
  return {
    ...original,
    claimNextStoredLocalPublishJob: mocks.claim,
    releaseExpiredStoredLocalPublishClaims: mocks.releaseExpiredClaims,
  };
});
vi.mock('@/lib/rednote-publishing-attempt-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rednote-publishing-attempt-store')>()),
  bindLinkedAttemptClaim: mocks.bindAttempt,
  getLinkedRednotePublishAttempt: mocks.getAttempt,
}));
vi.mock('@/lib/notion-posts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notion-posts')>()),
  getReadyXhsPost: mocks.getPost,
}));

import { claimNextLocalPublishJob } from '@/lib/local-publish-jobs';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';
import { manifestHash } from '@/lib/rednote-publish-batches';

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
      'legacy-local-publish',
      undefined,
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

  it('returns bounded batch authorization without Ready x3 consent', async () => {
    const mediaUrl = 'https://images.xhs.justlikekatie.com/day-16.png';
    const media = [{
      type: 'image' as const,
      url: mediaUrl,
      identity: rednoteMediaIdentity({ type: 'image', url: mediaUrl }),
    }];
    const job = {
      id: expectedJobId,
      status: 'claimed' as const,
      claimToken: '22222222-2222-4222-8222-222222222222',
      claimExpiresAt: '2099-08-16T13:00:00.000Z',
      notionPageId: '33333333-3333-4333-8333-333333333333',
      headline: 'Day 16',
      title: 'Day 16',
      caption: 'Caption',
      tags: ['Tag'],
      platform: 'RedNote' as const,
      mediaType: 'image' as const,
      mediaIndex: 0,
      mediaUrl,
      media,
      expectedAccountId: '678ba3b5000000000a03ecd2',
      publishAt: '2099-08-16T13:30:00.000Z',
      notionLastEditedTime: '2099-08-16T12:00:00.000Z',
      batchAuthorization: {
        batchId: '44444444-4444-4444-8444-444444444444',
        manifestHash: 'a'.repeat(64),
        itemHash: '',
        snapshotRevision: '2099-08-16T12:00:00.000Z',
        approvedState: 'approved' as const,
        approvedAt: '2099-08-16T12:05:00.000Z',
        media,
        publishAt: '2099-08-16T13:30:00.000Z',
        lateAction: 'schedule' as const,
      },
    };
    job.batchAuthorization.itemHash = manifestHash({
      notionPageId: job.notionPageId,
      headline: job.headline,
      title: job.title,
      caption: job.caption,
      tags: job.tags,
      platform: job.platform,
      mediaType: job.mediaType,
      mediaIndex: job.mediaIndex,
      mediaUrl: job.mediaUrl,
      media: job.media,
      expectedAccountId: job.expectedAccountId,
      publishAt: job.publishAt,
      notionLastEditedTime: job.notionLastEditedTime,
    });
    mocks.claim.mockResolvedValue(job);
    mocks.getAttempt.mockResolvedValue({
      approvedAt: '2099-08-16T12:05:00.000Z',
      payload: { expectedAccountId: job.expectedAccountId },
    });
    mocks.getPost.mockResolvedValue({
      id: job.notionPageId,
      headline: job.headline,
      caption: job.caption,
      status: 'Ready',
      candidateKind: 'packet_ready',
      publishPacketReady: true,
      hasVideo: false,
      needsMedia: false,
      needsCaption: false,
      mediaUrls: [mediaUrl],
      imageUrls: [mediaUrl],
      videoUrls: [],
      thumbnailUrl: '',
      tags: job.tags,
      publishAt: job.publishAt,
      lastEditedTime: job.notionLastEditedTime,
      automationBlockers: [],
      manualWarnings: [],
      publishBlockers: [],
    });

    const claim = await claimNextLocalPublishJob(
      'dispatch',
      undefined,
      'legacy-local-publish',
    );

    expect(claim).toMatchObject({ batchAuthorization: job.batchAuthorization });
    expect(claim).not.toHaveProperty('readyX3Authorization');
    expect(mocks.bindAttempt).toHaveBeenCalledWith(
      'legacy-local-publish',
      job.id,
      job.claimToken,
      job.claimExpiresAt,
    );
  });
});
