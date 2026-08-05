import { describe, expect, it } from 'vitest';
import {
  buildBatchCandidateAccounting,
  buildBatchItems,
  dueSweepKinds,
  manifestHash,
  MAX_LATE_SECONDS,
  weeklyWindow,
} from '@/lib/rednote-publish-batches';
import type { ReadyXhsPost } from '@/types/ready-post';
import type { LocalPublishJobSummary } from '@/types/local-publish-job';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';

function post(
  publishAt?: string,
  overrides: Partial<ReadyXhsPost> = {},
): ReadyXhsPost {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    pageUrl: 'https://notion.so/post',
    headline: 'Frozen title',
    caption: 'Frozen caption',
    status: 'Ready',
    candidateKind: 'packet_ready',
    publishPacketReady: true,
    hasVideo: true,
    needsMedia: false,
    needsCaption: false,
    mediaUrls: ['https://images.xhs.justlikekatie.com/videos/assets/post.mp4'],
    imageUrls: [],
    videoUrls: ['https://images.xhs.justlikekatie.com/videos/assets/post.mp4'],
    thumbnailUrl: '',
    tags: ['FrozenTag'],
    ...(publishAt ? { publishAt } : {}),
    scheduledDate: publishAt ?? null,
    lastEditedTime: '2026-08-04T12:00:00.000Z',
    publishBlockers: [],
    ...overrides,
  };
}

function localJob(
  notionPageId: string,
  status: LocalPublishJobSummary['status'],
  id: string,
): LocalPublishJobSummary {
  return {
    id,
    notionPageId,
    status,
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
    verificationAttempts: 0,
  };
}

