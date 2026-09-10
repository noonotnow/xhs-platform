import { isDeepStrictEqual } from 'util';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

export const RECOVERABLE_BOUNDED_BATCH_ERROR = 'BOUNDED_BATCH_BYPASS_DISABLED';
export const RECOVERABLE_AMBIGUOUS_CREATOR_ERROR = 'AMBIGUOUS_CREATOR_UI';
export const RECOVERABLE_AMBIGUOUS_CREATOR_MESSAGE =
  'Could not uniquely identify the image upload mode';
export const RECOVERABLE_NOT_LOGGED_IN_ERROR = 'NOT_LOGGED_IN';
export const RECOVERABLE_NOT_LOGGED_IN_MESSAGE =
  'RedNote creator login is required in the persistent browser profile';
export const RECOVERABLE_SCHEDULE_READBACK_MISMATCH_ERROR =
  'SCHEDULE_READBACK_MISMATCH';

export type RecoverableRednotePublishJobError =
  | typeof RECOVERABLE_BOUNDED_BATCH_ERROR
  | typeof RECOVERABLE_AMBIGUOUS_CREATOR_ERROR
  | typeof RECOVERABLE_NOT_LOGGED_IN_ERROR
  | typeof RECOVERABLE_SCHEDULE_READBACK_MISMATCH_ERROR;

export interface RednotePublishJobRecoveryInput {
  batchId: string;
  manifestHash: string;
  itemId: string;
  jobId: string;
  itemHash: string;
  snapshotRevision: string;
}

export interface ExistingRecoveryAudit {
  id: string;
  batchId: string;
  manifestHash: string;
  itemId: string;
  jobId: string;
  itemHash: string;
  snapshotRevision: string;
  recoveredBy: string;
  recoveredAt: string;
  priorErrorCode?: string;
  priorErrorMessage?: string;
  priorClaimAttempts: number;
  priorClaimedAt: string | null;
  priorCompletedAt: string;
}

export interface RecoveryCandidateState {
  batchId: string;
  batchStatus: string;
  manifestHash: string;
  approvedAt: string | null;
  itemId: string;
  itemBatchId: string;
  itemHash: string;
  itemState: string;
  itemLocalPublishJobId: string | null;
  itemSnapshot: LocalPublishSnapshot;
  jobId: string;
  jobBatchItemId: string | null;
  jobStatus: string;
  jobSnapshot: LocalPublishSnapshot;
  jobErrorCode: string | null;
  jobErrorMessage: string | null;
  jobClaimAttempts: number;
  jobClaimToken: string | null;
  jobClaimedAt: string | null;
  jobClaimExpiresAt: string | null;
  jobCompletedAt: string | null;
  stagedAt: string | null;
  dispatchAuthorizedAt: string | null;
  dispatchedAt: string | null;
  noteId: string | null;
  shareUrl: string | null;
  nextVerificationAt: string | null;
  verifiedAt: string | null;
  reconciledAt: string | null;
  verificationAttempts: number;
  activeOwnership: boolean;
  audit: ExistingRecoveryAudit | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SCHEDULE_READBACK_MISMATCH_MESSAGE =
  /^Creator date-picker did not retain the scheduled time \(got "(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d)", expected "(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d)"\)$/;

function isValidScheduleReadbackDateTime(value: string) {
  const [year, month, day, hour, minute] = value.split(/[- :]/).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute
  );
}

function isExactScheduleReadbackMismatchMessage(value: string | null | undefined) {
  const match = value?.match(SCHEDULE_READBACK_MISMATCH_MESSAGE);
  return Boolean(
    match &&
    match[1] !== match[2] &&
    isValidScheduleReadbackDateTime(match[1]) &&
    isValidScheduleReadbackDateTime(match[2]),
  );
}

function recoveryError(message: string, code = 'RECOVERY_PRECONDITION_FAILED') {
  return new LocalPublishJobError(message, code, 409);
}

