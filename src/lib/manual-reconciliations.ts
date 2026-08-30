import {
  parseCreateManualReconciliationInput,
  parseManualReconciliationRetry,
  parseManualReconciliationWorkerResult,
} from '@/lib/manual-reconciliation-input';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { syncReconciledPlanProvenance } from '@/lib/plan-reconciliation-sync';
import {
  claimDueManualReconciliations,
  completeManualReconciliation,
  deferManualReconciliation,
  failManualReconciliation,
  findManualReconciliationByIdempotencyKey,
  insertManualReconciliation,
  listManualReconciliations,
  loadManualReconciliation,
  manualReconciliationSummary,
  recordManualVerifiedSnapshot,
  retryManualReconciliation,
} from '@/lib/manual-reconciliation-store';
import { reconcileVerifiedExternalPost } from '@/lib/external-post-reconciliations';
import {
  getReadyXhsPost,
  getXhsPostForManualHandling,
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
  notionVersion?: string,
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
    ...(notionVersion ? { notionVersion } : {}),
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
  workspaceId = 'legacy-local-publish',
) {
  const input = parseCreateManualReconciliationInput(rawInput);
  const existing = await findManualReconciliationByIdempotencyKey(idempotencyKey, workspaceId);
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
    expected: expectedSnapshot(
      post,
      Boolean(handling),
      handling?.notionVersion ?? post.lastEditedTime,
    ),
    idempotencyKey,
    workspaceId,
  });
  return {
    reconciliation: manualReconciliationSummary(result.request),
    created: result.created,
  };
}

export async function getManualReconciliationSummaries(workspaceId = 'legacy-local-publish') {
  return (await listManualReconciliations(workspaceId)).map(manualReconciliationSummary);
}

export async function retryFailedManualReconciliation(
  id: string,
  rawInput: unknown,
  workspaceId = 'legacy-local-publish',
) {
  parseManualReconciliationRetry(rawInput);
  const existing = await loadManualReconciliation(id, workspaceId);
  if (existing.status === 'reconciled') {
    return manualReconciliationSummary(existing);
  }
  if (existing.kind === 'targeted_local_job') {
    return retryFailedExternalJobDisposition(id, workspaceId);
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
    await retryManualReconciliation(
      id,
      expectedSnapshot(
        post,
        Boolean(handling),
        handling?.notionVersion ?? post.lastEditedTime,
      ),
      workspaceId,
    ),
  );
}

export async function claimManualReconciliations(
  limit: number,
  workspaceId = 'legacy-local-publish',
) {
  return claimDueManualReconciliations(limit, leaseSeconds(), workspaceId);
}

async function reconciliationSummaryWithPlanSync(
    reconciliation: Awaited<ReturnType<typeof loadManualReconciliation>>,
    ) {
    const summary = manualReconciliationSummary(reconciliation);
    try {
      const handling = await loadManualPostHandlingByPage(reconciliation.notionPageId);
      if (
        handling?.mode !== 'scheduled'
        || handling.recordedBy !== 'plan'
        || handling.receiptStatus !== 'reconciled'
      ) {
        return summary;
      }
      const planProvenanceSync = await syncReconciledPlanProvenance(reconciliation.notionPageId);
      if (planProvenanceSync.status !== 'synced') {
        console.warn('[XHS] PLAN reconciliation provenance sync did not complete', {
          notionPageId: reconciliation.notionPageId,
          code: planProvenanceSync.code,
        });
      }
      return { ...summary, planProvenanceSync };
    } catch (error) {
      console.error('[XHS] PLAN reconciliation provenance sync lookup failed', {
        notionPageId: reconciliation.notionPageId,
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      return {
        ...summary,
        planProvenanceSync: {
          status: 'failed' as const,
          code: 'PLAN_RECONCILIATION_SYNC_LOOKUP_FAILED',
          message: 'XHS could not determine whether this reconciled receipt needs PLAN provenance sync.',
        },
      };
    }
    }

    export async function submitManualReconciliationResult(
  id: string,
  claimToken: string,
  rawResult: unknown,
  workspaceId = 'legacy-local-publish',
) {
  const result = parseManualReconciliationWorkerResult(rawResult);
  if (result.status === 'verification_pending') {
    return manualReconciliationSummary(await deferManualReconciliation(
      id,
      claimToken,
      result.code,
      result.message,
      manualReconciliationBackoffSeconds(),
      workspaceId,
    ));
  }
  if (result.status === 'failed') {
    return manualReconciliationSummary(await failManualReconciliation(
      id,
      claimToken,
      result.code,
      result.message,
      workspaceId,
    ));
  }

  const request = await recordManualVerifiedSnapshot(
    id,
    claimToken,
    result.snapshot,
    workspaceId,
  );
  if (request.kind === 'targeted_local_job') {
    try {
      await reconcileExternalJobDisposition(
        id,
        claimToken,
        result.snapshot,
        workspaceId,
      );
      return manualReconciliationSummary(await loadManualReconciliation(id, workspaceId));
    } catch (error) {
      const known = normalizeLocalPublishJobError(error);
      if (known.code === 'RECONCILIATION_IN_PROGRESS') {
        return manualReconciliationSummary(await loadManualReconciliation(id, workspaceId));
      }
      const terminal = known.status >= 400 && known.status < 500;
      const stored = terminal
        ? await failManualReconciliation(
            id,
            claimToken,
            known.code,
            known.message,
            workspaceId,
          )
        : await deferManualReconciliation(
            id,
            claimToken,
            known.code,
            'Verified post found, but canonical Notion backfill is incomplete',
            manualReconciliationBackoffSeconds(),
            workspaceId,
          );
      return manualReconciliationSummary(stored);
    }
  }

  if (request.status === 'reconciled') return reconciliationSummaryWithPlanSync(request);
  try {
    const receipt = await reconcileVerifiedExternalPost({
      snapshot: result.snapshot,
      idempotencyKey: request.id,
      targetNotionPageId: request.notionPageId,
      source: 'manual',
      workspaceId,
      ...(request.expected.notionVersion ? { manualHandling: {} } : {}),
    });
    return reconciliationSummaryWithPlanSync(await completeManualReconciliation(
      id,
      claimToken,
      receipt.id,
      workspaceId,
    ));
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    if (known.code === 'RECONCILIATION_IN_PROGRESS') {
      return manualReconciliationSummary(await loadManualReconciliation(id, workspaceId));
    }
    const terminal = known.status >= 400 && known.status < 500;
    const stored = terminal
      ? await failManualReconciliation(
          id,
          claimToken,
          known.code,
          known.message,
          workspaceId,
        )
      : await deferManualReconciliation(
          id,
          claimToken,
          known.code,
          'Verified post found, but canonical Notion backfill is incomplete',
          manualReconciliationBackoffSeconds(),
          workspaceId,
        );
    return manualReconciliationSummary(stored);
  }
}
