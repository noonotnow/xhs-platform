export interface RednoteMetrics {
  views: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
}

export interface ClaimedRednoteMetricPost {
  notionPageId: string;
  noteId: string;
  shareUrl: string;
  publishedAt: string;
  claimToken: string;
  claimExpiresAt: string;
  previousMetrics?: RednoteMetrics;
  lastObservedAt?: string;
}

export interface RednoteMetricObservation {
  notionPageId: string;
  claimToken: string;
  observedAt: string;
  metrics: RednoteMetrics;
}

export interface RednoteWorkerRunSummary {
  claimed: number;
  verified: number;
  measured: number;
  snapshotsWritten: number;
  failures: number;
}
