import { describe, expect, it, vi } from 'vitest';
import {
  parseLocalPublishWorkerResult,
  parseQueueLocalPublishInput,
  queueLocalPublishJob,
  submitLocalPublishJobResult,
  type StoredLocalPublishJob,
} from '@/lib/local-publish-jobs';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';
import type { ReadyXhsPost } from '@/types/ready-post';

const snapshot: LocalPublishSnapshot = {
  notionPageId: '11111111-1111-4111-8111-111111111111',
  headline: 'Headline',
  title: 'Final title',
  caption: 'Final caption',
  tags: ['Tag'],
  platform: 'RedNote',
  mediaType: 'video',
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
  publishAt: '2026-08-04T13:30:00.000Z',
  notionLastEditedTime: '2026-08-01T12:00:00.000Z',
};

function stored(status: StoredLocalPublishJob['status']): StoredLocalPublishJob {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    notionPageId: snapshot.notionPageId,
    snapshot,
    status,
    claimToken: '33333333-3333-4333-8333-333333333333',
    ...(status === 'submitted' ||
    status === 'scheduled' ||
    status === 'verification_pending' ||
    status === 'verified' ||
    status === 'reconciled'
      ? {
          noteId: 'note_123',
          shareUrl: 'https://www.rednote.com/explore/note_123',
        }
      : {}),
    verificationAttempts: status === 'verification_pending' ? 1 : 0,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
  };
}

function readyPost(): ReadyXhsPost {
  return {
    id: snapshot.notionPageId,
    pageUrl: 'https://notion.so/post',
    headline: snapshot.headline,
    caption: snapshot.caption,
    status: 'Ready',
    candidateKind: 'packet_ready',
    publishPacketReady: true,
    hasVideo: true,
    needsMedia: false,
    needsCaption: false,
    mediaUrls: [snapshot.mediaUrl],
    imageUrls: [],
    videoUrls: [snapshot.mediaUrl],
    thumbnailUrl: '',
    tags: snapshot.tags,
    publishAt: snapshot.publishAt,
    scheduledDate: null,
    lastEditedTime: snapshot.notionLastEditedTime,
    automationBlockers: [],
    manualWarnings: [],
    publishBlockers: [],
  };
}

const queueBody = {
  notionPageId: snapshot.notionPageId,
  lastEditedTime: snapshot.notionLastEditedTime,
  confirmed: true,
  title: snapshot.title,
  caption: snapshot.caption,
  tags: snapshot.tags,
  media: { type: 'video', index: 0 },
};

