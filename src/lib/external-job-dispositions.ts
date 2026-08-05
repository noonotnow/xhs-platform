import {
  parseExternalJobDispositionInput,
} from '@/lib/external-job-disposition-input';
import {
  completeExternalJobDisposition,
  externalJobDispositionSummary,
  insertExternalJobDisposition,
  prepareExternalJobDisposition,
  retryExternalJobDisposition,
} from '@/lib/external-job-disposition-store';
import { reconcileVerifiedExternalPost } from '@/lib/external-post-reconciliations';
import type { ExternalPostSnapshot } from '@/types/local-publish-job';

interface ReconciliationDependencies {
  prepare: typeof prepareExternalJobDisposition;
  reconcile: typeof reconcileVerifiedExternalPost;
  complete: typeof completeExternalJobDisposition;
}

const reconciliationDependencies: ReconciliationDependencies = {
  prepare: prepareExternalJobDisposition,
  reconcile: reconcileVerifiedExternalPost,
  complete: completeExternalJobDisposition,
};

export async function createExternalJobDisposition(
  rawInput: unknown,
  idempotencyKey: string,
) {
  const input = parseExternalJobDispositionInput(rawInput);
  const result = await insertExternalJobDisposition(input, idempotencyKey);
  return {
    disposition: externalJobDispositionSummary(result.request),
    created: result.created,
  };
}

export async function reconcileExternalJobDisposition(
  id: string,
  claimToken: string,
  snapshot: ExternalPostSnapshot,
  dependencies: ReconciliationDependencies = reconciliationDependencies,
) {
  const prepared = await dependencies.prepare(id, claimToken, snapshot);
  if (prepared.status === 'reconciled') {
    return externalJobDispositionSummary(prepared);
  }
  const receipt = await dependencies.reconcile({
    snapshot,
    idempotencyKey: prepared.id,
    targetNotionPageId: prepared.notionPageId,
    targetDispositionId: prepared.id,
  });
  return externalJobDispositionSummary(
    await dependencies.complete(id, claimToken, receipt.id),
  );
}

export async function retryFailedExternalJobDisposition(id: string) {
  return externalJobDispositionSummary(await retryExternalJobDisposition(id));
}
