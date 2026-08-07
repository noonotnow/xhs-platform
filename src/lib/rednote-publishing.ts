import {
  parseRednoteAttemptTransactionRequest,
  RednotePublishingError,
  rednoteStableDigest,
  validateRednoteAttemptSources,
  verifyRednoteAssetBytes,
} from '@/lib/rednote-publishing-input';
import {
  defaultRednoteNotionProjectionAdapter,
  projectRednotePostMutation,
  readRednotePostExecution,
  RednotePostProjectionError,
  type RednoteNotionProjectionAdapter,
} from '@/lib/rednote-publishing-notion';
import {
  advanceStoredRednoteReceiptLookup,
  appendStoredRednoteAttemptEvent,
  captureStoredRednoteReceipt,
  completeRednotePostMutation,
  conflictRednotePostMutation,
  createStoredRednoteAttempt,
  listPendingRednotePostMutations,
  loadRednoteAttemptDetail,
  loadRednotePostMutation,
  prepareRednoteWorkerClaim,
  recordStoredRednoteTerminalOutcome,
  recordRednotePostMutationFailure,
  replayStoredRednoteReceipt,
  replayStoredRednoteWorkerClaim,
  supersedeStoredRednoteAttempt,
  transferStoredRednoteOperatorResolution,
  verifyRednotePostMutation,
  withRednotePostProjectionLock,
  type RednoteDatabasePool,
} from '@/lib/rednote-publishing-store';
import { requireRednotePublishingStartEnabled } from '@/lib/rednote-publishing-feature';
import { getStoredLocalPublishJob } from '@/lib/local-publish-job-store';
import { getXhsPostForManualHandling } from '@/lib/notion-posts';
import type {
  RednoteAttemptEvent,
  RednoteAttemptTransactionRequest,
  RednotePublishReceipt,
} from '@/lib/rednote-publishing-contract-v1';
import type {
  RednoteAdminPrincipal,
  RednoteRequesterPrincipal,
  RednoteWorkerPrincipal,
} from '@/lib/rednote-publishing-auth';

export interface RednoteReconciliationDependencies {
  notion?: RednoteNotionProjectionAdapter;
  pool?: RednoteDatabasePool;
  now?: () => Date;
}

function reconciliationError(error: unknown) {
  if (
    error instanceof RednotePublishingError ||
    error instanceof RednotePostProjectionError
  ) {
    return error;
  }
  return new RednotePostProjectionError(
    'The canonical Posts projection is unavailable',
    'REDNOTE_NOTION_UNAVAILABLE',
  );
}

export async function reconcileRednotePostMutation(
  mutationId: string,
  dependencies: RednoteReconciliationDependencies = {},
) {
  const mutation = await loadRednotePostMutation(
    mutationId,
    dependencies.pool,
  );
  if (!mutation) {
    throw new RednotePublishingError(
      'Rednote Posts mutation was not found',
      'REDNOTE_MUTATION_NOT_FOUND',
      404,
    );
  }
  if (mutation.state === 'applied') return mutation;
  if (mutation.state === 'conflict') {
    throw new RednotePublishingError(
      'A conflicted Posts mutation requires explicit operator repair',
      'REDNOTE_MUTATION_CONFLICT',
      409,
    );
  }
  if (mutation.state === 'verified') {
    const completed = await completeRednotePostMutation({
      mutationId,
      appliedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      pool: dependencies.pool,
    });
    return completed.mutation;
  }

  return withRednotePostProjectionLock(
    mutation.sourceNotionPageId,
    () => reconcileLockedRednotePostMutation(mutationId, dependencies),
    dependencies.pool,
  );
}

