import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { buildLocalPublishSnapshot } from '@/lib/local-publish-job-input';
import {
  getReadyXhsPost,
  listReadyXhsPosts,
  NotionPostsError,
} from '@/lib/notion-posts';
import {
  jobSummary,
  listPublishOwningLocalJobs,
} from '@/lib/local-publish-job-store';
import {
  approveStoredPublishBatch,
  createStoredPublishBatch,
  listStoredPublishBatches,
  type NewPublishBatchItem,
} from '@/lib/rednote-publish-batch-store';
import type {
  LocalPublishSnapshot,
  LocalPublishJobSummary,
  PublishBatchBlockedCandidate,
  PublishBatchKind,
} from '@/types/local-publish-job';
import type { ReadyXhsPost } from '@/types/ready-post';

export const REDNOTE_TIME_ZONE = 'America/New_York';
export const MAX_LATE_SECONDS = 24 * 60 * 60;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function manifestHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function primaryMedia(post: ReadyXhsPost) {
  if (post.hasVideo && post.videoUrls[0]) {
    return { type: 'video' as const, index: 0 };
  }
  if (!post.hasVideo && post.imageUrls[0]) {
    return { type: 'image' as const, index: 0 };
  }
  return null;
}

export function buildBatchSnapshot(post: ReadyXhsPost): LocalPublishSnapshot | null {
  if (
    post.status.trim().toLowerCase() === 'published' ||
    post.candidateKind !== 'packet_ready' ||
    post.publishBlockers.length > 0 ||
    !post.publishAt
  ) {
    return null;
  }
  const publishAt = new Date(post.publishAt);
  if (
    Number.isNaN(publishAt.getTime()) ||
    publishAt.getUTCSeconds() !== 0 ||
    publishAt.getUTCMilliseconds() !== 0
  ) {
    return null;
  }
  const media = primaryMedia(post);
  if (!media) return null;
  const snapshot = buildLocalPublishSnapshot(post, {
    notionPageId: post.id,
    lastEditedTime: post.lastEditedTime,
    confirmed: true,
    compatibilityTrialConfirmed: false,
    title: post.headline,
    caption: post.caption,
    tags: post.tags,
    media,
  });
  return { ...snapshot, publishAt: publishAt.toISOString() };
}

function zonedParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REDNOTE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function zonedMidnightUtc(year: number, month: number, day: number) {
  let candidate = Date.UTC(year, month - 1, day);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(candidate));
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    candidate += Date.UTC(year, month - 1, day) - represented;
  }
  return new Date(candidate);
}

export function weeklyWindow(now: Date) {
  const parts = zonedParts(now);
  const localDate = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
  ));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const daysUntilMonday = (8 - weekday) % 7 || 7;
  const monday = new Date(localDate);
  monday.setUTCDate(localDate.getUTCDate() + daysUntilMonday);
  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(monday.getUTCDate() + 7);
  return {
    start: zonedMidnightUtc(
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate(),
    ),
    end: zonedMidnightUtc(
      nextMonday.getUTCFullYear(),
      nextMonday.getUTCMonth() + 1,
      nextMonday.getUTCDate(),
    ),
  };
}

export function dueSweepKinds(now: Date) {
  const parts = zonedParts(now);
  const kinds: Array<'daily' | 'weekly'> = [];
  if (parts.hour === '08') kinds.push('daily');
  if (parts.weekday === 'Sun' && parts.hour === '18') kinds.push('weekly');
  return kinds;
}

export function buildBatchItems(
  posts: ReadyXhsPost[],
  kind: PublishBatchKind,
  now: Date,
) {
  const weekly = weeklyWindow(now);
  return posts.flatMap((post): NewPublishBatchItem[] => {
    const snapshot = buildBatchSnapshot(post);
    if (!snapshot?.publishAt) return [];
    const publishAt = new Date(snapshot.publishAt);
    if (kind === 'weekly' && (publishAt < weekly.start || publishAt >= weekly.end)) return [];
    const lateBySeconds = Math.max(0, Math.floor((now.getTime() - publishAt.getTime()) / 1000));
    if (lateBySeconds > MAX_LATE_SECONDS) return [];
    const dispatchMode = lateBySeconds > 0 ? 'post_now' as const : 'scheduled' as const;
    return [{
      notionPageId: post.id,
      snapshot,
      itemHash: manifestHash(snapshot),
      dispatchMode,
      lateBySeconds,
    }];
  });
}

