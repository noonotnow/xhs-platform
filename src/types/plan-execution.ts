import type { RednotePublishJobRecoveryEvidence } from '@/types/local-publish-job';

export type PlanExecutionState =
  | 'no_attempt'
  | 'queued'
  | 'attempting'
  | 'failed_recoverable_pre_publish'
  | 'failed_not_recoverable'
  | 'receipt_pending'
  | 'published';

export interface PlanExecutionProjection {
  notionPageId: string;
  state: PlanExecutionState;
  retryEligible: boolean;
  publicationRuledOut: boolean;
  jobId?: string;
  jobUpdatedAt?: string;
  errorCode?: string;
  detail: string;
  noteId?: string;
  shareUrl?: string;
  recoveryEvidence?: RednotePublishJobRecoveryEvidence;
}
