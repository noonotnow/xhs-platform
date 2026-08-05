import { parseOperatorSuccessAttestationInput } from '@/lib/operator-success-attestation-input';
import { insertOperatorSuccessAttestation } from '@/lib/operator-success-attestation-store';

export async function createOperatorSuccessAttestation(
  rawInput: unknown,
  idempotencyKey: string,
  actor: string,
) {
  return insertOperatorSuccessAttestation(
    parseOperatorSuccessAttestationInput(rawInput),
    idempotencyKey,
    actor,
  );
}
