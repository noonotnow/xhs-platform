import { describe, expect, it } from 'vitest';
import {
  claimTokenDigest,
  parseOperatorAttestedReceipt,
  parseOperatorSuccessAttestation,
} from '@/lib/operator-success-attestation';

const fullIdentity = {
  jobId: '11111111-1111-4111-8111-111111111111',
  pageId: 'notion-page',
  batchId: '22222222-2222-4222-8222-222222222222',
  itemId: '33333333-3333-4333-8333-333333333333',
  snapshotDigest: 'a'.repeat(64),
  itemHash: 'a'.repeat(64),
  scheduledAt: '2026-08-05T13:00:00.000Z',
  claimTokenDigest: 'b'.repeat(64),
};

describe('operator success attestation contract', () => {
  it('accepts only the exact versioned full server identity', () => {
    expect(parseOperatorSuccessAttestation({
      revision: 'rednote.operator-success-attestation.v1',
      confirmed: true,
      identity: fullIdentity,
    })).toEqual(fullIdentity);
    expect(() => parseOperatorSuccessAttestation({
      revision: 'rednote.operator-success-attestation.v1',
      confirmed: true,
      identity: { ...fullIdentity, snapshotDigest: 'c'.repeat(64) },
    })).toThrow(expect.objectContaining({ code: 'ATTESTATION_IDENTITY_CONFLICT' }));
  });

  it('canonicalizes UUID casing before immutable equality checks', () => {
    const parsed = parseOperatorSuccessAttestation({
      revision: 'rednote.operator-success-attestation.v1',
      confirmed: true,
      identity: {
        ...fullIdentity,
        jobId: fullIdentity.jobId.toUpperCase(),
        batchId: fullIdentity.batchId.toUpperCase(),
        itemId: fullIdentity.itemId.toUpperCase(),
      },
    });
    expect(parsed.jobId).toBe(fullIdentity.jobId);
    expect(parsed.batchId).toBe(fullIdentity.batchId);
    expect(parsed.itemId).toBe(fullIdentity.itemId);
  });

  it('uses the legacy-v5 worker projection without inventing itemId', () => {
    const identity = {
      jobId: fullIdentity.jobId,
      pageId: fullIdentity.pageId,
      batchId: fullIdentity.batchId,
      snapshotDigest: fullIdentity.snapshotDigest,
      itemHash: fullIdentity.itemHash,
      scheduledAt: fullIdentity.scheduledAt,
      claimTokenDigest: fullIdentity.claimTokenDigest,
    };
    expect(parseOperatorAttestedReceipt({
      revision: 'rednote.operator-success-attestation.v1',
      attestationId: '44444444-4444-4444-8444-444444444444',
      identity,
      result: {
        status: 'pending',
        code: 'RECEIPT_NOT_FOUND',
        message: 'No exact receipt is visible yet',
      },
    }).identity).toEqual(identity);
  });

  it('hashes the exact raw UTF-8 claim token without normalization', () => {
    expect(claimTokenDigest('ABC')).not.toBe(claimTokenDigest('abc'));
    expect(claimTokenDigest('22222222-2222-4222-8222-222222222222'))
      .toMatch(/^[a-f0-9]{64}$/);
  });
});
