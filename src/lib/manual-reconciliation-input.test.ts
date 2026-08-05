import { describe, expect, it } from 'vitest';
import {
  normalizeManualRedNoteIdentity,
  parseCreateManualReconciliationInput,
  parseManualReconciliationWorkerResult,
} from '@/lib/manual-reconciliation-input';

describe('manual reconciliation input', () => {
  it('canonicalizes public URLs and strips query and fragment data', () => {
    expect(normalizeManualRedNoteIdentity('note_123')).toEqual({
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
    });
    expect(normalizeManualRedNoteIdentity(
      'https://www.rednote.com/explore/note_123',
    )).toEqual({
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
    });
    for (const value of [
      'https://www.rednote.com/explore/note_123?source=share',
      'https://www.rednote.com/explore/note_123/',
      'https://www.xiaohongshu.com/explore/note_123',
    ]) {
      expect(normalizeManualRedNoteIdentity(value)).toEqual({
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
      });
    }
    expect(normalizeManualRedNoteIdentity(
      'https://www.rednote.com/explore/note_123?xsec_token=secret#fragment',
    )).toEqual({
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
    });
    for (const value of [
      'https://rednote.com/explore/note_123',
      'https://example.com/explore/note_123',
      'https://www.rednote.com/user/note_123',
      'note 123',
    ]) {
      expect(() => normalizeManualRedNoteIdentity(value)).toThrow(
        'allowed public RedNote explore URL',
      );
    }
  });

  it('requires confirmation and rejects extra client metadata', () => {
    const body = {
      notionPageId: '11111111-1111-4111-8111-111111111111',
      publicPost: 'note_123',
      confirmed: true,
    };
    expect(parseCreateManualReconciliationInput(body)).toMatchObject({
      notionPageId: body.notionPageId,
      noteId: 'note_123',
    });
    expect(() => parseCreateManualReconciliationInput({
      ...body,
      title: 'Untrusted title',
    })).toThrow('unsupported fields');
    expect(() => parseCreateManualReconciliationInput({
      ...body,
      confirmed: false,
    })).toThrow('confirmation');
  });

  it('accepts a strict verified snapshot and redacts unsafe failures', () => {
    expect(parseManualReconciliationWorkerResult({
      status: 'verified',
      snapshot: {
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
        title: 'Final title',
        caption: 'Final caption',
        mediaType: 'video',
      },
    })).toMatchObject({ status: 'verified' });
    expect(() => parseManualReconciliationWorkerResult({
      status: 'failed',
      code: 'AUTH_FAILED',
      message: 'Cookie token=secret',
    })).toThrow('credential-like');
  });

  it.each(['staged', 'submitted', 'scheduled', 'publishing'])(
    'does not accept the dispatch status %s',
    (status) => {
      expect(() => parseManualReconciliationWorkerResult({
        status,
        noteId: 'note_123',
        shareUrl: 'https://www.rednote.com/explore/note_123',
      })).toThrow('status must be verified');
    },
  );
});
