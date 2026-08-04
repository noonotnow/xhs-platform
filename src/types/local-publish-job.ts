export type LocalPublishMediaType = 'image' | 'video';
export type LocalPublishCompatibilityTrial = 'unverified_mov';
export type LocalPublishWorkLane = 'all' | 'dispatch' | 'verification';
export type LocalPublishJobStatus =
  | 'queued'
  | 'claimed'
  | 'staged'
  | 'submitted'
  | 'scheduled'
  | 'verification_pending'
  | 'verified'
  | 'reconciled'
  | 'failed';

export interface LocalPublishSnapshot {
  notionPageId: string;
  headline: string;
  title: string;
  caption: string;
  tags: string[];
  platform: 'RedNote';
  mediaType: LocalPublishMediaType;
  mediaIndex: number;
  mediaUrl: string;
  compatibilityTrial?: LocalPublishCompatibilityTrial;
  thumbnailUrl?: string;
  publishAt?: string;
  notionLastEditedTime: string;
}

export interface LocalPublishJobSummary {
  id: string;
  notionPageId: string;
  status: LocalPublishJobStatus;
  compatibilityTrial?: LocalPublishCompatibilityTrial;
  errorCode?: string;
  errorMessage?: string;
  noteId?: string;
  shareUrl?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  verificationAttempts: number;
  nextVerificationAt?: string;
  stagedAt?: string;
  dispatchedAt?: string;
  verifiedAt?: string;
  reconciledAt?: string;
  completedAt?: string;
}

export interface BatchAuthorization {
  batchId: string;
  manifestHash: string;
  itemHash: string;
  snapshotRevision: string;
  approvedState: 'approved';
  approvedAt: string;
  media: {
    url: string;
    type: LocalPublishMediaType;
    identity: string;
  };
  publishAt: string;
  lateAction: 'schedule' | 'post_now';
}

interface ClaimedLocalPublishJobBase
  extends Omit<LocalPublishSnapshot, 'mediaIndex' | 'notionLastEditedTime'> {
  id: string;
  claimToken: string;
  claimExpiresAt: string;
  batchAuthorization?: BatchAuthorization;
}

export type PublishBatchKind = 'weekly' | 'catch_up' | 'bootstrap';
export type PublishBatchStatus =
  | 'pending_approval'
  | 'approved'
  | 'partially_approved'
  | 'superseded';
export type PublishBatchItemState =
  | 'needs_approval'
  | 'approved'
  | 'invalidated'
  | LocalPublishJobStatus;

export interface PublishBatchItem {
  id: string;
  notionPageId: string;
  snapshot: LocalPublishSnapshot;
  itemHash: string;
  state: PublishBatchItemState;
  dispatchMode: 'scheduled' | 'post_now';
  lateBySeconds: number;
  invalidationReason?: string;
  localPublishJobId?: string;
}

export interface PublishBatchBlockedCandidate {
  notionPageId: string;
  headline: string;
  publishAt?: string;
  reason: string;
}

export interface PublishBatch {
  id: string;
  kind: PublishBatchKind;
  status: PublishBatchStatus;
  manifestHash: string;
  windowStart?: string;
  windowEnd?: string;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  supersededAt?: string;
  supersededByBatchId?: string;
  items: PublishBatchItem[];
  blockedCandidates: PublishBatchBlockedCandidate[];
}

export type ClaimedLocalPublishJob =
  | (ClaimedLocalPublishJobBase & { status: 'claimed' | 'staged' })
  | (ClaimedLocalPublishJobBase & {
      status: 'submitted' | 'scheduled' | 'verification_pending';
      noteId: string;
      shareUrl: string;
      verificationAttempts: number;
      nextVerificationAt: string;
    })
  | (ClaimedLocalPublishJobBase & {
      status: 'verified';
      noteId: string;
      shareUrl: string;
      verificationAttempts: number;
    });

export interface ExternalPostSnapshot {
  noteId: string;
  shareUrl: string;
  title: string;
  caption: string;
  mediaType: LocalPublishMediaType;
}

export type ExternalReconciliationStatus = 'processing' | 'succeeded' | 'failed';
export type ExternalReconciliationOutcome =
  | 'matched_note_id'
  | 'matched_url'
  | 'created'
  | 'targeted_page';

export interface ExternalReconciliationSummary {
  id: string;
  noteId: string;
  shareUrl: string;
  title: string;
  mediaType: LocalPublishMediaType;
  status: ExternalReconciliationStatus;
  outcome?: ExternalReconciliationOutcome;
  notionPageId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type ManualReconciliationStatus =
  | 'queued'
  | 'verifying'
  | 'reconciled'
  | 'failed';

export interface ManualReconciliationExpectedSnapshot {
  title: string;
  caption: string;
  mediaType: LocalPublishMediaType;
}

export interface ManualReconciliationSummary {
  id: string;
  notionPageId: string;
  sourceLocalJobId?: string;
  noteId: string;
  shareUrl: string;
  status: ManualReconciliationStatus;
  verificationAttempts: number;
  nextAttemptAt?: string;
  externalReconciliationId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ClaimedManualReconciliation {
  id: string;
  notionPageId: string;
  noteId: string;
  shareUrl: string;
  expected: ManualReconciliationExpectedSnapshot;
  verificationAttempts: number;
  claimToken: string;
  claimExpiresAt: string;
}
