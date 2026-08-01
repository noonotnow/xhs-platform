import { isDeepStrictEqual } from 'util';
import { getReadyXhsPost, markXhsPostPublished, NotionPostsError } from '@/lib/notion-posts';
import {
  buildLocalPublishSnapshot,
  LocalPublishJobError,
  parseQueueLocalPublishInput,
  type QueueLocalPublishInput,
} from '@/lib/local-publish-job-input';
import {
  claimNextStoredLocalPublishJob,
  completeStoredLocalPublishSuccess,
  failStoredLocalPublishJob,
  findLocalPublishJobByIdempotencyKey,
  insertLocalPublishJob,
  jobSummary,
  listLocalPublishJobs,
  prepareStoredLocalPublishSuccess,
  type StoredLocalPublishJob,
} from '@/lib/local-publish-job-store';
import type { PublishReadyPostResponse, ReadyXhsPost } from '@/types/ready-post';

const DEFAULT_LEASE_SECONDS = 2 * 60 * 60;
const MIN_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 24 * 60 * 60;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

interface QueueDependencies {
  getPost: (pageId: string) => Promise<ReadyXhsPost>;
  findByIdempotencyKey: typeof findLocalPublishJobByIdempotencyKey;
  insert: typeof insertLocalPublishJob;
}

interface ResultDependencies {
  fail: typeof failStoredLocalPublishJob;
  prepareSuccess: typeof prepareStoredLocalPublishSuccess;
  completeSuccess: typeof completeStoredLocalPublishSuccess;
  backfill: (pageId: string, result: PublishReadyPostResponse) => Promise<void>;
}

const queueDependencies: QueueDependencies = {
  getPost: getReadyXhsPost,
  findByIdempotencyKey: findLocalPublishJobByIdempotencyKey,
  insert: insertLocalPublishJob,
};

const resultDependencies: ResultDependencies = {
  fail: failStoredLocalPublishJob,
  prepareSuccess: prepareStoredLocalPublishSuccess,
  completeSuccess: completeStoredLocalPublishSuccess,
  backfill: markXhsPostPublished,
};

function cleanResultText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string') {
    throw new LocalPublishJobError(`${field} must be a string`, 'VALIDATION_ERROR', 400);
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  if (!cleaned || cleaned.length > maxLength) {
    throw new LocalPublishJobError(
      `${field} must be between 1 and ${maxLength} characters`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return cleaned;
}

function cleanFailureMessage(value: unknown) {
  const message = cleanResultText(value, 'message', 500).replace(/\s+/g, ' ');
  if (
    /https?:\/\//i.test(message) ||
    /\b(?:authorization|bearer|cookie|set-cookie|password|secret)\b/i.test(message) ||
    /\btoken\s*=/i.test(message)
  ) {
    throw new LocalPublishJobError(
      'Failure message must not contain URLs or credential-like data',
      'UNSAFE_FAILURE_MESSAGE',
      400,
    );
  }
  return message;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new LocalPublishJobError(
      'Result body contains unsupported fields',
      'VALIDATION_ERROR',
      400,
    );
  }
}

export type LocalPublishWorkerResult =
  | { status: 'succeeded'; noteId: string; shareUrl: string }
  | { status: 'failed'; code: string; message: string };

export function parseLocalPublishWorkerResult(value: unknown): LocalPublishWorkerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('Result body must be a JSON object', 'VALIDATION_ERROR', 400);
  }
  const body = value as Record<string, unknown>;
  if (body.status === 'succeeded') {
    assertExactKeys(body, ['noteId', 'shareUrl', 'status']);
    const noteId = cleanResultText(body.noteId, 'noteId', 128);
    if (!/^[A-Za-z0-9_-]+$/.test(noteId)) {
      throw new LocalPublishJobError(
        'noteId contains unsupported characters',
        'INVALID_SUCCESS_RESULT',
        400,
      );
    }
    const shareUrl = cleanResultText(body.shareUrl, 'shareUrl', 500);
    const expectedUrl = `https://www.rednote.com/explore/${noteId}`;
    if (shareUrl !== expectedUrl) {
      throw new LocalPublishJobError(
        'shareUrl must exactly match the verified RedNote explore URL for noteId',
        'INVALID_SUCCESS_RESULT',
        400,
      );
    }
    return { status: 'succeeded', noteId, shareUrl };
  }
  if (body.status === 'failed') {
    assertExactKeys(body, ['code', 'message', 'status']);
    const code = cleanResultText(body.code, 'code', 80);
    if (!/^[A-Z0-9_][A-Z0-9_.-]*$/.test(code)) {
      throw new LocalPublishJobError(
        'Failure code must be an uppercase safe identifier',
        'VALIDATION_ERROR',
        400,
      );
    }
    return {
      status: 'failed',
      code,
      message: cleanFailureMessage(body.message),
    };
  }
  throw new LocalPublishJobError(
    'status must be succeeded or failed',
    'VALIDATION_ERROR',
    400,
  );
}