export function exactRecoverablePublishJobError(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): RecoverableRednotePublishJobError | null {
  if (errorCode === RECOVERABLE_BOUNDED_BATCH_ERROR) {
    return errorCode;
  }
  if (
    errorCode === RECOVERABLE_AMBIGUOUS_CREATOR_ERROR &&
    errorMessage === RECOVERABLE_AMBIGUOUS_CREATOR_MESSAGE
  ) {
    return errorCode;
  }
  if (
    errorCode === RECOVERABLE_NOT_LOGGED_IN_ERROR &&
    errorMessage === RECOVERABLE_NOT_LOGGED_IN_MESSAGE
  ) {
    return errorCode;
  }
  if (
    errorCode === RECOVERABLE_SCHEDULE_READBACK_MISMATCH_ERROR &&
    isExactScheduleReadbackMismatchMessage(errorMessage)
  ) {
    return errorCode;
  }
  return null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new LocalPublishJobError(
      'Recovery body contains unsupported or missing fields',
      'VALIDATION_ERROR',
      400,
    );
  }
}

function uuid(value: unknown, field: string) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new LocalPublishJobError(`${field} must be a UUID`, 'VALIDATION_ERROR', 400);
  }
  return value.toLowerCase();
}

function hash(value: unknown, field: string) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new LocalPublishJobError(
      `${field} must be a lowercase SHA-256 hash`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return value;
}