async function reconcileLockedRednotePostMutation(
  mutationId: string,
  dependencies: RednoteReconciliationDependencies,
) {
  const mutation = await loadRednotePostMutation(
    mutationId,
    dependencies.pool,
  );
  if (!mutation) {
    throw new RednotePublishingError(
      'Rednote Posts mutation was not found',
      'REDNOTE_MUTATION_NOT_FOUND',
      404,
    );
  }
  if (mutation.state === 'applied') return mutation;
  if (mutation.state === 'conflict') {
    throw new RednotePublishingError(
      'A conflicted Posts mutation requires explicit operator repair',
      'REDNOTE_MUTATION_CONFLICT',
      409,
    );
  }
  const attemptedAt = (dependencies.now?.() ?? new Date()).toISOString();
  try {
    const projection = await projectRednotePostMutation(
      mutation,
      dependencies.notion ?? defaultRednoteNotionProjectionAdapter(),
    );
    if (projection.outcome === 'conflict') {
      const conflicted = await conflictRednotePostMutation({
        mutationId,
        code: 'REDNOTE_POST_CAS_CONFLICT',
        diagnostics: {
          code: 'REDNOTE_POST_CAS_CONFLICT',
          expectedActiveAttemptId: mutation.expected.activeAttemptId,
          observedActiveAttemptId: projection.observed.activeAttemptId,
          observedStatus: projection.observed.status,
          observedNextAction: projection.observed.nextAction,
          observedPublishExecution: projection.observed.publishExecution,
        },
        attemptedAt,
        pool: dependencies.pool,
      });
      if (!conflicted) {
        const raced = await loadRednotePostMutation(
          mutationId,
          dependencies.pool,
        );
        if (raced?.state === 'applied') return raced;
      }
      throw new RednotePublishingError(
        'The canonical Posts execution state changed',
        'REDNOTE_POST_CAS_CONFLICT',
        409,
      );
    }
    await verifyRednotePostMutation({
      mutationId,
      verifiedAt: attemptedAt,
      pool: dependencies.pool,
    });
    const completed = await completeRednotePostMutation({
      mutationId,
      appliedAt: attemptedAt,
      pool: dependencies.pool,
    });
    return completed.mutation;
  } catch (error) {
    const normalized = reconciliationError(error);
    if (
      normalized.status === 409 &&
      normalized.code !== 'REDNOTE_POST_CAS_CONFLICT'
    ) {
      await conflictRednotePostMutation({
        mutationId,
        code: normalized.code,
        diagnostics: {
          code: normalized.code,
          permanentProjectionConflict: true,
        },
        attemptedAt,
        pool: dependencies.pool,
      });
    } else if (normalized.code !== 'REDNOTE_POST_CAS_CONFLICT') {
      await recordRednotePostMutationFailure({
        mutationId,
        code: normalized.code,
        message: normalized.message,
        attemptedAt,
        pool: dependencies.pool,
      });
    }
    throw normalized;
  }
}

export async function reconcilePendingRednotePostMutations(
  limit = 25,
  dependencies: RednoteReconciliationDependencies = {},
) {
  const pending = await listPendingRednotePostMutations(
    limit,
    dependencies.pool,
  );
  const results = [];
  for (const mutation of pending) {
    try {
      results.push({
        mutationId: mutation.id,
        state: (
          await reconcileRednotePostMutation(mutation.id, dependencies)
        ).state,
      });
    } catch (error) {
      const normalized = reconciliationError(error);
      results.push({
        mutationId: mutation.id,
        state: normalized.status === 409 ? 'conflict' : 'pending',
        code: normalized.code,
      });
    }
  }
  return results;
}

export interface RednoteControlPlaneDependencies
  extends RednoteReconciliationDependencies {
  loadPost?: typeof getXhsPostForManualHandling;
  loadLocalJob?: typeof getStoredLocalPublishJob;
  verifyAssets?: typeof verifyRednoteAssetBytes;
}

function requestError(message: string, code: string, status = 400) {
  return new RednotePublishingError(message, code, status);
}

function bindAttemptRequest(
  raw: unknown,
  idempotencyKey: string,
  principal: RednoteRequesterPrincipal,
) {
  const request = parseRednoteAttemptTransactionRequest(raw);
  if (
    request.idempotencyKey !== idempotencyKey ||
    request.requestedBy !== principal.requester
  ) {
    throw requestError(
      'The request identity does not match the authenticated requester',
      'REDNOTE_REQUESTER_MISMATCH',
      403,
    );
  }
  if (
    request.payload.executor.type === 'operator' &&
    (
      principal.requester !== 'admin' ||
      request.payload.executor.id !== principal.actorId
    )
  ) {
    throw requestError(
      'Operator provenance must match the authenticated administrator',
      'REDNOTE_OPERATOR_PROVENANCE_MISMATCH',
      403,
    );
  }
  return request;
}

