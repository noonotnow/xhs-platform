import { isDeepStrictEqual } from 'util';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  parseManualPublicReceiptSupersessionInput,
  type ManualPublicReceiptSupersessionInput,
} from '@/lib/manual-public-receipt-supersession-input';
import {
  findManualPublicReceiptSupersessionByIdempotencyKey,
  supersedeAmbiguousLocalAttemptWithManualReceipt,
  type ManualPublicReceiptSupersessionRecord,
} from '@/lib/manual-public-receipt-supersession-store';
import {
  loadManualReconciliation,
  manualReconciliationSummary,
} from '@/lib/manual-reconciliation-store';
import { getXhsPostForManualHandling } from '@/lib/notion-posts';

function replayMatches(
  record: ManualPublicReceiptSupersessionRecord,
  input: ManualPublicReceiptSupersessionInput,
) {
  return record.notionPageId === input.notionPageId
    && record.expectedNotionVersion === input.expectedNotionVersion
    && record.jobId === input.jobId
    && record.batchId === input.batchId
    && record.batchItemId === input.batchItemId
    && record.manifestHash === input.manifestHash
    && record.itemHash === input.itemHash
    && record.snapshotRevision === input.snapshotRevision
    && record.noteId === input.noteId
    && record.shareUrl === input.shareUrl
    && record.provenance === input.provenance;
}

function expectedSnapshot(post: Awaited<ReturnType<typeof getXhsPostForManualHandling>>) {
  const matchFields: Array<'title' | 'caption' | 'mediaType'> = [];
  if (post.headline.trim()) matchFields.push('title');
  if (post.caption) matchFields.push('caption');
  if (!post.manualWarnings.some((warning) => /media|capcut|needs media/i.test(warning))) {
    matchFields.push('mediaType');
  }
  return {
    title: post.headline.trim(),
    caption: post.caption,
    mediaType: post.hasVideo ? 'video' as const : 'image' as const,
    notionVersion: post.lastEditedTime,
    matchFields,
  };
}

export async function createManualPublicReceiptSupersession(
  rawInput: unknown,
  idempotencyKey: string,
  operatorEmail: string,
) {
  const input = parseManualPublicReceiptSupersessionInput(rawInput);
  const replay = await findManualPublicReceiptSupersessionByIdempotencyKey(
    idempotencyKey,
  );
  if (replay) {
    if (!replayMatches(replay, input)) {
      throw new LocalPublishJobError(
        'Idempotency-Key was already used for a different manual receipt supersession',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return {
      supersession: replay,
      reconciliation: manualReconciliationSummary(
        await loadManualReconciliation(replay.reconciliationId),
      ),
      created: false,
    };
  }

  const post = await getXhsPostForManualHandling(input.notionPageId);
  if (post.status.trim().toLowerCase() !== 'approved') {
    throw new LocalPublishJobError(
      'Manual receipt supersession requires canonical Notion Status Approved',
      'POST_NOT_APPROVED',
      409,
    );
  }
  if (post.lastEditedTime !== input.expectedNotionVersion) {
    throw new LocalPublishJobError(
      'The canonical Notion revision changed',
      'NOTION_REVISION_CONFLICT',
      409,
    );
  }
  if (post.xhsNoteId || post.xhsShareUrl || post.publishedAt) {
    throw new LocalPublishJobError(
      'The canonical Notion record already contains publication identity',
      'PUBLIC_IDENTITY_EXISTS',
      409,
    );
  }

  const expected = expectedSnapshot(post);
  const result = await supersedeAmbiguousLocalAttemptWithManualReceipt({
    request: input,
    expected,
    warnings: [...post.manualWarnings],
    ...(post.publishAt ? { scheduledAt: post.publishAt } : {}),
    idempotencyKey,
    operatorEmail,
  });
  if (!result.created) {
    const stored = await loadManualReconciliation(result.record.reconciliationId);
    if (!isDeepStrictEqual(stored.expected, expected)) {
      throw new LocalPublishJobError(
        'The existing supersession has different canonical Notion evidence',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
  }
  return {
    supersession: result.record,
    reconciliation: manualReconciliationSummary(
      await loadManualReconciliation(result.record.reconciliationId),
    ),
    created: result.created,
  };
}
