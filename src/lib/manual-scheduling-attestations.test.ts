import { beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestHash } from '@/lib/rednote-publish-batches';

const mocks = vi.hoisted(() => ({
  getPost: vi.fn(),
  insert: vi.fn(),
  replay: vi.fn(),
}));

vi.mock('@/lib/notion-posts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/notion-posts')>();
  return { ...original, getReadyXhsPost: mocks.getPost };
});
vi.mock('@/lib/manual-scheduling-attestation-store', () => ({
  insertManualSchedulingAttestation: mocks.insert,
  loadManualSchedulingAttestationReplay: mocks.replay,
}));

import { createManualSchedulingAttestation } from '@/lib/manual-scheduling-attestations';

const post = {
  id: '44444444-4444-4444-8444-444444444444',
  pageUrl: 'https://notion.so/post',
  headline: 'Day 6',
  caption: 'Frozen caption',
  status: 'Ready',
  publishPacketReady: true,
  hasVideo: false,
  needsMedia: false,
  needsCaption: false,
  mediaUrls: ['https://images.xhs.justlikekatie.com/day6.png'],
  imageUrls: ['https://images.xhs.justlikekatie.com/day6.png'],
  videoUrls: [],
  thumbnailUrl: 'https://images.xhs.justlikekatie.com/day6.png',
  tags: ['day6'],
  scheduledDate: '2026-08-06T10:30:00-04:00',
  publishAt: '2026-08-06T14:30:00.000Z',
  lastEditedTime: '2026-08-04T13:12:00.000Z',
  publishBlockers: [],
  candidateKind: 'packet_ready' as const,
};
const snapshot = {
  notionPageId: post.id,
  headline: post.headline,
  title: post.headline,
  caption: post.caption,
  tags: post.tags,
  platform: 'RedNote' as const,
  mediaType: 'image' as const,
  mediaIndex: 0,
  mediaUrl: post.imageUrls[0],
  thumbnailUrl: post.thumbnailUrl,
  publishAt: post.publishAt,
  notionLastEditedTime: post.lastEditedTime,
};
const input = {
  notionPageId: post.id,
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  itemHash: manifestHash(snapshot),
  snapshotRevision: post.lastEditedTime,
  requestedPublishAt: post.publishAt,
  confirmed: true,
};

describe('manual scheduling attestation service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replay.mockResolvedValue(null);
    mocks.getPost.mockResolvedValue(post);
    mocks.insert.mockResolvedValue({ created: true, attestation: { id: 'receipt' } });
  });

  it('returns an exact durable replay without reading changed Notion state', async () => {
    mocks.replay.mockResolvedValue({
      created: false,
      attestation: { id: 'receipt', provenance: 'manual_scheduled' },
    });

    await expect(createManualSchedulingAttestation(
      input,
      '33333333-3333-4333-8333-333333333333',
      'operator@example.com',
    )).resolves.toMatchObject({ created: false });
    expect(mocks.getPost).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('reads Notion without mutating it and records the exact current packet', async () => {
    await expect(createManualSchedulingAttestation(
      input,
      '33333333-3333-4333-8333-333333333333',
      'operator@example.com',
    )).resolves.toMatchObject({ created: true });
    expect(mocks.getPost).toHaveBeenCalledWith(post.id);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        notionPageId: post.id,
        itemHash: input.itemHash,
        snapshotRevision: post.lastEditedTime,
      }),
      '33333333-3333-4333-8333-333333333333',
      'operator@example.com',
    );
  });

  it('fails closed when Notion changed and when Published is no longer eligible', async () => {
    mocks.getPost.mockResolvedValueOnce({
      ...post,
      lastEditedTime: '2026-08-05T13:12:00.000Z',
    });
    await expect(createManualSchedulingAttestation(
      input,
      '33333333-3333-4333-8333-333333333333',
      'operator@example.com',
    )).rejects.toMatchObject({ code: 'MANUAL_SCHEDULING_STALE_REVISION' });
    expect(mocks.insert).not.toHaveBeenCalled();

    mocks.getPost.mockRejectedValueOnce(Object.assign(
      new Error('Post is already Published'),
      { code: 'POST_NOT_READY', status: 409 },
    ));
    await expect(createManualSchedulingAttestation(
      input,
      '33333333-3333-4333-8333-333333333333',
      'operator@example.com',
    )).rejects.toThrow(/Published/);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
