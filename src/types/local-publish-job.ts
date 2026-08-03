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

interface ClaimedLocalPublishJobBase
  extends Omit<LocalPublishSnapshot, 'mediaIndex' | 'notionLastEditedTime'> {
  id: string;
  claimToken: string;
  claimExpiresAt: string;
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
  | 'created';

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
