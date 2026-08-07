import { describe, expect, it } from 'vitest';
import { parseManualPostHandlingInput } from '@/lib/manual-post-handling-input';

describe('manual post handling input', () => {
  it('accepts only exact scheduled or published handling evidence', () => {
    expect(parseManualPostHandlingInput({
      notionPageId: 'post',
      expectedLastEditedTime: '2026-08-06T12:00:00-04:00',
      mode: 'published',
    })).toEqual({
      notionPageId: 'post',
      expectedLastEditedTime: '2026-08-06T16:00:00.000Z',
      mode: 'published',
    });
  });

  it('rejects extra fields and invalid modes', () => {
    expect(() => parseManualPostHandlingInput({
      notionPageId: 'post',
      expectedLastEditedTime: '2026-08-06T16:00:00.000Z',
      mode: 'automated',
    })).toThrow(/scheduled or published/);
    expect(() => parseManualPostHandlingInput({
      notionPageId: 'post',
      expectedLastEditedTime: '2026-08-06T16:00:00.000Z',
      mode: 'scheduled',
      packetReady: true,
    })).toThrow(/contain only/);
  });
});
