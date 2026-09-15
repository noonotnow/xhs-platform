import { LocalPublishJobError } from '@/lib/local-publish-job-input';

export const EXACT_JOB_ACTIVATION_CONTRACT_REVISION =
  'exact-job-activation/v1' as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface ExactJobActivationSelectors {
  lane: 'dispatch';
  contractRevision: typeof EXACT_JOB_ACTIVATION_CONTRACT_REVISION;
  expectedJobId: string;
  activationId: string;
  expectedBatchId: string;
  expectedItemId: string;
  expectedManifestHash: string;
  expectedItemHash: string;
  expectedSourceRevision: string;
  expectedReleaseId: string;
  expectedWorkerAttestationId: string;
  nonce: string;
}

export interface ExactJobActivationEnvelope {
  contractRevision: typeof EXACT_JOB_ACTIVATION_CONTRACT_REVISION;
  activationId: string;
  batchId: string;
  itemId: string;
  jobId: string;
  manifestHash: string;
  itemHash: string;
  sourceRevision: string;
  releaseId: string;
  workerAttestationId: string;
}

function validOpaqueId(value: string) {
  return value.length >= 1
    && value.length <= 200
    && value === value.trim();
}

export function validateExactJobActivationSelectors(
  input: Omit<
    Partial<ExactJobActivationSelectors>,
    'lane' | 'contractRevision'
  > & {
    lane: string;
    contractRevision?: string;
  },
): asserts input is ExactJobActivationSelectors {
  if (
    input.lane !== 'dispatch'
    || input.contractRevision !== EXACT_JOB_ACTIVATION_CONTRACT_REVISION
    || !input.expectedJobId
    || !UUID_PATTERN.test(input.expectedJobId)
    || !input.activationId
    || !UUID_PATTERN.test(input.activationId)
    || !input.expectedBatchId
    || !UUID_PATTERN.test(input.expectedBatchId)
    || !input.expectedItemId
    || !UUID_PATTERN.test(input.expectedItemId)
    || !input.expectedManifestHash
    || !SHA256_PATTERN.test(input.expectedManifestHash)
    || !input.expectedItemHash
    || !SHA256_PATTERN.test(input.expectedItemHash)
    || !input.expectedSourceRevision
    || input.expectedSourceRevision.length > 200
    || !input.expectedReleaseId
    || !validOpaqueId(input.expectedReleaseId)
    || !input.expectedWorkerAttestationId
    || !validOpaqueId(input.expectedWorkerAttestationId)
    || !input.nonce
    || input.nonce.length < 32
    || input.nonce.length > 200
  ) {
    throw new LocalPublishJobError(
      'Exact dispatch requires the complete exact-job activation v1 selector tuple',
      'EXACT_JOB_ACTIVATION_SELECTOR_MISMATCH',
      400,
    );
  }
}
