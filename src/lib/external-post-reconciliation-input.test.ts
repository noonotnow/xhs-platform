import { describe, expect, it } from 'vitest';
import { parseExternalPostSnapshot } from '@/lib/external-post-reconciliation-input';

const verified = {
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
  title: 'Final title',
  caption: 'Final caption',
  mediaType: 'video',
};

describe('external post snapshot validation', () => {
  it('accepts only an exact verified RedNote explore identity', () => {
    expect(parseExternalPostSnapshot(verified)).toEqual(verified);
    expect(() => parseExternalPostSnapshot({
      ...verified,
      shareUrl: `${verified.shareUrl}?source=share`,
    })).toThrow('exactly match');
    expect(() => parseExternalPostSnapshot({
      ...verified,
      shareUrl: 'http://www.rednote.com/explore/note_123',
    })).toThrow('exactly match');
  });

  it('rejects media URLs and every other unsupported field', () => {
    expect(() => parseExternalPostSnapshot({
      ...verified,
      mediaUrl: 'https://example.com/untrusted.mp4',
    })).toThrow('unsupported fields');
  });
});
