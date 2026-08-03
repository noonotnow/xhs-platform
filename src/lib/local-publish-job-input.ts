import {
  extractLegacyTrailingHashtags,
  isCanonicalMediaImage,
  isCanonicalMediaMov,
  isCanonicalMediaVideo,
} from '@/lib/notion-posts';
import {
  isMovCompatibilityTrialEligible,
  movCompatibilityTrialBlockers,
} from '@/lib/mov-compatibility-trial';
import type { ReadyXhsPost } from '@/types/ready-post';
import type {
  LocalPublishMediaType,
  LocalPublishSnapshot,
} from '@/types/local-publish-job';

const MAX_TITLE_LENGTH = 100;
const MAX_CAPTION_LENGTH = 5_000;
const MAX_TAG_LENGTH = 100;
const MAX_TAGS = 20;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export class LocalPublishJobError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function cleanText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string') {
    throw new LocalPublishJobError(`${field} must be a string`, 'VALIDATION_ERROR', 400);
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  if (!cleaned) {
    throw new LocalPublishJobError(`${field} is required`, 'VALIDATION_ERROR', 400);
  }
  if (cleaned.length > maxLength) {
    throw new LocalPublishJobError(
      `${field} must be ${maxLength} characters or fewer`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return cleaned;
}

function cleanTags(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new LocalPublishJobError(
      `tags must be an array with at most ${MAX_TAGS} entries`,
      'VALIDATION_ERROR',
      400,
    );
  }
  const tags = value.map((tag) =>
    cleanText(tag, 'Each tag', MAX_TAG_LENGTH).replace(/^#+/, '').trim());
  if (tags.some((tag) => !tag)) {
    throw new LocalPublishJobError('Tags cannot contain only # characters', 'VALIDATION_ERROR', 400);
  }
  return Array.from(new Set(tags));
}

function mediaChoice(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('media must select a trusted asset', 'VALIDATION_ERROR', 400);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'image' && candidate.type !== 'video') {
    throw new LocalPublishJobError('media.type must be image or video', 'VALIDATION_ERROR', 400);
  }
  if (!Number.isSafeInteger(candidate.index) || (candidate.index as number) < 0) {
    throw new LocalPublishJobError(
      'media.index must be a non-negative integer',
      'VALIDATION_ERROR',
      400,
    );
  }
  return {
    type: candidate.type as LocalPublishMediaType,
    index: candidate.index as number,
  };
}

export interface QueueLocalPublishInput {
  notionPageId: string;
  lastEditedTime: string;
  confirmed: true;
  compatibilityTrialConfirmed: boolean;
  title: string;
  caption: string;
  tags: string[];
  media: {
    type: LocalPublishMediaType;
    index: number;
  };
}

export function queueCopy(
  input: Pick<QueueLocalPublishInput, 'caption' | 'tags'>,
  useLegacyFallback: boolean,
) {
  if (!useLegacyFallback) return { caption: input.caption, tags: input.tags };
  const legacyCopy = extractLegacyTrailingHashtags(input.caption);
  return {
    caption: legacyCopy.caption,
    tags: input.tags.length > 0 ? input.tags : legacyCopy.tags,
  };
}

export function parseQueueLocalPublishInput(value: unknown): QueueLocalPublishInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('Request body must be a JSON object', 'VALIDATION_ERROR', 400);
  }
  const body = value as Record<string, unknown>;
  if (body.confirmed !== true) {
    throw new LocalPublishJobError(
      'Explicit operator confirmation is required',
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
  const notionPageId = cleanText(body.notionPageId, 'notionPageId', 64);
  const lastEditedTime = cleanText(body.lastEditedTime, 'lastEditedTime', 64);
  return {
    notionPageId,
    lastEditedTime,
    confirmed: true,
    compatibilityTrialConfirmed: body.compatibilityTrialConfirmed === true,
    title: cleanText(body.title, 'title', MAX_TITLE_LENGTH),
    caption: cleanText(body.caption, 'caption', MAX_CAPTION_LENGTH),
    tags: cleanTags(body.tags),
    media: mediaChoice(body.media),
  };
}

export function buildLocalPublishSnapshot(
  post: ReadyXhsPost,
  input: QueueLocalPublishInput,
): LocalPublishSnapshot {
  if (post.lastEditedTime !== input.lastEditedTime) {
    throw new LocalPublishJobError(
      'This post changed in Notion. Refresh and review it before queueing.',
      'EDIT_CONFLICT',
      409,
    );
  }
  const compatibilityTrial = input.compatibilityTrialConfirmed;
  if (!compatibilityTrial && post.publishBlockers.length > 0) {
    throw new LocalPublishJobError(
      `Post cannot be queued: ${post.publishBlockers.join('; ')}`,
      'PUBLISH_BLOCKED',
      422,
    );
  }
  if (compatibilityTrial) {
    const unrelatedBlockers = movCompatibilityTrialBlockers(post);
    if (!isMovCompatibilityTrialEligible(post)) {
      const blockers = unrelatedBlockers.length > 0
        ? unrelatedBlockers.join('; ')
        : 'the post is not in the narrow media-only MOV trial state';
      throw new LocalPublishJobError(
        `MOV compatibility trial cannot be queued: ${blockers}`,
        'COMPATIBILITY_TRIAL_BLOCKED',
        422,
      );
    }
  }

  const candidates = compatibilityTrial
    ? post.compatibilityTrialVideoUrls ?? []
    : input.media.type === 'video'
      ? post.videoUrls
      : post.imageUrls;
  const mediaUrl = candidates[input.media.index];
  const validMedia = compatibilityTrial
    ? input.media.type === 'video' && isCanonicalMediaMov(mediaUrl ?? '')
    : input.media.type === 'video'
      ? isCanonicalMediaVideo(mediaUrl ?? '')
      : isCanonicalMediaImage(mediaUrl ?? '');
  if (!mediaUrl || !validMedia) {
    throw new LocalPublishJobError(
      'The selected media is not a trusted canonical HTTPS asset',
      'INVALID_MEDIA_CHOICE',
      422,
    );
  }

  const thumbnailUrl = isCanonicalMediaImage(post.thumbnailUrl)
    ? post.thumbnailUrl
    : undefined;
  const reviewedCopy = queueCopy(input, post.tagsSource === 'legacy-caption');
  return {
    notionPageId: post.id,
    headline: post.headline.trim(),
    title: input.title,
    caption: reviewedCopy.caption,
    tags: reviewedCopy.tags,
    platform: 'RedNote',
    mediaType: input.media.type,
    mediaIndex: input.media.index,
    mediaUrl,
    ...(compatibilityTrial ? { compatibilityTrial: 'unverified_mov' as const } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(post.publishAt ? { publishAt: post.publishAt } : {}),
    notionLastEditedTime: post.lastEditedTime,
  };
}

export function parseIdempotencyKey(value: string | null) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new LocalPublishJobError(
      'A valid Idempotency-Key UUID header is required',
      'INVALID_IDEMPOTENCY_KEY',
      400,
    );
  }
  return value.toLowerCase();
}
