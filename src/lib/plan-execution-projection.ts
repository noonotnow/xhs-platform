import type {
  LocalPublishJobSummary,
  PublishBatch,
  RednotePublishJobRecoveryEvidence,
} from '@/types/local-publish-job';
import type { PlanExecutionProjection } from '@/types/plan-execution';

function latestJob(
  notionPageId: string,
  jobs: LocalPublishJobSummary[],
): LocalPublishJobSummary | undefined {
  return jobs
    .filter((job) => job.notionPageId === notionPageId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function recoveryForJob(
  jobId: string,
  batches: PublishBatch[],
): RednotePublishJobRecoveryEvidence | undefined {
  return batches
    .flatMap((batch) => batch.items)
    .find((item) => item.localPublishJobId === jobId && item.recoveryEvidence)
    ?.recoveryEvidence;
}

export function projectPlanExecution(
  notionPageId: string,
  jobs: LocalPublishJobSummary[],
  batches: PublishBatch[],
): PlanExecutionProjection {
  const job = latestJob(notionPageId, jobs);
  if (!job) {
    return {
      notionPageId,
      state: 'no_attempt',
      retryEligible: false,
      publicationRuledOut: true,
      detail: 'No RedNote worker attempt is recorded for this canonical Post.',
    };
  }

  const common = {
    notionPageId,
    jobId: job.id,
    jobUpdatedAt: job.updatedAt,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.noteId ? { noteId: job.noteId } : {}),
    ...(job.shareUrl ? { shareUrl: job.shareUrl } : {}),
  };

  if (job.status === 'reconciled') {
    return {
      ...common,
      state: 'published',
      retryEligible: false,
      publicationRuledOut: false,
      detail: 'Publication identity is reconciled. Preserve this receipt.',
    };
  }

  if ([
    'submitted',
    'scheduled',
    'operator_attested',
    'verification_pending',
    'verified',
  ].includes(job.status)) {
    return {
      ...common,
      state: 'receipt_pending',
      retryEligible: false,
      publicationRuledOut: false,
      detail: job.errorMessage || 'An existing attempt needs receipt verification or backfill. Do not publish again.',
    };
  }

  if (job.status === 'queued') {
    return {
      ...common,
      state: 'queued',
      retryEligible: false,
      publicationRuledOut: true,
      detail: 'The exact approved job is queued for the worker.',
    };
  }

  if (job.status === 'claimed' || job.status === 'staged') {
    return {
      ...common,
      state: 'attempting',
      retryEligible: false,
      publicationRuledOut: false,
      detail: 'The worker owns an active or unresolved attempt. PLAN must not dispatch another.',
    };
  }

  const recoveryEvidence = recoveryForJob(job.id, batches);
  if (job.status === 'failed' && recoveryEvidence) {
    return {
      ...common,
      state: 'failed_recoverable_pre_publish',
      retryEligible: true,
      publicationRuledOut: true,
      recoveryEvidence,
      detail: job.errorMessage || 'The durable execution system proved this exact failure is recoverable before publication.',
    };
  }

  return {
    ...common,
    state: 'failed_not_recoverable',
    retryEligible: false,
    publicationRuledOut: false,
    detail: job.errorMessage || 'The failed attempt is not proven safe to retry. Resolve its evidence in XHS Admin.',
  };
}