describe('local publish job orchestration', () => {
  it('parses only explicit Ready x3 consent', () => {
    expect(parseQueueLocalPublishInput({ ...queueBody, consent: 'ready_x3' }))
      .toMatchObject({ consent: 'ready_x3' });
    expect(() => parseQueueLocalPublishInput({ ...queueBody, consent: 'always' }))
      .toThrow('consent must be ready_x3');
  });

  it('passes the same idempotency key through repeat queue requests', async () => {
    const getPost = vi.fn().mockResolvedValue(readyPost());
    const findByIdempotencyKey = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stored('queued'));
    const insert = vi.fn().mockResolvedValue({ job: stored('queued'), created: true });
    const dependencies = { getPost, findByIdempotencyKey, insert };
    const key = '44444444-4444-4444-8444-444444444444';

    await expect(queueLocalPublishJob(queueBody, key, dependencies))
      .resolves.toMatchObject({ created: true });
    await expect(queueLocalPublishJob(queueBody, key, dependencies))
      .resolves.toMatchObject({ created: false });
    expect(insert).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(expect.any(Object), key);
    expect(getPost).toHaveBeenCalledOnce();
  });

  it('does not reuse a normal idempotency request for a MOV trial', async () => {
    const getPost = vi.fn();
    const findByIdempotencyKey = vi.fn().mockResolvedValue(stored('queued'));
    const insert = vi.fn();

    await expect(queueLocalPublishJob(
      { ...queueBody, compatibilityTrialConfirmed: true },
      '44444444-4444-4444-8444-444444444444',
      { getPost, findByIdempotencyKey, insert },
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(getPost).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('keeps an identical retry idempotent without replacing its frozen snapshot', async () => {
    const getPost = vi.fn().mockResolvedValue({
      ...readyPost(),
      lastEditedTime: '2026-08-01T13:00:00.000Z',
    });
    const findByIdempotencyKey = vi.fn().mockResolvedValue(stored('queued'));
    const insert = vi.fn();

    await expect(queueLocalPublishJob(
      queueBody,
      '44444444-4444-4444-8444-444444444444',
      { getPost, findByIdempotencyKey, insert },
    )).resolves.toMatchObject({ created: false });
    expect(getPost).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('keeps an identical legacy hashtag fallback retry idempotent', async () => {
    const legacySnapshot = {
      ...snapshot,
      caption: 'Body copy',
      tags: ['Legacy'],
    };
    const getPost = vi.fn();
    const findByIdempotencyKey = vi.fn().mockResolvedValue({
      ...stored('queued'),
      snapshot: legacySnapshot,
    });
    const insert = vi.fn();
    const body = {
      ...queueBody,
      caption: 'Body copy\n\n#Legacy',
      tags: [],
    };

    await expect(queueLocalPublishJob(
      body,
      '44444444-4444-4444-8444-444444444444',
      { getPost, findByIdempotencyKey, insert },
    )).resolves.toMatchObject({ created: false });
    expect(getPost).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('re-fetches Notion and rejects drift before creating a new job', async () => {
    const getPost = vi.fn().mockResolvedValue({
      ...readyPost(),
      lastEditedTime: '2026-08-01T13:00:00.000Z',
    });
    const findByIdempotencyKey = vi.fn().mockResolvedValue(null);
    const insert = vi.fn();

    await expect(queueLocalPublishJob(
      queueBody,
      '55555555-5555-4555-8555-555555555555',
      { getPost, findByIdempotencyKey, insert },
    )).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    expect(getPost).toHaveBeenCalledWith(snapshot.notionPageId);
    expect(insert).not.toHaveBeenCalled();
  });

  it('normalizes a matching RedNote explore URL to its query-free canonical form', () => {
    expect(parseLocalPublishWorkerResult({
      status: 'succeeded',
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123/?source=worker#receipt',
    })).toEqual({
      status: 'verified',
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
    });
    expect(() => parseLocalPublishWorkerResult({
      status: 'succeeded',
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/other',
    })).toThrow('must match');
    expect(() => parseLocalPublishWorkerResult({
      status: 'succeeded',
      noteId: 'note_123',
      shareUrl: 'https://rednote.com/explore/note_123',
    })).toThrow('must match');
    expect(parseLocalPublishWorkerResult({
      status: 'published',
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
    })).toMatchObject({ status: 'verified' });
  });

  it('rejects credential-like failure details before persistence', () => {
    expect(parseLocalPublishWorkerResult({
      status: 'failed',
      code: 'READY_X3_LATE_FALLBACK_DENIED',
      message: 'Ready ×3 authorization does not permit Post now at this time',
    })).toEqual({
      status: 'failed',
      code: 'READY_X3_LATE_FALLBACK_DENIED',
      message: 'Ready ×3 authorization does not permit Post now at this time',
    });
    expect(() => parseLocalPublishWorkerResult({
      status: 'failed',
      code: 'UPSTREAM_REJECTED',
      message: 'Authorization: Bearer raw-upstream-credential',
    })).toThrow('credential-like data');
    expect(() => parseLocalPublishWorkerResult({
      status: 'failed',
      code: 'UPSTREAM_REJECTED',
      message: 'Creator returned https://internal.example/error',
    })).toThrow('credential-like data');
  });

  it('uses a distinct identity-free deferral only for attested verification', async () => {
    expect(parseLocalPublishWorkerResult({
      status: 'attested_verification_pending',
      code: 'PUBLIC_NOTE_NOT_FOUND',
      message: 'The scheduled post is not public yet',
    })).toEqual({
      status: 'attested_verification_pending',
      code: 'PUBLIC_NOTE_NOT_FOUND',
      message: 'The scheduled post is not public yet',
    });

    const deferAttestedVerification = vi.fn().mockResolvedValue(
      stored('operator_attested'),
    );
    await expect(submitLocalPublishJobResult(
      stored('operator_attested').id,
      stored('operator_attested').claimToken!,
      {
        status: 'attested_verification_pending',
        code: 'PUBLIC_NOTE_NOT_FOUND',
        message: 'The scheduled post is not public yet',
      },
      {
        stage: vi.fn(),
        recordDispatch: vi.fn(),
        deferVerification: vi.fn(),
        deferAttestedVerification,
        fail: vi.fn(),
        prepareVerification: vi.fn(),
        completeReconciliation: vi.fn(),
        backfill: vi.fn(),
      },
    )).resolves.toMatchObject({ status: 'operator_attested' });
    expect(deferAttestedVerification).toHaveBeenCalledOnce();
  });

  it('reconciles a later exact identity without reopening dispatch', async () => {
    const dependencies = {
      stage: vi.fn(),
      recordDispatch: vi.fn(),
      deferVerification: vi.fn(),
      deferAttestedVerification: vi.fn(),
      fail: vi.fn(),
      prepareVerification: vi.fn().mockResolvedValue(stored('verified')),
      completeReconciliation: vi.fn().mockResolvedValue(stored('reconciled')),
      backfill: vi.fn(),
    };
    await expect(submitLocalPublishJobResult(
      stored('operator_attested').id,
      stored('operator_attested').claimToken!,
      {
        status: 'verified',
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
      },
      dependencies,
    )).resolves.toMatchObject({ status: 'reconciled' });
    expect(dependencies.prepareVerification).toHaveBeenCalledOnce();
    expect(dependencies.backfill).toHaveBeenCalledOnce();
    expect(dependencies.completeReconciliation).toHaveBeenCalledOnce();
    expect(dependencies.stage).not.toHaveBeenCalled();
    expect(dependencies.recordDispatch).not.toHaveBeenCalled();
  });

  it('reconciles an immediate submitted receipt against the frozen notionPageId', async () => {
    const prepared = {
      ...stored('verified'),
      dispatchedAt: '2026-08-01T12:15:00.000Z',
    };
    const dependencies = {
      stage: vi.fn(),
      recordDispatch: vi.fn().mockResolvedValue({
        ...stored('submitted'),
        dispatchedAt: prepared.dispatchedAt,
      }),
      deferVerification: vi.fn().mockResolvedValue(stored('verification_pending')),
      fail: vi.fn(),
      prepareVerification: vi.fn().mockResolvedValue(prepared),
      completeReconciliation: vi.fn().mockResolvedValue(stored('reconciled')),
      backfill: vi.fn().mockResolvedValue(undefined),
    };

    await expect(submitLocalPublishJobResult(
      stored('claimed').id,
      stored('claimed').claimToken!,
      {
        status: 'submitted',
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
      },
      dependencies,
    )).resolves.toMatchObject({ status: 'reconciled' });
    expect(dependencies.recordDispatch).toHaveBeenCalledWith(
      stored('claimed').id,
      stored('claimed').claimToken,
      'submitted',
      'note_123',
      'https://www.rednote.com/explore/note_123',
      900,
    );
    expect(dependencies.backfill).toHaveBeenCalledWith(snapshot.notionPageId, {
      status: 'success',
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
    }, prepared.dispatchedAt);
  });

  it('keeps scheduled acceptance pending until publication is verified', async () => {
    const scheduled = {
      ...stored('scheduled'),
      snapshot: {
        ...snapshot,
        publishAt: '2026-08-04T13:30:00.000Z',
      },
    };
    const dependencies = {
      stage: vi.fn(),
      recordDispatch: vi.fn().mockResolvedValue(scheduled),
      deferVerification: vi.fn(),
      fail: vi.fn(),
      prepareVerification: vi.fn(),
      completeReconciliation: vi.fn(),
      backfill: vi.fn(),
    };
    await expect(submitLocalPublishJobResult(
      stored('claimed').id,
      stored('claimed').claimToken!,
      {
        status: 'scheduled',
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
      },
      dependencies,
    )).resolves.toMatchObject({ status: 'scheduled' });
    expect(dependencies.prepareVerification).not.toHaveBeenCalled();
    expect(dependencies.backfill).not.toHaveBeenCalled();

    dependencies.recordDispatch.mockResolvedValueOnce({
      ...scheduled,
      status: 'verification_pending',
    });
    await expect(submitLocalPublishJobResult(
      scheduled.id,
      scheduled.claimToken!,
      {
        status: 'submitted',
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
      },
      dependencies,
    )).resolves.toMatchObject({ status: 'verification_pending' });
    expect(dependencies.prepareVerification).not.toHaveBeenCalled();
    expect(dependencies.backfill).not.toHaveBeenCalled();
  });

  it('defers uncertain post-dispatch verification without another Notion effect', async () => {
    const dependencies = {
      stage: vi.fn(),
      recordDispatch: vi.fn(),
      deferVerification: vi.fn().mockResolvedValue(stored('verification_pending')),
      fail: vi.fn(),
      prepareVerification: vi.fn(),
      completeReconciliation: vi.fn(),
      backfill: vi.fn(),
    };
    await expect(submitLocalPublishJobResult(
      stored('submitted').id,
      stored('submitted').claimToken!,
      {
        status: 'verification_pending',
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
        code: 'REDNOTE_300031',
        message: 'RedNote is still processing the public post',
      },
      dependencies,
    )).resolves.toMatchObject({ status: 'verification_pending' });
    expect(dependencies.deferVerification).toHaveBeenCalledWith(
      stored('submitted').id,
      stored('submitted').claimToken,
      'note_123',
      'https://www.rednote.com/explore/note_123',
      'REDNOTE_300031',
      'RedNote is still processing the public post',
      [900, 3_600, 21_600, 86_400],
    );
    expect(dependencies.backfill).not.toHaveBeenCalled();
  });

  it('backfills Notion only after preparing a verified transition', async () => {
    const prepared = {
      ...stored('verified'),
      dispatchedAt: '2026-08-01T12:15:00.000Z',
      verifiedAt: '2026-08-01T12:30:00.000Z',
    };
    const completed = stored('reconciled');
    const dependencies = {
      stage: vi.fn(),
      recordDispatch: vi.fn(),
      deferVerification: vi.fn(),
      fail: vi.fn(),
      prepareVerification: vi.fn().mockResolvedValue(prepared),
      completeReconciliation: vi.fn().mockResolvedValue(completed),
      backfill: vi.fn().mockResolvedValue(undefined),
    };
    const result = {
      status: 'verified',
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
    };

    await expect(submitLocalPublishJobResult(
      prepared.id,
      prepared.claimToken!,
      result,
      dependencies,
    )).resolves.toMatchObject({ status: 'reconciled', noteId: 'note_123' });
    expect(dependencies.prepareVerification.mock.invocationCallOrder[0])
      .toBeLessThan(dependencies.backfill.mock.invocationCallOrder[0]);
    expect(dependencies.backfill).toHaveBeenCalledWith(snapshot.notionPageId, {
      status: 'success',
      noteId: 'note_123',
      shareUrl: result.shareUrl,
    }, prepared.verifiedAt);
    expect(dependencies.completeReconciliation.mock.invocationCallOrder[0])
      .toBeGreaterThan(dependencies.backfill.mock.invocationCallOrder[0]);
  });

  it('never backfills failures and leaves backfill errors verified', async () => {
    const failedDependencies = {
      stage: vi.fn(),
      recordDispatch: vi.fn(),
      deferVerification: vi.fn(),
      fail: vi.fn().mockResolvedValue(stored('failed')),
      prepareVerification: vi.fn(),
      completeReconciliation: vi.fn(),
      backfill: vi.fn(),
    };
    await submitLocalPublishJobResult(
      stored('claimed').id,
      stored('claimed').claimToken!,
      { status: 'failed', code: 'STAGING_DISCARDED', message: 'Operator discarded staging' },
      failedDependencies,
    );
    expect(failedDependencies.backfill).not.toHaveBeenCalled();

    const successDependencies = {
      stage: vi.fn(),
      recordDispatch: vi.fn().mockResolvedValue(stored('submitted')),
      deferVerification: vi.fn(),
      fail: vi.fn(),
      prepareVerification: vi.fn().mockResolvedValue(stored('verified')),
      completeReconciliation: vi.fn(),
      backfill: vi.fn().mockRejectedValue(new Error('Notion unavailable')),
    };
    await expect(submitLocalPublishJobResult(
      stored('claimed').id,
      stored('claimed').claimToken!,
      {
        status: 'submitted',
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
      },
      successDependencies,
    )).rejects.toMatchObject({ code: 'NOTION_BACKFILL_FAILED' });
    expect(successDependencies.completeReconciliation).not.toHaveBeenCalled();
  });

  it('treats an identical reconciled verification report as idempotent', async () => {
    const dependencies = {
      stage: vi.fn(),
      recordDispatch: vi.fn(),
      deferVerification: vi.fn(),
      fail: vi.fn(),
      prepareVerification: vi.fn().mockResolvedValue(stored('reconciled')),
      completeReconciliation: vi.fn(),
      backfill: vi.fn(),
    };
    await expect(submitLocalPublishJobResult(
      stored('reconciled').id,
      stored('reconciled').claimToken!,
      {
        status: 'succeeded',
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
      },
      dependencies,
    )).resolves.toMatchObject({ status: 'reconciled' });
    expect(dependencies.backfill).not.toHaveBeenCalled();
    expect(dependencies.completeReconciliation).not.toHaveBeenCalled();
  });

  it('treats an identical reconciled submitted retry as idempotent', async () => {
    const dependencies = {
      stage: vi.fn(),
      recordDispatch: vi.fn().mockResolvedValue(stored('reconciled')),
      deferVerification: vi.fn(),
      fail: vi.fn(),
      prepareVerification: vi.fn(),
      completeReconciliation: vi.fn(),
      backfill: vi.fn(),
    };
    await expect(submitLocalPublishJobResult(
      stored('reconciled').id,
      stored('reconciled').claimToken!,
      {
        status: 'submitted',
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
      },
      dependencies,
    )).resolves.toMatchObject({ status: 'reconciled' });
    expect(dependencies.prepareVerification).not.toHaveBeenCalled();
    expect(dependencies.backfill).not.toHaveBeenCalled();
    expect(dependencies.completeReconciliation).not.toHaveBeenCalled();
  });
});
