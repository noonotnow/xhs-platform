import { RednotePublishingError } from '@/lib/rednote-publishing-input';
import {
  defaultRednoteNotionProjectionAdapter,
  projectRednotePostMutation,
  RednotePostProjectionError,
  type RednoteNotionProjectionAdapter,
} from '@/lib/rednote-publishing-notion';
import {
  completeRednotePostMutation,
  conflictRednotePostMutation,
  listPendingRednotePostMutations,
  loadRednotePostMutation,
  recordRednotePostMutationFailure,
  verifyRednotePostMutation,
  withRednotePostProjectionLock,
  type RednoteDatabasePool,
} from '@/lib/rednote-publishing-store';

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
  if (mutation.state === 'verified') {
    const completed = await completeRednotePostMutation({
      mutationId,
      appliedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      pool: dependencies.pool,
    });
    return completed.mutation;
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