describe('bounded RedNote publish batches', () => {
  it('hashes canonical object content independent of key insertion order', () => {
    expect(manifestHash({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(manifestHash({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('hashes the canonical media type and URL identity', () => {
    expect(rednoteMediaIdentity({
      type: 'video',
      url: 'https://media.example/post.mp4',
    })).toBe('6ca2ae08e649315bda395c0f4bed4dcc7051b9619a7b3803e6b290e4c664f520');
  });

  it('requires an exact publish time and makes <=24h late conversion explicit', () => {
    const now = new Date('2026-08-04T13:00:00.000Z');
    expect(buildBatchItems([post()], 'bootstrap', now)).toEqual([]);
    expect(buildBatchItems(
      [post('2026-08-04T12:00:01.000Z')],
      'bootstrap',
      now,
    )).toEqual([]);
    expect(buildBatchItems(
      [post('2026-08-04T12:00:00.000Z')],
      'bootstrap',
      now,
    )[0]).toMatchObject({
      dispatchMode: 'post_now',
      lateBySeconds: 3_600,
      snapshot: { title: 'Frozen title' },
    });

    expect(buildBatchItems(
      [post(new Date(now.getTime() - (MAX_LATE_SECONDS + 1) * 1000).toISOString())],
      'bootstrap',
      now,
    )).toEqual([]);
  });

  it('leaves unrelated untimed Posts unchanged and outside every dispatch batch', () => {
    const now = new Date('2026-08-04T13:00:00.000Z');
    const untimed = post(undefined, {
      id: '22222222-2222-4222-8222-222222222222',
      headline: 'Planning without a publish time',
    });
    const before = structuredClone(untimed);
    const timed = post('2026-08-04T14:00:00.000Z');

    expect(buildBatchItems([untimed, timed], 'bootstrap', now)).toEqual([
      expect.objectContaining({ notionPageId: timed.id }),
    ]);
    expect(untimed).toEqual(before);
  });

  it('accounts for a late bootstrap item and visibly blocks a trial-only MOV sibling', () => {
    const now = new Date('2026-08-04T14:04:00.000Z');
    const day3 = post('2026-08-04T13:30:00.000Z', {
      id: '33333333-3333-4333-8333-333333333333',
      headline: 'Day 3',
    });
    const movUrl = 'https://images.xhs.justlikekatie.com/videos/assets/day-4.mov';
    const day4 = post('2026-08-06T02:30:00.000Z', {
      id: '44444444-4444-4444-8444-444444444444',
      headline: 'Day 4',
      mediaUrls: [movUrl],
      videoUrls: [],
      compatibilityTrialVideoUrls: [movUrl],
      candidateKind: 'packet_ready',
    });

    const accounting = buildBatchCandidateAccounting([day3, day4], 'bootstrap', now);
    expect(accounting.items).toHaveLength(1);
    expect(accounting.items[0]).toMatchObject({
      notionPageId: day3.id,
      dispatchMode: 'post_now',
    });
    expect(accounting.blockedCandidates).toEqual([expect.objectContaining({
      notionPageId: day4.id,
      headline: 'Day 4',
      publishAt: '2026-08-06T02:30:00.000Z',
      reason: expect.stringMatching(
        /no authoritative RedNote-compatible verdict.*Attach canonical MP4.*authoritative RedNote compatibility certification.*extension or container alone/i,
      ),
    })]);
  });

  it('fails closed for the live bootstrap ownership and Published cases', () => {
    const now = new Date('2026-08-04T14:04:00.000Z');
    const scheduled = post('2026-08-04T15:00:00.000Z', {
      id: '11111111-1111-4111-8111-111111111111',
      headline: '他真的很像童话里的王子',
    });
    const submitted = post('2026-08-04T16:00:00.000Z', {
      id: '22222222-2222-4222-8222-222222222222',
      headline: '今日氛围格子：刘学义 / 源仲 / 老公',
    });
    const published = post('2026-08-04T17:00:00.000Z', {
      id: '33333333-3333-4333-8333-333333333333',
      headline: 'Canonical published record',
      status: 'Published',
    });
    const eligibleSibling = post('2026-08-04T18:00:00.000Z', {
      id: '44444444-4444-4444-8444-444444444444',
      headline: 'Eligible sibling',
    });

    const accounting = buildBatchCandidateAccounting(
      [scheduled, submitted, published, eligibleSibling],
      'bootstrap',
      now,
      [
        localJob(scheduled.id, 'scheduled', 'job-scheduled'),
        localJob(submitted.id, 'submitted', 'job-submitted'),
      ],
    );

    expect(accounting.items.map((item) => item.notionPageId))
      .toEqual([eligibleSibling.id]);
    expect(accounting.blockedCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        notionPageId: scheduled.id,
        reason: expect.stringMatching(/job-scheduled is scheduled.*do not publish it again/i),
      }),
      expect.objectContaining({
        notionPageId: submitted.id,
        reason: expect.stringMatching(/job-submitted is submitted.*do not publish it again/i),
      }),
      expect.objectContaining({
        notionPageId: published.id,
        reason: expect.stringMatching(/Status is Published.*not authorized/i),
      }),
    ]));
  });

  it('computes the next Monday-Sunday window across New York DST', () => {
    const standard = weeklyWindow(new Date('2026-01-04T23:00:00.000Z'));
    expect(standard).toEqual({
      start: new Date('2026-01-05T05:00:00.000Z'),
      end: new Date('2026-01-12T05:00:00.000Z'),
    });
    const daylight = weeklyWindow(new Date('2026-08-02T22:00:00.000Z'));
    expect(daylight).toEqual({
      start: new Date('2026-08-03T04:00:00.000Z'),
      end: new Date('2026-08-10T04:00:00.000Z'),
    });
  });

  it('recognizes DST-safe local sweep hours', () => {
    expect(dueSweepKinds(new Date('2026-08-02T22:00:00.000Z')))
      .toEqual(['weekly']);
    expect(dueSweepKinds(new Date('2026-12-01T13:00:00.000Z')))
      .toEqual(['daily']);
    expect(dueSweepKinds(new Date('2026-12-01T12:00:00.000Z')))
      .toEqual([]);
  });
});
