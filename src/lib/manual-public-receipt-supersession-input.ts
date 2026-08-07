import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { normalizeRednotePublicIdentity } from '@/lib/rednote-publication';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

export interface ManualPublicReceiptSupersessionInput {
  notionPageId: string;
  expectedNotionVersion: string;
  jobId: string;
  batchId: string;
  batchItemId: string;
  manifestHash: string;
  itemHash: string;
  snapshotRevision: string;
  noteId: string;
  shareUrl: string;
  provenance: 'manual';
}

function text(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string') {
    throw new LocalPublishJobError(`${field} must be a string`, 'VALIDATION_ERROR', 400);
  }
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) {
    throw new LocalPublishJobError(
      `${field} must be between 1 and ${maxLength} characters`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return cleaned;
}

function uuid(value: unknown, field: string) {
  const cleaned = text(value, field, 36);
  if (!UUID.test(cleaned)) {
    throw new LocalPublishJobError(`${field} must be a UUID`, 'VALIDATION_ERROR', 400);
  }
  return cleaned;
}

function hash(value: unknown, field: string) {
  const cleaned = text(value, field, 64);
  if (!HASH.test(cleaned)) {
    throw new LocalPublishJobError(
      `${field} must be a lowercase SHA-256 digest`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return cleaned;
}

export function parseManualPublicReceiptSupersessionInput(
  value: unknown,
): ManualPublicReceiptSupersessionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Request body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  const expectedKeys = [
    'batchId',
    'batchItemId',
    'confirmed',
    'expectedNotionVersion',
    'itemHash',
    'jobId',
    'manifestHash',
    'noteId',
    'notionPageId',
    'provenance',
    'shareUrl',
    'snapshotRevision',
    'supersedeAmbiguousWorkerAttempt',
  ].sort();
  const keys = Object.keys(body).sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new LocalPublishJobError(
      'Request body contains unsupported fields',
      'VALIDATION_ERROR',
      400,
    );
  }
  if (body.confirmed !== true || body.supersedeAmbiguousWorkerAttempt !== true) {
    throw new LocalPublishJobError(
      'Explicit manual receipt supersession confirmation is required',
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
  if (body.provenance !== 'manual') {
    throw new LocalPublishJobError(
      'provenance must be manual',
      'VALIDATION_ERROR',
      400,
    );
  }
  const expectedNotionVersion = text(
    body.expectedNotionVersion,
    'expectedNotionVersion',
    64,
  );
  if (Number.isNaN(new Date(expectedNotionVersion).getTime())) {
    throw new LocalPublishJobError(
      'expectedNotionVersion must be an ISO timestamp',
      'VALIDATION_ERROR',
      400,
    );
  }
  const snapshotRevision = text(body.snapshotRevision, 'snapshotRevision', 64);
  if (Number.isNaN(new Date(snapshotRevision).getTime())) {
    throw new LocalPublishJobError(
      'snapshotRevision must be an ISO timestamp',
      'VALIDATION_ERROR',
      400,
    );
  }
  const noteId = text(body.noteId, 'noteId', 128);
  const shareUrl = text(body.shareUrl, 'shareUrl', 500);
  const identity = normalizeRednotePublicIdentity(shareUrl);
  if (!identity || identity.noteId !== noteId || identity.shareUrl !== shareUrl) {
    throw new LocalPublishJobError(
      'noteId and shareUrl must be the same canonical public RedNote identity',
      'INVALID_REDNOTE_IDENTITY',
      400,
    );
  }
  return {
    notionPageId: text(body.notionPageId, 'notionPageId', 64),
    expectedNotionVersion,
    jobId: uuid(body.jobId, 'jobId'),
    batchId: uuid(body.batchId, 'batchId'),
    batchItemId: uuid(body.batchItemId, 'batchItemId'),
    manifestHash: hash(body.manifestHash, 'manifestHash'),
    itemHash: hash(body.itemHash, 'itemHash'),
    snapshotRevision,
    noteId,
    shareUrl,
    provenance: 'manual',
  };
}
