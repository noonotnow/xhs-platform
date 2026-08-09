import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  getReadyXhsPost,
  markXhsPostAwaitingReceipt,
} from '@/lib/notion-posts';
import { parsePlanOperatorScheduledInput } from '@/lib/plan-operator-scheduled-input';
import {
  insertPlanOperatorScheduledState,
  loadPlanOperatorScheduledReplay,
} from '@/lib/plan-operator-scheduled-store';

export async function markPlanOperatorScheduled(
  rawInput: unknown,
  idempotencyKey: string,
) {
  const input = parsePlanOperatorScheduledInput(rawInput);
  const replay = await loadPlanOperatorScheduledReplay(input, idempotencyKey);
  if (replay) {
    await markXhsPostAwaitingReceipt(input.notionPageId);
    return { execution: replay, created: false };
  }

  const post = await getReadyXhsPost(input.notionPageId);
  if (
    post.status.trim().toLowerCase() !== 'ready'
    || !post.publishPacketReady
  ) {
    throw new LocalPublishJobError(
      'The canonical Notion post must be Ready with its publish packet ready',
      'PLAN_OPERATOR_SCHEDULED_NOT_READY',
      409,
    );
  }
  if (!post.publishAt || post.publishAt !== input.expectedScheduledAt) {
    throw new LocalPublishJobError(
      'The canonical ScheduledDate changed or is invalid',
      'PLAN_OPERATOR_SCHEDULED_STALE_SCHEDULE',
      409,
    );
  }
  const result = await insertPlanOperatorScheduledState(
    input,
    idempotencyKey,
    post.lastEditedTime,
  );
  await markXhsPostAwaitingReceipt(input.notionPageId);
  return result;
}