async function validateAuthoritativeRequest(
  request: RednoteAttemptTransactionRequest,
  dependencies: RednoteControlPlaneDependencies,
) {
  const loadPost = dependencies.loadPost ?? getXhsPostForManualHandling;
  const loadLocalJob = dependencies.loadLocalJob ?? getStoredLocalPublishJob;
  const verifyAssets = dependencies.verifyAssets ?? verifyRednoteAssetBytes;
  const [post] = await Promise.all([
    loadPost(request.payload.sourceNotionPageId),
    verifyAssets(request),
  ]);
  const localJob = request.payload.sourceLocalPublishJobId
    ? await loadLocalJob(request.payload.sourceLocalPublishJobId)
    : null;
  validateRednoteAttemptSources(
    request,
    {
      id: post.id,
      lastEditedTime: post.lastEditedTime,
      status: post.status,
      packetAuthorized: post.publishPacketReady,
      title: post.headline,
      caption: post.caption,
      tags: post.tags,
      scheduledDate: post.scheduledDate,
      mediaUrls: post.mediaUrls,
      ...(post.thumbnailUrl ? { thumbnailUrl: post.thumbnailUrl } : {}),
    },
    localJob
      ? { id: localJob.id, snapshot: localJob.snapshot }
      : undefined,
  );
  return post.lastEditedTime;
}

export async function createRednoteAttempt(input: {
  rawRequest: unknown;
  idempotencyKey: string;
  principal: RednoteRequesterPrincipal;
  dependencies?: RednoteControlPlaneDependencies;
}) {
  const dependencies = input.dependencies ?? {};
  const request = bindAttemptRequest(
    input.rawRequest,
    input.idempotencyKey,
    input.principal,
  );
  if (request.payload.executor.type === 'operator') {
    throw requestError(
      'Operator attempts require supersession or explicit transfer',
      'REDNOTE_OPERATOR_TRANSACTION_REQUIRED',
      409,
    );
  }
  return createStoredRednoteAttempt({
    request,
    rawRequestDigest: rednoteStableDigest(input.rawRequest),
    validateNew: async () => {
      requireRednotePublishingStartEnabled();
      await validateAuthoritativeRequest(request, dependencies);
    },
    pool: dependencies.pool,
  });
}

export async function getRednoteAttempt(
  attemptId: string,
  dependencies: RednoteControlPlaneDependencies = {},
) {
  const detail = await loadRednoteAttemptDetail(attemptId, dependencies.pool);
  if (!detail) {
    throw requestError(
      'Rednote attempt was not found',
      'REDNOTE_ATTEMPT_NOT_FOUND',
      404,
    );
  }
  return detail;
}

export async function claimRednoteAttempt(input: {
  attemptId: string;
  expectedActiveAttemptId: string | null;
  workerRunId: string;
  playwrightRunId?: string;
  occurredAt: string;
  principal: RednoteWorkerPrincipal;
  dependencies?: RednoteControlPlaneDependencies;
}) {
  const dependencies = input.dependencies ?? {};
  const replay = await replayStoredRednoteWorkerClaim({
    attemptId: input.attemptId,
    expectedActiveAttemptId: input.expectedActiveAttemptId,
    workerRunId: input.workerRunId,
    playwrightRunId: input.playwrightRunId,
    occurredAt: input.occurredAt,
    actorId: input.principal.actorId,
    pool: dependencies.pool,
  });
  if (replay) {
    return getRednoteAttempt(input.attemptId, dependencies);
  }
  requireRednotePublishingStartEnabled();
  const notion = dependencies.notion ?? defaultRednoteNotionProjectionAdapter();
  const detail = await getRednoteAttempt(input.attemptId, dependencies);
  const observedPost = await readRednotePostExecution(
    detail.attempt.sourceNotionPageId,
    notion,
  );
  const prepared = await prepareRednoteWorkerClaim({
    attemptId: input.attemptId,
    expectedActiveAttemptId: input.expectedActiveAttemptId,
    observedPost,
    workerRunId: input.workerRunId,
    playwrightRunId: input.playwrightRunId,
    occurredAt: input.occurredAt,
    actorId: input.principal.actorId,
    pool: dependencies.pool,
  });
  await reconcileRednotePostMutation(prepared.mutation.id, dependencies);
  return loadRednoteAttemptDetail(input.attemptId, dependencies.pool);
}

