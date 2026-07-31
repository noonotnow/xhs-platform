import {
  getReadyXhsPost,
  isCanonicalMediaVideo,
  markXhsPostPublished,
  NotionPostsError,
} from '@/lib/notion-posts';
import {
  publishVideoUrl,
  type PublishVideoUrlResponse,
  XhsMicroserviceHttpError,
} from '@/lib/xhs-microservice';
import type { PublishReadyPostResponse } from '@/types/ready-post';
import {
  claimXhsPublish,
  recordXhsPublish,
  releaseXhsPublishClaim,
} from '@/lib/xhs-publish-receipts';

export class ReadyPostPublishError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly published?: PublishReadyPostResponse,
  ) {
    super(message);
  }
}

interface PublishDependencies {
  getPost: typeof getReadyXhsPost;
  publish: typeof publishVideoUrl;
  backfill: typeof markXhsPostPublished;
  claim: typeof claimXhsPublish;
  record: typeof recordXhsPublish;
  release: typeof releaseXhsPublishClaim;
}

const defaultDependencies: PublishDependencies = {
  getPost: getReadyXhsPost,
  publish: publishVideoUrl,
  backfill: markXhsPostPublished,
  claim: claimXhsPublish,
  record: recordXhsPublish,
  release: releaseXhsPublishClaim,
};

function confirmedResult(result: PublishVideoUrlResponse): PublishReadyPostResponse {
  if (
    result.status !== 'success' ||
    typeof result.note_id !== 'string' ||
    !result.note_id.trim() ||
    typeof result.share_url !== 'string' ||
    !result.share_url.startsWith('https://')
  ) {
    throw new ReadyPostPublishError(
      'XHS microservice returned an invalid success response',
      'INVALID_PUBLISH_RESPONSE',
      502,
    );
  }
  return {
    status: 'success',
    noteId: result.note_id,
    shareUrl: result.share_url,
  };
}

export async function publishReadyPost(
  pageId: string,
  input: { confirmed?: unknown; lastEditedTime?: unknown },
  dependencies: PublishDependencies = defaultDependencies,
) {
  if (input.confirmed !== true) {
    throw new ReadyPostPublishError(
      'Explicit operator confirmation is required',
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
  if (typeof input.lastEditedTime !== 'string' || !input.lastEditedTime) {
    throw new ReadyPostPublishError(
      'lastEditedTime is required',
      'VALIDATION_ERROR',
      400,
    );
  }

  const post = await dependencies.getPost(pageId);
  if (post.lastEditedTime !== input.lastEditedTime) {
    throw new ReadyPostPublishError(
      'This post changed in Notion. Refresh and review it before publishing.',
      'EDIT_CONFLICT',
      409,
    );
  }
  if (post.publishBlockers.length > 0) {
    throw new ReadyPostPublishError(
      `Post cannot be published: ${post.publishBlockers.join('; ')}`,
      'PUBLISH_BLOCKED',
      422,
    );
  }

  const videoUrl = post.videoUrls.find(isCanonicalMediaVideo);
  if (!videoUrl) {
    throw new ReadyPostPublishError(
      'Post has no trusted canonical MEDIA MP4',
      'INVALID_VIDEO_URL',
      422,
    );
  }

  if (!(await dependencies.claim(pageId))) {
    throw new ReadyPostPublishError(
      'This post is already publishing or has already been published',
      'PUBLISH_ALREADY_CLAIMED',
      409,
    );
  }

  let published: PublishReadyPostResponse;
  try {
    published = confirmedResult(await dependencies.publish({
      video_url: videoUrl,
      title: post.headline,
      caption: post.caption,
      tags: post.tags.length > 0 ? post.tags : undefined,
    }));
  } catch (error) {
    if (error instanceof XhsMicroserviceHttpError) {
      await dependencies.release(pageId);
    }
    throw error;
  }

  try {
    await dependencies.record(pageId, published);
  } catch (error) {
    console.error('XHS publish succeeded but publish receipt persistence failed:', error);
    throw new ReadyPostPublishError(
      'XHS published the post, but the local publish receipt could not be saved. Do not publish again; use the returned XHS link to reconcile the record.',
      'PUBLISH_RECEIPT_FAILED',
      502,
      published,
    );
  }

  try {
    await dependencies.backfill(pageId, published);
  } catch (error) {
    console.error('XHS publish succeeded but Notion backfill failed:', error);
    throw new ReadyPostPublishError(
      'XHS published the post, but Notion backfill failed. Do not publish again; update the record using the returned XHS link.',
      'NOTION_BACKFILL_FAILED',
      502,
      published,
    );
  }

  return published;
}

export function normalizePublishError(error: unknown) {
  if (error instanceof ReadyPostPublishError || error instanceof NotionPostsError) {
    return error;
  }
  console.error('Ready post publish failed:', error);
  return new ReadyPostPublishError(
    'Failed to publish the selected post',
    'PUBLISH_FAILED',
    502,
  );
}
