import { isDeepStrictEqual } from 'util';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';
import {
  REDNOTE_PUBLISHING_CONTRACT_REVISION,
  type FrozenRednoteAttemptPayload,
  type RednoteAttemptEvent,
  type RednoteAttemptEventType,
  type RednoteAttemptEvidence,
  type RednotePublishExecution,
  type RednotePublishReceipt,
  type RednotePostStatus,
  type RednoteNextAction,
  type RednoteReceiptLookupState,
  type RednoteTerminalAttemptOutcome,
  type RednoteTransactionRequester,
  type RednoteAttemptTransactionRequest,
} from '@/lib/rednote-publishing-contract-v1';
import {
  RednotePublishingError,
  validateRednoteReceiptIdentity,
} from '@/lib/rednote-publishing-input';

type Queryable = Pick<PoolClient, 'query'>;
export interface RednoteDatabasePool {
  connect(): Promise<Queryable & { release(): void }>;
}

export interface RednoteAttemptRow extends QueryResultRow {
  id: string;
  contract_revision: typeof REDNOTE_PUBLISHING_CONTRACT_REVISION;
  source_notion_page_id: string;
  source_post_revision: string;
  source_local_publish_job_id: string | null;
  frozen_payload: FrozenRednoteAttemptPayload;
  payload_digest: string;
  payload_revision: string;
  executor_type: 'worker' | 'operator';
  executor_kind: 'playwright' | 'microservice' | 'operator';
  executor_id: string;
  worker_run_id: string | null;
  playwright_run_id: string | null;
  target_publish_at: Date | string | null;
  requested_at: Date | string;
  created_at: Date | string;
  terminal_outcome: RednoteTerminalAttemptOutcome | null;
  terminal_at: Date | string | null;
  receipt_lookup_state: RednoteReceiptLookupState;
  receipt_lookup_updated_at: Date | string;
  active: boolean;
  activated_at: Date | string | null;
  claim_source_status: 'Ready' | null;
  claim_source_post_revision: string | null;
  claim_packet_authorized_at: Date | string | null;
  supersedes_attempt_id: string | null;
  superseded_by_attempt_id: string | null;
  operator_resolution_started_at: Date | string | null;
  operator_resolution_completed_at: Date | string | null;
  diagnostics: Record<string, unknown>;
}

export interface RednoteAttemptView {
  id: string;
  sourceNotionPageId: string;
  sourcePostRevision: string;
  sourceLocalPublishJobId?: string;
  payload: FrozenRednoteAttemptPayload;
  executor: {
    type: 'worker' | 'operator';
    kind: 'playwright' | 'microservice' | 'operator';
    id: string;
    workerRunId?: string;
    playwrightRunId?: string;
  };
  requestedAt: string;
  createdAt: string;
  targetPublishAt?: string;
  terminalOutcome?: RednoteTerminalAttemptOutcome;
  terminalAt?: string;
  receiptLookupState: RednoteReceiptLookupState;
  receiptLookupUpdatedAt: string;
  active: boolean;
  activatedAt?: string;
  claimSourceStatus?: 'Ready';
  claimSourcePostRevision?: string;
  claimPacketAuthorizedAt?: string;
  supersedesAttemptId?: string;
  supersededByAttemptId?: string;
  operatorResolutionStartedAt?: string;
  operatorResolutionCompletedAt?: string;
  diagnostics: Readonly<Record<string, unknown>>;
}

export interface RednotePostMutationRow extends QueryResultRow {
  id: string;
  attempt_id: string;
  source_notion_page_id: string;
  mutation_kind: string;
  expected_active_attempt_id: string | null;
  expected_source_post_revision: string | null;
  expected_status: RednotePostStatus | null;
  expected_next_action: RednoteNextAction | null;
  expected_publish_execution: RednotePublishExecution | null;
  desired_active_attempt_id: string | null;
  desired_status: RednotePostStatus | null;
  desired_next_action: RednoteNextAction | null;
  desired_publish_execution: RednotePublishExecution | null;
  desired_rednote_url: string | null;
  desired_rednote_note_id: string | null;
  desired_platform_publish_time: Date | string | null;
  claim_worker_run_id: string | null;
  claim_playwright_run_id: string | null;
  claim_occurred_at: Date | string | null;
  claim_actor_id: string | null;
  state: 'pending' | 'applied' | 'conflict';
  attempt_count: number;
  diagnostics: Record<string, unknown>;
  last_error_code: string | null;
  last_error_message: string | null;
  last_attempt_at: Date | string | null;
  applied_at: Date | string | null;
  conflict_at: Date | string | null;
  created_at: Date | string;
}

export interface RednotePostMutationView {
  id: string;
  attemptId: string;
  sourceNotionPageId: string;
  kind: string;
  expected: {
    activeAttemptId: string | null;
    sourcePostRevision?: string;
    status?: RednotePostStatus;
    nextAction?: RednoteNextAction;
    publishExecution?: RednotePublishExecution;
  };
  desired: {
    activeAttemptId: string | null;
    status?: RednotePostStatus;
    nextAction?: RednoteNextAction;
    publishExecution?: RednotePublishExecution;
    rednoteUrl?: string;
    rednoteNoteId?: string;
    platformPublishTime?: string;
  };
  state: 'pending' | 'applied' | 'conflict';
  diagnostics: Readonly<Record<string, unknown>>;
  createdAt: string;
}

export interface RednoteEventRow extends QueryResultRow {
  id: string;
  attempt_id: string;
  event_type: RednoteAttemptEventType;
  occurred_at: Date | string;
  actor_type: RednoteAttemptEvent['actor']['type'];
  actor_id: string;
  evidence: RednoteAttemptEvidence[];
  diagnostics: Record<string, unknown>;
  created_at: Date | string;
}

export interface RednoteReceiptRow extends QueryResultRow {
  id: string;
  attempt_id: string;
  rednote_url: string;
  rednote_note_id: string;
  platform_publish_time: Date | string;
  captured_at: Date | string;
  provenance: Record<string, unknown>;
  created_at: Date | string;
}

