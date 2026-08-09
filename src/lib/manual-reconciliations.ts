import {
  parseCreateManualReconciliationInput,
  parseManualReconciliationRetry,
  parseManualReconciliationWorkerResult,
} from '@/lib/manual-reconciliation-input';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  assertManualVerifiedSnapshot,
  claimDueManualReconciliations,
  completeManualReconciliation,
  deferManualReconciliation,
  failManualReconciliation,
  findManualReconciliationByIdempotencyKey,
  insertManualReconciliation,
  listManualReconciliations,
  loadManualReconciliation,
  manualReconciliationSummary,
  retryManualReconciliation,
} from '@/lib/manual-reconciliation-store';
import { reconcileVerifiedExternalPost } from '@/lib/external-post-reconciliations';
import {
  getReadyXhsPost,
  getXhsPostForManualHandling,
  markXhsPostAwaitingReceipt,
} from '@/lib/notion-posts';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { loadManualPostHandlingByPage } from '@/lib/manual-post-handling-store';
import {
  reconcileExternalJobDisposition,
  retryFailedExternalJobDisposition,
} from '@/lib/external-job-dispositions';

const DEFAULT_LEASE_SECONDS = 30 * 60;
const MIN_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 2 * 60 * 60;
const DEFAULT_BACKOFF_SECONDS = [15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60] as const;

function expectedSnapshot(
  post: Awaited<ReturnType<typeof getXhsPostForManualHandling>>,
  manualHandled: boolean,
) {
  const matchFields: Array<'title' | 'caption' | 'mediaType'> = [];
  if (post.headline.trim()) matchFields.push('title');
  if (post.caption) matchFields.push('caption');
  if (
    !post.manualWarnings.some((warning) =>
      /media|capcut|needs media/i.test(warning))
  ) {
    matchFields.push('mediaType');
  }
  return {
    title: post.headline.trim(),
    caption: post.caption,
    mediaType: post.hasVideo ? 'video' as const : 'image' as const,
    ...(manualHandled ? { matchFields: [] } : {}),
  };
}

function assertManualReconciliationCandidate(
  post: Awaited<ReturnType<typeof getReadyXhsPost>>,
) {
  if (post.candidateKind !== 'packet_ready') {
    throw new LocalPublishJobError(
      'MOV compatibility trials cannot enter manual published-post reconciliation',
      'MANUAL_RECONCILIATION_NOT_ALLOWED',
      409,
    );
  }
}

function leaseSeconds() {
  const configured = Number(process.env.MANUAL_RECONCILIATION_LEASE_SECONDS);
  if (!Number.isSafeInteger(configured)) return DEFAULT_LEASE_SECONDS;
  return Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, configured));
}

export function manualReconciliationBackoffSeconds() {
  const configured = process.env.MANUAL_RECONCILIATION_BACKOFF_SECONDS
    ?.split(',')
    .map((value) => Number(value.trim()));
  if (
    configured?.length === 4 &&
    configured.every((value) =>
      Number.isSafeInteger(value) && value >= 60 && value <= 604_800)
  ) {
    return configured as [number, number, number, number];
  }
  return [...DEFAULT_BACKOFF_SECONDS] as [number, number, number, number];
}

