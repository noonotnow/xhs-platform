import { buildLocalPublishSnapshot, LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  fenceReadyX3SourceMutation,
} from '@/lib/rednote-publishing-attempt-store';
import {
  getXhsPostForManualHandling,
} from '@/lib/notion-posts';
import {
  getPendingReadyX3ScheduleEditOperation,
  getReadyX3ScheduleEditCandidate,
  getReadyX3ScheduleEditOperation,
  prepareReadyX3ScheduleEditOperation,
  readyX3PacketIdentity,
  reconcileReadyX3ScheduleEditOperation,
} from '@/lib/rednote-schedule-edit-store';
import type { ReadyX3ScheduleEditCandidate } from '@/lib/rednote-schedule-edit-store';
import type { ReadyXhsPost } from '@/types/ready-post';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

function exactTimestamp(value: string | null | undefined) {
  const match = value?.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/i,
  );
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fraction, , offsetSign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  if (
    month < 1 || month > 12
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) return null;
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(
    hour,
    minute,
    second,
    Number((fraction ?? '').padEnd(3, '0') || 0),
  );
  if (
    local.getUTCFullYear() !== year
    || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute
    || local.getUTCSeconds() !== second
  ) return null;
  const offset = (offsetHour * 60 + offsetMinute) * 60_000
    * (offsetSign === '-' ? -1 : 1);
  const timestamp = local.getTime() - offset;
  return Number.isFinite(timestamp) && Date.parse(value!) === timestamp
    ? timestamp
    : null;
}

function sameSchedule(left: string | null | undefined, right: string | null | undefined) {
  if (left == null || right == null) return left == null && right == null;
  const leftTime = exactTimestamp(left);
  const rightTime = exactTimestamp(right);
  return leftTime !== null && rightTime !== null && leftTime === rightTime;
}

async function readCanonicalSource(sourceNotionPageId: string) {
  try {
    return await getXhsPostForManualHandling(sourceNotionPageId);
  } catch {
    throw new LocalPublishJobError(
      'The canonical source is unavailable. The Ready x3 schedule-edit hold remains pending.',
      'SCHEDULE_EDIT_SOURCE_UNAVAILABLE',
      503,
    );
  }
}

function packetSnapshot(
  post: ReadyXhsPost,
  candidate: ReadyX3ScheduleEditCandidate,
): LocalPublishSnapshot | null {
  if (
    post.candidateKind !== 'packet_ready'
    || !post.publishPacketReady
    || post.automationBlockers.length > 0
    || post.status.trim().toLowerCase() !== 'ready'
    || post.headline.trim() !== candidate.snapshot.headline
    || post.caption !== candidate.snapshot.caption
    || JSON.stringify(post.tags) !== JSON.stringify(candidate.snapshot.tags)
  ) {
    return null;
  }
  try {
    const snapshot = buildLocalPublishSnapshot(post, {
      notionPageId: post.id,
      lastEditedTime: post.lastEditedTime,
      confirmed: true,
      compatibilityTrialConfirmed: false,
      title: candidate.snapshot.title,
      caption: candidate.snapshot.caption,
      tags: candidate.snapshot.tags,
      media: {
        type: candidate.snapshot.mediaType,
        index: candidate.snapshot.mediaIndex,
      },
      mode: 'schedule',
      consent: 'ready_x3',
    });
    const withExpectedAccount: LocalPublishSnapshot = {
      ...snapshot,
      expectedAccountId: candidate.snapshot.expectedAccountId,
    };
    if (
      withExpectedAccount.mediaType !== candidate.snapshot.mediaType
      || withExpectedAccount.mediaIndex !== candidate.snapshot.mediaIndex
      || withExpectedAccount.mediaUrl !== candidate.snapshot.mediaUrl
      || JSON.stringify(withExpectedAccount.media) !== JSON.stringify(candidate.snapshot.media)
      || withExpectedAccount.thumbnailUrl !== candidate.snapshot.thumbnailUrl
      || withExpectedAccount.expectedAccountId !== candidate.snapshot.expectedAccountId
    ) {
      return null;
    }
    return withExpectedAccount;
  } catch {
    return null;
  }
}

function scheduledDateAfter(value: unknown) {
  if (value === null) return { raw: null, instant: null };
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 200
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new LocalPublishJobError(
      'scheduledDateAfter must be null or an exact ISO timestamp with a timezone.',
      'VALIDATION_ERROR',
      400,
    );
  }
  const instant = exactTimestamp(value);
  if (instant === null) {
    throw new LocalPublishJobError(
      'scheduledDateAfter must be null or an exact ISO timestamp with a timezone.',
      'VALIDATION_ERROR',
      400,
    );
  }
  return { raw: value, instant: new Date(instant).toISOString() };
}

async function invalidateStaleReadyX3(
  workspaceId: string,
  sourceNotionPageId: string,
  sourceRevision: string,
) {
  const result = await fenceReadyX3SourceMutation(
    workspaceId,
    sourceNotionPageId,
    sourceRevision,
  );
  if (result.publicationMayHaveStarted) {
    throw new LocalPublishJobError(
      'A Ready x3 browser action may already have started; source mutation is blocked for reconciliation.',
      'READY_X3_PUBLICATION_MAY_HAVE_STARTED',
      409,
    );
  }
  return {
    state: 'consent_cleared' as const,
    sourceRevision,
    invalidatedAttemptIds: result.invalidatedAttemptIds,
    invalidatedJobIds: result.invalidatedJobIds,
    clearedScheduleEditOperationIds: result.clearedScheduleEditOperationIds,
  };
}

