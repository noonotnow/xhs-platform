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

export const REDNOTE_WORKER_RESULT_CONTRACT_VERSION =
  'rednote-worker-result/v2' as const;
export const REDNOTE_EVIDENCE_CONTRACT_VERSION =
  'rednote-evidence/v1' as const;

export type RednoteWorkerResultOutcome =
  | 'acknowledged'
  | 'scheduled'
  | 'ambiguous'
  | 'rejected';

export interface AuthenticatedAccountEvidence {
  accountId: string;
  capturedAt: string;
  ownership: 'owned' | 'account_mismatch';
}

export interface XsecAccessEvidence {
  capturedAt: string;
  accessible: true;
}

export interface PublicIndexEvidence {
  checkedAt: string;
  status: 'indexed' | 'pending' | 'not_found';
  publicUrl?: string;
}

export interface PublishMedia {
  identity: string;
  type: LocalPublishMediaType;
  url: string;
}

export interface RednotePublicationEvidenceSummary {
  authenticatedAccount?: AuthenticatedAccountEvidence;
  xsecAccess?: XsecAccessEvidence;
  publicIndex?: PublicIndexEvidence;
  restriction?: {
    reportedAt: string;
    status: 'removed' | 'restricted';
  };
}

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
  /** Ordered immutable media list; absent only on pre-v2 stored snapshots. */
  media?: PublishMedia[];
  compatibilityTrial?: LocalPublishCompatibilityTrial;
  thumbnailUrl?: string;
  publishAt?: string;
  automationConsent?: 'ready_x3';
  notionLastEditedTime: string;
  expectedAccountId?: string;
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
  dispatchAuthorizedAt?: string;
  dispatchedAt?: string;
  verifiedAt?: string;
  reconciledAt?: string;
  completedAt?: string;
  successAttestation?: OperatorSuccessAttestationSummary;
  receiptContractVersion?: typeof REDNOTE_WORKER_RESULT_CONTRACT_VERSION;
  receiptOutcome?: RednoteWorkerResultOutcome;
  receiptAcknowledgedAt?: string;
  evidence?: RednotePublicationEvidenceSummary;
}

export interface BatchAuthorization {
  batchId: string;
  manifestHash: string;
  itemHash: string;
  snapshotRevision: string;
  approvedState: 'approved';
  approvedAt: string;
  media: PublishMedia[];
  publishAt: string;
  lateAction: 'schedule' | 'post_now';
}

/** A one-shot, immutable consent for a Ready ×3 worker dispatch. */
export interface ReadyX3Authorization {
  kind: 'ready_x3';
  action: 'schedule' | 'post_now';
  packetRevision: string;
  packetDigest: string;
  media: PublishMedia[];
  platform: 'RedNote';
  publishAt: string;
  authorizedAt: string;
  lateFallback: {
    action: 'schedule' | 'post_now';
    maxLateMinutes: 30;
  };
}

interface ClaimedLocalPublishJobBase
  extends Omit<
    LocalPublishSnapshot,
    'notionLastEditedTime' | 'media' | 'expectedAccountId'
  > {
  id: string;
  claimToken: string;
  claimExpiresAt: string;
  media: PublishMedia[];
  expectedAccountId: string;
  /** Revision of the exact Notion packet frozen into this claim. */
  notionLastEditedTime: string;
  batchAuthorization?: BatchAuthorization;
  readyX3Authorization?: ReadyX3Authorization;
  dispatchAuthorizedAt?: string;
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
  priorErrorCode:
    | 'BOUNDED_BATCH_BYPASS_DISABLED'
    | 'AMBIGUOUS_CREATOR_UI'
    | 'NOT_LOGGED_IN';
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

export interface PublicRednotePublishJobRecovery {
  id: string;
  batchId: string;
  manifestHash: string;
  itemId: string;
  jobId: string;
  itemHash: string;
  snapshotRevision: string;
  approvedAt: string;
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

export interface PublishLifecycleBlocker {
  notionPageId: string;
  lifecycleId: string;
  lifecycleState: string;
}

export interface PublishBatch {
  id: string;
  workspaceId: string;
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
      noteId?: string;
      shareUrl?: string;
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
      shareUrl?: string;
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
  source?: 'automation' | 'manual' | 'recovery';
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
  notionVersion?: string;
  matchFields?: Array<'title' | 'caption' | 'mediaType'>;
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
  verifiedSnapshot?: ExternalPostSnapshot;
  verificationAttempts: number;
  claimToken: string;
  claimExpiresAt: string;
}
