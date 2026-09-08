import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  approve: vi.fn(),
  list: vi.fn(),
}));
const attempts = vi.hoisted(() => ({
  createLinked: vi.fn(),
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
    createLinkedRednotePublishAttempt: attempts.createLinked,
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

describe('approved RedNote batch attempt materialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('REDNOTE_EXPECTED_ACCOUNT_ID', snapshot.expectedAccountId);
    stores.list.mockResolvedValue([batch]);
  });

  it('does not create a duplicate attempt on an exact approved-batch replay', async () => {
    attempts.getLinked.mockResolvedValue({
      payload: { expectedAccountId: snapshot.expectedAccountId },
      readyX3Authorization: { media },
    });

    await expect(approvePublishBatch(
      batch.id,
      batch.manifestHash,
      'operator@example.com',
      'legacy-local-publish',
    )).resolves.toEqual(batch);
    expect(attempts.createLinked).not.toHaveBeenCalled();
  });

  it('repairs a missing approved linked attempt without issuing a second job', async () => {
    attempts.getLinked.mockRejectedValue(new LocalPublishJobError(
      'The local job is missing its durable publishing attempt',
      'ATTEMPT_NOT_FOUND',
      409,
    ));
    attempts.createLinked.mockResolvedValue({ attempt: { id: 'attempt-1' }, created: true });

    await expect(approvePublishBatch(
      batch.id,
      batch.manifestHash,
      'operator@example.com',
      'legacy-local-publish',
    )).resolves.toEqual(batch);
    expect(stores.approve).not.toHaveBeenCalled();
    expect(attempts.createLinked).toHaveBeenCalledWith(
      snapshot,
      batch.items[0].localPublishJobId,
      'legacy-local-publish',
      batch.items[0].localPublishJobId,
      'schedule',
    );
  });

  it('fails closed when the existing attempt differs from the frozen account', async () => {
    attempts.getLinked.mockResolvedValue({
      payload: { expectedAccountId: 'different-account' },
      readyX3Authorization: { media },
    });

    await expect(approvePublishBatch(
      batch.id,
      batch.manifestHash,
      'operator@example.com',
      'legacy-local-publish',
    )).rejects.toMatchObject({ code: 'ATTEMPT_PACKET_MISMATCH' });
    expect(attempts.createLinked).not.toHaveBeenCalled();
  });
});
