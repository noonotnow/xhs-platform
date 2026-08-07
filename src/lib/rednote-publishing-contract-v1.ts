export const REDNOTE_PUBLISHING_CONTRACT_REVISION =
  'rednote-publishing/v1' as const;

export const REDNOTE_POST_STATUSES = [
  'Not started',
  'Draft',
  'In progress',
  'Ready',
  'Published',
] as const;
export type RednotePostStatus = (typeof REDNOTE_POST_STATUSES)[number];

export const REDNOTE_NEXT_ACTIONS = [
  'Develop packet',
  'Ready for publication',
  'Resolve attempt',
  'Backfill receipt',
  'Backfill metrics',
  'Reconciled',
  'Blocked',
] as const;
export type RednoteNextAction = (typeof REDNOTE_NEXT_ACTIONS)[number];

export const REDNOTE_PUBLISH_EXECUTIONS = [
  'Not attempted',
  'Worker claimed',
  'Worker batched',
  'Worker batch failed',
  'Operator scheduled',
] as const;
export type RednotePublishExecution =
  (typeof REDNOTE_PUBLISH_EXECUTIONS)[number];

export const REDNOTE_TERMINAL_ATTEMPT_OUTCOMES = [
  'accepted',
  'known_failed',
  'outcome_unknown',
] as const;
export type RednoteTerminalAttemptOutcome =
  (typeof REDNOTE_TERMINAL_ATTEMPT_OUTCOMES)[number];

export const REDNOTE_EXECUTOR_TYPES = ['worker', 'operator'] as const;
export type RednoteExecutorType = (typeof REDNOTE_EXECUTOR_TYPES)[number];

export const REDNOTE_EXECUTOR_KINDS = [
  'playwright',
  'microservice',
  'operator',
] as const;
export type RednoteExecutorKind = (typeof REDNOTE_EXECUTOR_KINDS)[number];

export const REDNOTE_TRANSACTION_REQUESTERS = [
  'create',
  'plan',
  'admin',
] as const;
export type RednoteTransactionRequester =
  (typeof REDNOTE_TRANSACTION_REQUESTERS)[number];

export const REDNOTE_RECEIPT_LOOKUP_STATES = [
  'pending',
  'found',
  'not_found',
  'not_required',
] as const;
export type RednoteReceiptLookupState =
  (typeof REDNOTE_RECEIPT_LOOKUP_STATES)[number];

export const REDNOTE_CANONICAL_PROPERTIES = {
  status: 'Status',
  nextAction: 'Next action',
  publishExecution: 'Publish execution',
  activeAttemptId: 'Active XHS attempt ID',
  scheduledDate: 'ScheduledDate',
  platformPublishTime: 'Platform publish time',
  rednoteUrl: 'Rednote URL',
  rednoteNoteId: 'Rednote Note ID',
} as const;

export type RednoteCanonicalPropertyName =
  (typeof REDNOTE_CANONICAL_PROPERTIES)[keyof typeof REDNOTE_CANONICAL_PROPERTIES];

export const REDNOTE_LEGACY_READ_ALIASES = {
  nextAction: ['Backfill metadata', 'Backfill URL/metrics'],
} as const;

export type RednoteLegacyReadAlias =
  (typeof REDNOTE_LEGACY_READ_ALIASES)[keyof typeof REDNOTE_LEGACY_READ_ALIASES][number];

export type RednoteNextActionReadResult =
  | { kind: 'canonical'; value: RednoteNextAction }
  | {
      kind: 'legacy_classification_required';
      legacyValue: RednoteLegacyReadAlias;
      candidates: readonly ['Backfill receipt', 'Backfill metrics', 'Reconciled'];
    };

export function resolveNextActionRead(
  value: string,
  context: {
    hasReceiptIdentity: boolean;
    metricsComplete: boolean;
  },
): RednoteNextActionReadResult | undefined {
  if (value === 'Backfill metadata' || value === 'Backfill URL/metrics') {
    if (!context.hasReceiptIdentity) {
      return { kind: 'canonical', value: 'Backfill receipt' };
    }
    if (!context.metricsComplete) {
      return { kind: 'canonical', value: 'Backfill metrics' };
    }
    return {
      kind: 'legacy_classification_required',
      legacyValue: value,
      candidates: ['Backfill receipt', 'Backfill metrics', 'Reconciled'],
    };
  }
  const canonical = REDNOTE_NEXT_ACTIONS.find((candidate) => candidate === value);
  return canonical ? { kind: 'canonical', value: canonical } : undefined;
}

export function assertCanonicalNextActionWrite(
  value: string,
): void {
  if (value === 'Backfill metadata' || value === 'Backfill URL/metrics') {
    throw new Error(`${value} is a read-only legacy alias; write Backfill receipt`);
  }
  if (!REDNOTE_NEXT_ACTIONS.some((candidate) => candidate === value)) {
    throw new Error(`${value} is not a canonical Next action`);
  }
}

export function assertCanonicalStatusWrite(
  value: string,
): asserts value is RednotePostStatus {
  if (!REDNOTE_POST_STATUSES.some((candidate) => candidate === value)) {
    throw new Error(`${value} is not a canonical Status`);
  }
}

export function assertCanonicalPublishExecutionWrite(
  value: string,
): asserts value is RednotePublishExecution {
  if (!REDNOTE_PUBLISH_EXECUTIONS.some((candidate) => candidate === value)) {
    throw new Error(`${value} is not a canonical Publish execution`);
  }
}

export type RednoteExecutorIdentity =
  | {
      type: 'worker';
      kind: 'playwright';
      id: string;
      workerRunId?: string;
      playwrightRunId?: string;
    }
  | {
      type: 'worker';
      kind: 'microservice';
      id: string;
      workerRunId?: string;
      playwrightRunId?: never;
    }
  | {
      type: 'operator';
      kind: 'operator';
      id: string;
      workerRunId?: never;
      playwrightRunId?: never;
    };

