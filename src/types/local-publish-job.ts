export type LocalPublishMediaType = 'image' | 'video';
export type LocalPublishCompatibilityTrial = 'unverified_mov';
export type LocalPublishWorkLane = 'all' | 'dispatch' | 'verification';
export type LocalPublishJobStatus =
  | 'queued'
  | 'claimed'
  | 'staged'
  | 'submitted'
  | 'scheduled'
  | 'operator_attested'
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
  successAttestation?: OperatorSuccessAttestationSummary;
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
  recoveryEvidence?: RednotePublishJobRecoveryEvidence;
  successAttestationEvidence?: OperatorSuccessAttestationEvidence;
}

export interface OperatorSuccessAttestationEvidence {
  batchId: string;
  manifestHash: string;
  itemId: string;
  jobId: string;
  itemHash: string;
  snapshotRevision: string;
  requestedPublishAt: string;
  expectedOutcome: {
    kind: 'scheduled';
    publishAt: string;
    timeZone: 'America/New_York';
    text: string;
  };
}

export type OperatorSuccessAttestationProvenance =
  | 'worker_ambiguous'
  | 'manual_scheduled';

export interface ManualSchedulingAttestationEvidence {
  batchId: string;
  manifestHash: string;
  itemId: string;
  itemHash: string;
  snapshotRevision: string;
  requestedPublishAt: string;
}

export interface OperatorSuccessAttestationSummary
  extends OperatorSuccessAttestationEvidence {
  id: string;
  notionPageId: string;
  provenance: OperatorSuccessAttestationProvenance;
  contractRevision:
    | 'operator-success-attestation/v1'
    | 'manual-scheduling-attestation/v1';
  snapshotDigest: string;
  priorClaimTokenDigest?: string;
  releaseRequired: boolean;
  localReleaseIdentity?: {
    jobId: string;
    notionPageId: string;
    priorClaimTokenDigest: string;
    batchId: string;
    manifestHash: string;
    itemHash: string;
    snapshotRevision: string;
    requestedPublishAt: string;
    publishMode: 'scheduled';
  };
  attestedBy: string;
  attestedAt: string;
}

export interface RednotePublishJobRecoveryEvidence {
  batchId: string;
  manifestHash: string;
  itemId: string;
  jobId: string;
  itemHash: string;
  snapshotRevision: string;
  priorErrorCode: 'BOUNDED_BATCH_BYPASS_DISABLED' | 'AMBIGUOUS_CREATOR_UI';
  claimAttempts: number;
  latestAuditedClaimAttempts?: number;
}

export interface RednotePublishJobRecovery
  extends Omit<
    RednotePublishJobRecoveryEvidence,
    'priorErrorCode' | 'claimAttempts' | 'latestAuditedClaimAttempts'
  > {
  id: string;
  approvedAt: string;
  recoveredBy: string;
  recoveredAt: string;
  priorClaimAttempts: number;
  alreadyRecovered: boolean;
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
      status: 'operator_attested';
      verificationAttempts: number;
      nextVerificationAt: string;
      successAttestation: OperatorSuccessAttestationSummary;
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
export type ManualReconciliationKind = 'notion_only' | 'targeted_local_job';

export interface ManualReconciliationExpectedSnapshot {
  title: string;
  caption: string;
  mediaType: LocalPublishMediaType;
}

export interface ManualReconciliationSummary {
  id: string;
  notionPageId: string;
  kind: ManualReconciliationKind;
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
  kind: ManualReconciliationKind;
  sourceLocalJobId?: string;
  noteId: string;
  shareUrl: string;
  expected: ManualReconciliationExpectedSnapshot;
  verificationAttempts: number;
  claimToken: string;
  claimExpiresAt: string;
}