export function parseRednotePublishJobRecoveryInput(
  value: unknown,
): RednotePublishJobRecoveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Recovery body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  exactKeys(body, [
    'batchId',
    'confirmed',
    'itemHash',
    'itemId',
    'jobId',
    'manifestHash',
    'snapshotRevision',
  ]);
  if (body.confirmed !== true) {
    throw new LocalPublishJobError(
      'Explicit recovery confirmation is required',
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
  const revision = typeof body.snapshotRevision === 'string'
    ? new Date(body.snapshotRevision)
    : null;
  if (
    typeof body.snapshotRevision !== 'string' ||
    body.snapshotRevision.length > 64 ||
    !revision ||
    Number.isNaN(revision.getTime()) ||
    revision.toISOString() !== body.snapshotRevision
  ) {
    throw new LocalPublishJobError(
      'snapshotRevision must be an exact canonical UTC timestamp',
      'VALIDATION_ERROR',
      400,
    );
  }
  return {
    batchId: uuid(body.batchId, 'batchId'),
    manifestHash: hash(body.manifestHash, 'manifestHash'),
    itemId: uuid(body.itemId, 'itemId'),
    jobId: uuid(body.jobId, 'jobId'),
    itemHash: hash(body.itemHash, 'itemHash'),
    snapshotRevision: body.snapshotRevision,
  };
}

function assertImmutableEvidence(
  state: RecoveryCandidateState,
  input: RednotePublishJobRecoveryInput,
) {
  if (
    state.batchId !== input.batchId ||
    state.itemId !== input.itemId ||
    state.jobId !== input.jobId ||
    state.itemBatchId !== input.batchId ||
    state.jobBatchItemId !== input.itemId ||
    state.itemLocalPublishJobId !== input.jobId ||
    state.manifestHash !== input.manifestHash ||
    state.itemHash !== input.itemHash ||
    state.itemSnapshot.notionLastEditedTime !== input.snapshotRevision ||
    state.jobSnapshot.notionLastEditedTime !== input.snapshotRevision ||
    !isDeepStrictEqual(state.itemSnapshot, state.jobSnapshot)
  ) {
    throw recoveryError('Recovery identifiers, hashes, linkage, or immutable snapshots do not match.');
  }
  if (
    state.batchStatus !== 'approved' ||
    !state.approvedAt
  ) {
    throw recoveryError('The bounded batch is not still exactly approved.');
  }
  if (state.activeOwnership) {
    throw recoveryError('Another publish or reconciliation lifecycle owns this post.');
  }
  if (
    state.stagedAt ||
    state.dispatchAuthorizedAt ||
    state.dispatchedAt ||
    state.noteId ||
    state.shareUrl ||
    state.nextVerificationAt ||
    state.verifiedAt ||
    state.reconciledAt ||
    state.verificationAttempts !== 0
  ) {
    throw recoveryError('Staging, dispatch, publication, or verification evidence blocks recovery.');
  }
}

export function validateRecoveryCandidate(
  state: RecoveryCandidateState,
  input: RednotePublishJobRecoveryInput,
  recoveredBy: string,
): 'recover' | 'repair_missing_attempt_lineage' {
  assertImmutableEvidence(state, input);
  if (!recoveredBy.trim() || recoveredBy.length > 320) {
    throw recoveryError('The authenticated recovery operator is unavailable.');
  }
  if (state.audit) {
    if (
      state.audit.batchId !== input.batchId ||
      state.audit.itemId !== input.itemId ||
      state.audit.jobId !== input.jobId ||
      state.audit.manifestHash !== input.manifestHash ||
      state.audit.itemHash !== input.itemHash ||
      state.audit.snapshotRevision !== input.snapshotRevision
    ) {
      throw recoveryError('This job was already recovered with different evidence.');
    }
    if (!state.audit.recoveredBy.trim() || state.audit.recoveredBy.length > 320) {
      throw recoveryError('The immutable recovery audit actor is unavailable.');
    }
    const safelyQueued =
      state.itemState === 'queued' &&
      state.jobStatus === 'queued' &&
      !state.jobErrorCode &&
      !state.jobClaimToken &&
      !state.jobClaimedAt &&
      !state.jobClaimExpiresAt &&
      !state.jobCompletedAt;
    if (safelyQueued) {
      if (
        !exactRecoverablePublishJobError(
          state.audit.priorErrorCode ?? null,
          state.audit.priorErrorMessage ?? null,
        ) ||
        state.jobClaimAttempts !== state.audit.priorClaimAttempts
      ) {
        throw recoveryError('The safely queued job does not match the latest audited claim generation.');
      }
      return 'repair_missing_attempt_lineage';
    }
    if (state.audit.recoveredBy !== recoveredBy) {
      throw recoveryError('This later failed generation is bound to the original recovery actor.');
    }
    const laterClaimGeneration =
      state.jobErrorCode === RECOVERABLE_AMBIGUOUS_CREATOR_ERROR
        ? state.jobClaimAttempts === state.audit.priorClaimAttempts + 1
        : state.jobClaimAttempts > state.audit.priorClaimAttempts;
    if (
      state.itemState !== 'failed' ||
      state.jobStatus !== 'failed' ||
      !exactRecoverablePublishJobError(state.jobErrorCode, state.jobErrorMessage) ||
      !state.jobClaimedAt ||
      !state.jobCompletedAt ||
      !laterClaimGeneration ||
      new Date(state.jobClaimedAt) <= new Date(state.audit.priorCompletedAt) ||
      new Date(state.jobClaimedAt) <= new Date(state.audit.recoveredAt) ||
      new Date(state.jobCompletedAt) <= new Date(state.jobClaimedAt)
    ) {
      throw recoveryError(
        'The job does not prove a distinct later recoverable terminal claim generation.',
      );
    }
    return 'recover';
  }
  if (
    state.itemState !== 'failed' ||
    state.jobStatus !== 'failed' ||
    !exactRecoverablePublishJobError(state.jobErrorCode, state.jobErrorMessage) ||
    state.jobErrorCode === RECOVERABLE_AMBIGUOUS_CREATOR_ERROR ||
    !state.jobCompletedAt
  ) {
    throw recoveryError('Only an exact recoverable terminal pre-dispatch failure is recoverable.');
  }
  return 'recover';
}