export interface ObservedRednotePostExecution {
  activeAttemptId: string | null;
  sourcePostRevision: string;
  status: RednotePostStatus;
  nextAction: RednoteNextAction;
  publishExecution: RednotePublishExecution;
  packetAuthorized?: boolean;
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalTimestamp(value: Date | string | null) {
  return value ? timestamp(value) : undefined;
}

export function rednoteAttemptView(row: RednoteAttemptRow): RednoteAttemptView {
  return {
    id: row.id,
    sourceNotionPageId: row.source_notion_page_id,
    sourcePostRevision: row.source_post_revision,
    ...(row.source_local_publish_job_id
      ? { sourceLocalPublishJobId: row.source_local_publish_job_id }
      : {}),
    payload: row.frozen_payload,
    executor: {
      type: row.executor_type,
      kind: row.executor_kind,
      id: row.executor_id,
      ...(row.worker_run_id ? { workerRunId: row.worker_run_id } : {}),
      ...(row.playwright_run_id
        ? { playwrightRunId: row.playwright_run_id }
        : {}),
    },
    requestedAt: timestamp(row.requested_at),
    createdAt: timestamp(row.created_at),
    ...(optionalTimestamp(row.target_publish_at)
      ? { targetPublishAt: optionalTimestamp(row.target_publish_at) }
      : {}),
    ...(row.terminal_outcome ? { terminalOutcome: row.terminal_outcome } : {}),
    ...(optionalTimestamp(row.terminal_at)
      ? { terminalAt: optionalTimestamp(row.terminal_at) }
      : {}),
    receiptLookupState: row.receipt_lookup_state,
    receiptLookupUpdatedAt: timestamp(row.receipt_lookup_updated_at),
    active: row.active,
    ...(optionalTimestamp(row.activated_at)
      ? { activatedAt: optionalTimestamp(row.activated_at) }
      : {}),
    ...(row.claim_source_status
      ? { claimSourceStatus: row.claim_source_status }
      : {}),
    ...(row.claim_source_post_revision
      ? { claimSourcePostRevision: row.claim_source_post_revision }
      : {}),
    ...(optionalTimestamp(row.claim_packet_authorized_at)
      ? {
          claimPacketAuthorizedAt: optionalTimestamp(
            row.claim_packet_authorized_at,
          ),
        }
      : {}),
    ...(row.supersedes_attempt_id
      ? { supersedesAttemptId: row.supersedes_attempt_id }
      : {}),
    ...(row.superseded_by_attempt_id
      ? { supersededByAttemptId: row.superseded_by_attempt_id }
      : {}),
    ...(optionalTimestamp(row.operator_resolution_started_at)
      ? {
          operatorResolutionStartedAt: optionalTimestamp(
            row.operator_resolution_started_at,
          ),
        }
      : {}),
    ...(optionalTimestamp(row.operator_resolution_completed_at)
      ? {
          operatorResolutionCompletedAt: optionalTimestamp(
            row.operator_resolution_completed_at,
          ),
        }
      : {}),
    diagnostics: row.diagnostics,
  };
}

export function rednotePostMutationView(
  row: RednotePostMutationRow,
): RednotePostMutationView {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    sourceNotionPageId: row.source_notion_page_id,
    kind: row.mutation_kind,
    expected: {
      activeAttemptId: row.expected_active_attempt_id,
      ...(row.expected_source_post_revision
        ? { sourcePostRevision: row.expected_source_post_revision }
        : {}),
      ...(row.expected_status ? { status: row.expected_status } : {}),
      ...(row.expected_next_action
        ? { nextAction: row.expected_next_action }
        : {}),
      ...(row.expected_publish_execution
        ? { publishExecution: row.expected_publish_execution }
        : {}),
    },
    desired: {
      activeAttemptId: row.desired_active_attempt_id,
      ...(row.desired_status ? { status: row.desired_status } : {}),
      ...(row.desired_next_action
        ? { nextAction: row.desired_next_action }
        : {}),
      ...(row.desired_publish_execution
        ? { publishExecution: row.desired_publish_execution }
        : {}),
      ...(row.desired_rednote_url
        ? { rednoteUrl: row.desired_rednote_url }
        : {}),
      ...(row.desired_rednote_note_id
        ? { rednoteNoteId: row.desired_rednote_note_id }
        : {}),
      ...(optionalTimestamp(row.desired_platform_publish_time)
        ? {
            platformPublishTime: optionalTimestamp(
              row.desired_platform_publish_time,
            ),
          }
        : {}),
    },
    state: row.state,
    diagnostics: row.diagnostics,
    createdAt: timestamp(row.created_at),
  };
}

function storeError(message: string, code: string, status = 409) {
  return new RednotePublishingError(message, code, status);
}

async function begin(client: Queryable) {
  await client.query('BEGIN');
}

async function rollback(client: Queryable) {
  await client.query('ROLLBACK');
}

async function commit(client: Queryable) {
  await client.query('COMMIT');
}

async function lockedAttempt(client: Queryable, attemptId: string) {
  const identity = await client.query<
    QueryResultRow & { source_notion_page_id: string }
  >(
    `SELECT source_notion_page_id
     FROM rednote_publish_attempts
     WHERE id = $1::uuid`,
    [attemptId],
  );
  const pageId = identity.rows[0]?.source_notion_page_id;
  if (!pageId) {
    throw storeError('Rednote attempt was not found', 'REDNOTE_ATTEMPT_NOT_FOUND', 404);
  }
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [pageId],
  );
  const result = await client.query<RednoteAttemptRow>(
    'SELECT * FROM rednote_publish_attempts WHERE id = $1::uuid FOR UPDATE',
    [attemptId],
  );
  const row = result.rows[0];
  if (!row || row.source_notion_page_id !== pageId) {
    throw storeError(
      'Rednote attempt identity changed while locking',
      'REDNOTE_DURABLE_STATE_INVALID',
      500,
    );
  }
  return row;
}

async function insertEvent(
  client: Queryable,
  input: {
    attemptId: string;
    type: RednoteAttemptEventType;
    occurredAt: string;
    actor: RednoteAttemptEvent['actor'];
    evidence?: readonly RednoteAttemptEvidence[];
    diagnostics?: Readonly<Record<string, unknown>>;
  },
) {
  const result = await client.query<RednoteEventRow>(
    `INSERT INTO rednote_publish_attempt_events (
       attempt_id, event_type, occurred_at, actor_type, actor_id,
       evidence, diagnostics
     ) VALUES (
       $1::uuid, $2, $3::timestamptz, $4, $5, $6::jsonb, $7::jsonb
     )
     RETURNING *`,
    [
      input.attemptId,
      input.type,
      input.occurredAt,
      input.actor.type,
      input.actor.id,
      JSON.stringify(input.evidence ?? []),
      JSON.stringify(input.diagnostics ?? {}),
    ],
  );
  return result.rows[0]!;
}

async function unresolvedMutation(client: Queryable, pageId: string) {
  const result = await client.query<RednotePostMutationRow>(
    `SELECT *
     FROM rednote_publish_post_mutations
     WHERE source_notion_page_id = $1
       AND state IN ('pending', 'conflict')
     FOR UPDATE`,
    [pageId],
  );
  return result.rows[0];
}

async function insertMutation(
  client: Queryable,
  input: {
    attemptId: string;
    pageId: string;
    kind: string;
    expected: ObservedRednotePostExecution;
    desired: {
      activeAttemptId: string | null;
      status?: RednotePostStatus;
      nextAction?: RednoteNextAction;
      publishExecution?: RednotePublishExecution;
      rednoteUrl?: string;
      rednoteNoteId?: string;
      platformPublishTime?: string;
    };
    state?: 'pending' | 'conflict';
    diagnostics?: Readonly<Record<string, unknown>>;
    claim?: {
      workerRunId: string;
      playwrightRunId?: string;
      occurredAt: string;
      actorId: string;
    };
  },
) {
  const result = await client.query<RednotePostMutationRow>(
    `INSERT INTO rednote_publish_post_mutations (
       attempt_id, source_notion_page_id, mutation_kind,
       expected_active_attempt_id, expected_source_post_revision,
       expected_status, expected_next_action, expected_publish_execution,
       desired_active_attempt_id, desired_status, desired_next_action,
       desired_publish_execution, desired_rednote_url, desired_rednote_note_id,
      desired_platform_publish_time, claim_worker_run_id,
      claim_playwright_run_id, claim_occurred_at, claim_actor_id,
      state, diagnostics, conflict_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14, $15::timestamptz,
       $16, $17, $18::timestamptz, $19,
       $20, $21::jsonb,
       CASE WHEN $20 = 'conflict' THEN CURRENT_TIMESTAMP ELSE NULL END
     )
     RETURNING *`,
    [
      input.attemptId,
      input.pageId,
      input.kind,
      input.expected.activeAttemptId,
      input.expected.sourcePostRevision,
      input.expected.status,
      input.expected.nextAction,
      input.expected.publishExecution,
      input.desired.activeAttemptId,
      input.desired.status ?? null,
      input.desired.nextAction ?? null,
      input.desired.publishExecution ?? null,
      input.desired.rednoteUrl ?? null,
      input.desired.rednoteNoteId ?? null,
      input.desired.platformPublishTime ?? null,
      input.claim?.workerRunId ?? null,
      input.claim?.playwrightRunId ?? null,
      input.claim?.occurredAt ?? null,
      input.claim?.actorId ?? null,
      input.state ?? 'pending',
      JSON.stringify(input.diagnostics ?? {}),
    ],
  );
  return result.rows[0]!;
}