async function reconcilePendingOperation(input: {
  workspaceId: string;
  sourceNotionPageId: string;
  actorId: string;
  expectedSourceRevisionAfter?: string;
}) {
  const pending = await getPendingReadyX3ScheduleEditOperation(
    input.workspaceId,
    input.sourceNotionPageId,
  );
  if (!pending) return null;
  const candidate = await getReadyX3ScheduleEditCandidate(
    input.workspaceId,
    input.sourceNotionPageId,
    pending.id,
  );
  if (!candidate || candidate.attemptId !== pending.parentAttemptId) {
    throw new LocalPublishJobError(
      'The pending schedule edit lost its Ready x3 parent. Its dispatch hold remains in place.',
      'SCHEDULE_EDIT_PARENT_CHANGED',
      409,
    );
  }
  const post = await readCanonicalSource(input.sourceNotionPageId);
  const snapshot = packetSnapshot(post, candidate);
  const reconciled = await reconcileReadyX3ScheduleEditOperation({
    workspaceId: input.workspaceId,
    idempotencyKey: pending.idempotencyKey,
    observation: {
      sourceRevision: post.lastEditedTime,
      scheduledDate: post.scheduledDate,
      packetIdentity: snapshot ? readyX3PacketIdentity(snapshot) : null,
    },
    actorId: input.actorId,
    ...(input.expectedSourceRevisionAfter
      ? { expectedSourceRevisionAfter: input.expectedSourceRevisionAfter }
      : {}),
  });
  return reconciled;
}

export async function prepareReadyX3ScheduleEdit(input: {
  workspaceId: string;
  sourceNotionPageId: string;
  idempotencyKey: string;
  scheduledDateAfter: unknown;
  actorId: string;
}) {
  const after = scheduledDateAfter(input.scheduledDateAfter);
  const replay = await getReadyX3ScheduleEditOperation(
    input.workspaceId,
    input.idempotencyKey,
  );
  if (replay) {
    if (
      replay.sourceNotionPageId !== input.sourceNotionPageId
      || replay.scheduledDateAfter !== after.raw
    ) {
      throw new LocalPublishJobError(
        'Idempotency-Key was already used for a different Ready x3 schedule edit.',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return replay;
  }

  const pending = await reconcilePendingOperation({
    workspaceId: input.workspaceId,
    sourceNotionPageId: input.sourceNotionPageId,
    actorId: input.actorId,
  });
  if (pending?.state === 'prepared') {
    throw new LocalPublishJobError(
      'A previous source write is not yet observable. Its dispatch hold remains pending.',
      'SCHEDULE_EDIT_RECONCILIATION_REQUIRED',
      503,
    );
  }

  const candidate = await getReadyX3ScheduleEditCandidate(
    input.workspaceId,
    input.sourceNotionPageId,
  );
  if (!candidate) return { state: 'no_authorization' as const };
  const post = await readCanonicalSource(input.sourceNotionPageId);
  const beforeSnapshot = packetSnapshot(post, candidate);
  if (
    !beforeSnapshot
    || !sameSchedule(post.scheduledDate, candidate.snapshot.publishAt)
    || candidate.snapshot.notionLastEditedTime !== post.lastEditedTime
  ) {
    return invalidateStaleReadyX3(
      input.workspaceId,
      input.sourceNotionPageId,
      post.lastEditedTime,
    );
  }
  const beforeMillis = exactTimestamp(candidate.snapshot.publishAt);
  const afterMillis = after.instant ? Date.parse(after.instant) : null;
  const operationKind = beforeMillis !== null
    && beforeMillis > Date.now()
    && afterMillis !== null
    && afterMillis > Date.now()
    && afterMillis !== beforeMillis
    && candidate.lateFallbackPolicy.maxLateMinutes === 30
    ? 'retarget' as const
    : 'invalidate' as const;
  const operation = await prepareReadyX3ScheduleEditOperation({
    workspaceId: input.workspaceId,
    sourceNotionPageId: input.sourceNotionPageId,
    idempotencyKey: input.idempotencyKey,
    sourceRevisionBefore: post.lastEditedTime,
    publishAtBefore: candidate.snapshot.publishAt!,
    scheduledDateAfter: after.raw,
    publishAtAfter: after.instant,
    packetIdentity: candidate.packetIdentity,
    operationKind,
    actorId: input.actorId,
  });
  return operation;
}

export async function reconcileReadyX3ScheduleEdit(input: {
  workspaceId: string;
  sourceNotionPageId: string;
  idempotencyKey: string;
  actorId: string;
  expectedSourceRevisionAfter?: string;
}) {
  const operation = await getReadyX3ScheduleEditOperation(
    input.workspaceId,
    input.idempotencyKey,
  );
  if (!operation || operation.sourceNotionPageId !== input.sourceNotionPageId) {
    throw new LocalPublishJobError(
      'The Ready x3 schedule-edit operation was not found for this source.',
      'SCHEDULE_EDIT_NOT_FOUND',
      404,
    );
  }
  if (operation.state !== 'prepared') return operation;
  const reconciled = await reconcilePendingOperation({
    workspaceId: input.workspaceId,
    sourceNotionPageId: input.sourceNotionPageId,
    actorId: input.actorId,
    ...(input.expectedSourceRevisionAfter
      ? { expectedSourceRevisionAfter: input.expectedSourceRevisionAfter }
      : {}),
  });
  if (!reconciled || reconciled.id !== operation.id) {
    throw new LocalPublishJobError(
      'The Ready x3 schedule-edit operation is no longer pending.',
      'SCHEDULE_EDIT_NOT_FOUND',
      409,
    );
  }
  return reconciled;
}