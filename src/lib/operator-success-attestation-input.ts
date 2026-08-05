import { LocalPublishJobError } from '@/lib/local-publish-job-input';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

export interface OperatorSuccessAttestationInput {
  batchId: string;
  manifestHash: string;
  itemId: string;
  jobId: string;
  itemHash: string;
  snapshotRevision: string;
  requestedPublishAt: string;
}

function exactKeys(body: Record<string, unknown>) {
  const expected = [
    'batchId',
    'confirmed',
    'itemHash',
    'itemId',
    'jobId',
    'manifestHash',
    'requestedPublishAt',
    'snapshotRevision',
  ];
  const keys = Object.keys(body).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new LocalPublishJobError(
      'Attestation body contains unsupported or missing fields',
      'VALIDATION_ERROR',
      400,
    );
  }
}

function uuid(value: unknown, field: string) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new LocalPublishJobError(`${field} must be an exact UUID`, 'VALIDATION_ERROR', 400);
  }
  return value.toLowerCase();
}

function hash(value: unknown, field: string) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new LocalPublishJobError(
      `${field} must be a lowercase SHA-256 hash`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return value;
}

function canonicalTimestamp(value: unknown, field: string) {
  if (typeof value !== 'string' || value.length > 64) {
    throw new LocalPublishJobError(
      `${field} must be an exact canonical UTC timestamp`,
      'VALIDATION_ERROR',
      400,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new LocalPublishJobError(
      `${field} must be an exact canonical UTC timestamp`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return value;
}

export function parseOperatorSuccessAttestationInput(
  value: unknown,
): OperatorSuccessAttestationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Attestation body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  exactKeys(body);
  if (body.confirmed !== true) {
    throw new LocalPublishJobError(
      'Explicit operator confirmation is required',
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
  return {
    batchId: uuid(body.batchId, 'batchId'),
    manifestHash: hash(body.manifestHash, 'manifestHash'),
    itemId: uuid(body.itemId, 'itemId'),
    jobId: uuid(body.jobId, 'jobId'),
    itemHash: hash(body.itemHash, 'itemHash'),
    snapshotRevision: canonicalTimestamp(body.snapshotRevision, 'snapshotRevision'),
    requestedPublishAt: canonicalTimestamp(body.requestedPublishAt, 'requestedPublishAt'),
  };
}
