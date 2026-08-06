import { manualSchedulingProvenanceMismatch } from '@/lib/manual-scheduling-provenance';
import type {
  LocalPublishJobSummary,
  ManualReconciliationSummary,
  ManualSchedulingAttestationEvidence,
  PublishBatch,
} from '@/types/local-publish-job';
import type { ReadyXhsPost } from '@/types/ready-post';

export function isActiveLocalPublishJob(job: LocalPublishJobSummary) {
  return job.status !== 'failed' && job.status !== 'reconciled';
}

export function displayedLocalPublishJob(
  jobs: LocalPublishJobSummary[],
  notionPageId: string,
) {
  const matching = jobs.filter((job) => job.notionPageId === notionPageId);
  const attested = matching.find((job) => job.status === 'operator_attested');
  if (attested) return attested;
  return matching.find(isActiveLocalPublishJob) ?? matching[0];
}

export function receiptPendingLocalPublishJobs(jobs: LocalPublishJobSummary[]) {
  return jobs.filter((job) => job.status === 'operator_attested');
}

export type PublicationOperationalTruth =
  | 'published'
  | 'scheduled_receipt_pending'
  | 'attested_verification_pending'
  | 'provenance_mismatch'
  | 'not_published';

export function publicationOperationalTruth(
  post: ReadyXhsPost,
  job: LocalPublishJobSummary | undefined,
  reconciliation: ManualReconciliationSummary | undefined,
): { state: PublicationOperationalTruth; label: string } {
  if (
    post.status.trim().toLowerCase() === 'published' ||
    job?.status === 'reconciled' ||
    reconciliation?.status === 'reconciled'
  ) {
    return { state: 'published', label: 'Published' };
  }
  if (
    reconciliation?.status === 'queued' ||
    reconciliation?.status === 'verifying'
  ) {
    return {
      state: 'attested_verification_pending',
      label: 'Attested · verification pending',
    };
  }
  if (job?.status === 'operator_attested') {
    if (
      job.successAttestation?.provenance === 'manual_scheduled' &&
      manualSchedulingProvenanceMismatch(post, job.successAttestation)
    ) {
      return {
        state: 'provenance_mismatch',
        label: 'Scheduled · provenance mismatch · needs review',
      };
    }
    if (job.successAttestation?.provenance === 'manual_scheduled') {
      return {
        state: 'scheduled_receipt_pending',
        label: 'Scheduled · receipt pending',
      };
    }
    return {
      state: 'attested_verification_pending',
      label: 'Attested · verification pending',
    };
  }
  return { state: 'not_published', label: 'Not published' };
}

export function directManualSchedulingCandidate(
  post: ReadyXhsPost | undefined,
  batches: PublishBatch[],
  jobs: LocalPublishJobSummary[],
): ManualSchedulingAttestationEvidence | undefined {
  if (
    !post ||
    post.candidateKind !== 'packet_ready' ||
    !post.scheduledDate ||
    !post.publishAt ||
    post.status.trim().toLowerCase() === 'published'
  ) {
    return undefined;
  }
  for (const batch of batches) {
    if (!['approved', 'partially_approved'].includes(batch.status)) continue;
    const item = batch.items.find((candidate) => {
      if (
        candidate.notionPageId !== post.id ||
        !['approved', 'queued'].includes(candidate.state) ||
        candidate.dispatchMode !== 'scheduled' ||
        candidate.snapshot.notionLastEditedTime !== post.lastEditedTime ||
        candidate.snapshot.publishAt !== post.publishAt
      ) {
        return false;
      }
      if (!candidate.localPublishJobId) return true;
      return jobs.some((job) =>
        job.id === candidate.localPublishJobId &&
        job.notionPageId === post.id &&
        job.status === 'queued');
    });
    if (item?.snapshot.publishAt) {
      return {
        batchId: batch.id,
        manifestHash: batch.manifestHash,
        itemId: item.id,
        itemHash: item.itemHash,
        snapshotRevision: item.snapshot.notionLastEditedTime,
        requestedPublishAt: item.snapshot.publishAt,
      };
    }
  }
  return undefined;
}
