import {
  beginExternalReconciliation,
  completeExternalReconciliation,
  failExternalReconciliation,
} from '@/lib/external-post-reconciliation-store';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  NotionPostsError,
  reconcileExternalXhsPost,
} from '@/lib/notion-posts';
import type { ExternalPostSnapshot } from '@/types/local-publish-job';

function safeFailure(error: unknown) {
  if (error instanceof NotionPostsError) {
    return {
      code: error.code,
      message: error.message,
      httpStatus: error.status,
    };
  }
  return {
    code: 'EXTERNAL_RECONCILIATION_FAILED',
    message: 'External RedNote reconciliation failed',
    httpStatus: 502,
  };
}

function completedResult(record: {
  id: string;
  status: string;
  notionPageId?: string;
  outcome?: string;
}) {
  if (
    record.status !== 'succeeded' ||
    !record.notionPageId ||
    !record.outcome
  ) {
    throw new LocalPublishJobError(
      'External reconciliation is not complete',
      'INVALID_RECONCILIATION_TRANSITION',
      409,
    );
  }
  return {
    id: record.id,
    status: 'succeeded' as const,
    notionPageId: record.notionPageId,
    outcome: record.outcome,
  };
}

export async function reconcileVerifiedExternalPost(input: {
  snapshot: ExternalPostSnapshot;
  idempotencyKey: string;
}) {
  const started = await beginExternalReconciliation(
    input.snapshot,
    input.idempotencyKey,
  );
  if (!started.acquired) return completedResult(started.record);

  try {
    const result = await reconcileExternalXhsPost(
      input.snapshot,
      started.record.createdAt,
    );
    const completed = await completeExternalReconciliation(
      started.record.id,
      result.notionPageId,
      result.outcome,
    );
    return completedResult(completed);
  } catch (error) {
    const failure = safeFailure(error);
    await failExternalReconciliation(
      started.record.id,
      failure.code,
      failure.message,
    );
    throw new LocalPublishJobError(
      failure.message,
      failure.code,
      failure.httpStatus,
    );
  }
}
