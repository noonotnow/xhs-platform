import { createHash } from 'crypto';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { OperatorSuccessAttestationIdentity } from '@/types/local-publish-job';

export const OPERATOR_SUCCESS_ATTESTATION_REVISION =
  'rednote.operator-success-attestation.v1' as const;
export const OPERATOR_SUCCESS_CAPABILITY_MAX_AGE_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

function exactKeys(body: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new LocalPublishJobError('Attestation body is not exact', 'VALIDATION_ERROR', 400);
  }
}

function identity(value: unknown, includeItemId: boolean) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('identity must be an object', 'VALIDATION_ERROR', 400);
  }
  const body = value as Record<string, unknown>;
  const fields = [
    'jobId', 'pageId', 'batchId', ...(includeItemId ? ['itemId'] : []),
    'snapshotDigest', 'itemHash', 'scheduledAt', 'claimTokenDigest',
  ];
  exactKeys(body, fields);
  for (const field of ['jobId', 'batchId', ...(includeItemId ? ['itemId'] : [])]) {
    if (typeof body[field] !== 'string' || !UUID.test(body[field])) {
      throw new LocalPublishJobError(`${field} must be a UUID`, 'VALIDATION_ERROR', 400);
    }
    body[field] = body[field].toLowerCase();
  }
  for (const field of ['snapshotDigest', 'itemHash', 'claimTokenDigest']) {
    if (typeof body[field] !== 'string' || !HASH.test(body[field])) {
      throw new LocalPublishJobError(`${field} must be lowercase SHA-256`, 'VALIDATION_ERROR', 400);
    }
  }
  if (body.snapshotDigest !== body.itemHash) {
    throw new LocalPublishJobError(
      'snapshotDigest and itemHash must match',
      'ATTESTATION_IDENTITY_CONFLICT',
      409,
    );
  }
  const scheduled = typeof body.scheduledAt === 'string' ? new Date(body.scheduledAt) : null;
  if (!scheduled || Number.isNaN(scheduled.getTime()) || scheduled.toISOString() !== body.scheduledAt) {
    throw new LocalPublishJobError('scheduledAt must be canonical UTC', 'VALIDATION_ERROR', 400);
  }
  if (typeof body.pageId !== 'string' || !body.pageId || body.pageId.length > 128) {
    throw new LocalPublishJobError('pageId is invalid', 'VALIDATION_ERROR', 400);
  }
  return body as unknown as OperatorSuccessAttestationIdentity;
}

export function parseOperatorSuccessAttestation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('Attestation body must be an object', 'VALIDATION_ERROR', 400);
  }
  const body = value as Record<string, unknown>;
  exactKeys(body, ['revision', 'confirmed', 'identity']);
  if (body.revision !== OPERATOR_SUCCESS_ATTESTATION_REVISION || body.confirmed !== true) {
    throw new LocalPublishJobError('Exact revision and confirmation are required', 'VALIDATION_ERROR', 400);
  }
  return identity(body.identity, true);
}

export function parseOperatorAttestedReceipt(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('Receipt body must be an object', 'VALIDATION_ERROR', 400);
  }
  const body = value as Record<string, unknown>;
  exactKeys(body, ['revision', 'attestationId', 'identity', 'result']);
  if (body.revision !== OPERATOR_SUCCESS_ATTESTATION_REVISION ||
      typeof body.attestationId !== 'string' || !UUID.test(body.attestationId)) {
    throw new LocalPublishJobError('Receipt revision or attestationId is invalid', 'VALIDATION_ERROR', 400);
  }
  if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) {
    throw new LocalPublishJobError('result must be an object', 'VALIDATION_ERROR', 400);
  }
  const result = body.result as Record<string, unknown>;
  if (result.status === 'pending') exactKeys(result, ['status', 'code', 'message']);
  else if (result.status === 'verified') exactKeys(result, ['status', 'noteId', 'shareUrl']);
  else throw new LocalPublishJobError('Unsupported receipt status', 'VALIDATION_ERROR', 400);
  if (
    result.status === 'pending' &&
    typeof result.message === 'string' &&
    (
      /https?:\/\//i.test(result.message) ||
      /\b(?:authorization|bearer|cookie|password|secret|token)\b/i.test(result.message)
    )
  ) {
    throw new LocalPublishJobError('Pending receipt message is unsafe', 'VALIDATION_ERROR', 400);
  }
  return {
    attestationId: body.attestationId.toLowerCase(),
    identity: identity(body.identity, false),
    result,
  };
}

export function claimTokenDigest(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function workerCapabilities(value: string | null) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}