export async function appendRednoteAttemptEvent(input: {
  attemptId: string;
  event: Omit<RednoteAttemptEvent, 'attemptId' | 'actor'>;
  workerRunId?: string;
  playwrightRunId?: string;
  principal: RednoteWorkerPrincipal | RednoteAdminPrincipal;
  dependencies?: RednoteControlPlaneDependencies;
}) {
  return appendStoredRednoteAttemptEvent({
    attemptId: input.attemptId,
    event: {
      ...input.event,
      actor: {
        type: input.principal.requester,
        id: input.principal.actorId,
      },
    },
    workerRunId: input.workerRunId,
    playwrightRunId: input.playwrightRunId,
    pool: input.dependencies?.pool,
  });
}

export async function recordRednoteTerminalOutcome(input: {
  attemptId: string;
  outcome: 'accepted' | 'known_failed' | 'outcome_unknown';
  occurredAt: string;
  evidence?: RednoteAttemptEvent['evidence'];
  workerRunId?: string;
  playwrightRunId?: string;
  principal: RednoteWorkerPrincipal | RednoteAdminPrincipal;
  dependencies?: RednoteControlPlaneDependencies;
}) {
  const dependencies = input.dependencies ?? {};
  const notion = dependencies.notion ?? defaultRednoteNotionProjectionAdapter();
  const detail = await getRednoteAttempt(input.attemptId, dependencies);
  const observedPost = detail.attempt.active &&
      !detail.attempt.supersededByAttemptId
    ? await readRednotePostExecution(
        detail.attempt.sourceNotionPageId,
        notion,
      )
    : undefined;
  const result = await recordStoredRednoteTerminalOutcome({
    attemptId: input.attemptId,
    outcome: input.outcome,
    occurredAt: input.occurredAt,
    evidence: input.evidence,
    workerRunId: input.workerRunId,
    playwrightRunId: input.playwrightRunId,
    observedPost,
    actor: {
      type: input.principal.requester,
      id: input.principal.actorId,
    },
    pool: dependencies.pool,
  });
  if (result.mutation) {
    await reconcileRednotePostMutation(result.mutation.id, dependencies);
  }
  return loadRednoteAttemptDetail(input.attemptId, dependencies.pool);
}

export async function advanceRednoteReceiptLookup(input: {
  attemptId: string;
  state: 'not_found' | 'found' | 'not_required';
  occurredAt: string;
  evidence?: RednoteAttemptEvent['evidence'];
  workerRunId?: string;
  playwrightRunId?: string;
  principal: RednoteWorkerPrincipal | RednoteAdminPrincipal;
  dependencies?: RednoteControlPlaneDependencies;
}) {
  return advanceStoredRednoteReceiptLookup({
    attemptId: input.attemptId,
    state: input.state,
    occurredAt: input.occurredAt,
    evidence: input.evidence,
    workerRunId: input.workerRunId,
    playwrightRunId: input.playwrightRunId,
    actor: {
      type: input.principal.requester,
      id: input.principal.actorId,
    },
    pool: input.dependencies?.pool,
  });
}