export type RednoteMediaType = 'image' | 'video';
export type RednoteMediaRole = 'content' | 'cover' | 'poster';

export interface FrozenRednoteMediaAsset {
  assetId: string;
  deliveryUrl: string;
  sha256: string;
  mediaType: RednoteMediaType;
  role: RednoteMediaRole;
}

interface FrozenRednoteBrowserPayloadBase {
  sourcePostId: string;
  title: string;
  caption: string;
  tags: readonly string[];
  scheduledDate: string | null;
  targetPublishAt: string;
  timingMode: 'scheduled' | 'post_now';
  visibility: 'public' | 'private';
}

export type FrozenRednoteBrowserPayload =
  | (FrozenRednoteBrowserPayloadBase & {
      publishMode: 'image';
      mediaAssets: readonly [
        FrozenRednoteMediaAsset & { mediaType: 'image'; role: 'content' },
        ...(FrozenRednoteMediaAsset & {
          mediaType: 'image';
          role: 'content';
        })[],
      ];
      coverAsset?: never;
      posterAsset?: never;
    })
  | (FrozenRednoteBrowserPayloadBase & {
      publishMode: 'video';
      mediaAssets: readonly [
        FrozenRednoteMediaAsset & { mediaType: 'video'; role: 'content' },
      ];
      coverAsset?: FrozenRednoteMediaAsset & {
        mediaType: 'image';
        role: 'cover';
      };
      posterAsset?: FrozenRednoteMediaAsset & {
        mediaType: 'image';
        role: 'poster';
      };
    });

export interface RednoteAttemptTransactionRequest {
  requestedBy: RednoteTransactionRequester;
  idempotencyKey: string;
  payload: FrozenRednoteAttemptPayload;
}

export interface FrozenRednoteAttemptPayload {
  contractRevision: typeof REDNOTE_PUBLISHING_CONTRACT_REVISION;
  sourceNotionPageId: string;
  sourceLocalPublishJobId?: string;
  payloadRevision: string;
  payloadDigest: string;
  requestedAt: string;
  executor: RednoteExecutorIdentity;
  browserPayload: FrozenRednoteBrowserPayload;
}

export function toRednoteBrowserExecutionPayload(
  attempt: FrozenRednoteAttemptPayload,
): FrozenRednoteBrowserPayload {
  return attempt.browserPayload;
}

export const REDNOTE_ATTEMPT_EVENT_TYPES = [
  'attempt_created',
  'worker_claimed',
  'worker_batched',
  'worker_batch_failed',
  'execution_started',
  'execution_evidence',
  'terminal_outcome_recorded',
  'receipt_lookup',
  'superseded',
] as const;
export type RednoteAttemptEventType =
  (typeof REDNOTE_ATTEMPT_EVENT_TYPES)[number];

export interface RednoteAttemptEvidence {
  kind: string;
  reference?: string;
  capturedAt: string;
  data?: Readonly<Record<string, unknown>>;
}

export interface RednoteAttemptEvent {
  attemptId: string;
  type: RednoteAttemptEventType;
  occurredAt: string;
  actor: {
    type: RednoteExecutorType | RednoteTransactionRequester;
    id: string;
  };
  evidence?: readonly RednoteAttemptEvidence[];
  diagnostics?: Readonly<Record<string, unknown>>;
}

export interface RednotePublishReceipt {
  attemptId: string;
  rednoteUrl: string;
  rednoteNoteId: string;
  platformPublishTime: string;
  capturedAt: string;
  provenance: Readonly<Record<string, unknown>>;
}

export function hasAtomicPublishedIdentity(value: {
  rednoteUrl?: string | null;
  rednoteNoteId?: string | null;
}): boolean {
  return Boolean(value.rednoteUrl) === Boolean(value.rednoteNoteId);
}

export function assertPublishedInvariant(value: {
  status: RednotePostStatus;
  rednoteUrl?: string | null;
  rednoteNoteId?: string | null;
}): void {
  if (
    !hasAtomicPublishedIdentity(value) ||
    (value.status === 'Published' &&
      (!value.rednoteUrl || !value.rednoteNoteId))
  ) {
    throw new Error('Published requires Rednote URL and Rednote Note ID atomically');
  }
}

export function workerAttemptMayRemainActive(value: {
  executorType: RednoteExecutorType;
  terminalOutcome?: RednoteTerminalAttemptOutcome | null;
  receiptLookupState: RednoteReceiptLookupState;
}): boolean {
  return value.executorType === 'worker' &&
    value.terminalOutcome !== 'known_failed' &&
    value.receiptLookupState !== 'found' &&
    value.receiptLookupState !== 'not_required';
}

export function shouldClearActiveAttempt(reason: {
  knownFailure?: boolean;
  operatorSupersession?: boolean;
  receiptCaptured?: boolean;
}): boolean {
  return Boolean(
    reason.knownFailure ||
    reason.operatorSupersession ||
    reason.receiptCaptured,
  );
}

export function assertNewAttemptForRetry(value: {
  previousAttemptId: string;
  requestedAttemptId: string;
}): void {
  if (value.previousAttemptId === value.requestedAttemptId) {
    throw new Error('Intentional retry requires a new attempt ID');
  }
}

export function isAttemptResultCurrent(value: {
  resultAttemptId: string;
  activeAttemptId: string | null;
  supersededByAttemptId?: string | null;
}): boolean {
  return value.activeAttemptId === value.resultAttemptId &&
    !value.supersededByAttemptId;
}
