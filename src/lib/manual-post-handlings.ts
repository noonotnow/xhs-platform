import { isDeepStrictEqual } from 'util';
import {
  ManualPostHandlingError,
  parseManualPostHandlingInput,
} from '@/lib/manual-post-handling-input';
import {
  findManualPostHandlingByIdempotencyKey,
  insertManualPostHandling,
  listManualPostHandlings,
} from '@/lib/manual-post-handling-store';
import { getXhsPostForManualHandling } from '@/lib/notion-posts';

export async function markManualPostHandled(
  rawInput: unknown,
  idempotencyKey: string,
) {
  const input = parseManualPostHandlingInput(rawInput);
  const replay = await findManualPostHandlingByIdempotencyKey(idempotencyKey);
  if (replay) {
    if (
      replay.notionPageId !== input.notionPageId
      || replay.notionVersion !== input.expectedLastEditedTime
      || replay.mode !== input.mode
      || replay.recordedBy !== 'admin'
    ) {
      throw new ManualPostHandlingError(
        'Idempotency-Key was already used for a different manual handling',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return { handling: replay, created: false };
  }

  const post = await getXhsPostForManualHandling(input.notionPageId);
  const status = post.status.trim().toLowerCase();
  if (status === 'published') {
    throw new ManualPostHandlingError(
      'This post is already Published in Notion',
      'POST_ALREADY_PUBLISHED',
      409,
    );
  }
  if (status !== 'approved') {
    throw new ManualPostHandlingError(
      'Manual handling requires canonical Notion Status Approved',
      'POST_NOT_APPROVED',
      409,
    );
  }
  if (post.lastEditedTime !== input.expectedLastEditedTime) {
    throw new ManualPostHandlingError(
      'The Notion post changed; refresh before recording operator handling',
      'NOTION_REVISION_CONFLICT',
      409,
    );
  }

  const warnings = [...post.manualWarnings];
  const result = await insertManualPostHandling({
    notionPageId: post.id,
    notionVersion: post.lastEditedTime,
    mode: input.mode,
    ...(post.publishAt ? { scheduledAt: post.publishAt } : {}),
    warnings,
    recordedBy: 'admin',
    idempotencyKey,
  });
  if (
    !result.created
    && !isDeepStrictEqual(result.handling.warnings, warnings)
  ) {
    throw new ManualPostHandlingError(
      'The existing manual handling has different durable warnings',
      'IDEMPOTENCY_CONFLICT',
      409,
    );
  }
  return result;
}

export async function getManualPostHandlingSummaries() {
  return listManualPostHandlings();
}