export async function captureRednoteReceipt(input: {
  receipt: RednotePublishReceipt;
  workerRunId?: string;
  playwrightRunId?: string;
  principal: RednoteWorkerPrincipal | RednoteAdminPrincipal;
  dependencies?: RednoteControlPlaneDependencies;
}) {
  const dependencies = input.dependencies ?? {};
  const actor = {
    type: input.principal.requester,
    id: input.principal.actorId,
  } as const;
  const replay = await replayStoredRednoteReceipt({
    receipt: input.receipt,
    actor,
    workerRunId: input.workerRunId,
    playwrightRunId: input.playwrightRunId,
    pool: dependencies.pool,
  });
  if (replay) return replay;
  const notion = dependencies.notion ?? defaultRednoteNotionProjectionAdapter();
  const detail = await getRednoteAttempt(input.receipt.attemptId, dependencies);
  const observedPost = await readRednotePostExecution(
    detail.attempt.sourceNotionPageId,
    notion,
  );
  const result = await captureStoredRednoteReceipt({
    receipt: input.receipt,
    observedPost,
    actor,
    workerRunId: input.workerRunId,
    playwrightRunId: input.playwrightRunId,
    pool: dependencies.pool,
  });
  if (result.mutation) {
    await reconcileRednotePostMutation(result.mutation.id, dependencies);
  }
  return result;
}

export async function supersedeRednoteAttempt(input: {
  priorAttemptId: string;
  rawRequest: unknown;
  idempotencyKey: string;
  expectedActiveAttemptId: string;
  occurredAt: string;
  principal: RednoteAdminPrincipal;
  dependencies?: RednoteControlPlaneDependencies;
}) {
  const dependencies = input.dependencies ?? {};
  const request = bindAttemptRequest(
    input.rawRequest,
    input.idempotencyKey,
    input.principal,
  );
  const notion = dependencies.notion ?? defaultRednoteNotionProjectionAdapter();
  const result = await supersedeStoredRednoteAttempt({
    priorAttemptId: input.priorAttemptId,
    request,
    rawRequestDigest: rednoteStableDigest({
      operation: 'supersede',
      priorAttemptId: input.priorAttemptId,
      expectedActiveAttemptId: input.expectedActiveAttemptId,
      occurredAt: input.occurredAt,
      request: input.rawRequest,
    }),
    expectedActiveAttemptId: input.expectedActiveAttemptId,
    occurredAt: input.occurredAt,
    actorId: input.principal.actorId,
    validateNew: async () => {
      requireRednotePublishingStartEnabled();
      const [validatedRevision, observedPost] = await Promise.all([
        validateAuthoritativeRequest(request, dependencies),
        readRednotePostExecution(
          request.payload.sourceNotionPageId,
          notion,
        ),
      ]);
      if (validatedRevision !== observedPost.sourcePostRevision) {
        throw requestError(
          'The authoritative Posts revision changed during validation',
          'REDNOTE_SOURCE_REVISION_MISMATCH',
          409,
        );
      }
      return observedPost;
    },
    pool: dependencies.pool,
  });
  if (result.mutation) {
    await reconcileRednotePostMutation(result.mutation.id, dependencies);
  }
  return result;
}

export async function transferRednoteOperatorResolution(input: {
  priorOperatorAttemptId: string;
  rawRequest: unknown;
  idempotencyKey: string;
  occurredAt: string;
  reason: string;
  principal: RednoteAdminPrincipal;
  dependencies?: RednoteControlPlaneDependencies;
}) {
  const dependencies = input.dependencies ?? {};
  const notion = dependencies.notion ?? defaultRednoteNotionProjectionAdapter();
  const request = bindAttemptRequest(
    input.rawRequest,
    input.idempotencyKey,
    input.principal,
  );
  return transferStoredRednoteOperatorResolution({
    priorOperatorAttemptId: input.priorOperatorAttemptId,
    request,
    rawRequestDigest: rednoteStableDigest({
      operation: 'operator_transfer',
      priorOperatorAttemptId: input.priorOperatorAttemptId,
      occurredAt: input.occurredAt,
      reason: input.reason,
      request: input.rawRequest,
    }),
    occurredAt: input.occurredAt,
    actorId: input.principal.actorId,
    reason: input.reason,
    validateNew: async () => {
      const [validatedRevision, observedPost] = await Promise.all([
        validateAuthoritativeRequest(request, dependencies),
        readRednotePostExecution(
          request.payload.sourceNotionPageId,
          notion,
        ),
      ]);
      if (validatedRevision !== observedPost.sourcePostRevision) {
        throw requestError(
          'The authoritative Posts revision changed during validation',
          'REDNOTE_SOURCE_REVISION_MISMATCH',
          409,
        );
      }
      return observedPost;
    },
    pool: dependencies.pool,
  });
}
