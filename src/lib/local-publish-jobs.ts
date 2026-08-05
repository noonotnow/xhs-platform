import { isDeepStrictEqual } from 'util';
import { getReadyXhsPost, markXhsPostPublished, NotionPostsError } from '@/lib/notion-posts';
import {
  buildLocalPublishSnapshot,
  LocalPublishJobError,
  parseQueueLocalPublishInput,
  queueCopy,
  type QueueLocalPublishInput,
} from '@/lib/local-publish-job-input';
import {
  authorizeStoredLocalPublishJob,
  claimNextStoredLocalPublishJob,
  completeStoredLocalPublishReconciliation,
  consumeStoredDispatchAuthorization,
  deferStoredLocalPublishVerification,
  deferStoredOperatorAttestedVerification,
  failStoredLocalPublishJob,
  findLocalPublishJobByIdempotencyKey,
  insertLocalPublishJob,
  jobSummary,
  listLocalPublishJobs,
  prepareStoredLocalPublishVerification,
  recordStoredLocalPublishDispatch,
  stageStoredLocalPublishJob,
  type StoredLocalPublishJob,
} from '@/lib/local-publish-job-store';
import {
  isRednoteNoteId,
  normalizeRednoteShareUrl,
} from '@/lib/rednote-publication';
import type { PublishReadyPostResponse, ReadyXhsPost } from '@/types/ready-post';
import type { LocalPublishWorkLane } from '@/types/local-publish-job';
import {
  buildBatchSnapshot,
  manifestHash,
} from '@/lib/rednote-publish-batches';
import { invalidateStoredBatchItem } from '@/lib/rednote-publish-batch-store';

const DEFAULT_LEASE_SECONDS = 2 * 60 * 60;
const MIN_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 24 * 60 * 60;
const DEFAULT_VERIFICATION_BACKOFF_SECONDS = [15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60] as const;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface QueueDependencies {
  getPost: (pageId: string) => Promise<ReadyXhsPost>;
  findByIdempotencyKey: typeof findLocalPublishJobByIdempotencyKey;
  insert: typeof insertLocalPublishJob;
}

interface ResultDependencies {
  stage: typeof stageStoredLocalPublishJob;
  recordDispatch: typeof recordStoredLocalPublishDispatch;
  deferVerification: typeof deferStoredLocalPublishVerification;
  deferAttestedVerification?: typeof deferStoredOperatorAttestedVerification;
  fail: typeof failStoredLocalPublishJob;
  prepareVerification: typeof prepareStoredLocalPublishVerification;
  completeReconciliation: typeof completeStoredLocalPublishReconciliation;
  backfill: (
    pageId: string,
    result: PublishReadyPostResponse,
    publishedAt?: string,
  ) => Promise<void>;
}

const queueDependencies: QueueDependencies = {
  getPost: getReadyXhsPost,
  findByIdempotencyKey: findLocalPublishJobByIdempotencyKey,
  insert: insertLocalPublishJob,
};

