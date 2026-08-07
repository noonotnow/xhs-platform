import { validate as isUuid } from 'uuid';
import {
  REDNOTE_ATTEMPT_EVENT_TYPES,
  type RednoteAttemptEvidence,
  type RednoteAttemptEventType,
  type RednotePublishReceipt,
} from '@/lib/rednote-publishing-contract-v1';
import { RednotePublishingError } from '@/lib/rednote-publishing-input';

function invalid(message: string) {
  return new RednotePublishingError(message, 'REDNOTE_REQUEST_INVALID', 400);
}

function object(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Request body must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw invalid('Request body contains missing or unsupported fields');
  }
  return record;
}

function string(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${key} must be a non-empty string`);
  }
  return value;
}

function iso(record: Record<string, unknown>, key: string) {
  const value = string(record, key);
  let normalized: string;
  try {
    normalized = new Date(value).toISOString();
  } catch {
    throw invalid(`${key} must be an exact ISO timestamp`);
  }
  if (normalized !== value) {
    throw invalid(`${key} must be an exact ISO timestamp`);
  }
  return value;
}

function evidence(value: unknown): readonly RednoteAttemptEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid('evidence must be an array');
  return value.map((item) => {
    const keys = item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item)
      : [];
    const record = object(item, keys);
    const allowed = ['kind', 'reference', 'capturedAt', 'data'];
    if (keys.some((key) => !allowed.includes(key))) {
      throw invalid('Evidence contains unsupported fields');
    }
    const capturedAt = iso(record, 'capturedAt');
    const kind = string(record, 'kind');
    if (
      record.reference !== undefined &&
      typeof record.reference !== 'string'
    ) {
      throw invalid('Evidence reference must be a string');
    }
    if (
      record.data !== undefined &&
      (
        !record.data ||
        typeof record.data !== 'object' ||
        Array.isArray(record.data)
      )
    ) {
      throw invalid('Evidence data must be a JSON object');
    }
    return {
      kind,
      capturedAt,
      ...(record.reference ? { reference: record.reference as string } : {}),
      ...(record.data
        ? { data: record.data as Readonly<Record<string, unknown>> }
        : {}),
    };
  });
}

export function requireRednoteIdempotencyKey(request: Request) {
  const value = request.headers.get('idempotency-key')?.trim();
  if (!value || !isUuid(value)) {
    throw invalid('Idempotency-Key must be a UUID');
  }
  return value;
}

export function requireRednoteUuid(value: string, name = 'id') {
  if (!isUuid(value)) {
    throw invalid(`${name} must be a UUID`);
  }
  return value;
}

export function requireRednoteWorkerCallbackIdentity(request: Request) {
  const workerRunId = request.headers.get('x-rednote-worker-run-id')?.trim();
  const playwrightRunId =
    request.headers.get('x-rednote-playwright-run-id')?.trim();
  if (!workerRunId) {
    throw invalid('X-Rednote-Worker-Run-Id is required');
  }
  return {
    workerRunId,
    ...(playwrightRunId ? { playwrightRunId } : {}),
  };
}

export async function readRednoteJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw invalid('Request body must be valid JSON');
  }
}

export function parseRednoteClaimBody(value: unknown) {
  const record = object(value, [
    'expectedActiveAttemptId',
    'workerRunId',
    'occurredAt',
    ...(value && typeof value === 'object' && 'playwrightRunId' in value
      ? ['playwrightRunId']
      : []),
  ]);
  const expected = record.expectedActiveAttemptId;
  if (expected !== null && (typeof expected !== 'string' || !isUuid(expected))) {
    throw invalid('expectedActiveAttemptId must be a UUID or null');
  }
  return {
    expectedActiveAttemptId: expected as string | null,
    workerRunId: string(record, 'workerRunId'),
    ...(record.playwrightRunId !== undefined
      ? { playwrightRunId: string(record, 'playwrightRunId') }
      : {}),
    occurredAt: iso(record, 'occurredAt'),
  };
}

export function parseRednoteEventBody(value: unknown) {
  const source = value as Record<string, unknown> | null;
  const record = object(value, [
    'type',
    'occurredAt',
    ...(source && 'evidence' in source ? ['evidence'] : []),
    ...(source && 'diagnostics' in source ? ['diagnostics'] : []),
  ]);
  const type = string(record, 'type');
  if (!REDNOTE_ATTEMPT_EVENT_TYPES.includes(type as RednoteAttemptEventType)) {
    throw invalid('type is not a canonical Rednote attempt event');
  }
  if (
    record.diagnostics !== undefined &&
    (
      !record.diagnostics ||
      typeof record.diagnostics !== 'object' ||
      Array.isArray(record.diagnostics)
    )
  ) {
    throw invalid('diagnostics must be a JSON object');
  }
  const parsedEvidence = evidence(record.evidence);
  return {
    type: type as RednoteAttemptEventType,
    occurredAt: iso(record, 'occurredAt'),
    ...(parsedEvidence
      ? { evidence: parsedEvidence }
      : {}),
    ...(record.diagnostics
      ? {
          diagnostics:
            record.diagnostics as Readonly<Record<string, unknown>>,
        }
      : {}),
  };
}

export function parseRednoteOutcomeBody(value: unknown) {
  const source = value as Record<string, unknown> | null;
  const record = object(value, [
    'outcome',
    'occurredAt',
    ...(source && 'evidence' in source ? ['evidence'] : []),
  ]);
  const outcome = string(record, 'outcome');
  if (!['accepted', 'known_failed', 'outcome_unknown'].includes(outcome)) {
    throw invalid('outcome is not canonical');
  }
  const parsedEvidence = evidence(record.evidence);
  return {
    outcome: outcome as 'accepted' | 'known_failed' | 'outcome_unknown',
    occurredAt: iso(record, 'occurredAt'),
    ...(parsedEvidence
      ? { evidence: parsedEvidence }
      : {}),
  };
}

export function parseRednoteReceiptLookupBody(value: unknown) {
  const source = value as Record<string, unknown> | null;
  const record = object(value, [
    'state',
    'occurredAt',
    ...(source && 'evidence' in source ? ['evidence'] : []),
  ]);
  const state = string(record, 'state');
  if (!['not_found', 'found', 'not_required'].includes(state)) {
    throw invalid('state is not canonical');
  }
  const parsedEvidence = evidence(record.evidence);
  return {
    state: state as 'not_found' | 'found' | 'not_required',
    occurredAt: iso(record, 'occurredAt'),
    ...(parsedEvidence
      ? { evidence: parsedEvidence }
      : {}),
  };
}

export function parseRednoteReceiptBody(
  value: unknown,
  attemptId: string,
): RednotePublishReceipt {
  const record = object(value, [
    'attemptId',
    'rednoteUrl',
    'rednoteNoteId',
    'platformPublishTime',
    'capturedAt',
    'provenance',
  ]);
  if (string(record, 'attemptId') !== attemptId) {
    throw invalid('Receipt attemptId does not match the route');
  }
  if (
    !record.provenance ||
    typeof record.provenance !== 'object' ||
    Array.isArray(record.provenance)
  ) {
    throw invalid('provenance must be a JSON object');
  }
  return {
    attemptId,
    rednoteUrl: string(record, 'rednoteUrl'),
    rednoteNoteId: string(record, 'rednoteNoteId'),
    platformPublishTime: iso(record, 'platformPublishTime'),
    capturedAt: iso(record, 'capturedAt'),
    provenance: record.provenance as Readonly<Record<string, unknown>>,
  };
}

export function parseRednoteSupersedeBody(value: unknown) {
  const record = object(value, [
    'request',
    'expectedActiveAttemptId',
    'occurredAt',
  ]);
  const expectedActiveAttemptId = string(record, 'expectedActiveAttemptId');
  if (!isUuid(expectedActiveAttemptId)) {
    throw invalid('expectedActiveAttemptId must be a UUID');
  }
  return {
    request: record.request,
    expectedActiveAttemptId,
    occurredAt: iso(record, 'occurredAt'),
  };
}

export function parseRednoteTransferBody(value: unknown) {
  const record = object(value, ['request', 'occurredAt', 'reason']);
  return {
    request: record.request,
    occurredAt: iso(record, 'occurredAt'),
    reason: string(record, 'reason'),
  };
}
