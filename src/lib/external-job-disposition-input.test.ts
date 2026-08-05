import { describe, expect, it } from 'vitest';
import { parseExternalJobDispositionInput } from '@/lib/external-job-disposition-input';

const input = {
  notionPageId: 'notion-page',
  localJobId: '11111111-1111-4111-8111-111111111111',
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
  confirmed: true,
};

describe('external job disposition input', () => {
  it('accepts only the exact confirmed canonical identity tuple', () => {
    expect(parseExternalJobDispositionInput(input)).toEqual({
      notionPageId: input.notionPageId,
      localJobId: input.localJobId,
      noteId: input.noteId,
      shareUrl: input.shareUrl,
    });
  });

  it('accepts publicPost and strips all query and fragment data', () => {
    expect(parseExternalJobDispositionInput({
      confirmed: true,
      notionPageId: input.notionPageId,
      localJobId: input.localJobId,
      publicPost: `${input.shareUrl}?xsec_token=secret&source=share#fragment`,
    })).toEqual({
      notionPageId: input.notionPageId,
      localJobId: input.localJobId,
      noteId: input.noteId,
      shareUrl: input.shareUrl,
    });
  });

  it.each([
    [{ ...input, confirmed: false }, 'CONFIRMATION_REQUIRED'],
    [{ ...input, localJobId: 'job-1' }, 'VALIDATION_ERROR'],
    [{ ...input, shareUrl: 'https://www.rednote.com/explore/other' }, 'INVALID_REDNOTE_IDENTITY'],
    [{
      confirmed: true,
      notionPageId: input.notionPageId,
      localJobId: input.localJobId,
      publicPost: 'https://example.com/explore/note_123',
    }, 'INVALID_REDNOTE_IDENTITY'],
    [{
      confirmed: true,
      notionPageId: input.notionPageId,
      localJobId: input.localJobId,
      publicPost: 'https://www.rednote.com/user/note_123',
    }, 'INVALID_REDNOTE_IDENTITY'],
    [{ ...input, extra: true }, 'VALIDATION_ERROR'],
  ])('rejects unsafe input %#', (value, code) => {
    expect(() => parseExternalJobDispositionInput(value)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});