const resultDependencies: ResultDependencies = {
  stage: stageStoredLocalPublishJob,
  recordDispatch: recordStoredLocalPublishDispatch,
  deferVerification: deferStoredLocalPublishVerification,
  deferAttestedVerification: deferStoredOperatorAttestedVerification,
  fail: failStoredLocalPublishJob,
  prepareVerification: prepareStoredLocalPublishVerification,
  completeReconciliation: completeStoredLocalPublishReconciliation,
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
  | { status: 'staged' }
  | { status: 'submitted' | 'scheduled'; noteId: string; shareUrl: string }
  | {
      status: 'verification_pending';
      noteId: string;
      shareUrl: string;
      code: string;
      message: string;
    }
  | {
      status: 'attested_verification_pending';
      code: string;
      message: string;
    }
  | { status: 'verified'; noteId: string; shareUrl: string }
  | { status: 'failed'; code: string; message: string };

function cleanCode(value: unknown) {
  const code = cleanResultText(value, 'code', 80);
  if (!/^[A-Z0-9_][A-Z0-9_.-]*$/.test(code)) {
    throw new LocalPublishJobError(
      'Result code must be an uppercase safe identifier',
      'VALIDATION_ERROR',
      400,
    );
  }
  return code;
}

function publicationIdentifiers(body: Record<string, unknown>) {
  const noteId = cleanResultText(body.noteId, 'noteId', 128);
  if (!isRednoteNoteId(noteId)) {
    throw new LocalPublishJobError(
      'noteId contains unsupported characters',
      'INVALID_SUCCESS_RESULT',
      400,
    );
  }
  const suppliedShareUrl = cleanResultText(body.shareUrl, 'shareUrl', 500);
  const shareUrl = normalizeRednoteShareUrl(noteId, suppliedShareUrl);
  if (!shareUrl) {
    throw new LocalPublishJobError(
      'shareUrl must match the RedNote explore URL for noteId',
      'INVALID_SUCCESS_RESULT',
      400,
    );
  }
  return { noteId, shareUrl };
}

export function parseLocalPublishWorkerResult(value: unknown): LocalPublishWorkerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError('Result body must be a JSON object', 'VALIDATION_ERROR', 400);
  }
  const body = value as Record<string, unknown>;
  if (body.status === 'staged') {
    assertExactKeys(body, ['status']);
    return { status: 'staged' };
  }
  if (
    body.status === 'submitted' ||
    body.status === 'scheduled'
  ) {
    assertExactKeys(body, ['noteId', 'shareUrl', 'status']);
    return {
      status: body.status,
      ...publicationIdentifiers(body),
    };
  }
  if (body.status === 'verification_pending') {
    assertExactKeys(body, ['code', 'message', 'noteId', 'shareUrl', 'status']);
    return {
      status: 'verification_pending',
      ...publicationIdentifiers(body),
      code: cleanCode(body.code),
      message: cleanFailureMessage(body.message),
    };
  }
  if (body.status === 'attested_verification_pending') {
    assertExactKeys(body, ['code', 'message', 'status']);
    return {
      status: 'attested_verification_pending',
      code: cleanCode(body.code),
      message: cleanFailureMessage(body.message),
    };
  }
  if (
    body.status === 'published' ||
    body.status === 'verified' ||
    body.status === 'succeeded'
  ) {
    assertExactKeys(body, ['noteId', 'shareUrl', 'status']);
    return { status: 'verified', ...publicationIdentifiers(body) };
  }
  if (body.status === 'failed') {
    assertExactKeys(body, ['code', 'message', 'status']);
    return {
      status: 'failed',
      code: cleanCode(body.code),
      message: cleanFailureMessage(body.message),
    };
  }
  throw new LocalPublishJobError(
    'status must be staged, submitted, scheduled, verification_pending, attested_verification_pending, published, verified, or failed',
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
    const rawCopy = queueCopy(input, false);
    const legacyCopy = queueCopy(input, true);
    const copyMatches = (
      existing.snapshot.caption === rawCopy.caption &&
      isDeepStrictEqual(existing.snapshot.tags, rawCopy.tags)
    ) || (
      existing.snapshot.caption === legacyCopy.caption &&
      isDeepStrictEqual(existing.snapshot.tags, legacyCopy.tags)
    );
    const matches = existing.snapshot.notionPageId === input.notionPageId &&
      existing.snapshot.notionLastEditedTime === input.lastEditedTime &&
      existing.snapshot.title === input.title &&
      copyMatches &&
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

export function verificationBackoffSeconds() {
  const configured = process.env.LOCAL_PUBLISH_VERIFICATION_BACKOFF_SECONDS
    ?.split(',')
    .map((value) => Number(value.trim()));
  if (
    configured?.length === 4 &&
    configured.every((value) => Number.isSafeInteger(value) && value >= 60 && value <= 604_800)
  ) {
    return configured as [number, number, number, number];
  }
  return [...DEFAULT_VERIFICATION_BACKOFF_SECONDS] as [number, number, number, number];
}

export function validateExpectedVerificationJobId(
  lane: LocalPublishWorkLane,
  expectedJobId: string,
) {
  if (!UUID_PATTERN.test(expectedJobId)) {
    throw new LocalPublishJobError(
      'expectedJobId must be one exact UUID',
      'VALIDATION_ERROR',
      400,
    );
  }
  if (lane !== 'verification') {
    throw new LocalPublishJobError(
      'expectedJobId requires lane=verification',
      'VALIDATION_ERROR',
      400,
    );
  }
}

export async function claimNextLocalPublishJob(
  lane: LocalPublishWorkLane = 'all',
  expectedJobId?: string,
) {
  if (expectedJobId !== undefined) {
    validateExpectedVerificationJobId(lane, expectedJobId);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const job = await claimNextStoredLocalPublishJob(leaseSeconds(), lane, expectedJobId);
    if (!job && expectedJobId) {
      throw new LocalPublishJobError(
        'The expected verification job is not currently claimable',
        'EXPECTED_JOB_NOT_CLAIMABLE',
        409,
      );
    }
    if (!job || !job.batchAuthorization) return job;
    if (
      job.status !== 'claimed' &&
      job.status !== 'staged'
    ) {
      return job;
    }
    if (await batchSourceMatches(job)) return job;
    await invalidateStoredBatchItem(
      job.id,
      job.claimToken,
      'The Notion source changed after batch approval. Refresh it into a new batch.',
    );
  }
  throw new LocalPublishJobError(
    'Too many stale batch items were invalidated in one claim request',
    'BATCH_CLAIM_RETRY_LIMIT',
    409,
  );
}

async function batchSourceMatches(job: Awaited<ReturnType<typeof authorizeStoredLocalPublishJob>>) {
  if (!job.batchAuthorization) return true;
  try {
    const post = await getReadyXhsPost(job.notionPageId);
    const current = buildBatchSnapshot(post);
    return Boolean(
      current &&
        manifestHash(current) === job.batchAuthorization.itemHash &&
        current.notionLastEditedTime === job.batchAuthorization.snapshotRevision &&
        isDeepStrictEqual(current, {
          notionPageId: job.notionPageId,
          headline: job.headline,
          title: job.title,
          caption: job.caption,
          tags: job.tags,
          platform: job.platform,
          mediaType: job.mediaType,
          mediaIndex: current.mediaIndex,
          mediaUrl: job.mediaUrl,
          ...(job.thumbnailUrl ? { thumbnailUrl: job.thumbnailUrl } : {}),
          publishAt: job.publishAt,
          notionLastEditedTime: job.batchAuthorization.snapshotRevision,
        }),
    );
  } catch (error) {
    if (!(error instanceof NotionPostsError) || error.status >= 500) throw error;
    return false;
  }
}

export async function authorizeLocalPublishJob(id: string, claimToken: string) {
  const job = await authorizeStoredLocalPublishJob(id, claimToken);
  if (
    job.batchAuthorization &&
    (job.status === 'claimed' || job.status === 'staged') &&
    !(await batchSourceMatches(job))
  ) {
    await invalidateStoredBatchItem(
      job.id,
      job.claimToken,
      'The Notion source changed after batch approval. Refresh it into a new batch.',
    );
    throw new LocalPublishJobError(
      'The bounded batch authorization is stale or revoked',
      'INVALID_BATCH_AUTHORIZATION',
      409,
    );
  }
  if (job.status === 'staged') {
    return consumeStoredDispatchAuthorization(job.id, job.claimToken);
  }
  return job;
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
  let publishedAt: string | undefined;
  if (result.status === 'staged') {
    return jobSummary(await dependencies.stage(id, claimToken));
  }
  if (result.status === 'submitted' || result.status === 'scheduled') {
    const dispatched = await dependencies.recordDispatch(
      id,
      claimToken,
      result.status,
      result.noteId,
      result.shareUrl,
      verificationBackoffSeconds()[0],
    );
    if (dispatched.status !== 'submitted') return jobSummary(dispatched);
    publishedAt = dispatched.dispatchedAt;
  }
  if (result.status === 'verification_pending') {
    return jobSummary(await dependencies.deferVerification(
      id,
      claimToken,
      result.noteId,
      result.shareUrl,
      result.code,
      result.message,
      verificationBackoffSeconds(),
    ));
  }
  if (result.status === 'attested_verification_pending') {
    return jobSummary(await (
      dependencies.deferAttestedVerification ?? deferStoredOperatorAttestedVerification
    )(
      id,
      claimToken,
      result.code,
      result.message,
      verificationBackoffSeconds(),
    ));
  }
  if (result.status === 'failed') {
    return jobSummary(await dependencies.fail(
      id,
      claimToken,
      result.code,
      result.message,
    ));
  }

  const publicationResult = result as Extract<
    LocalPublishWorkerResult,
    { status: 'submitted' | 'verified' }
  >;
  const prepared = await dependencies.prepareVerification(
    id,
    claimToken,
    publicationResult.noteId,
    publicationResult.shareUrl,
  );
  if (prepared.status === 'reconciled') return jobSummary(prepared);

  try {
    await dependencies.backfill(prepared.notionPageId, {
      status: 'success',
      noteId: publicationResult.noteId,
      shareUrl: publicationResult.shareUrl,
    }, publishedAt ?? prepared.verifiedAt);
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

  return jobSummary(await dependencies.completeReconciliation(
    id,
    claimToken,
    publicationResult.noteId,
    publicationResult.shareUrl,
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
