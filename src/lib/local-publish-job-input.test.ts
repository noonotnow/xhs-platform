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
    candidateKind: 'packet_ready',
    publishPacketReady: true,
    hasVideo: true,
    needsMedia: false,
    needsCaption: false,
    mediaUrls: ['https://images.xhs.justlikekatie.com/videos/assets/post.mp4'],
    imageUrls: ['https://images.xhs.justlikekatie.com/uploads/post.jpg'],
    videoUrls: ['https://images.xhs.justlikekatie.com/videos/assets/post.mp4'],
    thumbnailUrl: 'https://images.xhs.justlikekatie.com/uploads/thumb.jpg',
    tags: ['Notion'],
    publishAt: '2026-08-04T13:30:00.000Z',
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
      publishAt: '2026-08-04T13:30:00.000Z',
      notionLastEditedTime: readyPost().lastEditedTime,
    });
    expect(snapshot.mediaUrl).not.toContain('attacker.example');
  });

  it('keeps legacy fallback hashtags out of the frozen body caption', () => {
    const parsed = parseQueueLocalPublishInput(input({
      caption: 'Body copy\n\n#Legacy #旧标签',
      tags: [],
    }));
    const snapshot = buildLocalPublishSnapshot(readyPost({
      caption: 'Body copy',
      tags: ['Legacy', '旧标签'],
      tagsSource: 'legacy-caption',
    }), parsed);

    expect(snapshot.caption).toBe('Body copy');
    expect(snapshot.tags).toEqual(['Legacy', '旧标签']);
  });

  it('omits publishAt only when ScheduledDate is absent', () => {
    const parsed = parseQueueLocalPublishInput(input());
    expect(buildLocalPublishSnapshot(
      readyPost({ publishAt: undefined }),
      parsed,
    )).not.toHaveProperty('publishAt');
    expect(buildLocalPublishSnapshot(readyPost(), parsed).publishAt)
      .toBe('2026-08-04T13:30:00.000Z');
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
      candidateKind: 'mov_compatibility_trial',
      publishPacketReady: false,
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

  it('queues an eligible MOV trial even when a distinct canonical JPG cover is attached', () => {
    const movUrl = 'https://images.xhs.justlikekatie.com/videos/assets/post.mov';
    const coverUrl = 'https://images.xhs.justlikekatie.com/uploads/post-cover.jpg';
    const parsed = parseQueueLocalPublishInput(input({
      compatibilityTrialConfirmed: true,
    }));

    expect(buildLocalPublishSnapshot(readyPost({
      candidateKind: 'mov_compatibility_trial',
      publishPacketReady: false,
      needsMedia: true,
      mediaUrls: [movUrl, coverUrl],
      imageUrls: [coverUrl],
      videoUrls: [],
      compatibilityTrialVideoUrls: [movUrl],
      publishBlockers: [
        'Needs media is still checked',
        'No canonical HTTPS Rednote media is attached',
      ],
    }), parsed)).toMatchObject({
      mediaUrl: movUrl,
      compatibilityTrial: 'unverified_mov',
    });
  });

  it('rejects MOV trials without the separate flag or with unrelated blockers', () => {
    const movUrl = 'https://images.xhs.justlikekatie.com/videos/assets/post.mov';
    const trialPost = readyPost({
      candidateKind: 'mov_compatibility_trial',
      publishPacketReady: false,
      needsMedia: true,
      mediaUrls: [movUrl],
      videoUrls: [],
      compatibilityTrialVideoUrls: [movUrl],
      publishBlockers: [
        'Needs media is still checked',
        'No canonical HTTPS Rednote media is attached',
      ],
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

  it('does not reinterpret a packet-ready record as a MOV trial', () => {
    const movUrl = 'https://images.xhs.justlikekatie.com/videos/assets/post.mov';
    expect(() => buildLocalPublishSnapshot(readyPost({
      mediaUrls: [movUrl],
      videoUrls: [],
      compatibilityTrialVideoUrls: [movUrl],
      needsMedia: true,
      publishBlockers: [
        'Needs media is still checked',
        'No canonical HTTPS Rednote media is attached',
      ],
    }), parseQueueLocalPublishInput(input({
      compatibilityTrialConfirmed: true,
    })))).toThrow('narrow media-only MOV trial state');
  });

  it('rejects untrusted and non-MOV trial media', () => {
    const parsed = parseQueueLocalPublishInput(input({
      compatibilityTrialConfirmed: true,
    }));
    expect(() => buildLocalPublishSnapshot(readyPost({
      candidateKind: 'mov_compatibility_trial',
      publishPacketReady: false,
      needsMedia: true,
      compatibilityTrialVideoUrls: ['https://attacker.example/post.mov'],
      publishBlockers: [
        'Needs media is still checked',
        'No canonical HTTPS Rednote media is attached',
      ],
    }), parsed)).toThrow('trusted canonical HTTPS asset');
    expect(() => buildLocalPublishSnapshot(readyPost({
      candidateKind: 'mov_compatibility_trial',
      publishPacketReady: false,
      needsMedia: true,
      compatibilityTrialVideoUrls: [
        'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
      ],
      publishBlockers: [
        'Needs media is still checked',
        'No canonical HTTPS Rednote media is attached',
      ],
    }), parsed)).toThrow('trusted canonical HTTPS asset');
  });
});
