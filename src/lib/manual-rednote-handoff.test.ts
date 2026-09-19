import { describe, expect, it, vi } from 'vitest';
import {
  copyHandoffText,
  canSharePreparedPacket,
  formatRednoteHandoffText,
  formatTags,
  getCanonicalVideoUrl,
  getMediaDownloadName,
  getMissingTags,
  getVideoDownloadName,
  isManualHandoffEligible,
  isPreparedHandoffFresh,
  PREPARED_HANDOFF_FRESHNESS_MS,
  prepareOrderedMediaFiles,
  REDNOTE_CREATOR_PUBLISH_URL,
  SAFE_EXTERNAL_LINK_PROPS,
  shouldOfferTitleCopy,
} from '@/lib/manual-rednote-handoff';

describe('manual Rednote handoff', () => {
  it('checks canShare with the complete ordered file set before offering file sharing', () => {
    const files = [
      new File(['one'], 'packet-01.jpg', { type: 'image/jpeg' }),
      new File(['two'], 'packet-02.jpg', { type: 'image/jpeg' }),
    ];
    const canShare = vi.fn().mockReturnValue(true);
    const shareData = {
      title: 'Exact packet',
      text: 'Approved text',
      files,
    };
    expect(canSharePreparedPacket({ canShare }, shareData)).toBe(true);
    expect(canShare).toHaveBeenCalledWith(shareData);
    expect(canSharePreparedPacket({}, shareData)).toBe(false);
  });

  it('expires prepared authority after the documented short window', () => {
    const validatedAt = Date.UTC(2026, 8, 19, 12);
    expect(isPreparedHandoffFresh(validatedAt, validatedAt)).toBe(true);
    expect(isPreparedHandoffFresh(
      validatedAt,
      validatedAt + PREPARED_HANDOFF_FRESHNESS_MS - 1,
    )).toBe(true);
    expect(isPreparedHandoffFresh(
      validatedAt,
      validatedAt + PREPARED_HANDOFF_FRESHNESS_MS,
    )).toBe(false);
    expect(isPreparedHandoffFresh(validatedAt, validatedAt - 1)).toBe(false);
  });

  const eligibility = {
    destination: 'RedNote',
    studioStatus: 'Ready',
    publishPacketReady: true,
    readinessBlockers: [],
    workspace: {
      requestedId: 'workspace-one',
      packetId: 'workspace-one',
    },
    postId: 'post-one',
    sourceRevision: '2026-09-19T12:00:00.000Z',
    packet: {
      identity: 'packet-five',
      postId: 'post-one',
      sourceRevision: '2026-09-19T12:00:00.000Z',
      mediaIdentities: ['rendition-11:1', 'rendition-11:2'],
      expectedMediaIdentities: ['rendition-11:1', 'rendition-11:2'],
    },
    attempt: {
      identity: 'attempt-one',
      sourceLocalPublishJobId: 'job-one',
      payloadDigest: 'digest-one',
      payloadRevision: 'packet-v5',
      eligible: true,
    },
    localPublishJobId: 'job-one',
  };

  it('accepts only exact packet-ready Ready or compatible Approved handoffs', () => {
    expect(isManualHandoffEligible(eligibility)).toBe(true);
    expect(isManualHandoffEligible({
      ...eligibility,
      studioStatus: 'Approved',
    })).toBe(true);
    expect(isManualHandoffEligible({
      ...eligibility,
      publishPacketReady: false,
    })).toBe(false);
    expect(isManualHandoffEligible({
      ...eligibility,
      readinessBlockers: ['Caption is empty'],
    })).toBe(false);
  });

  it('fails closed when Post, packet, revision, attempt, workspace, or media identity drifts', () => {
    expect(isManualHandoffEligible({
      ...eligibility,
      destination: 'Weibo',
    })).toBe(false);
    expect(isManualHandoffEligible({
      ...eligibility,
      workspace: {
        requestedId: 'workspace-one',
        packetId: 'workspace-two',
      },
    })).toBe(false);
    expect(isManualHandoffEligible({
      ...eligibility,
      packet: { ...eligibility.packet, postId: 'other-post' },
    })).toBe(false);
    expect(isManualHandoffEligible({
      ...eligibility,
      packet: { ...eligibility.packet, sourceRevision: 'stale-revision' },
    })).toBe(false);
    expect(isManualHandoffEligible({
      ...eligibility,
      packet: { ...eligibility.packet, mediaIdentities: [] },
    })).toBe(false);
    expect(isManualHandoffEligible({
      ...eligibility,
      packet: {
        ...eligibility.packet,
        mediaIdentities: ['rendition-11:2', 'rendition-11:1'],
      },
    })).toBe(false);
    expect(isManualHandoffEligible({
      ...eligibility,
      packet: {
        ...eligibility.packet,
        mediaIdentities: ['rendition-11:1', 'different-rendition'],
      },
    })).toBe(false);
    expect(isManualHandoffEligible({
      ...eligibility,
      attempt: { ...eligibility.attempt, sourceLocalPublishJobId: 'other-job' },
    })).toBe(false);
    expect(isManualHandoffEligible({
      ...eligibility,
      attempt: { ...eligibility.attempt, eligible: false },
    })).toBe(false);
  });

  it('uses the official Creator publish URL with safe external-link attributes', () => {
    expect(REDNOTE_CREATOR_PUBLISH_URL).toBe(
      'https://creator.rednote.com/publish/publish',
    );
    expect(SAFE_EXTERNAL_LINK_PROPS).toEqual({
      target: '_blank',
      rel: 'noopener noreferrer',
    });
  });

  it('copies text without performing any network or publish mutation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(copyHandoffText({ writeText }, 'Caption from CREATE', 'Caption'))
      .resolves.toEqual({ ok: true, message: 'Caption copied.' });
    expect(writeText).toHaveBeenCalledWith('Caption from CREATE');
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('reports unavailable and rejected clipboard writes', async () => {
    await expect(copyHandoffText(undefined, 'Caption', 'Caption')).resolves.toEqual({
      ok: false,
      message: 'Clipboard access is unavailable. Select and copy the caption manually.',
    });

    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
    await expect(copyHandoffText({ writeText }, 'Caption', 'Caption')).resolves.toEqual({
      ok: false,
      message: 'Could not copy the caption. Select it and copy manually.',
    });
  });

  it('accepts only the canonical MEDIA MP4 and creates a useful filename', () => {
    const canonical =
      'https://images.xhs.justlikekatie.com/videos/assets/6c/video-source.mp4';
    expect(getCanonicalVideoUrl([
      'https://example.com/video.mp4',
      canonical,
    ])).toBe(canonical);
    expect(getCanonicalVideoUrl([
      'http://images.xhs.justlikekatie.com/videos/assets/video.mp4',
      'https://images.xhs.justlikekatie.com/other/video.mp4',
    ])).toBeUndefined();
    expect(getVideoDownloadName('Studio day: first look!', canonical))
      .toBe('studio-day-first-look.mp4');
    expect(getVideoDownloadName('幕后花絮', canonical)).toBe('幕后花絮.mp4');
  });

  it('offers only useful separate title and tag controls', () => {
    expect(shouldOfferTitleCopy('Studio day', 'Studio day\nBehind the scenes')).toBe(false);
    expect(shouldOfferTitleCopy('Studio day', 'Behind the scenes')).toBe(true);
    expect(getMissingTags(['BTS', '#Studio'], 'Behind the scenes #BTS')).toEqual(['Studio']);
    expect(getMissingTags(['art'], 'A launch party')).toEqual(['art']);
    expect(formatTags(['Studio', 'DayOne'])).toBe('#Studio #DayOne');
  });

  it('formats approved copy without duplicating tags already in the caption', () => {
    expect(formatRednoteHandoffText(
      'Approved caption #existing',
      ['existing', 'FinalTag'],
    )).toBe('Approved caption #existing\n\n#FinalTag');
  });

  it('numbers media download names in canonical order', () => {
    expect(getMediaDownloadName(
      'Exact packet',
      'https://images.xhs.justlikekatie.com/uploads/first.jpeg',
      1,
      'image/jpeg',
    )).toBe('exact-packet-01.jpeg');
    expect(getMediaDownloadName(
      'Exact packet',
      'https://images.xhs.justlikekatie.com/uploads/second.webp?version=11',
      2,
      'image/webp',
    )).toBe('exact-packet-02.webp');
  });

  it('uses validated MIME types when URL extensions are missing or disagree', () => {
    expect(getMediaDownloadName(
      'Exact packet',
      'https://images.xhs.justlikekatie.com/uploads/no-extension',
      1,
      'image/png',
    )).toBe('exact-packet-01.png');
    expect(getMediaDownloadName(
      'Exact packet',
      'https://images.xhs.justlikekatie.com/uploads/wrong.jpg',
      2,
      'video/quicktime',
    )).toBe('exact-packet-02.mov');
    expect(() => getMediaDownloadName(
      'Exact packet',
      'https://images.xhs.justlikekatie.com/uploads/file.jpg',
      3,
      'application/octet-stream',
    )).toThrow('Unsupported prepared asset type');
  });

  it('prepares every ordered asset and fails the whole preparation on one asset error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(['one']), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }))
      .mockResolvedValueOnce(new Response(new Blob(['no']), { status: 503 })));
    await expect(prepareOrderedMediaFiles('Exact packet', [
      { url: 'https://example.com/first.jpg' },
      { url: 'https://example.com/second.jpg' },
    ])).rejects.toThrow('Asset 2 could not be prepared');
    vi.unstubAllGlobals();
  });

  it('prepares every asset in order with MIME-authoritative filenames', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(['one'], { type: 'image/png' }), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }))
      .mockResolvedValueOnce(new Response(new Blob(['two'], { type: 'video/quicktime' }), {
        status: 200,
        headers: { 'Content-Type': 'video/quicktime' },
      }));
    vi.stubGlobal('fetch', fetch);

    const files = await prepareOrderedMediaFiles('Exact packet', [
      { url: 'https://example.com/no-extension' },
      { url: 'https://example.com/wrong.jpg' },
    ]);

    expect(files.map((file) => ({ name: file.name, type: file.type }))).toEqual([
      { name: 'exact-packet-01.png', type: 'image/png' },
      { name: 'exact-packet-02.mov', type: 'video/quicktime' },
    ]);
    expect(fetch.mock.calls.every(([, init]) => init?.cache === 'no-store')).toBe(true);
    vi.unstubAllGlobals();
  });
});
