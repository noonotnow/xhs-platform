import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  approve: vi.fn(),
  list: vi.fn(),
}));
const attempts = vi.hoisted(() => ({
  createBatchLinked: vi.fn(),
  getLinked: vi.fn(),
}));

vi.mock('@/lib/rednote-publish-batch-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rednote-publish-batch-store')>();
  return {
    ...original,
    approveStoredPublishBatch: stores.approve,
    listStoredPublishBatches: stores.list,
  };
});

vi.mock('@/lib/rednote-publishing-attempt-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rednote-publishing-attempt-store')>();
  return {
    ...original,
    createBatchLinkedRednotePublishAttempt: attempts.createBatchLinked,
    getLinkedRednotePublishAttempt: attempts.getLinked,
  };
});

import { approvePublishBatch } from '@/lib/rednote-publish-batches';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';

const media = [{
  type: 'video' as const,
  url: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
  identity: rednoteMediaIdentity({
    type: 'video',
    url: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
  }),
}];
const snapshot = {
  notionPageId: '11111111-1111-4111-8111-111111111111',
  headline: 'Headline',
  title: 'Title',
  caption: 'Caption',
  tags: ['Tag'],
  platform: 'RedNote' as const,
  mediaType: 'video' as const,
  mediaIndex: 0,
  mediaUrl: media[0].url,
  media,
  publishAt: '2099-08-04T13:30:00.000Z',
  notionLastEditedTime: '2099-08-01T12:00:00.000Z',
  expectedAccountId: 'creator-account-1',
};
const batch = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'bootstrap' as const,
  status: 'approved' as const,
  manifestHash: 'manifest-hash',
  items: [{
    id: '33333333-3333-4333-8333-333333333333',
    notionPageId: snapshot.notionPageId,
    snapshot,
    itemHash: 'item-hash',
    dispatchMode: 'schedule' as const,
    lateBySeconds: 0,
    state: 'queued' as const,
    localPublishJobId: '44444444-4444-4444-8444-444444444444',
  }],
};
const linkedBatchAttempt = {
  approvedAt: '2099-08-01T12:05:00.000Z',
  payload: {
    sourcePostId: snapshot.notionPageId,
    expectedAccountId: snapshot.expectedAccountId,
    title: snapshot.title,
    caption: snapshot.caption,
    tags: snapshot.tags,
    scheduledDate: snapshot.publishAt,
    targetPublishAt: snapshot.publishAt,
    timingMode: 'scheduled',
    publishMode: 'video',
    mediaAssets: [{
      assetId: 'video-0',
      deliveryUrl: media[0].url,
      sha256: 'a'.repeat(64),
      mediaType: 'video',
      role: 'content',
    }],
  },
};

describe('approved RedNote batch attempt materialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('REDNOTE_EXPECTED_ACCOUNT_ID', snapshot.expectedAccountId);
    stores.list.mockResolvedValue([batch]);
  });

  it('does not create a duplicate attempt on an exact approved-batch replay', async () => {
    attempts.getLinked.mockResolvedValue(linkedBatchAttempt);

    await expect(approvePublishBatch(
      batch.id,
      batch.manifestHash,
      'operator@example.com',
      'legacy-local-publish',
    )).resolves.toEqual(batch);
    expect(attempts.createBatchLinked).not.toHaveBeenCalled();
  });

  it('repairs a missing approved linked attempt without issuing a second job', async () => {
    attempts.getLinked.mockRejectedValue(new LocalPublishJobError(
      'The local job is missing its durable publishing attempt',
      'ATTEMPT_NOT_FOUND',
      409,
    ));
    attempts.createBatchLinked.mockResolvedValue({
      attempt: { id: 'attempt-1' },
      created: true,
    });

    await expect(approvePublishBatch(
      batch.id,
      batch.manifestHash,
      'operator@example.com',
      'legacy-local-publish',
    )).resolves.toEqual(batch);
    expect(stores.approve).not.toHaveBeenCalled();
    expect(attempts.createBatchLinked).toHaveBeenCalledWith(
      snapshot,
      batch.items[0].localPublishJobId,
      'legacy-local-publish',
      batch.items[0].localPublishJobId,
      'schedule',
    );
  });

  it('fails closed when the existing attempt differs from the frozen account', async () => {
    attempts.getLinked.mockResolvedValue({
      ...linkedBatchAttempt,
      payload: { ...linkedBatchAttempt.payload, expectedAccountId: 'different-account' },
    });

    await expect(approvePublishBatch(
      batch.id,
      batch.manifestHash,
      'operator@example.com',
      'legacy-local-publish',
    )).rejects.toMatchObject({ code: 'ATTEMPT_PACKET_MISMATCH' });
    expect(attempts.createBatchLinked).not.toHaveBeenCalled();
  });

  it('rejects a linked attempt carrying Ready x3 consent for a bounded batch', async () => {
    attempts.getLinked.mockResolvedValue({
      ...linkedBatchAttempt,
      readyX3Authorization: { kind: 'ready_x3' },
    });

    await expect(approvePublishBatch(
      batch.id,
      batch.manifestHash,
      'operator@example.com',
      'legacy-local-publish',
    )).rejects.toMatchObject({ code: 'ATTEMPT_PACKET_MISMATCH' });
    expect(attempts.createBatchLinked).not.toHaveBeenCalled();
  });
});