export function buildBatchCandidateAccounting(
  posts: ReadyXhsPost[],
  kind: PublishBatchKind,
  now: Date,
  localJobs: LocalPublishJobSummary[] = [],
) {
  const weekly = weeklyWindow(now);
  const owningJobs = new Map<string, LocalPublishJobSummary>();
  for (const job of localJobs) {
    if (!owningJobs.has(job.notionPageId)) owningJobs.set(job.notionPageId, job);
  }
  const items = buildBatchItems(posts, kind, now)
    .filter((item) => !owningJobs.has(item.notionPageId));
  const included = new Set(items.map((item) => item.notionPageId));
  const blockedCandidates = posts.flatMap((post): PublishBatchBlockedCandidate[] => {
    if (included.has(post.id)) return [];
    const publishAt = post.publishAt ? new Date(post.publishAt) : null;
    if (
      kind === 'weekly' &&
      publishAt &&
      !Number.isNaN(publishAt.getTime()) &&
      (publishAt < weekly.start || publishAt >= weekly.end)
    ) {
      return [];
    }

    let reason: string;
    const owningJob = owningJobs.get(post.id);
    if (post.status.trim().toLowerCase() === 'published') {
      reason =
        'Canonical Notion Status is Published. This record is already post-dispatch and is not authorized for another batch.';
    } else if (owningJob) {
      reason =
        `Local publish job ${owningJob.id} is ${owningJob.status}. ` +
        'An existing active or post-dispatch lifecycle owns this record; do not publish it again.';
    } else if (!publishAt) {
      reason = 'Needs publish time: set an exact ScheduledDate instant with timezone.';
    } else if (
      Number.isNaN(publishAt.getTime()) ||
      publishAt.getUTCSeconds() !== 0 ||
      publishAt.getUTCMilliseconds() !== 0
    ) {
      reason = 'ScheduledDate must be an exact canonical UTC minute.';
    } else if ((now.getTime() - publishAt.getTime()) / 1000 > MAX_LATE_SECONDS) {
      reason = 'ScheduledDate is more than 24 hours late and fails closed.';
    } else if (
      (post.compatibilityTrialVideoUrls?.length ?? 0) > 0 &&
      post.videoUrls.length === 0
    ) {
      reason =
        'Canonical MOV media is present, but no authoritative RedNote-compatible verdict is available. Attach canonical MP4 media or obtain authoritative RedNote compatibility certification; extension or container alone is not evidence, and no batch bypass is allowed.';
    } else if (post.publishBlockers.length > 0) {
      reason = post.publishBlockers.join(' · ');
    } else {
      reason = 'The post is not currently eligible for an immutable publish snapshot.';
    }
    return [{
      notionPageId: post.id,
      headline: post.headline,
      ...(post.publishAt ? { publishAt: post.publishAt } : {}),
      reason,
    }];
  });
  return { items, blockedCandidates };
}

export async function createPublishBatch(kind: PublishBatchKind, now = new Date()) {
  const { posts } = await listReadyXhsPosts({ includePublishedCandidates: true });
  const jobs = await listPublishOwningLocalJobs(posts.map((post) => post.id));
  const { items, blockedCandidates } = buildBatchCandidateAccounting(
    posts,
    kind,
    now,
    jobs.map(jobSummary),
  );
  const window = kind === 'weekly' ? weeklyWindow(now) : undefined;
  return createStoredPublishBatch({
    kind,
    manifestHash: manifestHash(items.map((item) => ({
      notionPageId: item.notionPageId,
      itemHash: item.itemHash,
      dispatchMode: item.dispatchMode,
      lateBySeconds: item.lateBySeconds,
    }))),
    items,
    blockedCandidates,
    ...(window ? { windowStart: window.start.toISOString(), windowEnd: window.end.toISOString() } : {}),
  });
}

export async function approvePublishBatch(
  batchId: string,
  expectedManifestHash: string,
  approvedBy: string,
) {
  const batch = (await listStoredPublishBatches(batchId))[0];
  if (!batch || batch.manifestHash !== expectedManifestHash) {
    throw new Error('The batch manifest changed or no longer exists; refresh before approving.');
  }
  if (batch.status !== 'pending_approval') {
    throw new Error(
      batch.status === 'superseded'
        ? 'This batch was superseded and can never be approved. Refresh to review its replacement manifest.'
        : 'The batch is no longer pending approval; refresh before approving.',
    );
  }
  const decisions = await Promise.all(batch.items.map(async (item) => {
    try {
      const post = await getReadyXhsPost(item.notionPageId);
      const current = buildBatchSnapshot(post);
      const currentHash = current ? manifestHash(current) : '';
      return {
        itemId: item.id,
        approved: currentHash === item.itemHash &&
          isDeepStrictEqual(current, item.snapshot),
        reason: currentHash === item.itemHash
          ? undefined
          : 'The Notion source revision or frozen publishing fields changed.',
      };
    } catch (error) {
      if (!(error instanceof NotionPostsError) || error.status >= 500) throw error;
      return {
        itemId: item.id,
        approved: false,
        reason: 'The Notion post is no longer an eligible unpublished packet.',
      };
    }
  }));
  return approveStoredPublishBatch(
    batchId,
    expectedManifestHash,
    approvedBy,
    decisions,
  );
}

export async function listPublishBatches(batchId?: string) {
  return listStoredPublishBatches(batchId);
}
