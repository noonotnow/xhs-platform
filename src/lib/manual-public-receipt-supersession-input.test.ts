import { describe, expect, it } from 'vitest';
import { parseManualPublicReceiptSupersessionInput } from
  '@/lib/manual-public-receipt-supersession-input';

const input = {
  notionPageId: 'ff813547-96bc-472c-8ec4-c4bcc9c058c0',
  expectedNotionVersion: '2026-08-06T18:30:00.000Z',
  jobId: 'a682cbdd-8392-4757-87b3-adb2ae729cfb',
  batchId: 'c05ef8d9-f4a0-4d5e-b75d-a99367ec8305',
  batchItemId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemHash: 'b'.repeat(64),
  snapshotRevision: '2026-08-04T09:44:00.000Z',
  noteId: '6a723ae5000000000f03a000',
  shareUrl: 'https://www.rednote.com/explore/6a723ae5000000000f03a000',
  provenance: 'manual',
  confirmed: true,
  supersedeAmbiguousWorkerAttempt: true,
};

describe('manual public receipt supersession input', () => {
  it('requires exact evidence and canonical manual identity', () => {
    expect(parseManualPublicReceiptSupersessionInput(input)).toEqual({
      notionPageId: input.notionPageId,
      expectedNotionVersion: input.expectedNotionVersion,
      jobId: input.jobId,
      batchId: input.batchId,
      batchItemId: input.batchItemId,
      manifestHash: input.manifestHash,
      itemHash: input.itemHash,
      snapshotRevision: input.snapshotRevision,
      noteId: input.noteId,
      shareUrl: input.shareUrl,
      provenance: 'manual',
    });
  });

  it.each([
    ['missing supersession confirmation', { supersedeAmbiguousWorkerAttempt: false }],
    ['non-manual provenance', { provenance: 'worker' }],
    ['conflicting note and URL', { noteId: 'different-note' }],
    ['non-canonical URL', {
      shareUrl: `${input.shareUrl}?source=copy_link`,
    }],
    ['malformed job id', { jobId: 'job' }],
    ['malformed item hash', { itemHash: 'B'.repeat(64) }],
    ['malformed revision', { expectedNotionVersion: 'yesterday' }],
  ])('rejects %s', (_label, override) => {
    expect(() => parseManualPublicReceiptSupersessionInput({
      ...input,
      ...override,
    })).toThrow();
  });
});
