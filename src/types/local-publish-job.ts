export type LocalPublishMediaType = 'image' | 'video';
export type LocalPublishJobStatus =
  | 'queued'
  | 'claimed'
  | 'ambiguous'
  | 'succeeded'
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
  thumbnailUrl?: string;
  scheduledDate?: string;
  notionLastEditedTime: string;
}

export interface LocalPublishJobSummary {
  id: string;
  notionPageId: string;
  status: LocalPublishJobStatus;
  errorCode?: string;
  errorMessage?: string;
  noteId?: string;
  shareUrl?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  completedAt?: string;
}

export interface ClaimedLocalPublishJob
  extends Omit<LocalPublishSnapshot, 'mediaIndex' | 'notionLastEditedTime'> {
  id: string;
  claimToken: string;
  claimExpiresAt: string;
}
