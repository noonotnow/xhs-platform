import { describe, expect, it } from 'vitest';
import {
  buildLocalPublishSnapshot,
  parseQueueLocalPublishInput,
} from '@/lib/local-publish-job-input';
import type { ReadyXhsPost } from '@/types/ready-post';

function readyPost(overrides: Partial<ReadyXhsPost> = {}): ReadyXhsPost {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    pageUrl: 'https://notion.so/post',
    headline: 'Server headline',
    caption: 'Notion caption',
    status: 'Ready',
    publishPacketReady: true,
    hasVideo: true,
    needsMedia: false,
    needsCaption: false,
    mediaUrls: ['https://images.xhs.justlikekatie.com/videos/assets/post.mp4'],
    imageUrls: ['https://images.xhs.justlikekatie.com/uploads/post.jpg'],
    videoUrls: ['https://images.xhs.justlikekatie.com/videos/assets/post.mp4'],
    thumbnailUrl: 'https://images.xhs.justlikekatie.com/uploads/thumb.jpg',
    tags: ['Notion'],
    scheduledDate: '2026-08-04',
    lastEditedTime: '2026-08-01T12:00:00.000Z',
    publishBlockers: [],
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    notionPageId: readyPost().id,
    lastEditedTime: readyPost().lastEditedTime,
    confirmed: true,
    title: 'Final title',
    caption: 'Final reviewed caption',
    tags: ['#BTS', 'Behind the scenes'],
    media: {
      type: 'video',
      index: 0,
      url: 'https://attacker.example/video.mp4',
    },
    ...overrides,
  };
}

describe('local publish job input', () => {
  it('builds an immutable snapshot using server-trusted media and Notion fields', () => {
    const parsed = parseQueueLocalPublishInput(input());
    const snapshot = buildLocalPublishSnapshot(readyPost(), parsed);

    expect(snapshot).toEqual({
      notionPageId: readyPost().id,
      headline: 'Server headline',
      title: 'Final title',
      caption: 'Final reviewed caption',
      tags: ['BTS', 'Behind the scenes'],
      platform: 'RedNote',
      mediaType: 'video',
      mediaIndex: 0,
      mediaUrl: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
      thumbnailUrl: 'https://images.xhs.justlikekatie.com/uploads/thumb.jpg',
      scheduledDate: '2026-08-04',
      notionLastEditedTime: readyPost().lastEditedTime,
    });
    expect(snapshot.mediaUrl).not.toContain('attacker.example');
  });

  it('revalidates the reviewed Notion version and readiness blockers', () => {
    const parsed = parseQueueLocalPublishInput(input());
    expect(() => buildLocalPublishSnapshot(
      readyPost({ lastEditedTime: '2026-08-01T13:00:00.000Z' }),
      parsed,
    )).toThrow('changed in Notion');
    expect(() => buildLocalPublishSnapshot(
      readyPost({ publishBlockers: ['Needs media is still checked'] }),
      parsed,
    )).toThrow('Needs media is still checked');
  });

  it('rejects an out-of-range or noncanonical media selection', () => {
    const parsed = parseQueueLocalPublishInput(input({
      media: { type: 'image', index: 0 },
    }));
    expect(() => buildLocalPublishSnapshot(
      readyPost({ imageUrls: ['https://example.com/post.jpg'] }),
      parsed,
    )).toThrow('trusted canonical HTTPS asset');
  });

  it('builds an explicitly confirmed unverified MOV trial snapshot', () => {
    const movUrl = 'https://images.xhs.justlikekatie.com/videos/assets/post.mov';
    const parsed = parseQueueLocalPublishInput(input({
      compatibilityTrialConfirmed: true,
    }));
    const snapshot = buildLocalPublishSnapshot(readyPost({
      mediaUrls: [movUrl],
      videoUrls: [],
      compatibilityTrialVideoUrls: [movUrl],
      needsMedia: true,
      publishBlockers: [
        'Needs media is still checked',
        'No canonical HTTPS Rednote media is attached',
      ],
    }), parsed);

    expect(snapshot).toMatchObject({
      mediaType: 'video',
      mediaUrl: movUrl,
      compatibilityTrial: 'unverified_mov',
    });
    expect(snapshot.thumbnailUrl).toBe(readyPost().thumbnailUrl);
  });

  it('rejects MOV trials without the separate flag or with unrelated blockers', () => {
    const movUrl = 'https://images.xhs.justlikekatie.com/videos/assets/post.mov';
    const trialPost = readyPost({
      mediaUrls: [movUrl],
      videoUrls: [],
      compatibilityTrialVideoUrls: [movUrl],
      publishBlockers: ['No canonical HTTPS Rednote media is attached'],
    });

    expect(() => buildLocalPublishSnapshot(
      trialPost,
      parseQueueLocalPublishInput(input()),
    )).toThrow('No canonical HTTPS Rednote media is attached');
    expect(() => buildLocalPublishSnapshot(
      {
        ...trialPost,
        publishBlockers: [
          ...trialPost.publishBlockers,
          'Weibo text is empty',
        ],
      },
      parseQueueLocalPublishInput(input({ compatibilityTrialConfirmed: true })),
    )).toThrow('Weibo text is empty');
  });

  it('rejects untrusted and non-MOV trial media', () => {
    const parsed = parseQueueLocalPublishInput(input({
      compatibilityTrialConfirmed: true,
    }));
    expect(() => buildLocalPublishSnapshot(readyPost({
      compatibilityTrialVideoUrls: ['https://attacker.example/post.mov'],
      publishBlockers: ['No canonical HTTPS Rednote media is attached'],
    }), parsed)).toThrow('trusted canonical HTTPS asset');
    expect(() => buildLocalPublishSnapshot(readyPost({
      compatibilityTrialVideoUrls: [
        'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
      ],
      publishBlockers: ['No canonical HTTPS Rednote media is attached'],
    }), parsed)).toThrow('trusted canonical HTTPS asset');
  });
});
