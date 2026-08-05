import { describe, expect, it } from 'vitest';
import { parseOperatorSuccessAttestationInput } from '@/lib/operator-success-attestation-input';

const input = {
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  itemHash: 'b'.repeat(64),
  snapshotRevision: '2026-08-04T13:12:00.000Z',
  requestedPublishAt: '2026-08-06T14:30:00.000Z',
  confirmed: true,
};

describe('operator success attestation input', () => {
  it('accepts only exact confirmed immutable evidence', () => {
    expect(parseOperatorSuccessAttestationInput(input)).toEqual({
      batchId: input.batchId,
      manifestHash: input.manifestHash,
      itemId: input.itemId,
      jobId: input.jobId,
      itemHash: input.itemHash,
      snapshotRevision: input.snapshotRevision,
      requestedPublishAt: input.requestedPublishAt,
    });
  });

  it.each([
    [{ ...input, confirmed: false }],
    [{ ...input, requestedPublishAt: '2026-08-06T10:30:00-04:00' }],
    [{ ...input, arbitraryStatus: 'reconciled' }],
  ])('rejects unsafe input %#', (value) => {
    expect(() => parseOperatorSuccessAttestationInput(value)).toThrow();
  });
});
