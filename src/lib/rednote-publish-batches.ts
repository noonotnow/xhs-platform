import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { buildLocalPublishSnapshot } from '@/lib/local-publish-job-input';
import {
  getReadyXhsPost,
  listReadyXhsPosts,
  NotionPostsError,
} from '@/lib/notion-posts';
import {
  approveStoredPublishBatch,
  createStoredPublishBatch,
  listStoredPublishBatches,
  type NewPublishBatchItem,
} from '@/lib/rednote-publish-batch-store';
import type {
  LocalPublishSnapshot,
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
    post.candidateKind !== 'packet_ready' ||
    post.publishBlockers.length > 0 ||
    !post.publishAt
  ) {
    return null;
  }
  const media = primaryMedia(post);
  if (!media) return null;
  return buildLocalPublishSnapshot(post, {
    notionPageId: post.id,
    lastEditedTime: post.lastEditedTime,
    confirmed: true,
    compatibilityTrialConfirmed: false,
    title: post.headline,
    caption: post.caption,
    tags: post.tags,
    media,
  });
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

export async function createPublishBatch(kind: PublishBatchKind, now = new Date()) {
  const { posts } = await listReadyXhsPosts();
  const items = buildBatchItems(posts, kind, now);
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
  const decisions = await Promise.all(batch.items.map(async (item) => {
    try {
      const post = await getReadyXhsPost(item.notionPageId);
      const current = buildBatchSnapshot(post);
      const currentHash = current ? manifestHash(current) : '';
      return {
        itemId: item.id,
        approved: currentHash === item.itemHash &&
          isDeepStrictEqual(
            item.dispatchMode === 'post_now'
              ? { ...current, publishAt: undefined }
              : current,
            item.dispatchMode === 'post_now'
              ? { ...item.snapshot, publishAt: undefined }
              : item.snapshot,
          ),
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
