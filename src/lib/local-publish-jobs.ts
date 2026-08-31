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
  heartbeatStoredLocalPublishJob,
} from '@/lib/local-publish-job-store';
import {
  isRednoteNoteId,
  normalizeRednoteShareUrl,
} from '@/lib/rednote-publication';
import type { PublishReadyPostResponse, ReadyXhsPost } from '@/types/ready-post';
import type {
  LocalPublishJobSummary,
  LocalPublishSnapshot,
  LocalPublishWorkLane,
} from '@/types/local-publish-job';
import type { ReadyX3Authorization } from '@/types/local-publish-job';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';
import {
  buildBatchSnapshot,
  manifestHash,
} from '@/lib/rednote-publish-batches';
import { invalidateStoredBatchItem } from '@/lib/rednote-publish-batch-store';
import {
  createRednotePublishAttempt,
  frozenPayloadDigest,
  bindLinkedAttemptClaim,
  authorizeLinkedAttempt,
  consumeLinkedReadyX3DispatchAuthorization,
  recordLinkedAttemptOutcome,
  heartbeatLinkedAttempt,
  getLinkedRednotePublishAttempt,
  invalidateLinkedReadyX3Source,
  supersedeUnclaimedReadyX3Schedule,
  withReadyX3SourceLock,
} from '@/lib/rednote-publishing-attempt-store';
import {
  REDNOTE_PUBLISHING_CONTRACT_REVISION,
  type FrozenRednoteAttemptPayload,
} from '@/lib/rednote-publishing-contract-v1';
import { createHash } from 'crypto';

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