export async function queueLocalPublishJob(
  rawInput: unknown,
  idempotencyKey: string,
  dependencies: QueueDependencies = queueDependencies,
) {
  const input: QueueLocalPublishInput = parseQueueLocalPublishInput(rawInput);
  const existing = await dependencies.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    const matches = existing.snapshot.notionPageId === input.notionPageId &&
      existing.snapshot.notionLastEditedTime === input.lastEditedTime &&
      existing.snapshot.title === input.title &&
      existing.snapshot.caption === input.caption &&
      isDeepStrictEqual(existing.snapshot.tags, input.tags) &&
      existing.snapshot.mediaType === input.media.type &&
      existing.snapshot.mediaIndex === input.media.index &&
      existing.snapshot.compatibilityTrial === (
        input.compatibilityTrialConfirmed ? 'unverified_mov' : undefined
      );
    if (!matches) {
      throw new LocalPublishJobError(
        'Idempotency-Key was already used for a different request',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return { job: jobSummary(existing), created: false };
  }
  const post = await dependencies.getPost(input.notionPageId);
  const snapshot = buildLocalPublishSnapshot(post, input);
  const result = await dependencies.insert(snapshot, idempotencyKey);
  return { job: jobSummary(result.job), created: result.created };
}

function leaseSeconds() {
  const configured = Number(process.env.LOCAL_PUBLISH_JOB_LEASE_SECONDS);
  if (!Number.isSafeInteger(configured)) return DEFAULT_LEASE_SECONDS;
  return Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, configured));
}

export async function claimNextLocalPublishJob() {
  return claimNextStoredLocalPublishJob(leaseSeconds());
}

export async function getLocalPublishJobSummaries() {
  return (await listLocalPublishJobs()).map(jobSummary);
}

export async function submitLocalPublishJobResult(
  id: string,
  claimToken: string,
  rawResult: unknown,
  dependencies: ResultDependencies = resultDependencies,
) {
  const result = parseLocalPublishWorkerResult(rawResult);
  if (result.status === 'failed') {
    return jobSummary(await dependencies.fail(
      id,
      claimToken,
      result.code,
      result.message,
    ));
  }

  const prepared = await dependencies.prepareSuccess(
    id,
    claimToken,
    result.noteId,
    result.shareUrl,
  );
  if (prepared.status === 'succeeded') return jobSummary(prepared);

  try {
    await dependencies.backfill(prepared.notionPageId, {
      status: 'success',
      noteId: result.noteId,
      shareUrl: result.shareUrl,
    });
  } catch (error) {
    console.error('Verified local publish result could not be backfilled to Notion', {
      jobId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new LocalPublishJobError(
      'RedNote publishing was verified, but Notion backfill is incomplete. Do not publish again; retry this same success result.',
      'NOTION_BACKFILL_FAILED',
      502,
    );
  }

  return jobSummary(await dependencies.completeSuccess(
    id,
    claimToken,
    result.noteId,
    result.shareUrl,
  ));
}

export function normalizeLocalPublishJobError(error: unknown) {
  if (error instanceof LocalPublishJobError || error instanceof NotionPostsError) {
    return error;
  }
  console.error('Local publish job operation failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  return new LocalPublishJobError(
    'The local publish job operation failed',
    'LOCAL_PUBLISH_JOB_FAILED',
    503,
  );
}

export type { StoredLocalPublishJob };
