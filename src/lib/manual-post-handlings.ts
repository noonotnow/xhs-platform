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
import {
  getXhsPostForManualHandling,
  markXhsPostAwaitingReceipt,
} from '@/lib/notion-posts';

export async function markManualPostHandled(
  rawInput: unknown,
  idempotencyKey: string,
) {
  const input = parseManualPostHandlingInput(rawInput);
  const replay = await findManualPostHandlingByIdempotencyKey(idempotencyKey);
  if (replay) {
    if (
      replay.notionPageId !== input.notionPageId
      || replay.mode !== input.mode
      || replay.recordedBy !== 'admin'
    ) {
      throw new ManualPostHandlingError(
        'Idempotency-Key was already used for a different manual handling',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    await markXhsPostAwaitingReceipt(input.notionPageId);
    return { handling: replay, created: false };
  }

  const post = await getXhsPostForManualHandling(input.notionPageId);
  const status = post.status.trim().toLowerCase();
  if (status !== 'ready' || !post.publishPacketReady) {
    throw new ManualPostHandlingError(
      'Manual handling requires a Ready post with its publish packet ready',
      'POST_NOT_READY',
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
  await markXhsPostAwaitingReceipt(post.id);
  return result;
}

export async function getManualPostHandlingSummaries() {
  return listManualPostHandlings();
}