async function insertAttempt(
  client: Queryable,
  request: RednoteAttemptTransactionRequest,
  options?: {
    id?: string;
    terminalOutcome?: RednoteTerminalAttemptOutcome;
    terminalAt?: string;
    supersedesAttemptId?: string;
    operatorResolutionStartedAt?: string;
  },
) {
  const payload = request.payload;
  const result = await client.query<RednoteAttemptRow>(
    `INSERT INTO rednote_publish_attempts (
       id, contract_revision, source_notion_page_id, source_post_revision,
       source_local_publish_job_id, frozen_payload, payload_digest,
       payload_revision, executor_type, executor_kind, executor_id,
       worker_run_id, playwright_run_id, target_publish_at, requested_at,
       terminal_outcome, terminal_at, supersedes_attempt_id,
      operator_resolution_started_at, receipt_lookup_updated_at
     ) VALUES (
       COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5::uuid, $6::jsonb,
       $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15::timestamptz,
       $16, $17::timestamptz, $18::uuid, $19::timestamptz, $15::timestamptz
     )
     RETURNING *`,
    [
      options?.id ?? null,
      payload.contractRevision,
      payload.sourceNotionPageId,
      payload.sourcePostRevision,
      payload.sourceLocalPublishJobId ?? null,
      JSON.stringify(payload),
      payload.payloadDigest,
      payload.payloadRevision,
      payload.executor.type,
      payload.executor.kind,
      payload.executor.id,
      payload.executor.workerRunId ?? null,
      payload.executor.playwrightRunId ?? null,
      payload.browserPayload.targetPublishAt,
      payload.requestedAt,
      options?.terminalOutcome ?? null,
      options?.terminalAt ?? null,
      options?.supersedesAttemptId ?? null,
      options?.operatorResolutionStartedAt ?? null,
    ],
  );
  return result.rows[0]!;
}

