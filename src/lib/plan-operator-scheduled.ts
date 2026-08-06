import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { getReadyXhsPost } from '@/lib/notion-posts';
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
  if (replay) return { execution: replay, created: false };

  const post = await getReadyXhsPost(input.notionPageId);
  if (post.status.trim().toLowerCase() !== 'approved') {
    throw new LocalPublishJobError(
      'The canonical Notion post must remain Approved',
      'PLAN_OPERATOR_SCHEDULED_STATUS_CONFLICT',
      409,
    );
  }
  if (post.lastEditedTime !== input.expectedNotionVersion) {
    throw new LocalPublishJobError(
      'The canonical Notion post revision changed',
      'PLAN_OPERATOR_SCHEDULED_STALE_REVISION',
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
  return insertPlanOperatorScheduledState(input, idempotencyKey);
}
