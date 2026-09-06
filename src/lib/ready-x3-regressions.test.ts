import { beforeEach, describe, expect, it, vi } from 'vitest';

const attempt = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  recordOutcome: vi.fn(),
  supersede: vi.fn(),
  withSourceLock: vi.fn(async (
    _workspaceId: string,
    _notionPageId: string,
    operation: () => Promise<unknown>,
  ) => operation()),
}));

vi.mock('@/lib/rednote-publishing-attempt-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rednote-publishing-attempt-store')>();
  return {
    ...original,
    createRednotePublishAttempt: attempt.create,
    getLinkedRednotePublishAttempt: attempt.get,
    recordLinkedAttemptOutcome: attempt.recordOutcome,
    supersedeUnclaimedReadyX3Schedule: attempt.supersede,
    withReadyX3SourceLock: attempt.withSourceLock,
  };
});

import {
  queueLocalPublishJob,
  submitLocalPublishJobResult,
} from '@/lib/local-publish-jobs';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { ReadyXhsPost } from '@/types/ready-post';

const pageId = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const future = '2099-08-04T13:30:00.000Z';
const post: ReadyXhsPost = {
  id: pageId, pageUrl: 'https://notion.so/post', headline: 'Headline', caption: 'Caption',
  status: 'Ready', candidateKind: 'packet_ready', publishPacketReady: true, hasVideo: true,
  needsMedia: false, needsCaption: false,
  mediaUrls: ['https://images.xhs.justlikekatie.com/videos/assets/post.mp4'],
  imageUrls: [],
  videoUrls: ['https://images.xhs.justlikekatie.com/videos/assets/post.mp4'],
  thumbnailUrl: 'https://images.xhs.justlikekatie.com/cover.jpg',
  tags: ['Tag'], publishAt: future, scheduledDate: null, lastEditedTime: '2099-08-01T12:00:00.000Z',
  automationBlockers: [], manualWarnings: [], publishBlockers: [],
};
const body = {
  notionPageId: pageId, lastEditedTime: post.lastEditedTime, confirmed: true, title: 'Title',
  caption: 'Caption', tags: ['Tag'], media: { type: 'video' as const, index: 0 }, consent: 'ready_x3' as const,
};
const stored = {
  id: '33333333-3333-4333-8333-333333333333', workspaceId: 'workspace-1', notionPageId: pageId,
  snapshot: { notionPageId: pageId, headline: 'Headline', title: 'Title', caption: 'Caption',
    tags: ['Tag'], platform: 'RedNote' as const, mediaType: 'video' as const, mediaIndex: 0,
    mediaUrl: post.videoUrls[0], thumbnailUrl: post.thumbnailUrl,
    publishAt: future, notionLastEditedTime: post.lastEditedTime,
    expectedAccountId: 'creator-account-1' },
  status: 'queued' as const, verificationAttempts: 0, createdAt: future, updatedAt: future,
};

