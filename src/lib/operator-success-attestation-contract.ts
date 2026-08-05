import { createHash } from 'crypto';

export const OPERATOR_SUCCESS_ATTESTATION_CONTRACT_REVISION =
  'operator-success-attestation/v1' as const;
export const ATTESTATION_RELEASE_CONSUMED_CODE =
  'ATTESTATION_RELEASE_CONSUMED' as const;
export const ATTESTATION_RELEASE_CONSUMED_MESSAGE =
  'Matching local dispatch slot released; receipt verification remains pending.' as const;
export const OPERATOR_SUCCESS_ATTESTATION_TIME_ZONE =
  'America/New_York' as const;

export function operatorSuccessAttestationEnabled() {
  return process.env.LOCAL_PUBLISH_WORKER_ATTESTATION_CONTRACT_REVISION ===
    OPERATOR_SUCCESS_ATTESTATION_CONTRACT_REVISION;
}

export function claimTokenDigest(claimToken: string) {
  return createHash('sha256').update(claimToken, 'utf8').digest('hex');
}
