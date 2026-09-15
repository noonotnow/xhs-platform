import { describe, expect, it } from 'vitest';
import exactActivationFixture from '@/contracts/exact-job-activation-v1.json';
import {
  EXACT_JOB_ACTIVATION_CONTRACT_REVISION,
  validateExactJobActivationSelectors,
} from '@/lib/exact-job-activation-contract';

function validSelectors() {
  return {
    ...exactActivationFixture.request,
    contractRevision: exactActivationFixture.contractRevision,
    expectedJobId: '11111111-1111-4111-8111-111111111111',
    activationId: '22222222-2222-4222-8222-222222222222',
    expectedBatchId: '33333333-3333-4333-8333-333333333333',
    expectedItemId: '44444444-4444-4444-8444-444444444444',
    expectedWorkerAttestationId: '55555555-5555-4555-8555-555555555555',
    nonce: 'fixture-activation-nonce-with-at-least-32-bytes',
  };
}

describe('exact-job activation v1 contract', () => {
  it('mirrors the worker field names and accepts the complete selector tuple', () => {
    expect(exactActivationFixture.contractRevision).toBe(
      EXACT_JOB_ACTIVATION_CONTRACT_REVISION,
    );
    expect(exactActivationFixture.activationNonceHeader).toBe(
      'x-local-publish-activation-nonce',
    );
    expect(exactActivationFixture.request).not.toHaveProperty('nonce');
    expect(Object.keys(exactActivationFixture.response.exactActivation)).toEqual([
      'contractRevision',
      'activationId',
      'batchId',
      'itemId',
      'jobId',
      'manifestHash',
      'itemHash',
      'sourceRevision',
      'releaseId',
      'workerAttestationId',
    ]);
    expect(() => validateExactJobActivationSelectors(validSelectors()))
      .not.toThrow();
  });

  it.each([
    ['missing', undefined],
    ['unsupported', 'exact-job-activation/v2'],
  ])('rejects a %s contract revision with the stable fail-closed error', (_, revision) => {
    const selectors = {
      ...validSelectors(),
      contractRevision: revision,
    };

    expect(() => validateExactJobActivationSelectors(selectors)).toThrow(
      expect.objectContaining({
        code: 'EXACT_JOB_ACTIVATION_SELECTOR_MISMATCH',
        status: 400,
      }),
    );
  });

  it('rejects untrimmed release and worker attestation identifiers', () => {
    for (const selectors of [
      { ...validSelectors(), expectedReleaseId: ' release-1' },
      {
        ...validSelectors(),
        expectedWorkerAttestationId: 'attestation-1 ',
      },
    ]) {
      expect(() => validateExactJobActivationSelectors(selectors)).toThrow(
        expect.objectContaining({
          code: 'EXACT_JOB_ACTIVATION_SELECTOR_MISMATCH',
        }),
      );
    }
  });
});