describe('Ready x3 queue regression contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('REDNOTE_EXPECTED_ACCOUNT_ID', 'creator-account-1');
  });

  it('requires an exact future Ready x3 schedule before it writes work', async () => {
    const dependencies = {
      getPost: vi.fn().mockResolvedValue({ ...post, publishAt: '2020-08-04T13:30:00.000Z' }),
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      insert: vi.fn(),
    };
    await expect(queueLocalPublishJob(body, key, 'workspace-1', dependencies))
      .rejects.toMatchObject({ code: 'READY_X3_PUBLISH_TIME_REQUIRED' });
    expect(dependencies.insert).not.toHaveBeenCalled();
  });

  it('creates an auto-approved Ready x3 frozen attempt with its exact future schedule', async () => {
    attempt.supersede.mockResolvedValue(false);
    attempt.create.mockResolvedValue({ attempt: { id: 'attempt-1' }, created: true });
    const dependencies = {
      getPost: vi.fn().mockResolvedValue(post),
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ job: stored, created: true }),
    };
    await expect(queueLocalPublishJob(body, key, 'workspace-1', dependencies))
      .resolves.toMatchObject({ created: true, attempt: { id: 'attempt-1' } });
    expect(attempt.withSourceLock).toHaveBeenCalledWith(
      'workspace-1',
      pageId,
      expect.any(Function),
    );
    expect(attempt.supersede).toHaveBeenCalledWith(
      'workspace-1',
      expect.objectContaining({ publishAt: future }),
      'schedule',
    );
    expect(attempt.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1', idempotencyKey: key, approve: true, readyX3: true,
      payload: expect.objectContaining({
        payloadRevision: post.lastEditedTime,
        browserPayload: expect.objectContaining({
          scheduledDate: future, targetPublishAt: future, timingMode: 'scheduled',
          mediaAssets: [expect.objectContaining({ deliveryUrl: post.videoUrls[0], mediaType: 'video' })],
          coverAsset: expect.objectContaining({ deliveryUrl: post.thumbnailUrl, role: 'cover' }),
        }),
      }),
    }));
  });

  it('freezes Post now as immediate action while retaining the editorial schedule', async () => {
    attempt.supersede.mockResolvedValue(false);
    attempt.create.mockResolvedValue({ attempt: { id: 'attempt-now' }, created: true });
    const dependencies = {
      getPost: vi.fn().mockResolvedValue(post),
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ job: stored, created: true }),
    };

    await expect(queueLocalPublishJob(
      { ...body, mode: 'publish' },
      `${key}-post-now`,
      'workspace-1',
      dependencies,
    )).resolves.toMatchObject({ attempt: { id: 'attempt-now' } });

    expect(attempt.supersede).toHaveBeenCalledWith(
      'workspace-1',
      expect.objectContaining({ publishAt: future }),
      'post_now',
    );
    expect(attempt.create).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        browserPayload: expect.objectContaining({
          scheduledDate: future,
          timingMode: 'post_now',
          coverAsset: expect.objectContaining({ deliveryUrl: post.thumbnailUrl }),
        }),
      }),
    }));
    const targetPublishAt = attempt.create.mock.calls[0][0].payload.browserPayload.targetPublishAt;
    expect(targetPublishAt).not.toBe(future);
  });

  it('rejects a replay whose Ready x3 consent differs from the original request', async () => {
    attempt.get.mockResolvedValue({ readyX3Authorization: { kind: 'ready_x3' } });
    await expect(queueLocalPublishJob(
      { ...body, consent: undefined },
      key,
      'workspace-1',
      {
        getPost: vi.fn(),
        findByIdempotencyKey: vi.fn().mockResolvedValue(stored),
        insert: vi.fn(),
      },
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('preserves optional identity evidence and enters verification on schedule mismatch', async () => {
    attempt.get.mockResolvedValue({
      payload: {
        expectedAccountId: stored.snapshot.expectedAccountId,
        targetPublishAt: future,
      },
    });
    attempt.recordOutcome.mockResolvedValue(undefined);
    const recordScheduledAcknowledgement = vi.fn().mockResolvedValue({
      ...stored,
      status: 'verification_pending',
      noteId: 'scheduled-note-1',
      receiptOutcome: 'scheduled',
      authenticatedAccountId: stored.snapshot.expectedAccountId,
      errorCode: 'SCHEDULE_READBACK_MISMATCH',
    });

    await expect(submitLocalPublishJobResult(
      stored.id,
      '55555555-5555-4555-8555-555555555555',
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: 'scheduled',
        scheduledFor: '2099-08-04T13:31:00.000Z',
        acknowledgedAt: '2099-08-01T12:00:00.000Z',
        authenticatedAccount: {
          accountId: stored.snapshot.expectedAccountId,
          capturedAt: '2099-08-01T11:59:00.000Z',
          ownership: 'owned',
        },
        noteId: 'scheduled-note-1',
      },
      'workspace-1',
      {
        stage: vi.fn(),
        recordDispatch: vi.fn(),
        deferVerification: vi.fn(),
        fail: vi.fn(),
        prepareVerification: vi.fn(),
        completeReconciliation: vi.fn(),
        backfill: vi.fn(),
        recordScheduledAcknowledgement,
      },
    )).resolves.toMatchObject({
      status: 'verification_pending',
      noteId: 'scheduled-note-1',
      errorCode: 'SCHEDULE_READBACK_MISMATCH',
    });
    expect(attempt.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'outcome_unknown',
      receipt: expect.objectContaining({
        rednoteNoteId: 'scheduled-note-1',
        platformPublishTime: '2099-08-01T12:00:00.000Z',
      }),
    }));
    expect(recordScheduledAcknowledgement).toHaveBeenCalledWith(
      stored.id,
      '55555555-5555-4555-8555-555555555555',
      expect.objectContaining({
        noteId: 'scheduled-note-1',
        accountId: stored.snapshot.expectedAccountId,
      }),
      'workspace-1',
      false,
    );
  });

  it('repairs a matching Ready x3 job when attempt creation previously failed', async () => {
    attempt.get.mockRejectedValueOnce(new LocalPublishJobError(
      'The local job is missing its durable publishing attempt',
      'ATTEMPT_NOT_FOUND',
      409,
    ));
    attempt.create.mockResolvedValueOnce({
      attempt: { id: 'repaired-attempt', readyX3Authorization: { kind: 'ready_x3' } },
      created: true,
    });

    await expect(queueLocalPublishJob(
      body,
      key,
      'workspace-1',
      {
        getPost: vi.fn(),
        findByIdempotencyKey: vi.fn().mockResolvedValue({
          ...stored,
          snapshot: { ...stored.snapshot, automationConsent: 'ready_x3' },
        }),
        insert: vi.fn(),
      },
    )).resolves.toMatchObject({
      created: false,
      attempt: { id: 'repaired-attempt' },
    });
    expect(attempt.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      idempotencyKey: key,
      approve: true,
      readyX3: true,
      payload: expect.objectContaining({
        sourceLocalPublishJobId: stored.id,
        payloadRevision: stored.snapshot.notionLastEditedTime,
      }),
    }));
  });

  it('does not repair a missing legacy attempt as Ready x3', async () => {
    attempt.get.mockRejectedValueOnce(new LocalPublishJobError(
      'The local job is missing its durable publishing attempt',
      'ATTEMPT_NOT_FOUND',
      409,
    ));

    await expect(queueLocalPublishJob(
      body,
      key,
      'workspace-1',
      {
        getPost: vi.fn(),
        findByIdempotencyKey: vi.fn().mockResolvedValue(stored),
        insert: vi.fn(),
      },
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(attempt.create).not.toHaveBeenCalled();
  });
});