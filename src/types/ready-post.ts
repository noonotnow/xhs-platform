export type ReadyPostCandidateKind =
  | 'packet_ready'
  | 'mov_compatibility_trial'
  | 'active_unpublished';

export interface XhsPost {
  id: string;
  pageUrl: string;
  headline: string;
  caption: string;
  status: string;
  publishPacketReady: boolean;
  hasVideo: boolean;
  needsMedia: boolean;
  needsCaption: boolean;
  mediaUrls: string[];
  imageUrls: string[];
  videoUrls: string[];
  compatibilityTrialVideoUrls?: string[];
  thumbnailUrl: string;
  tags: string[];
  tagsSource?: 'final-tags' | 'legacy-caption' | 'none';
  scheduledDate: string | null;
  publishAt?: string;
  lastEditedTime: string;
  xhsNoteId?: string;
  xhsShareUrl?: string;
  publishedAt?: string;
  automationBlockers: string[];
  manualWarnings: string[];
  /** @deprecated Use automationBlockers. */
  publishBlockers: string[];
  manualHandling?: ManualPostHandlingSummary;
}

export interface ReadyXhsPost extends XhsPost {
  candidateKind: ReadyPostCandidateKind;
}

export interface ReadyXhsPostsResponse {
  posts: ReadyXhsPost[];
  warnings: string[];
}

export interface PublishReadyPostResponse {
  status: 'success';
  noteId: string;
  shareUrl: string;
}
import type { ManualPostHandlingSummary } from '@/types/manual-post-handling';
