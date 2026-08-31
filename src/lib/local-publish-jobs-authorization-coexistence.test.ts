import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  authorize: vi.fn(),
  consume: vi.fn(),
}));
const attempts = vi.hoisted(() => ({
  get: vi.fn(),
  authorizeLegacy: vi.fn(),
  consumeReadyX3: vi.fn(),
}));
const notion = vi.hoisted(() => ({
  getPost: vi.fn(),
}));

vi.mock('@/lib/local-publish-job-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/local-publish-job-store')>()),
  authorizeStoredLocalPublishJob: store.authorize,
  consumeStoredDispatchAuthorization: store.consume,
}));
vi.mock('@/lib/rednote-publishing-attempt-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rednote-publishing-attempt-store')>()),
  getLinkedRednotePublishAttempt: attempts.get,
  authorizeLinkedAttempt: attempts.authorizeLegacy,
  consumeLinkedReadyX3DispatchAuthorization: attempts.consumeReadyX3,
}));
vi.mock('@/lib/notion-posts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notion-posts')>()),
  getReadyXhsPost: notion.getPost,
}));

import { authorizeLocalPublishJob } from '@/lib/local-publish-jobs';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';

const workspaceId = 'workspace-1';
const jobId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const stagedLegacyJob = {
  id: jobId,
  status: 'staged' as const,
  notionPageId: '33333333-3333-4333-8333-333333333333',
  headline: 'Headline',
  title: 'Title',
  caption: 'Caption',
  tags: ['Tag'],
  platform: 'RedNote' as const,
  mediaType: 'image' as const,
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/post.png',
  publishAt: '2099-08-05T15:00:00.000Z',
  notionLastEditedTime: '2099-08-05T12:00:00.000Z',
  claimToken,
  claimExpiresAt: '2099-08-05T14:00:00.000Z',
};
const readyX3Authorization = {
  kind: 'ready_x3' as const,
  action: 'schedule' as const,
  packetRevision: stagedLegacyJob.notionLastEditedTime,
  packetDigest: 'a'.repeat(64),
  media: {
    url: stagedLegacyJob.mediaUrl,
    type: stagedLegacyJob.mediaType,
    identity: rednoteMediaIdentity({
      url: stagedLegacyJob.mediaUrl,
      type: stagedLegacyJob.mediaType,
    }),
  },
  platform: 'RedNote' as const,
  publishAt: stagedLegacyJob.publishAt,
  authorizedAt: '2099-08-05T12:30:00.000Z',
  lateFallback: { action: 'post_now' as const, maxLateMinutes: 30 as const },
};

describe('local publish authorization coexistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.authorize.mockResolvedValue(stagedLegacyJob);
    store.consume.mockResolvedValue(stagedLegacyJob);
    notion.getPost.mockResolvedValue({
      id: stagedLegacyJob.notionPageId,
      pageUrl: 'https://notion.so/post',
      headline: stagedLegacyJob.headline,
      caption: stagedLegacyJob.caption,
      status: 'Ready',
      candidateKind: 'packet_ready',
      publishPacketReady: true,
      hasVideo: false,
      needsMedia: false,
      needsCaption: false,
      mediaUrls: [stagedLegacyJob.mediaUrl],
      imageUrls: [stagedLegacyJob.mediaUrl],
      videoUrls: [],
      thumbnailUrl: '',
      tags: stagedLegacyJob.tags,
      publishAt: stagedLegacyJob.publishAt,
      scheduledDate: null,
      lastEditedTime: stagedLegacyJob.notionLastEditedTime,
      automationBlockers: [],
      manualWarnings: [],
      publishBlockers: [],
    });
  });

  it('retains linked-attempt authorization for a staged non-Ready-x3 worker job', async () => {
    attempts.get.mockResolvedValue({});
    attempts.authorizeLegacy.mockResolvedValue({
      attemptId: '44444444-4444-4444-8444-444444444444',
      authorizedAt: '2099-08-05T13:00:00.000Z',
    });

    await expect(authorizeLocalPublishJob(jobId, claimToken, workspaceId))
      .resolves.toMatchObject({ id: jobId, status: 'staged' });

    expect(attempts.authorizeLegacy)
      .toHaveBeenCalledWith(workspaceId, jobId, claimToken);
    expect(attempts.consumeReadyX3).not.toHaveBeenCalled();
    expect(store.consume).toHaveBeenCalledWith(jobId, claimToken, workspaceId);
  });

  it('idempotently revalidates the same consumed Ready x3 staged claim', async () => {
    store.authorize.mockResolvedValue({
      ...stagedLegacyJob,
      dispatchAuthorizedAt: '2099-08-05T13:00:00.000Z',
    });
    attempts.get.mockResolvedValue({ readyX3Authorization });

    await expect(authorizeLocalPublishJob(jobId, claimToken, workspaceId))
      .resolves.toMatchObject({
        id: jobId,
        status: 'staged',
        dispatchAuthorizedAt: '2099-08-05T13:00:00.000Z',
        readyX3Authorization,
      });

    expect(notion.getPost).toHaveBeenCalledWith(stagedLegacyJob.notionPageId);
    expect(attempts.consumeReadyX3).not.toHaveBeenCalled();
    expect(attempts.authorizeLegacy).not.toHaveBeenCalled();
    expect(store.consume).not.toHaveBeenCalled();
  });
});