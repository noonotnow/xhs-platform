import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  approve: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));
const attempts = vi.hoisted(() => ({
  createBatchLinked: vi.fn(),
  getLinked: vi.fn(),
}));
const notion = vi.hoisted(() => ({
  getReadyPost: vi.fn(),
}));
const lifecycle = vi.hoisted(() => ({
  listBlockers: vi.fn(),
}));

vi.mock('@/lib/rednote-publish-batch-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rednote-publish-batch-store')>();
  return {
    ...original,
    approveStoredPublishBatch: stores.approve,
    createStoredPublishBatch: stores.create,
    listStoredPublishBatches: stores.list,
  };
});

vi.mock('@/lib/notion-posts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/notion-posts')>();
  return {
    ...original,
    getReadyXhsPost: notion.getReadyPost,
  };
});

vi.mock('@/lib/local-publish-job-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/local-publish-job-store')>();
  return {
    ...original,
    listPublishLifecycleBlockers: lifecycle.listBlockers,
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

import {
  approvePublishBatch,
  manifestHash,
  preparePublishBatch,
} from '@/lib/rednote-publish-batches';
import type { NewPublishBatchItem } from '@/lib/rednote-publish-batch-store';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { NotionPostsError } from '@/lib/notion-posts';
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

const readyPost = {
  id: snapshot.notionPageId,
  pageUrl: 'https://www.notion.so/post',
  headline: snapshot.headline,
  caption: snapshot.caption,
  status: 'Ready',
  candidateKind: 'packet_ready' as const,
  publishPacketReady: true,
  hasVideo: true,
  needsMedia: false,
  needsCaption: false,
  mediaUrls: [snapshot.mediaUrl],
  imageUrls: [],
  videoUrls: [snapshot.mediaUrl],
  compatibilityTrialVideoUrls: [],
  thumbnailUrl: '',
  tags: snapshot.tags,
  scheduledDate: snapshot.publishAt,
  publishAt: snapshot.publishAt,
  lastEditedTime: snapshot.notionLastEditedTime,
  automationBlockers: [],
  manualWarnings: [],
  publishBlockers: [],
};
const frozenOnDemandSnapshot = {
  ...snapshot,
  title: snapshot.headline,
};

function pendingOnDemandBatch() {
  return {
    ...batch,
    kind: 'on_demand' as const,
    status: 'pending_approval' as const,
    manifestHash: 'on-demand-manifest',
    items: [{
      ...batch.items[0],
      snapshot: frozenOnDemandSnapshot,
      itemHash: manifestHash(frozenOnDemandSnapshot),
      dispatchMode: 'scheduled' as const,
      state: 'needs_approval' as const,
      localPublishJobId: undefined,
    }],
  };
}

describe('on-demand RedNote batch preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('REDNOTE_EXPECTED_ACCOUNT_ID', snapshot.expectedAccountId);
    notion.getReadyPost.mockResolvedValue(readyPost);
    lifecycle.listBlockers.mockResolvedValue([]);
  });

  it('freezes one exact scheduled Post into an unapproved deterministic candidate', async () => {
    stores.create.mockImplementation(async (input) => ({
      id: batch.id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      status: 'pending_approval',
      manifestHash: input.manifestHash,
      createdAt: '2099-08-01T12:01:00.000Z',
      items: input.items.map((item: NewPublishBatchItem, index: number) => ({
        ...item,
        id: `item-${index}`,
        state: 'needs_approval',
      })),
      blockedCandidates: input.blockedCandidates,
    }));

    const prepared = await preparePublishBatch(
      snapshot.notionPageId,
      'workspace-1',
      new Date('2099-08-01T12:00:00.000Z'),
    );
    const frozenSnapshot = {
      ...snapshot,
      title: snapshot.headline,
    };

    expect(notion.getReadyPost).toHaveBeenCalledWith(snapshot.notionPageId);
    expect(stores.create).toHaveBeenCalledOnce();
    expect(prepared).toMatchObject({
      kind: 'on_demand',
      status: 'pending_approval',
      items: [{
        notionPageId: snapshot.notionPageId,
        state: 'needs_approval',
        dispatchMode: 'scheduled',
        lateBySeconds: 0,
        snapshot: frozenSnapshot,
      }],
    });
    expect(prepared.items[0]).not.toHaveProperty('localPublishJobId');
    expect(prepared.items[0].itemHash).toBe(manifestHash(frozenSnapshot));
    expect(prepared.manifestHash).toBe(manifestHash([{
      notionPageId: snapshot.notionPageId,
      itemHash: prepared.items[0].itemHash,
      dispatchMode: 'scheduled',
      lateBySeconds: 0,
    }]));
    expect(stores.approve).not.toHaveBeenCalled();
    expect(attempts.createBatchLinked).not.toHaveBeenCalled();
  });

  it.each([
    ['past', '2099-08-04T13:31:00.000Z'],
    ['equal to now', snapshot.publishAt],
  ])('rejects a %s schedule without creating any publishing lifecycle', async (
    _label,
    now,
  ) => {
    await expect(preparePublishBatch(
      snapshot.notionPageId,
      'workspace-1',
      new Date(now),
    )).rejects.toMatchObject({
      code: 'POST_NOT_ELIGIBLE',
      status: 409,
    });

    expect(stores.create).not.toHaveBeenCalled();
    expect(stores.approve).not.toHaveBeenCalled();
    expect(attempts.createBatchLinked).not.toHaveBeenCalled();
  });

  it('rejects a Draft even when its publish packet checkbox is true', async () => {
    notion.getReadyPost.mockResolvedValue({
      ...readyPost,
      status: 'Draft',
    });

    await expect(preparePublishBatch(
      snapshot.notionPageId,
      'workspace-1',
      new Date('2099-08-01T12:00:00.000Z'),
    )).rejects.toMatchObject({
      code: 'POST_NOT_ELIGIBLE',
      status: 409,
    });

    expect(stores.create).not.toHaveBeenCalled();
    expect(stores.approve).not.toHaveBeenCalled();
    expect(attempts.createBatchLinked).not.toHaveBeenCalled();
  });

  it('fails closed when the selected revision already has lifecycle ownership', async () => {
    lifecycle.listBlockers.mockResolvedValue([{
      notionPageId: snapshot.notionPageId,
      lifecycleId: 'existing-item',
      lifecycleState: 'batch_item:needs_approval',
    }]);

    await expect(preparePublishBatch(
      snapshot.notionPageId,
      'workspace-1',
    )).rejects.toMatchObject({
      code: 'POST_REVISION_ALREADY_OWNED',
      status: 409,
    });
    expect(stores.create).not.toHaveBeenCalled();
  });

  it('fails closed when the selected Post is not eligible for a frozen scheduled snapshot', async () => {
    notion.getReadyPost.mockResolvedValue({
      ...readyPost,
      scheduledDate: '',
      publishAt: undefined,
      publishBlockers: ['Missing exact publication time'],
    });

    await expect(preparePublishBatch(
      snapshot.notionPageId,
      'workspace-1',
    )).rejects.toMatchObject({
      code: 'POST_NOT_ELIGIBLE',
      status: 409,
    });
    expect(stores.create).not.toHaveBeenCalled();
  });

  it('propagates a missing canonical Post without creating a candidate', async () => {
    notion.getReadyPost.mockRejectedValue(new NotionPostsError(
      'The requested Notion post was not found.',
      'NOTION_POST_NOT_FOUND',
      404,
    ));

    await expect(preparePublishBatch(
      snapshot.notionPageId,
      'workspace-1',
    )).rejects.toMatchObject({
      code: 'NOTION_POST_NOT_FOUND',
      status: 404,
    });
    expect(lifecycle.listBlockers).not.toHaveBeenCalled();
    expect(stores.create).not.toHaveBeenCalled();
  });

  it('fails closed when a concurrent preparation wins the store lock', async () => {
    stores.create.mockResolvedValue(null);

    await expect(preparePublishBatch(
      snapshot.notionPageId,
      'workspace-1',
    )).rejects.toMatchObject({
      code: 'POST_REVISION_CONFLICT',
      status: 409,
    });
  });
});

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

  it('invalidates a changed on-demand source before creating a job or attempt', async () => {
    const pendingBatch = pendingOnDemandBatch();
    const invalidatedBatch = {
      ...pendingBatch,
      status: 'partially_approved' as const,
      items: [{
        ...pendingBatch.items[0],
        state: 'invalidated' as const,
        invalidationReason: 'The Notion source revision or frozen publishing fields changed.',
      }],
    };
    stores.list
      .mockResolvedValueOnce([pendingBatch])
      .mockResolvedValueOnce([invalidatedBatch]);
    stores.approve.mockResolvedValue(invalidatedBatch);
    notion.getReadyPost.mockResolvedValue({
      ...readyPost,
      caption: 'Changed after preparation',
    });

    await expect(approvePublishBatch(
      pendingBatch.id,
      pendingBatch.manifestHash,
      'operator@example.com',
      'workspace-1',
    )).resolves.toEqual(invalidatedBatch);
    expect(stores.approve).toHaveBeenCalledWith(
      pendingBatch.id,
      pendingBatch.manifestHash,
      'operator@example.com',
      [{
        itemId: pendingBatch.items[0].id,
        approved: false,
        reason: 'The Notion source revision or frozen publishing fields changed.',
      }],
      'workspace-1',
    );
    expect(attempts.createBatchLinked).not.toHaveBeenCalled();
  });

  it.each([
    ['due', snapshot.publishAt],
    ['past', '2099-08-04T13:31:00.000Z'],
  ])('invalidates an on-demand candidate that is %s before job insertion', async (
    _label,
    now,
  ) => {
    const pendingBatch = pendingOnDemandBatch();
    const invalidatedBatch = {
      ...pendingBatch,
      status: 'partially_approved' as const,
      items: [{
        ...pendingBatch.items[0],
        state: 'invalidated' as const,
        invalidationReason:
          'ScheduledDate must be strictly in the future for on-demand publishing.',
      }],
    };
    stores.list
      .mockResolvedValueOnce([pendingBatch])
      .mockResolvedValueOnce([invalidatedBatch]);
    stores.approve.mockResolvedValue(invalidatedBatch);
    notion.getReadyPost.mockResolvedValue(readyPost);

    await expect(approvePublishBatch(
      pendingBatch.id,
      pendingBatch.manifestHash,
      'operator@example.com',
      'workspace-1',
      new Date(now),
    )).resolves.toEqual(invalidatedBatch);

    expect(stores.approve).toHaveBeenCalledWith(
      pendingBatch.id,
      pendingBatch.manifestHash,
      'operator@example.com',
      [{
        itemId: pendingBatch.items[0].id,
        approved: false,
        reason:
          'ScheduledDate must be strictly in the future for on-demand publishing.',
      }],
      'workspace-1',
    );
    expect(attempts.createBatchLinked).not.toHaveBeenCalled();
  });

  it('invalidates a non-Ready on-demand source before job insertion', async () => {
    const pendingBatch = pendingOnDemandBatch();
    const invalidatedBatch = {
      ...pendingBatch,
      status: 'partially_approved' as const,
      items: [{
        ...pendingBatch.items[0],
        state: 'invalidated' as const,
        invalidationReason:
          'Canonical Notion Status must be Ready for on-demand publishing.',
      }],
    };
    stores.list
      .mockResolvedValueOnce([pendingBatch])
      .mockResolvedValueOnce([invalidatedBatch]);
    stores.approve.mockResolvedValue(invalidatedBatch);
    notion.getReadyPost.mockResolvedValue({
      ...readyPost,
      status: 'Draft',
    });

    await expect(approvePublishBatch(
      pendingBatch.id,
      pendingBatch.manifestHash,
      'operator@example.com',
      'workspace-1',
      new Date('2099-08-01T12:00:00.000Z'),
    )).resolves.toEqual(invalidatedBatch);

    expect(stores.approve).toHaveBeenCalledWith(
      pendingBatch.id,
      pendingBatch.manifestHash,
      'operator@example.com',
      [{
        itemId: pendingBatch.items[0].id,
        approved: false,
        reason:
          'Canonical Notion Status must be Ready for on-demand publishing.',
      }],
      'workspace-1',
    );
    expect(attempts.createBatchLinked).not.toHaveBeenCalled();
  });

  it('approves an unchanged Ready on-demand source while it remains future scheduled', async () => {
    const pendingBatch = pendingOnDemandBatch();
    const approvedBatch = {
      ...pendingBatch,
      status: 'approved' as const,
      items: [{
        ...pendingBatch.items[0],
        state: 'approved' as const,
      }],
    };
    stores.list
      .mockResolvedValueOnce([pendingBatch])
      .mockResolvedValueOnce([approvedBatch]);
    stores.approve.mockResolvedValue(approvedBatch);
    notion.getReadyPost.mockResolvedValue(readyPost);

    await expect(approvePublishBatch(
      pendingBatch.id,
      pendingBatch.manifestHash,
      'operator@example.com',
      'workspace-1',
      new Date('2099-08-01T12:00:00.000Z'),
    )).resolves.toEqual(approvedBatch);

    expect(stores.approve).toHaveBeenCalledWith(
      pendingBatch.id,
      pendingBatch.manifestHash,
      'operator@example.com',
      [{
        itemId: pendingBatch.items[0].id,
        approved: true,
        reason: undefined,
      }],
      'workspace-1',
    );
  });
});
