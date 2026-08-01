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
  thumbnailUrl: string;
  tags: string[];
  scheduledDate?: string;
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