async function requestReplay(
  client: Queryable,
  requester: RednoteTransactionRequester,
  idempotencyKey: string,
  rawRequestDigest: string,
  lock = false,
) {
  const result = await client.query<
    QueryResultRow & { raw_request_digest: string; attempt_id: string }
  >(
    `SELECT raw_request_digest, attempt_id
     FROM rednote_publish_attempt_requests
     WHERE requester = $1 AND idempotency_key = $2::uuid
     ${lock ? 'FOR UPDATE' : ''}`,
    [requester, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  if (row.raw_request_digest !== rawRequestDigest) {
    throw storeError(
      'The requester Idempotency-Key belongs to a different request',
      'REDNOTE_IDEMPOTENCY_CONFLICT',
    );
  }
  return row.attempt_id;
}

async function loadAttemptWith(
  client: Queryable,
  attemptId: string,
) {
  const result = await client.query<RednoteAttemptRow>(
    'SELECT * FROM rednote_publish_attempts WHERE id = $1::uuid',
    [attemptId],
  );
  return result.rows[0];
}

export async function loadRednoteAttempt(
  attemptId: string,
  pool: RednoteDatabasePool = getPool(),
) {
  const client = await pool.connect();
  try {
    const row = await loadAttemptWith(client, attemptId);
    return row ? rednoteAttemptView(row) : undefined;
  } finally {
    client.release();
  }
}

export async function createStoredRednoteAttempt(input: {
  request: RednoteAttemptTransactionRequest;
  rawRequestDigest: string;
  validateNew: () => Promise<void>;
  pool?: RednoteDatabasePool;
}) {
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  const lockIdentity =
    `rednote-request:${input.request.requestedBy}:${input.request.idempotencyKey}`;
  try {
    await client.query(
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      [lockIdentity],
    );
    const replayId = await requestReplay(
      client,
      input.request.requestedBy,
      input.request.idempotencyKey,
      input.rawRequestDigest,
    );
    if (replayId) {
      const replay = await loadAttemptWith(client, replayId);
      if (!replay) {
        throw storeError(
          'Idempotency ledger references a missing attempt',
          'REDNOTE_DURABLE_STATE_INVALID',
          500,
        );
      }
      return { attempt: rednoteAttemptView(replay), created: false };
    }

    await input.validateNew();
    await begin(client);
    const racedReplayId = await requestReplay(
      client,
      input.request.requestedBy,
      input.request.idempotencyKey,
      input.rawRequestDigest,
      true,
    );
    if (racedReplayId) {
      const replay = await loadAttemptWith(client, racedReplayId);
      await commit(client);
      if (!replay) {
        throw storeError(
          'Idempotency ledger references a missing attempt',
          'REDNOTE_DURABLE_STATE_INVALID',
          500,
        );
      }
      return { attempt: rednoteAttemptView(replay), created: false };
    }
    const row = await insertAttempt(client, input.request);
    await client.query(
      `INSERT INTO rednote_publish_attempt_requests (
         requester, idempotency_key, raw_request_digest, attempt_id
       ) VALUES ($1, $2::uuid, $3, $4::uuid)`,
      [
        input.request.requestedBy,
        input.request.idempotencyKey,
        input.rawRequestDigest,
        row.id,
      ],
    );
    await insertEvent(client, {
      attemptId: row.id,
      type: 'attempt_created',
      occurredAt: input.request.payload.requestedAt,
      actor: {
        type: input.request.requestedBy,
        id: input.request.payload.executor.id,
      },
    });
    await commit(client);
    return { attempt: rednoteAttemptView(row), created: true };
  } catch (error) {
    try {
      await rollback(client);
    } catch {
      // The transaction may not have started.
    }
    throw error;
  } finally {
    try {
      await client.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [lockIdentity],
      );
    } finally {
      client.release();
    }
  }
}

export async function prepareRednoteWorkerClaim(input: {
  attemptId: string;
  expectedActiveAttemptId: string | null;
  observedPost: ObservedRednotePostExecution;
  workerRunId: string;
  playwrightRunId?: string;
  occurredAt: string;
  actorId: string;
  pool?: RednoteDatabasePool;
}) {
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    await begin(client);
    const attempt = await lockedAttempt(client, input.attemptId);
    if (
      !input.workerRunId.trim() ||
      input.workerRunId.length > 255 ||
      (input.playwrightRunId !== undefined &&
        (!input.playwrightRunId.trim() ||
          input.playwrightRunId.length > 255)) ||
      !input.actorId.trim() ||
      input.actorId.length > 255
    ) {
      throw storeError(
        'Worker claim identity is invalid',
        'REDNOTE_RUN_IDENTITY_INVALID',
        400,
      );
    }
    if (
      attempt.executor_type !== 'worker' ||
      attempt.active ||
      attempt.activated_at ||
      attempt.terminal_outcome ||
      attempt.superseded_by_attempt_id
    ) {
      throw storeError(
        'The attempt is not eligible for its first worker claim',
        'REDNOTE_CLAIM_INELIGIBLE',
      );
    }
    if (
      (attempt.worker_run_id &&
        attempt.worker_run_id !== input.workerRunId) ||
      (attempt.playwright_run_id &&
        attempt.playwright_run_id !== input.playwrightRunId) ||
      (attempt.executor_kind !== 'playwright' && input.playwrightRunId)
    ) {
      throw storeError(
        'Worker or Playwright run identity conflicts with the frozen executor',
        'REDNOTE_RUN_IDENTITY_CONFLICT',
      );
    }
    if (
      input.expectedActiveAttemptId !== null ||
      input.observedPost.activeAttemptId !== null ||
      input.observedPost.activeAttemptId !== input.expectedActiveAttemptId ||
      input.observedPost.status !== 'Ready' ||
      input.observedPost.nextAction !== 'Ready for publication' ||
      input.observedPost.publishExecution !== 'Not attempted' ||
      input.observedPost.sourcePostRevision !== attempt.source_post_revision ||
      input.observedPost.packetAuthorized !== true
    ) {
      throw storeError(
        'The Posts claim CAS, Ready state, or frozen source revision changed',
        'REDNOTE_CLAIM_CAS_CONFLICT',
      );
    }
    const execution = await client.query(
      `SELECT 1 FROM rednote_publish_attempt_events
       WHERE attempt_id = $1::uuid AND event_type = 'execution_started'`,
      [attempt.id],
    );
    if (execution.rows[0]) {
      throw storeError(
        'An attempt with execution evidence cannot be claimed again',
        'REDNOTE_SAME_ATTEMPT_REQUEUE_FORBIDDEN',
      );
    }
    const active = await client.query(
      `SELECT id FROM rednote_publish_attempts
       WHERE source_notion_page_id = $1 AND active
       FOR UPDATE`,
      [attempt.source_notion_page_id],
    );
    const operatorOwner = await client.query(
      `SELECT id FROM rednote_publish_attempts
       WHERE source_notion_page_id = $1
         AND operator_resolution_started_at IS NOT NULL
         AND operator_resolution_completed_at IS NULL
       FOR UPDATE`,
      [attempt.source_notion_page_id],
    );
    const receiptPending = await client.query(
      `SELECT pending.id
       FROM rednote_publish_attempts AS pending
       LEFT JOIN rednote_publish_attempt_receipts AS receipt
         ON receipt.attempt_id = pending.id
       WHERE pending.source_notion_page_id = $1
         AND pending.terminal_outcome = 'accepted'
         AND pending.receipt_lookup_state = 'found'
         AND pending.superseded_by_attempt_id IS NULL
         AND receipt.id IS NULL
       FOR UPDATE OF pending`,
      [attempt.source_notion_page_id],
    );
    if (
      active.rows[0] ||
      operatorOwner.rows[0] ||
      receiptPending.rows[0] ||
      await unresolvedMutation(client, attempt.source_notion_page_id)
    ) {
      throw storeError(
        'Another execution owner or unresolved projection owns this Post',
        'REDNOTE_OWNERSHIP_CONFLICT',
      );
    }
    const mutation = await insertMutation(client, {
      attemptId: attempt.id,
      pageId: attempt.source_notion_page_id,
      kind: 'worker_claim',
      expected: input.observedPost,
      desired: {
        activeAttemptId: attempt.id,
        status: input.observedPost.status,
        nextAction: 'Resolve attempt',
        publishExecution: 'Worker claimed',
      },
      diagnostics: { packetAuthorized: true },
      claim: {
        workerRunId: input.workerRunId,
        ...(input.playwrightRunId
          ? { playwrightRunId: input.playwrightRunId }
          : {}),
        occurredAt: input.occurredAt,
        actorId: input.actorId,
      },
    });
    await commit(client);
    return {
      attempt: rednoteAttemptView(attempt),
      mutation: rednotePostMutationView(mutation),
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

function assertWorkerClaimMutation(
  attempt: RednoteAttemptRow,
  mutation: RednotePostMutationRow | undefined,
) {
  if (
    !mutation ||
    mutation.attempt_id !== attempt.id ||
    mutation.mutation_kind !== 'worker_claim' ||
    !mutation.claim_worker_run_id ||
    !mutation.claim_occurred_at ||
    !mutation.claim_actor_id
  ) {
    throw storeError(
      'Worker claim mutation identity changed',
      'REDNOTE_DURABLE_STATE_INVALID',
      500,
    );
  }
  return mutation;
}

async function finalizeWorkerClaimLocked(
  client: Queryable,
  attempt: RednoteAttemptRow,
  mutation: RednotePostMutationRow,
) {
  assertWorkerClaimMutation(attempt, mutation);
  if (
    attempt.active &&
    attempt.activated_at &&
    attempt.claim_source_status === 'Ready' &&
    attempt.claim_source_post_revision === attempt.source_post_revision &&
    attempt.worker_run_id === mutation.claim_worker_run_id &&
    attempt.playwright_run_id === mutation.claim_playwright_run_id
  ) {
    return attempt;
  }
  if (
    attempt.executor_type !== 'worker' ||
    attempt.active ||
    attempt.activated_at ||
    attempt.terminal_outcome ||
    attempt.superseded_by_attempt_id ||
    mutation.expected_status !== 'Ready' ||
    mutation.expected_source_post_revision !== attempt.source_post_revision
  ) {
    throw storeError(
      'Worker claim state changed before finalization',
      'REDNOTE_CLAIM_FINALIZE_CONFLICT',
    );
  }
  if (
    attempt.executor_kind !== 'playwright' &&
    mutation.claim_playwright_run_id
  ) {
    throw storeError(
      'Microservice attempts cannot bind a Playwright run ID',
      'REDNOTE_RUN_IDENTITY_CONFLICT',
    );
  }
  const updated = await client.query<RednoteAttemptRow>(
    `UPDATE rednote_publish_attempts
     SET active = TRUE,
         activated_at = $2::timestamptz,
         claim_source_status = 'Ready',
         claim_source_post_revision = source_post_revision,
         claim_packet_authorized_at = $2::timestamptz,
         worker_run_id = COALESCE(worker_run_id, $3),
         playwright_run_id = COALESCE(playwright_run_id, $4)
     WHERE id = $1::uuid
       AND NOT active
       AND activated_at IS NULL
       AND terminal_outcome IS NULL
       AND superseded_by_attempt_id IS NULL
       AND (worker_run_id IS NULL OR worker_run_id = $3)
       AND (playwright_run_id IS NULL OR playwright_run_id = $4)
     RETURNING *`,
    [
      attempt.id,
      mutation.claim_occurred_at,
      mutation.claim_worker_run_id,
      mutation.claim_playwright_run_id,
    ],
  );
  if (!updated.rows[0]) {
    throw storeError(
      'Worker run identity or activation changed',
      'REDNOTE_CLAIM_FINALIZE_CONFLICT',
    );
  }
  await insertEvent(client, {
    attemptId: attempt.id,
    type: 'worker_claimed',
    occurredAt: timestamp(mutation.claim_occurred_at!),
    actor: { type: 'worker', id: mutation.claim_actor_id! },
    diagnostics: { mutationId: mutation.id },
  });
  return updated.rows[0];
}

async function lockedMutation(
  client: Queryable,
  mutationId: string,
  attemptId: string,
) {
  const result = await client.query<RednotePostMutationRow>(
    `SELECT * FROM rednote_publish_post_mutations
     WHERE id = $1::uuid AND attempt_id = $2::uuid
     FOR UPDATE`,
    [mutationId, attemptId],
  );
  const mutation = result.rows[0];
  if (!mutation) {
    throw storeError(
      'Rednote Posts mutation was not found',
      'REDNOTE_MUTATION_NOT_FOUND',
      404,
    );
  }
  return mutation;
}

async function mutationAttemptId(client: Queryable, mutationId: string) {
  const result = await client.query<QueryResultRow & { attempt_id: string }>(
    `SELECT attempt_id FROM rednote_publish_post_mutations
     WHERE id = $1::uuid`,
    [mutationId],
  );
  const attemptId = result.rows[0]?.attempt_id;
  if (!attemptId) {
    throw storeError(
      'Rednote Posts mutation was not found',
      'REDNOTE_MUTATION_NOT_FOUND',
      404,
    );
  }
  return attemptId;
}

export async function loadRednotePostMutation(
  mutationId: string,
  pool: RednoteDatabasePool = getPool(),
) {
  const client = await pool.connect();
  try {
    const result = await client.query<RednotePostMutationRow>(
      'SELECT * FROM rednote_publish_post_mutations WHERE id = $1::uuid',
      [mutationId],
    );
    return result.rows[0] ? rednotePostMutationView(result.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function withRednotePostProjectionLock<T>(
  sourceNotionPageId: string,
  action: () => Promise<T>,
  pool: RednoteDatabasePool = getPool(),
) {
  const client = await pool.connect();
  const lockIdentity = `rednote-projection:${sourceNotionPageId}`;
  try {
    await client.query(
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      [lockIdentity],
    );
    return await action();
  } finally {
    try {
      await client.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [lockIdentity],
      );
    } finally {
      client.release();
    }
  }
}

export async function listPendingRednotePostMutations(
  limit = 25,
  pool: RednoteDatabasePool = getPool(),
) {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const client = await pool.connect();
  try {
    const result = await client.query<RednotePostMutationRow>(
      `SELECT * FROM rednote_publish_post_mutations
       WHERE state = 'pending'
       ORDER BY last_attempt_at NULLS FIRST, created_at
       LIMIT $1`,
      [boundedLimit],
    );
    return result.rows.map(rednotePostMutationView);
  } finally {
    client.release();
  }
}

export async function recordRednotePostMutationFailure(input: {
  mutationId: string;
  code: string;
  message: string;
  attemptedAt: string;
  pool?: RednoteDatabasePool;
}) {
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    const result = await client.query<RednotePostMutationRow>(
      `UPDATE rednote_publish_post_mutations
       SET attempt_count = attempt_count + 1,
           last_attempt_at = $2::timestamptz,
           last_error_code = $3,
           last_error_message = $4
       WHERE id = $1::uuid AND state = 'pending'
       RETURNING *`,
      [
        input.mutationId,
        input.attemptedAt,
        input.code.slice(0, 128),
        input.message.slice(0, 1000),
      ],
    );
    return result.rows[0] ? rednotePostMutationView(result.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function conflictRednotePostMutation(input: {
  mutationId: string;
  code: string;
  diagnostics: Readonly<Record<string, unknown>>;
  attemptedAt: string;
  pool?: RednoteDatabasePool;
}) {
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    const result = await client.query<RednotePostMutationRow>(
      `UPDATE rednote_publish_post_mutations
       SET state = 'conflict',
           attempt_count = attempt_count + 1,
           last_attempt_at = $2::timestamptz,
           conflict_at = $2::timestamptz,
           last_error_code = $3,
           last_error_message = 'Posts compare-and-set precondition changed',
           diagnostics = diagnostics || $4::jsonb
       WHERE id = $1::uuid AND state = 'pending'
       RETURNING *`,
      [
        input.mutationId,
        input.attemptedAt,
        input.code.slice(0, 128),
        JSON.stringify(input.diagnostics),
      ],
    );
    return result.rows[0] ? rednotePostMutationView(result.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function completeRednotePostMutation(input: {
  mutationId: string;
  appliedAt: string;
  pool?: RednoteDatabasePool;
}) {
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    await begin(client);
    const attemptId = await mutationAttemptId(client, input.mutationId);
    const attempt = await lockedAttempt(client, attemptId);
    const mutation = await lockedMutation(client, input.mutationId, attempt.id);
    if (mutation.state === 'conflict') {
      throw storeError(
        'A conflicted Posts mutation requires explicit operator repair',
        'REDNOTE_MUTATION_CONFLICT',
      );
    }
    let finalizedAttempt = attempt;
    if (mutation.mutation_kind === 'worker_claim') {
      finalizedAttempt = await finalizeWorkerClaimLocked(
        client,
        attempt,
        mutation,
      );
    }
    if (
      mutation.mutation_kind === 'receipt_capture' &&
      attempt.executor_type === 'operator' &&
      !attempt.operator_resolution_completed_at
    ) {
      const completed = await client.query<RednoteAttemptRow>(
        `UPDATE rednote_publish_attempts
         SET operator_resolution_completed_at = $2::timestamptz
         WHERE id = $1::uuid
           AND operator_resolution_started_at IS NOT NULL
           AND operator_resolution_completed_at IS NULL
           AND superseded_by_attempt_id IS NULL
         RETURNING *`,
        [attempt.id, input.appliedAt],
      );
      if (!completed.rows[0]) {
        throw storeError(
          'Operator receipt ownership changed before publication finalization',
          'REDNOTE_OPERATOR_FINALIZE_CONFLICT',
        );
      }
      finalizedAttempt = completed.rows[0];
    }
    const applied = await client.query<RednotePostMutationRow>(
      `UPDATE rednote_publish_post_mutations
       SET state = 'applied',
           attempt_count = CASE
             WHEN state = 'pending' THEN attempt_count + 1
             ELSE attempt_count
           END,
           last_attempt_at = $2::timestamptz,
           last_error_code = NULL,
           last_error_message = NULL,
           applied_at = COALESCE(applied_at, $2::timestamptz),
           conflict_at = NULL
       WHERE id = $1::uuid AND state IN ('pending', 'applied')
       RETURNING *`,
      [
        mutation.id,
        input.appliedAt,
      ],
    );
    if (!applied.rows[0]) {
      throw storeError(
        'Posts mutation state changed before finalization',
        'REDNOTE_MUTATION_FINALIZE_CONFLICT',
      );
    }
    await commit(client);
    return {
      mutation: rednotePostMutationView(applied.rows[0]),
      attempt: rednoteAttemptView(finalizedAttempt),
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeRednoteWorkerClaim(input: {
  mutationId: string;
  pool?: RednoteDatabasePool;
}) {
  const pool = input.pool ?? getPool();
  const mutation = await loadRednotePostMutation(input.mutationId, pool);
  if (!mutation || mutation.kind !== 'worker_claim') {
    throw storeError(
      'Worker claim mutation was not found',
      'REDNOTE_CLAIM_MUTATION_NOT_FOUND',
      404,
    );
  }
  if (mutation.state !== 'applied') {
    throw storeError(
      'Worker claim cannot execute before Posts verification',
      'REDNOTE_CLAIM_NOT_VERIFIED',
      503,
    );
  }
  const completed = await completeRednotePostMutation({
    mutationId: input.mutationId,
    appliedAt: new Date().toISOString(),
    pool,
  });
  return completed.attempt;
}

export async function appendStoredRednoteAttemptEvent(input: {
  attemptId: string;
  event: Omit<RednoteAttemptEvent, 'attemptId'>;
  workerRunId?: string;
  playwrightRunId?: string;
  pool?: RednoteDatabasePool;
}) {
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    await begin(client);
    const attempt = await lockedAttempt(client, input.attemptId);
    if (
      (attempt.worker_run_id &&
        input.workerRunId &&
        attempt.worker_run_id !== input.workerRunId) ||
      (attempt.playwright_run_id &&
        input.playwrightRunId &&
        attempt.playwright_run_id !== input.playwrightRunId) ||
      (attempt.executor_kind !== 'playwright' && input.playwrightRunId)
    ) {
      throw storeError(
        'Attempt run identity does not match',
        'REDNOTE_RUN_IDENTITY_CONFLICT',
      );
    }
    await client.query(
      `UPDATE rednote_publish_attempts
       SET worker_run_id = COALESCE(worker_run_id, $2),
           playwright_run_id = COALESCE(playwright_run_id, $3)
       WHERE id = $1::uuid`,
      [
        attempt.id,
        input.workerRunId ?? null,
        input.playwrightRunId ?? null,
      ],
    );
    if (input.event.type === 'execution_started') {
      if (
        attempt.executor_type !== 'worker' ||
        !attempt.active ||
        attempt.terminal_outcome ||
        attempt.superseded_by_attempt_id
      ) {
        throw storeError(
          'execution_started requires the current active worker attempt',
          'REDNOTE_EXECUTION_NOT_AUTHORIZED',
        );
      }
      const existing = await client.query<RednoteEventRow>(
        `SELECT * FROM rednote_publish_attempt_events
         WHERE attempt_id = $1::uuid AND event_type = 'execution_started'
         FOR SHARE`,
        [attempt.id],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        const exact =
          timestamp(row.occurred_at) === input.event.occurredAt &&
          row.actor_type === input.event.actor.type &&
          row.actor_id === input.event.actor.id &&
          isDeepStrictEqual(row.evidence, input.event.evidence ?? []) &&
          isDeepStrictEqual(row.diagnostics, input.event.diagnostics ?? {});
        if (!exact) {
          throw storeError(
            'execution_started already exists with different evidence',
            'REDNOTE_EXECUTION_STARTED_CONFLICT',
          );
        }
        await commit(client);
        return row;
      }
    }
    const event = await insertEvent(client, {
      attemptId: attempt.id,
      ...input.event,
    });
    await commit(client);
    return event;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordStoredRednoteTerminalOutcome(input: {
  attemptId: string;
  outcome: RednoteTerminalAttemptOutcome;
  occurredAt: string;
  actorId: string;
  observedPost: ObservedRednotePostExecution;
  evidence?: readonly RednoteAttemptEvidence[];
  pool?: RednoteDatabasePool;
}) {
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    await begin(client);
    const attempt = await lockedAttempt(client, input.attemptId);
    const current =
      attempt.executor_type === 'worker' &&
      attempt.active &&
      !attempt.superseded_by_attempt_id &&
      input.observedPost.activeAttemptId === attempt.id;
    if (!current) {
      const event = await insertEvent(client, {
        attemptId: attempt.id,
        type: 'execution_evidence',
        occurredAt: input.occurredAt,
        actor: { type: 'worker', id: input.actorId },
        evidence: input.evidence,
        diagnostics: {
          staleResult: true,
          code: 'REDNOTE_STALE_RESULT',
          observedActiveAttemptId: input.observedPost.activeAttemptId,
        },
      });
      await commit(client);
      return {
        attempt: rednoteAttemptView(attempt),
        stale: true,
        event,
      };
    }
    if (attempt.terminal_outcome) {
      if (attempt.terminal_outcome !== input.outcome) {
        throw storeError(
          'Terminal outcome is already set',
          'REDNOTE_TERMINAL_OUTCOME_CONFLICT',
        );
      }
      await commit(client);
      return { attempt: rednoteAttemptView(attempt), stale: false };
    }
    if (await unresolvedMutation(client, attempt.source_notion_page_id)) {
      throw storeError(
        'An unresolved Posts mutation blocks terminal projection',
        'REDNOTE_MUTATION_PENDING',
        503,
      );
    }
    const knownFailureDiverged =
      input.outcome === 'known_failed' &&
      (
        attempt.claim_source_status !== 'Ready' ||
        !attempt.claim_packet_authorized_at ||
        input.observedPost.status !== 'Ready' ||
        input.observedPost.nextAction !== 'Resolve attempt' ||
        input.observedPost.publishExecution !== 'Worker claimed'
      );
    const update = await client.query<RednoteAttemptRow>(
      `UPDATE rednote_publish_attempts
       SET terminal_outcome = $2,
           terminal_at = $3::timestamptz,
           active = CASE WHEN $2 IN ('known_failed') THEN FALSE ELSE active END,
           receipt_lookup_state =
             CASE WHEN $2 = 'known_failed' THEN 'not_required'
                  ELSE receipt_lookup_state END,
           receipt_lookup_updated_at =
             CASE WHEN $2 = 'known_failed' THEN $3::timestamptz
                  ELSE receipt_lookup_updated_at END
       WHERE id = $1::uuid AND terminal_outcome IS NULL
       RETURNING *`,
      [attempt.id, input.outcome, input.occurredAt],
    );
    const updated = update.rows[0]!;
    const desired = input.outcome === 'known_failed'
      ? {
          activeAttemptId: null,
          status: 'Ready' as const,
          nextAction: 'Ready for publication' as const,
          publishExecution: 'Worker batch failed' as const,
        }
      : input.outcome === 'accepted'
        ? {
            activeAttemptId: attempt.id,
            status: input.observedPost.status,
            nextAction: 'Backfill receipt' as const,
            publishExecution: 'Worker batched' as const,
          }
        : {
            activeAttemptId: attempt.id,
            status: input.observedPost.status,
            nextAction: 'Resolve attempt' as const,
            publishExecution: 'Worker claimed' as const,
          };
    const mutation = await insertMutation(client, {
      attemptId: attempt.id,
      pageId: attempt.source_notion_page_id,
      kind: input.outcome,
      expected: {
        ...input.observedPost,
        ...(input.outcome === 'known_failed'
          ? { status: 'Ready' as const }
          : {}),
      },
      desired,
      state: knownFailureDiverged ? 'conflict' : 'pending',
      diagnostics: knownFailureDiverged
        ? {
            code: 'REDNOTE_KNOWN_FAILURE_LIFECYCLE_DIVERGED',
            observedStatus: input.observedPost.status,
            claimSourceStatus: attempt.claim_source_status,
          }
        : {},
    });
    await insertEvent(client, {
      attemptId: attempt.id,
      type: 'terminal_outcome_recorded',
      occurredAt: input.occurredAt,
      actor: { type: 'worker', id: input.actorId },
      evidence: input.evidence,
      diagnostics: knownFailureDiverged
        ? { mutationConflict: true, mutationId: mutation.id }
        : { mutationId: mutation.id },
    });
    await commit(client);
    return {
      attempt: rednoteAttemptView(updated),
      mutation: rednotePostMutationView(mutation),
      stale: false,
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function advanceStoredRednoteReceiptLookup(input: {
  attemptId: string;
  state: Exclude<RednoteReceiptLookupState, 'pending'>;
  occurredAt: string;
  actor: RednoteAttemptEvent['actor'];
  evidence?: readonly RednoteAttemptEvidence[];
  pool?: RednoteDatabasePool;
}) {
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    await begin(client);
    const attempt = await lockedAttempt(client, input.attemptId);
    if (attempt.terminal_outcome !== 'accepted' || attempt.superseded_by_attempt_id) {
      await insertEvent(client, {
        attemptId: attempt.id,
        type: 'receipt_lookup',
        occurredAt: input.occurredAt,
        actor: input.actor,
        evidence: input.evidence,
        diagnostics: { staleResult: true, requestedState: input.state },
      });
      await commit(client);
      return { attempt: rednoteAttemptView(attempt), stale: true };
    }
    if (attempt.receipt_lookup_state === input.state) {
      await commit(client);
      return { attempt: rednoteAttemptView(attempt), stale: false };
    }
    const valid =
      attempt.receipt_lookup_state === 'pending' ||
      (
        attempt.receipt_lookup_state === 'not_found' &&
        (input.state === 'found' || input.state === 'not_required')
      );
    if (!valid) {
      throw storeError(
        'Receipt lookup state cannot move backwards',
        'REDNOTE_RECEIPT_LOOKUP_CONFLICT',
      );
    }
    const updated = await client.query<RednoteAttemptRow>(
      `UPDATE rednote_publish_attempts
       SET receipt_lookup_state = $2,
           receipt_lookup_updated_at = $3::timestamptz,
           active = CASE WHEN $2 IN ('found', 'not_required')
                         THEN FALSE ELSE active END
       WHERE id = $1::uuid
       RETURNING *`,
      [attempt.id, input.state, input.occurredAt],
    );
    await insertEvent(client, {
      attemptId: attempt.id,
      type: 'receipt_lookup',
      occurredAt: input.occurredAt,
      actor: input.actor,
      evidence: input.evidence,
      diagnostics: {
        previousState: attempt.receipt_lookup_state,
        state: input.state,
        evidenceOnly: input.state === 'found',
      },
    });
    await commit(client);
    return { attempt: rednoteAttemptView(updated.rows[0]!), stale: false };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

function exactReceipt(row: RednoteReceiptRow, receipt: RednotePublishReceipt) {
  return (
    row.attempt_id === receipt.attemptId &&
    row.rednote_url === receipt.rednoteUrl &&
    row.rednote_note_id === receipt.rednoteNoteId &&
    timestamp(row.platform_publish_time) === receipt.platformPublishTime &&
    timestamp(row.captured_at) === receipt.capturedAt &&
    isDeepStrictEqual(row.provenance, receipt.provenance)
  );
}

export async function captureStoredRednoteReceipt(input: {
  receipt: RednotePublishReceipt;
  actor: RednoteAttemptEvent['actor'];
  observedPost: ObservedRednotePostExecution;
  pool?: RednoteDatabasePool;
}) {
  const identity = validateRednoteReceiptIdentity(input.receipt);
  input = {
    ...input,
    receipt: { ...input.receipt, ...identity },
  };
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    await begin(client);
    const attempt = await lockedAttempt(client, input.receipt.attemptId);
    const existing = await client.query<RednoteReceiptRow>(
      `SELECT * FROM rednote_publish_attempt_receipts
       WHERE attempt_id = $1::uuid FOR SHARE`,
      [attempt.id],
    );
    if (existing.rows[0]) {
      if (!exactReceipt(existing.rows[0], input.receipt)) {
        throw storeError(
          'Attempt already has a different immutable receipt',
          'REDNOTE_RECEIPT_CONFLICT',
        );
      }
      await commit(client);
      return { receipt: existing.rows[0], created: false };
    }
    const baseEligible =
      attempt.terminal_outcome === 'accepted' &&
      attempt.receipt_lookup_state === 'found' &&
      !attempt.active &&
      !attempt.superseded_by_attempt_id;
    const workerEligible =
      attempt.executor_type === 'worker' &&
      input.observedPost.activeAttemptId === attempt.id;
    const operatorEligible =
      attempt.executor_type === 'operator' &&
      Boolean(attempt.operator_resolution_started_at) &&
      !attempt.operator_resolution_completed_at &&
      input.observedPost.activeAttemptId === null &&
      input.observedPost.publishExecution === 'Operator scheduled' &&
      input.observedPost.nextAction === 'Backfill receipt';
    const otherActive = await client.query(
      `SELECT id FROM rednote_publish_attempts
       WHERE source_notion_page_id = $1 AND active AND id <> $2::uuid
       FOR UPDATE`,
      [attempt.source_notion_page_id, attempt.id],
    );
    const currentOperator = await client.query(
      `SELECT id FROM rednote_publish_attempts
       WHERE source_notion_page_id = $1
         AND operator_resolution_started_at IS NOT NULL
         AND operator_resolution_completed_at IS NULL
       FOR UPDATE`,
      [attempt.source_notion_page_id],
    );
    const operatorOwnerValid = attempt.executor_type === 'operator'
      ? currentOperator.rows[0]?.id === attempt.id
      : !currentOperator.rows[0];
    if (
      !baseEligible ||
      (!workerEligible && !operatorEligible) ||
      otherActive.rows[0] ||
      !operatorOwnerValid ||
      await unresolvedMutation(client, attempt.source_notion_page_id)
    ) {
      await insertEvent(client, {
        attemptId: attempt.id,
        type: 'execution_evidence',
        occurredAt: input.receipt.capturedAt,
        actor: input.actor,
        evidence: [{
          kind: 'stale_receipt_capture',
          capturedAt: input.receipt.capturedAt,
          data: {
            rednoteNoteId: input.receipt.rednoteNoteId,
            rednoteUrl: input.receipt.rednoteUrl,
          },
        }],
        diagnostics: { staleResult: true, code: 'REDNOTE_STALE_RECEIPT' },
      });
      await commit(client);
      return { created: false, stale: true };
    }
    const inserted = await client.query<RednoteReceiptRow>(
      `INSERT INTO rednote_publish_attempt_receipts (
         attempt_id, rednote_url, rednote_note_id, platform_publish_time,
         captured_at, provenance
       ) VALUES (
         $1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb
       )
       RETURNING *`,
      [
        attempt.id,
        input.receipt.rednoteUrl,
        input.receipt.rednoteNoteId,
        input.receipt.platformPublishTime,
        input.receipt.capturedAt,
        JSON.stringify(input.receipt.provenance),
      ],
    );
    const mutation = await insertMutation(client, {
      attemptId: attempt.id,
      pageId: attempt.source_notion_page_id,
      kind: 'receipt_capture',
      expected: input.observedPost,
      desired: {
        activeAttemptId: null,
        status: 'Published',
        nextAction: 'Backfill metrics',
        publishExecution: input.observedPost.publishExecution,
        rednoteUrl: input.receipt.rednoteUrl,
        rednoteNoteId: input.receipt.rednoteNoteId,
        platformPublishTime: input.receipt.platformPublishTime,
      },
      diagnostics: {
        captureMode: attempt.executor_type,
        operatorResolutionRetained: attempt.executor_type === 'operator',
      },
    });
    await insertEvent(client, {
      attemptId: attempt.id,
      type: 'execution_evidence',
      occurredAt: input.receipt.capturedAt,
      actor: input.actor,
      evidence: [{
        kind: 'receipt_captured',
        capturedAt: input.receipt.capturedAt,
        reference: inserted.rows[0]!.id,
      }],
      diagnostics: {
        mutationId: mutation.id,
        publicationPending: true,
      },
    });
    await commit(client);
    return {
      receipt: inserted.rows[0]!,
      mutation: rednotePostMutationView(mutation),
      created: true,
      stale: false,
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function supersedeStoredRednoteAttempt(input: {
  priorAttemptId: string;
  request: RednoteAttemptTransactionRequest;
  rawRequestDigest: string;
  expectedActiveAttemptId: string;
  observedPost: ObservedRednotePostExecution;
  occurredAt: string;
  actorId: string;
  pool?: RednoteDatabasePool;
}) {
  if (
    input.request.requestedBy !== 'admin' ||
    input.request.payload.executor.type !== 'operator'
  ) {
    throw storeError(
      'Operator supersession requires an admin operator request',
      'REDNOTE_SUPERSESSION_FORBIDDEN',
      403,
    );
  }
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    await begin(client);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`rednote-request:admin:${input.request.idempotencyKey}`],
    );
    const replayId = await requestReplay(
      client,
      'admin',
      input.request.idempotencyKey,
      input.rawRequestDigest,
      true,
    );
    if (replayId) {
      const replay = await loadAttemptWith(client, replayId);
      if (
        !replay ||
        replay.supersedes_attempt_id !== input.priorAttemptId
      ) {
        throw storeError(
          'Idempotent supersession ownership changed',
          'REDNOTE_IDEMPOTENCY_CONFLICT',
        );
      }
      const prior = await loadAttemptWith(client, input.priorAttemptId);
      await commit(client);
      return {
        priorAttempt: rednoteAttemptView(prior!),
        operatorAttempt: rednoteAttemptView(replay),
        created: false,
      };
    }
    const prior = await lockedAttempt(client, input.priorAttemptId);
    if (
      prior.source_notion_page_id !==
        input.request.payload.sourceNotionPageId ||
      !prior.active ||
      prior.superseded_by_attempt_id ||
      input.expectedActiveAttemptId !== prior.id ||
      input.observedPost.activeAttemptId !== prior.id
    ) {
      throw storeError(
        'The exact active worker ownership changed',
        'REDNOTE_SUPERSESSION_CAS_CONFLICT',
      );
    }
    if (await unresolvedMutation(client, prior.source_notion_page_id)) {
      throw storeError(
        'An unresolved projection blocks supersession',
        'REDNOTE_MUTATION_PENDING',
        503,
      );
    }
    const owner = await client.query(
      `SELECT id FROM rednote_publish_attempts
       WHERE source_notion_page_id = $1
         AND operator_resolution_started_at IS NOT NULL
         AND operator_resolution_completed_at IS NULL
       FOR UPDATE`,
      [prior.source_notion_page_id],
    );
    if (owner.rows[0]) {
      throw storeError(
        'Another operator resolution already owns this Post',
        'REDNOTE_OWNERSHIP_CONFLICT',
      );
    }
    const operator = await insertAttempt(client, input.request, {
      terminalOutcome: 'accepted',
      terminalAt: input.occurredAt,
      supersedesAttemptId: prior.id,
      operatorResolutionStartedAt: input.occurredAt,
    });
    const updatedPrior = await client.query<RednoteAttemptRow>(
      `UPDATE rednote_publish_attempts
       SET terminal_outcome = COALESCE(terminal_outcome, 'outcome_unknown'),
           terminal_at = COALESCE(terminal_at, $2::timestamptz),
           active = FALSE,
           receipt_lookup_state =
             CASE WHEN receipt_lookup_state IN ('pending', 'not_found')
                  THEN 'not_required' ELSE receipt_lookup_state END,
           receipt_lookup_updated_at = $2::timestamptz,
           superseded_by_attempt_id = $3::uuid
       WHERE id = $1::uuid
         AND active
         AND superseded_by_attempt_id IS NULL
       RETURNING *`,
      [prior.id, input.occurredAt, operator.id],
    );
    if (!updatedPrior.rows[0]) {
      throw storeError(
        'The active worker changed during supersession',
        'REDNOTE_SUPERSESSION_CAS_CONFLICT',
      );
    }
    await client.query(
      `INSERT INTO rednote_publish_attempt_requests (
         requester, idempotency_key, raw_request_digest, attempt_id
       ) VALUES ('admin', $1::uuid, $2, $3::uuid)`,
      [
        input.request.idempotencyKey,
        input.rawRequestDigest,
        operator.id,
      ],
    );
    await insertEvent(client, {
      attemptId: operator.id,
      type: 'attempt_created',
      occurredAt: input.occurredAt,
      actor: { type: 'admin', id: input.actorId },
    });
    await insertEvent(client, {
      attemptId: operator.id,
      type: 'terminal_outcome_recorded',
      occurredAt: input.occurredAt,
      actor: { type: 'admin', id: input.actorId },
      diagnostics: { operatorResolutionStarted: true },
    });
    await insertEvent(client, {
      attemptId: prior.id,
      type: 'superseded',
      occurredAt: input.occurredAt,
      actor: { type: 'admin', id: input.actorId },
      evidence: [{
        kind: 'operator_supersession',
        reference: operator.id,
        capturedAt: input.occurredAt,
      }],
    });
    const mutation = await insertMutation(client, {
      attemptId: operator.id,
      pageId: prior.source_notion_page_id,
      kind: 'operator_supersession',
      expected: input.observedPost,
      desired: {
        activeAttemptId: null,
        status: input.observedPost.status,
        nextAction: 'Backfill receipt',
        publishExecution: 'Operator scheduled',
      },
    });
    await commit(client);
    return {
      priorAttempt: rednoteAttemptView(updatedPrior.rows[0]),
      operatorAttempt: rednoteAttemptView(operator),
      mutation: rednotePostMutationView(mutation),
      created: true,
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

function mutationMatchesObserved(
  mutation: RednotePostMutationRow,
  observed: ObservedRednotePostExecution,
) {
  return (
    mutation.desired_active_attempt_id === observed.activeAttemptId &&
    (!mutation.desired_status || mutation.desired_status === observed.status) &&
    (!mutation.desired_next_action ||
      mutation.desired_next_action === observed.nextAction) &&
    (!mutation.desired_publish_execution ||
      mutation.desired_publish_execution === observed.publishExecution)
  );
}

export async function transferStoredRednoteOperatorResolution(input: {
  priorOperatorAttemptId: string;
  request: RednoteAttemptTransactionRequest;
  rawRequestDigest: string;
  observedPost: ObservedRednotePostExecution;
  occurredAt: string;
  actorId: string;
  reason: string;
  pool?: RednoteDatabasePool;
}) {
  if (
    input.request.requestedBy !== 'admin' ||
    input.request.payload.executor.type !== 'operator'
  ) {
    throw storeError(
      'Operator ownership transfer requires an admin operator request',
      'REDNOTE_OPERATOR_TRANSFER_FORBIDDEN',
      403,
    );
  }
  const pool = input.pool ?? getPool();
  const client = await pool.connect();
  try {
    await begin(client);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`rednote-request:admin:${input.request.idempotencyKey}`],
    );
    const replayId = await requestReplay(
      client,
      'admin',
      input.request.idempotencyKey,
      input.rawRequestDigest,
      true,
    );
    if (replayId) {
      const replay = await loadAttemptWith(client, replayId);
      const prior = await loadAttemptWith(client, input.priorOperatorAttemptId);
      if (
        !replay ||
        !prior ||
        replay.supersedes_attempt_id !== prior.id ||
        prior.superseded_by_attempt_id !== replay.id
      ) {
        throw storeError(
          'Idempotent operator transfer ownership changed',
          'REDNOTE_IDEMPOTENCY_CONFLICT',
        );
      }
      await commit(client);
      return {
        priorOperatorAttempt: rednoteAttemptView(prior),
        operatorAttempt: rednoteAttemptView(replay),
        created: false,
      };
    }
    if (
      input.observedPost.activeAttemptId !== null ||
      input.observedPost.publishExecution !== 'Operator scheduled' ||
      input.observedPost.nextAction !== 'Backfill receipt'
    ) {
      throw storeError(
        'Operator transfer requires the exact operator receipt projection',
        'REDNOTE_OPERATOR_TRANSFER_CAS_CONFLICT',
      );
    }
    const prior = await lockedAttempt(client, input.priorOperatorAttemptId);
    if (
      prior.executor_type !== 'operator' ||
      !prior.operator_resolution_started_at ||
      prior.operator_resolution_completed_at ||
      prior.superseded_by_attempt_id ||
      prior.source_notion_page_id !== input.request.payload.sourceNotionPageId
    ) {
      throw storeError(
        'The prior operator is not the current resolution owner',
        'REDNOTE_OPERATOR_TRANSFER_OWNERSHIP_CONFLICT',
      );
    }
    const receipt = await client.query(
      `SELECT id FROM rednote_publish_attempt_receipts
       WHERE attempt_id = $1::uuid FOR SHARE`,
      [prior.id],
    );
    if (receipt.rows[0]) {
      throw storeError(
        'Captured receipt ownership must be resolved, not transferred',
        'REDNOTE_OPERATOR_TRANSFER_RECEIPT_EXISTS',
      );
    }
    const activeWorker = await client.query(
      `SELECT id FROM rednote_publish_attempts
       WHERE source_notion_page_id = $1 AND active
       FOR UPDATE`,
      [prior.source_notion_page_id],
    );
    if (activeWorker.rows[0]) {
      throw storeError(
        'An active worker blocks operator ownership transfer',
        'REDNOTE_OPERATOR_TRANSFER_OWNERSHIP_CONFLICT',
      );
    }
    const unresolved = await unresolvedMutation(
      client,
      prior.source_notion_page_id,
    );
    if (unresolved) {
      if (
        unresolved.attempt_id !== prior.id ||
        unresolved.mutation_kind !== 'operator_supersession' ||
        !mutationMatchesObserved(unresolved, input.observedPost)
      ) {
        throw storeError(
          'The unresolved projection needs explicit repair before transfer',
          'REDNOTE_OPERATOR_TRANSFER_MUTATION_CONFLICT',
        );
      }
      await client.query(
        `UPDATE rednote_publish_post_mutations
         SET state = 'applied',
             applied_at = $2::timestamptz,
             conflict_at = NULL,
             diagnostics = diagnostics ||
               jsonb_build_object(
                 'explicitOperatorRepair', true,
                 'repairedBy', $3::text
               )
         WHERE id = $1::uuid
           AND state IN ('pending', 'conflict')`,
        [unresolved.id, input.occurredAt, input.actorId],
      );
    }
    const generated = await client.query<{ id: string }>(
      'SELECT gen_random_uuid() AS id',
    );
    const replacementId = generated.rows[0]!.id;
    const completed = await client.query<RednoteAttemptRow>(
      `UPDATE rednote_publish_attempts
       SET operator_resolution_completed_at = $2::timestamptz,
           superseded_by_attempt_id = $3::uuid,
           receipt_lookup_state =
             CASE WHEN receipt_lookup_state IN ('pending', 'not_found')
                  THEN 'not_required' ELSE receipt_lookup_state END,
           receipt_lookup_updated_at = $2::timestamptz
       WHERE id = $1::uuid
         AND operator_resolution_started_at IS NOT NULL
         AND operator_resolution_completed_at IS NULL
         AND superseded_by_attempt_id IS NULL
       RETURNING *`,
      [prior.id, input.occurredAt, replacementId],
    );
    if (!completed.rows[0]) {
      throw storeError(
        'Operator ownership changed during transfer',
        'REDNOTE_OPERATOR_TRANSFER_OWNERSHIP_CONFLICT',
      );
    }
    const replacement = await insertAttempt(client, input.request, {
      id: replacementId,
      terminalOutcome: 'accepted',
      terminalAt: input.occurredAt,
      supersedesAttemptId: prior.id,
      operatorResolutionStartedAt: input.occurredAt,
    });
    await client.query(
      `INSERT INTO rednote_publish_attempt_requests (
         requester, idempotency_key, raw_request_digest, attempt_id
       ) VALUES ('admin', $1::uuid, $2, $3::uuid)`,
      [
        input.request.idempotencyKey,
        input.rawRequestDigest,
        replacement.id,
      ],
    );
    await insertEvent(client, {
      attemptId: replacement.id,
      type: 'attempt_created',
      occurredAt: input.occurredAt,
      actor: { type: 'admin', id: input.actorId },
      diagnostics: { explicitOperatorTransfer: true },
    });
    await insertEvent(client, {
      attemptId: prior.id,
      type: 'superseded',
      occurredAt: input.occurredAt,
      actor: { type: 'admin', id: input.actorId },
      evidence: [{
        kind: 'operator_resolution_transfer',
        reference: replacement.id,
        capturedAt: input.occurredAt,
        data: { reason: input.reason },
      }],
      diagnostics: { explicitOperatorRepair: true },
    });
    await commit(client);
    return {
      priorOperatorAttempt: rednoteAttemptView(completed.rows[0]),
      operatorAttempt: rednoteAttemptView(replacement),
      created: true,
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