export async function createManualReconciliation(
  rawInput: unknown,
  idempotencyKey: string,
) {
  const input = parseCreateManualReconciliationInput(rawInput);
  const existing = await findManualReconciliationByIdempotencyKey(idempotencyKey);
  if (existing) {
    if (
      existing.kind !== 'notion_only' ||
      existing.notionPageId !== input.notionPageId ||
      existing.noteId !== input.noteId ||
      existing.shareUrl !== input.shareUrl
    ) {
      throw new LocalPublishJobError(
        'Idempotency-Key was already used for a different reconciliation request',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    await markXhsPostAwaitingReceipt(input.notionPageId);
    return {
      reconciliation: manualReconciliationSummary(existing),
      created: false,
    };
  }
  const handling = await loadManualPostHandlingByPage(input.notionPageId);
  const post = handling
    ? await getXhsPostForManualHandling(input.notionPageId)
    : await getReadyXhsPost(input.notionPageId);
  if (handling) {
    if (
      handling.receiptStatus !== 'pending'
    ) {
      throw new LocalPublishJobError(
        'The manually handled post no longer has pending receipt reconciliation',
        'MANUAL_RECONCILIATION_NOT_ALLOWED',
        409,
      );
    }
  } else {
    assertManualReconciliationCandidate(post);
  }
  const result = await insertManualReconciliation({
    ...input,
    expected: expectedSnapshot(post, Boolean(handling)),
    idempotencyKey,
  });
  await markXhsPostAwaitingReceipt(input.notionPageId);
  return {
    reconciliation: manualReconciliationSummary(result.request),
    created: result.created,
  };
}

export async function getManualReconciliationSummaries() {
  return (await listManualReconciliations()).map(manualReconciliationSummary);
}

export async function retryFailedManualReconciliation(
  id: string,
  rawInput: unknown,
) {
  parseManualReconciliationRetry(rawInput);
  const existing = await loadManualReconciliation(id);
  if (existing.status === 'reconciled') {
    return manualReconciliationSummary(existing);
  }
  if (existing.kind === 'targeted_local_job') {
    return retryFailedExternalJobDisposition(id);
  }
  const handling = await loadManualPostHandlingByPage(existing.notionPageId);
  const post = handling
    ? await getXhsPostForManualHandling(existing.notionPageId)
    : await getReadyXhsPost(existing.notionPageId);
  if (handling) {
    if (
      handling.receiptStatus !== 'pending'
    ) {
      throw new LocalPublishJobError(
        'The manually handled post no longer has pending receipt reconciliation',
        'MANUAL_RECONCILIATION_NOT_ALLOWED',
        409,
      );
    }
  } else {
    assertManualReconciliationCandidate(post);
  }
  return manualReconciliationSummary(
    await retryManualReconciliation(id, expectedSnapshot(post, Boolean(handling))),
  );
}

export async function claimManualReconciliations(limit: number) {
  return claimDueManualReconciliations(limit, leaseSeconds());
}

export async function submitManualReconciliationResult(
  id: string,
  claimToken: string,
  rawResult: unknown,
) {
  const result = parseManualReconciliationWorkerResult(rawResult);
  if (result.status === 'verification_pending') {
    return manualReconciliationSummary(await deferManualReconciliation(
      id,
      claimToken,
      result.code,
      result.message,
      manualReconciliationBackoffSeconds(),
    ));
  }
  if (result.status === 'failed') {
    return manualReconciliationSummary(await failManualReconciliation(
      id,
      claimToken,
      result.code,
      result.message,
    ));
  }

  const request = await assertManualVerifiedSnapshot(
    id,
    claimToken,
    result.snapshot,
  );
  if (request.kind === 'targeted_local_job') {
    try {
      await reconcileExternalJobDisposition(
        id,
        claimToken,
        result.snapshot,
      );
      return manualReconciliationSummary(await loadManualReconciliation(id));
    } catch (error) {
      const known = normalizeLocalPublishJobError(error);
      if (known.code === 'RECONCILIATION_IN_PROGRESS') {
        return manualReconciliationSummary(await loadManualReconciliation(id));
      }
      const terminal = known.status >= 400 && known.status < 500;
      const stored = terminal
        ? await failManualReconciliation(
            id,
            claimToken,
            known.code,
            known.message,
          )
        : await deferManualReconciliation(
            id,
            claimToken,
            known.code,
            'Verified post found, but canonical Notion backfill is incomplete',
            manualReconciliationBackoffSeconds(),
          );
      return manualReconciliationSummary(stored);
    }
  }

  if (request.status === 'reconciled') return manualReconciliationSummary(request);
  try {
    const receipt = await reconcileVerifiedExternalPost({
      snapshot: result.snapshot,
      idempotencyKey: request.id,
      targetNotionPageId: request.notionPageId,
      source: 'manual',
      ...(request.expected.notionVersion ? { manualHandling: {} } : {}),
    });
    return manualReconciliationSummary(await completeManualReconciliation(
      id,
      claimToken,
      receipt.id,
    ));
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    if (known.code === 'RECONCILIATION_IN_PROGRESS') {
      return manualReconciliationSummary(await loadManualReconciliation(id));
    }
    const terminal = known.status >= 400 && known.status < 500;
    const stored = terminal
      ? await failManualReconciliation(
          id,
          claimToken,
          known.code,
          known.message,
        )
      : await deferManualReconciliation(
          id,
          claimToken,
          known.code,
          'Verified post found, but canonical Notion backfill is incomplete',
          manualReconciliationBackoffSeconds(),
        );
    return manualReconciliationSummary(stored);
  }
}
