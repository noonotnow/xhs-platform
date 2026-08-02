export interface ReadyXhsPost {
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
  publishAt?: string;
  lastEditedTime: string;
  publishBlockers: string[];
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