interface QueueLocalPublishJobResult {
  job: LocalPublishJobSummary;
  created: boolean;
  attempt?:
    | Awaited<ReturnType<typeof getLinkedRednotePublishAttempt>>
    | Awaited<ReturnType<typeof createRednotePublishAttempt>>['attempt'];
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

const READY_X3_MAX_LATE_MS = 30 * 60 * 1_000;

async function createLinkedAttempt(
  snapshot: LocalPublishSnapshot,
  idempotencyKey: string,
  workspaceId: string,
  localJobId: string,
  readyX3Action?: 'schedule' | 'post_now',
) {
  const requestedAt = new Date().toISOString();
  const timingMode = readyX3Action ??
    (snapshot.publishAt ? 'schedule' as const : 'post_now' as const);
  const browserPayload = {
    sourcePostId: snapshot.notionPageId,
    title: snapshot.title,
    caption: snapshot.caption,
    tags: snapshot.tags,
    scheduledDate: snapshot.publishAt ?? null,
    targetPublishAt: timingMode === 'post_now'
      ? requestedAt
      : snapshot.publishAt ?? requestedAt,
    timingMode: timingMode === 'schedule' ? 'scheduled' as const : 'post_now' as const,
    visibility: 'public' as const,
    publishMode: snapshot.mediaType,
    mediaAssets: [{
      assetId: `${snapshot.mediaType}-${snapshot.mediaIndex}`,
      deliveryUrl: snapshot.mediaUrl,
      sha256: createHash('sha256').update(snapshot.mediaUrl).digest('hex'),
      mediaType: snapshot.mediaType,
      role: 'content' as const,
    }],
    ...(snapshot.mediaType === 'video' && snapshot.thumbnailUrl
      ? {
          coverAsset: {
            assetId: 'video-cover',
            deliveryUrl: snapshot.thumbnailUrl,
            sha256: createHash('sha256').update(snapshot.thumbnailUrl).digest('hex'),
            mediaType: 'image' as const,
            role: 'cover' as const,
          },
        }
      : {}),
  };
  const payload = {
    contractRevision: REDNOTE_PUBLISHING_CONTRACT_REVISION,
    sourceNotionPageId: snapshot.notionPageId,
    sourceLocalPublishJobId: localJobId,
    payloadRevision: snapshot.notionLastEditedTime,
    payloadDigest: '',
    requestedAt,
    executor: { type: 'worker' as const, kind: 'playwright' as const, id: 'local-publish-worker' },
    browserPayload,
  } as unknown as FrozenRednoteAttemptPayload;
  payload.payloadDigest = frozenPayloadDigest(payload);
  return createRednotePublishAttempt({
    workspaceId,
    idempotencyKey,
    payload,
    approve: Boolean(readyX3Action),
    readyX3: Boolean(readyX3Action),
  });
}

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
    /\b(?:bearer|cookie|set-cookie|password|secret)\b/i.test(message) ||
    /\bauthorization\s*[:=]/i.test(message) ||
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
  workspaceOrDependencies: string | QueueDependencies,
  suppliedDependencies?: QueueDependencies,
): Promise<QueueLocalPublishJobResult> {
  const workspaceId = typeof workspaceOrDependencies === 'string'
    ? workspaceOrDependencies
    : 'legacy-local-publish';
  const dependencies = typeof workspaceOrDependencies === 'string'
    ? suppliedDependencies ?? queueDependencies
    : workspaceOrDependencies;
  const input: QueueLocalPublishInput = parseQueueLocalPublishInput(rawInput);
  const existing = await dependencies.findByIdempotencyKey(idempotencyKey, workspaceId);
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
    if (typeof workspaceOrDependencies !== 'string') {
      return { job: jobSummary(existing), created: false };
    }
    let existingAttempt;
    try {
      existingAttempt = await getLinkedRednotePublishAttempt(workspaceId, existing.id);
    } catch (error) {
      if (
        !(error instanceof LocalPublishJobError) ||
        error.code !== 'ATTEMPT_NOT_FOUND'
      ) throw error;
      const storedReadyX3Consent = existing.snapshot.automationConsent === 'ready_x3';
      if (storedReadyX3Consent !== (input.consent === 'ready_x3')) {
        throw new LocalPublishJobError(
          'Idempotency-Key was already used with a different automation consent mode',
          'IDEMPOTENCY_CONFLICT',
          409,
        );
      }
      const repaired = await createLinkedAttempt(
        existing.snapshot,
        idempotencyKey,
        workspaceId,
        existing.id,
        storedReadyX3Consent
          ? input.mode === 'publish' ? 'post_now' : 'schedule'
          : undefined,
      );
      return {
        job: jobSummary(existing),
        attempt: repaired.attempt,
        created: false,
      };
    }
    const hasReadyX3Consent = Boolean(existingAttempt.readyX3Authorization);
    if (hasReadyX3Consent !== (input.consent === 'ready_x3')) {
      throw new LocalPublishJobError(
        'Idempotency-Key was already used with a different automation consent mode',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    if (
      hasReadyX3Consent &&
      (existingAttempt.readyX3Authorization as ReadyX3Authorization).action !==
        (input.mode === 'publish' ? 'post_now' : 'schedule')
    ) {
      throw new LocalPublishJobError(
        'Idempotency-Key was already used with a different Ready x3 action',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return {
      job: jobSummary(existing),
      attempt: existingAttempt,
      created: false,
    };
  }
  const post = await dependencies.getPost(input.notionPageId);
  const builtSnapshot = buildLocalPublishSnapshot(post, input);
  const snapshot: LocalPublishSnapshot = input.consent === 'ready_x3'
    ? { ...builtSnapshot, automationConsent: 'ready_x3' }
    : builtSnapshot;
  const readyX3Action = input.consent === 'ready_x3'
    ? input.mode === 'publish' ? 'post_now' as const : 'schedule' as const
    : undefined;
  if (input.consent === 'ready_x3' && !snapshot.publishAt) {
    throw new LocalPublishJobError('Ready x3 consent requires an exact scheduled publishAt', 'READY_X3_PUBLISH_TIME_REQUIRED', 422);
  }
  const readyX3PublishAt = snapshot.publishAt
    ? new Date(snapshot.publishAt).getTime()
    : Number.NaN;
  if (readyX3Action === 'schedule' && readyX3PublishAt <= Date.now()) {
    throw new LocalPublishJobError('Ready x3 scheduling requires a future publishAt', 'READY_X3_PUBLISH_TIME_REQUIRED', 422);
  }
  if (readyX3Action === 'post_now' && readyX3PublishAt < Date.now() - READY_X3_MAX_LATE_MS) {
    throw new LocalPublishJobError('Ready x3 Post now cannot use a publishAt more than 30 minutes late', 'READY_X3_PUBLISH_TIME_EXPIRED', 422);
  }
  if (readyX3Action && snapshot.mediaType === 'video' && !snapshot.thumbnailUrl) {
    throw new LocalPublishJobError('Ready x3 video requires a trusted cover image before staging', 'READY_X3_COVER_REQUIRED', 422);
  }
  const persist = async () => {
    if (input.consent === 'ready_x3') {
      await supersedeUnclaimedReadyX3Schedule(workspaceId, snapshot, readyX3Action!);
    }
    const result = await dependencies.insert(snapshot, idempotencyKey, workspaceId);
    if (typeof workspaceOrDependencies !== 'string') {
      return { job: jobSummary(result.job), created: result.created };
    }
    const attempt = await createLinkedAttempt(
      snapshot,
      idempotencyKey,
      workspaceId,
      result.job.id,
      readyX3Action,
    );
    return { job: jobSummary(result.job), attempt: attempt.attempt, created: result.created };
  };
  if (readyX3Action && typeof workspaceOrDependencies === 'string') {
    return withReadyX3SourceLock(workspaceId, snapshot.notionPageId, async () => {
      const raced = await dependencies.findByIdempotencyKey(idempotencyKey, workspaceId);
      if (raced) {
        return queueLocalPublishJob(
          rawInput,
          idempotencyKey,
          workspaceOrDependencies,
          suppliedDependencies,
        );
      }
      return persist();
    });
  }
  return persist();
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
  workspaceId = 'legacy-local-publish',
  claimToken?: string,
) {
  if (expectedJobId !== undefined) {
    validateExpectedVerificationJobId(lane, expectedJobId);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const job = await claimNextStoredLocalPublishJob(
      leaseSeconds(),
      lane,
      expectedJobId,
      workspaceId,
      claimToken,
    );
    if (!job && expectedJobId) {
      throw new LocalPublishJobError(
        'The expected verification job is not currently claimable',
        'EXPECTED_JOB_NOT_CLAIMABLE',
        409,
      );
    }
    if (job?.claimToken && job.claimExpiresAt && lane !== 'verification') {
      await bindLinkedAttemptClaim(workspaceId, job.id, job.claimToken, job.claimExpiresAt);
    }
    if (!job) return job;
    const linked = await getLinkedRednotePublishAttempt(workspaceId, job.id);
    const readyX3Authorization = readyX3AuthorizationFor(job, linked);
    if (readyX3Authorization) {
      const current = await assertReadyX3SourceCurrent(
        job,
        readyX3Authorization,
        workspaceId,
        linked.payload,
      );
      return { ...current, readyX3Authorization };
    }
    if (!job.batchAuthorization) return job;
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

function readyX3AuthorizationFor(job: (
  { snapshot: { publishAt?: string; mediaUrl: string; mediaType: 'image' | 'video'; platform: 'RedNote'; notionLastEditedTime: string } }
  | { publishAt?: string; mediaUrl: string; mediaType: 'image' | 'video'; platform: 'RedNote'; notionLastEditedTime: string; batchAuthorization?: { snapshotRevision: string } }
), attempt: Record<string, unknown>): ReadyX3Authorization | undefined {
  const authorization = attempt.readyX3Authorization as ReadyX3Authorization | undefined;
  if (!authorization) return undefined;
  const snapshot = 'snapshot' in job ? job.snapshot : job;
  const revision = snapshot.notionLastEditedTime;
  if (snapshot.platform !== 'RedNote' || !snapshot.publishAt ||
    authorization.packetRevision !== revision ||
    authorization.publishAt !== new Date(snapshot.publishAt).toISOString() ||
    authorization.media.identity !== rednoteMediaIdentity({ type: snapshot.mediaType, url: snapshot.mediaUrl }) ||
    authorization.lateFallback.maxLateMinutes !== 30) {
    throw new LocalPublishJobError('Ready x3 authorization does not match the frozen local snapshot', 'INVALID_READY_X3_AUTHORIZATION', 409);
  }
  return authorization;
}

type ReadyX3Claim = {
  id: string;
  claimToken: string;
  notionPageId: string;
  headline: string;
  title: string;
  caption: string;
  tags: string[];
  platform: 'RedNote';
  mediaType: 'image' | 'video';
  mediaIndex: number;
  mediaUrl: string;
  thumbnailUrl?: string;
  publishAt?: string;
  notionLastEditedTime: string;
};

const READY_X3_SOURCE_STALE_MESSAGE =
  'The Ready x3 source packet changed or is no longer eligible. Refresh and obtain new Ready x3 authorization.';

async function assertReadyX3SourceCurrent(
  job: ReadyX3Claim,
  authorization: ReadyX3Authorization,
  workspaceId: string,
  frozenBrowserPayload?: {
    title?: unknown;
    caption?: unknown;
    tags?: unknown;
  },
) {
  try {
    const post = await getReadyXhsPost(job.notionPageId);
    const eligible = buildBatchSnapshot(post);
    const hydratedJob: ReadyX3Claim = {
      ...job,
      headline: post.headline.trim(),
      title: typeof frozenBrowserPayload?.title === 'string'
        ? frozenBrowserPayload.title
        : job.title,
      caption: typeof frozenBrowserPayload?.caption === 'string'
        ? frozenBrowserPayload.caption
        : job.caption,
      tags: Array.isArray(frozenBrowserPayload?.tags)
        && frozenBrowserPayload.tags.every((tag): tag is string => typeof tag === 'string')
        ? frozenBrowserPayload.tags
        : job.tags,
    };
    const current = buildLocalPublishSnapshot(post, {
      notionPageId: job.notionPageId,
      lastEditedTime: job.notionLastEditedTime,
      confirmed: true,
      compatibilityTrialConfirmed: false,
      title: hydratedJob.title,
      caption: hydratedJob.caption,
      tags: hydratedJob.tags,
      media: { type: job.mediaType, index: job.mediaIndex },
      mode: 'schedule',
    });
    const publishAt = current.publishAt && new Date(current.publishAt).toISOString();
    if (
      eligible &&
      post.candidateKind === 'packet_ready' &&
      post.publishPacketReady &&
      post.automationBlockers.length === 0 &&
      post.status.trim().toLowerCase() === 'ready' &&
      current.platform === 'RedNote' &&
      current.notionLastEditedTime === job.notionLastEditedTime &&
      current.headline === hydratedJob.headline &&
      current.title === hydratedJob.title &&
      post.caption === hydratedJob.caption &&
      isDeepStrictEqual(post.tags, hydratedJob.tags) &&
      current.mediaType === job.mediaType &&
      current.mediaIndex === job.mediaIndex &&
      current.mediaUrl === job.mediaUrl &&
      current.thumbnailUrl === job.thumbnailUrl &&
      publishAt === job.publishAt &&
      authorization.packetRevision === job.notionLastEditedTime &&
      authorization.platform === 'RedNote' &&
      authorization.publishAt === job.publishAt &&
      authorization.media.url === job.mediaUrl &&
      authorization.media.type === job.mediaType &&
      authorization.media.identity === rednoteMediaIdentity({
        type: job.mediaType,
        url: job.mediaUrl,
      })
    ) return hydratedJob;
  } catch (error) {
    // An upstream outage must close the dispatch path but must not revoke consent.
    if (error instanceof NotionPostsError && (error as NotionPostsError).status >= 500) {
      throw error;
    }
    if (!(error instanceof NotionPostsError) && !(error instanceof LocalPublishJobError)) {
      throw error;
    }
  }

  await invalidateLinkedReadyX3Source(
    workspaceId,
    job.id,
    job.claimToken,
    READY_X3_SOURCE_STALE_MESSAGE,
  );
  throw new LocalPublishJobError(
    READY_X3_SOURCE_STALE_MESSAGE,
    'READY_X3_SOURCE_STALE',
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
    if (!(error instanceof NotionPostsError) || (error as NotionPostsError).status >= 500) throw error;
    return false;
  }
}

export async function authorizeLocalPublishJob(id: string, claimToken: string, workspaceId: string) {
  const job = await authorizeStoredLocalPublishJob(id, claimToken, workspaceId);
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
    const attempt = await getLinkedRednotePublishAttempt(workspaceId, job.id);
    const readyX3Authorization = readyX3AuthorizationFor(job, attempt);
    if (readyX3Authorization) {
      const current = await assertReadyX3SourceCurrent(
        job,
        readyX3Authorization,
        workspaceId,
        attempt.payload,
      );
      if (job.dispatchAuthorizedAt) {
        return { ...current, readyX3Authorization };
      }
      await consumeLinkedReadyX3DispatchAuthorization(workspaceId, job.id, job.claimToken);
    } else {
      if (job.dispatchAuthorizedAt) return job;
      await authorizeLinkedAttempt(workspaceId, job.id, job.claimToken);
    }
    const authorized = await consumeStoredDispatchAuthorization(job.id, job.claimToken, workspaceId);
    const authorizedAttempt = await getLinkedRednotePublishAttempt(workspaceId, job.id);
    const authorizedReadyX3Authorization = readyX3AuthorizationFor(authorized, authorizedAttempt);
    if (!authorizedReadyX3Authorization) return authorized;
    const current = await assertReadyX3SourceCurrent(
      authorized,
      authorizedReadyX3Authorization,
      workspaceId,
      authorizedAttempt.payload,
    );
    return { ...current, readyX3Authorization: authorizedReadyX3Authorization };
  }
  const attempt = await getLinkedRednotePublishAttempt(workspaceId, job.id);
  const readyX3Authorization = readyX3AuthorizationFor(job, attempt);
  if (!readyX3Authorization) return job;
  const current = await assertReadyX3SourceCurrent(
    job,
    readyX3Authorization,
    workspaceId,
    attempt.payload,
  );
  return { ...current, readyX3Authorization };
}

export async function heartbeatLocalPublishJob(id: string, claimToken: string, workspaceId: string) {
  const job = await heartbeatStoredLocalPublishJob(id, claimToken, workspaceId, leaseSeconds());
  if (job.claimExpiresAt) {
    await heartbeatLinkedAttempt(workspaceId, id, claimToken, job.claimExpiresAt);
  }
  return job;
}

export async function getLocalPublishJobSummaries(workspaceId: string) {
  return (await listLocalPublishJobs(workspaceId)).map(jobSummary);
}

export async function submitLocalPublishJobResult(
  id: string,
  claimToken: string,
  rawResult: unknown,
  workspaceOrDependencies: string | ResultDependencies,
  suppliedDependencies?: ResultDependencies,
) {
  const workspaceId = typeof workspaceOrDependencies === 'string'
    ? workspaceOrDependencies
    : 'legacy-local-publish';
  const dependencies = typeof workspaceOrDependencies === 'string'
    ? suppliedDependencies ?? resultDependencies
    : workspaceOrDependencies;
  const durableAttempt = typeof workspaceOrDependencies === 'string';
  const result = parseLocalPublishWorkerResult(rawResult);
  if (result.status === 'staged') {
    return jobSummary(await dependencies.stage(id, claimToken, workspaceId));
  }
  if (result.status === 'submitted' || result.status === 'scheduled') {
    const dispatched = await dependencies.recordDispatch(
      id,
      claimToken,
      result.status,
      result.noteId,
      result.shareUrl,
      verificationBackoffSeconds()[0],
      workspaceId,
    );
    return jobSummary(dispatched);
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
      workspaceId,
    ));
  }
  if (result.status === 'attested_verification_pending') {
    if (durableAttempt) await recordLinkedAttemptOutcome({
      workspaceId,
      localJobId: id,
      claimToken,
      outcome: 'accepted',
    });
    return jobSummary(await (
      dependencies.deferAttestedVerification ?? deferStoredOperatorAttestedVerification
    )(
      id,
      claimToken,
      result.code,
      result.message,
      verificationBackoffSeconds(),
      workspaceId,
    ));
  }
  if (result.status === 'failed') {
    if (durableAttempt) await recordLinkedAttemptOutcome({
      workspaceId,
      localJobId: id,
      claimToken,
      outcome: 'known_failed',
    });
    return jobSummary(await dependencies.fail(
      id,
      claimToken,
      result.code,
      result.message,
      workspaceId,
    ));
  }

  const publicationResult = result as Extract<
    LocalPublishWorkerResult,
    { status: 'submitted' | 'verified' }
  >;
  const receiptTime = new Date().toISOString();
  if (durableAttempt) await recordLinkedAttemptOutcome({
    workspaceId,
    localJobId: id,
    claimToken,
    outcome: 'accepted',
    receipt: {
      rednoteNoteId: publicationResult.noteId,
      rednoteUrl: publicationResult.shareUrl,
      platformPublishTime: receiptTime,
      provenance: { kind: 'verified_local_worker_result' },
    },
  });
  const prepared = await dependencies.prepareVerification(
    id,
    claimToken,
    publicationResult.noteId,
    publicationResult.shareUrl,
    workspaceId,
  );
  if (prepared.status === 'reconciled') return jobSummary(prepared);

  try {
    await dependencies.backfill(prepared.notionPageId, {
      status: 'success',
      noteId: publicationResult.noteId,
      shareUrl: publicationResult.shareUrl,
    }, prepared.verifiedAt);
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
    workspaceId,
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
