import { describe, expect, it, vi } from 'vitest';
import {
  copyHandoffText,
  formatTags,
  getCanonicalVideoUrl,
  getMissingTags,
  getVideoDownloadName,
  REDNOTE_CREATOR_PUBLISH_URL,
  SAFE_EXTERNAL_LINK_PROPS,
  shouldOfferTitleCopy,
} from '@/lib/manual-rednote-handoff';

describe('manual Rednote handoff', () => {
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
});
