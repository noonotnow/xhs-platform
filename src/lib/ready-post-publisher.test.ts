import { describe, expect, it, vi } from 'vitest';
import {
  publishReadyPost,
  ReadyPostPublishError,
} from '@/lib/ready-post-publisher';
import type { ReadyXhsPost } from '@/types/ready-post';
import { XhsMicroserviceHttpError } from '@/lib/xhs-microservice';

function readyPost(overrides: Partial<ReadyXhsPost> = {}): ReadyXhsPost {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    pageUrl: 'https://notion.so/post',
    headline: 'Ready micropost',
    caption: 'Caption from CREATE',
    status: 'Ready',
    publishPacketReady: true,
    hasVideo: true,
    needsMedia: false,
    needsCaption: false,
    mediaUrls: ['https://images.xhs.justlikekatie.com/videos/assets/micropost.mp4'],
    imageUrls: [],
    videoUrls: ['https://images.xhs.justlikekatie.com/videos/assets/micropost.mp4'],
    thumbnailUrl: '',
    tags: ['BTS'],
    lastEditedTime: '2026-07-31T01:00:00.000Z',
    publishBlockers: [],
    ...overrides,
  };
}

function dependencies(post = readyPost()) {
  return {
    getPost: vi.fn().mockResolvedValue(post),
    publish: vi.fn().mockResolvedValue({
      status: 'success' as const,
      note_id: 'xhs-note',
      share_url: 'https://www.xiaohongshu.com/explore/xhs-note',
    }),
    backfill: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue(true),
    record: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ready post publishing', () => {
  it('requires explicit confirmation before reading or publishing', async () => {
    const deps = dependencies();
    await expect(publishReadyPost(
      readyPost().id,
      { confirmed: false, lastEditedTime: readyPost().lastEditedTime },
      deps,
    )).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', status: 400 });
    expect(deps.getPost).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('publishes the canonical video contract and backfills after success', async () => {
    const post = readyPost();
    const deps = dependencies(post);
    const result = await publishReadyPost(
      post.id,
      { confirmed: true, lastEditedTime: post.lastEditedTime },
      deps,
    );

    expect(deps.publish).toHaveBeenCalledWith({
      video_url: post.videoUrls[0],
      title: post.headline,
      caption: post.caption,
      tags: post.tags,
    });
    expect(result).toEqual({
      status: 'success',
      noteId: 'xhs-note',
      shareUrl: 'https://www.xiaohongshu.com/explore/xhs-note',
    });
    expect(deps.backfill).toHaveBeenCalledWith(post.id, result);
    expect(deps.record).toHaveBeenCalledWith(post.id, result);
  });

  it('rejects a concurrent or repeated publish before calling the microservice', async () => {
    const deps = dependencies();
    deps.claim.mockResolvedValue(false);

    await expect(publishReadyPost(
      readyPost().id,
      { confirmed: true, lastEditedTime: readyPost().lastEditedTime },
      deps,
    )).rejects.toMatchObject({ code: 'PUBLISH_ALREADY_CLAIMED', status: 409 });
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('releases the durable claim when the microservice rejects publishing', async () => {
    const deps = dependencies();
    deps.publish.mockRejectedValue(new XhsMicroserviceHttpError(409, 'XHS session expired'));

    await expect(publishReadyPost(
      readyPost().id,
      { confirmed: true, lastEditedTime: readyPost().lastEditedTime },
      deps,
    )).rejects.toThrow('XHS microservice request failed (409)');
    expect(deps.release).toHaveBeenCalledWith(readyPost().id);
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.backfill).not.toHaveBeenCalled();
  });

  it('preserves the claim when the publish outcome is ambiguous', async () => {
    const deps = dependencies();
    deps.publish.mockRejectedValue(new Error('connection reset'));

    await expect(publishReadyPost(
      readyPost().id,
      { confirmed: true, lastEditedTime: readyPost().lastEditedTime },
      deps,
    )).rejects.toThrow('connection reset');
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.backfill).not.toHaveBeenCalled();
  });

  it('does not backfill Notion for an invalid success-shaped response', async () => {
    const deps = dependencies();
    deps.publish.mockResolvedValue({
      status: 'success',
      note_id: '',
      share_url: '',
    });

    await expect(publishReadyPost(
      readyPost().id,
      { confirmed: true, lastEditedTime: readyPost().lastEditedTime },
      deps,
    )).rejects.toMatchObject({ code: 'INVALID_PUBLISH_RESPONSE' });
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.backfill).not.toHaveBeenCalled();
  });

  it('rejects a stale Notion record before calling the microservice', async () => {
    const deps = dependencies();
    await expect(publishReadyPost(
      readyPost().id,
      { confirmed: true, lastEditedTime: 'stale' },
      deps,
    )).rejects.toMatchObject({ code: 'EDIT_CONFLICT', status: 409 });
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('returns confirmed publish details when Notion backfill fails', async () => {
    const deps = dependencies();
    deps.backfill.mockRejectedValue(new Error('Notion unavailable'));

    try {
      await publishReadyPost(
        readyPost().id,
        { confirmed: true, lastEditedTime: readyPost().lastEditedTime },
        deps,
      );
      throw new Error('Expected publishReadyPost to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ReadyPostPublishError);
      expect(error).toMatchObject({
        code: 'NOTION_BACKFILL_FAILED',
        status: 502,
        published: {
          status: 'success',
          noteId: 'xhs-note',
          shareUrl: 'https://www.xiaohongshu.com/explore/xhs-note',
        },
      });
    }
  });
});
