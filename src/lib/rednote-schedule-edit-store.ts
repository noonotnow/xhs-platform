import { createHash } from 'crypto';
import { inspectReadyX3SourceMutation } from '@/lib/ready-x3-source-mutation-safety';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '@/lib/db';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { snapshotPublishMedia } from '@/lib/rednote-publish-authorization';
import {
  REDNOTE_PUBLISHING_CONTRACT_REVISION,
  type FrozenRednoteAttemptPayload,
  type FrozenRednoteBrowserPayload,
} from '@/lib/rednote-publishing-contract-v1';
import { frozenPayloadDigest } from '@/lib/rednote-publishing-attempt-store';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

export type ReadyX3ScheduleEditState =
  | 'prepared'
  | 'committed'
  | 'consent_cleared'
  | 'aborted';

export interface ReadyX3ScheduleEditOperation {
  id: string;
  workspaceId: string;
  sourceNotionPageId: string;
  idempotencyKey: string;
  sourceRevisionBefore: string;
  sourceRevisionAfter: string | null;
  scheduledDateBefore: string;
  scheduledDateAfter: string | null;
  operationKind: 'retarget' | 'invalidate';
  state: ReadyX3ScheduleEditState;
  parentAttemptId: string;
  parentLocalPublishJobId: string;
  retargetedAttemptId: string | null;
  retargetedLocalPublishJobId: string | null;
  stateReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ReadyX3ScheduleEditCandidate {
  workspaceId: string;
  sourceNotionPageId: string;
  attemptId: string;
  localPublishJobId: string;
  snapshot: LocalPublishSnapshot;
  packetIdentity: string;
  frozenPayload: FrozenRednoteAttemptPayload;
  lateFallbackPolicy: { action: 'schedule' | 'post_now'; maxLateMinutes: 30 };
  approvedAt: string;
}

interface CandidateRow extends QueryResultRow {
  attempt_id: string;
  workspace_id: string;
  source_notion_page_id: string;
  source_local_publish_job_id: string;
  contract_revision: string;
  frozen_payload: FrozenRednoteAttemptPayload;
  payload_digest: string;
  payload_revision: string;
  target_publish_at: Date | string | null;
  approved_at: Date | string;
  requested_at: Date | string;
  authorization_kind: string;
  executor_type: string;
  executor_kind: string;
  executor_id: string;
  executor_worker_run_id: string | null;
  executor_playwright_run_id: string | null;
  late_fallback_policy: ReadyX3ScheduleEditCandidate['lateFallbackPolicy'] | null;
  attempt_active: boolean;
  attempt_terminal_outcome: string | null;
  attempt_superseded_by_attempt_id: string | null;
  attempt_claim_token: string | null;
  attempt_claim_expires_at: Date | string | null;
  attempt_dispatch_authorized_at: Date | string | null;
  attempt_ready_x3_schedule_edit_hold_id: string | null;
  local_publish_job_id: string;
  notion_page_id: string;
  job_snapshot: LocalPublishSnapshot;
  job_status: string;
  job_batch_item_id: string | null;
  job_claim_token: string | null;
  job_claim_expires_at: Date | string | null;
  job_dispatch_authorized_at: Date | string | null;
  job_external_disposition_request_id: string | null;
  job_ready_x3_schedule_edit_hold_id: string | null;
}

interface OperationRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  source_notion_page_id: string;
  idempotency_key: string;
  source_revision_before: string;
  source_revision_after: string | null;
  publish_at_before: Date | string;
  scheduled_date_after: string | null;
  operation_kind: 'retarget' | 'invalidate';
  state: ReadyX3ScheduleEditState;
  parent_attempt_id: string;
  parent_local_publish_job_id: string;
  retargeted_attempt_id: string | null;
  retargeted_local_publish_job_id: string | null;
  state_reason: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  packet_identity: string;
  publish_at_after: Date | string | null;
}

interface ReadyX3ScheduleEditObservation {
  sourceRevision: string;
  scheduledDate: string | null;
  packetIdentity: string | null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicUuid(seed: string) {
  const bytes = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  bytes[12] = '5';
  bytes[16] = ((Number.parseInt(bytes[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

function timestamp(value: string | null | undefined) {
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
  const millis = local.getTime() - offset;
  if (!Number.isFinite(millis) || Date.parse(value!) !== millis) return null;
  return millis;
}

function sameSchedule(left: string | null | undefined, right: string | null | undefined) {
  if (left == null || right == null) return left == null && right == null;
  const leftMillis = timestamp(left);
  const rightMillis = timestamp(right);
  return leftMillis !== null && rightMillis !== null && leftMillis === rightMillis;
}

function mapOperation(row: OperationRow): ReadyX3ScheduleEditOperation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceNotionPageId: row.source_notion_page_id,
    idempotencyKey: row.idempotency_key,
    sourceRevisionBefore: row.source_revision_before,
    sourceRevisionAfter: row.source_revision_after,
    scheduledDateBefore: iso(row.publish_at_before)!,
    scheduledDateAfter: row.scheduled_date_after,
    operationKind: row.operation_kind,
    state: row.state,
    parentAttemptId: row.parent_attempt_id,
    parentLocalPublishJobId: row.parent_local_publish_job_id,
    retargetedAttemptId: row.retargeted_attempt_id,
    retargetedLocalPublishJobId: row.retargeted_local_publish_job_id,
    stateReason: row.state_reason,
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at),
  };
}

function mediaDigestMatches(media: { deliveryUrl: string; sha256: string }) {
  return media.sha256 === sha256(media.deliveryUrl);
}

function frozenPayloadMatchesReadyX3Snapshot(
  payload: FrozenRednoteAttemptPayload,
  snapshot: LocalPublishSnapshot,
  localPublishJobId: string,
) {
  const browser = payload.browserPayload;
  const expectedMedia = snapshotPublishMedia(snapshot);
  const contentAssets = browser.mediaAssets;
  const mediaMatches = expectedMedia.length === contentAssets.length
    && expectedMedia.every((media, index) => {
      const asset = contentAssets[index];
      return Boolean(
        asset
          && asset.role === 'content'
          && asset.mediaType === media.type
          && asset.deliveryUrl === media.url
          && asset.assetId === `${media.type}-${index}`
          && mediaDigestMatches(asset),
      );
    });
  const coverMatches = snapshot.mediaType !== 'video'
    ? !browser.coverAsset && !browser.posterAsset
    : (
      browser.coverAsset?.deliveryUrl === snapshot.thumbnailUrl
      && (
        !browser.coverAsset
        || (
          browser.coverAsset.role === 'cover'
          && browser.coverAsset.mediaType === 'image'
          && browser.coverAsset.assetId === 'video-cover'
          && mediaDigestMatches(browser.coverAsset)
        )
      )
      && !browser.posterAsset
    );
  return payload.contractRevision === REDNOTE_PUBLISHING_CONTRACT_REVISION
    && payload.sourceNotionPageId === snapshot.notionPageId
    && payload.sourceLocalPublishJobId === localPublishJobId
    && payload.payloadRevision === snapshot.notionLastEditedTime
    && payload.payloadDigest === frozenPayloadDigest(payload)
    && browser.sourcePostId === snapshot.notionPageId
    && browser.expectedAccountId === snapshot.expectedAccountId
    && browser.title === snapshot.title
    && browser.caption === snapshot.caption
    && stable(browser.tags) === stable(snapshot.tags)
    && browser.publishMode === snapshot.mediaType
    && browser.timingMode === 'scheduled'
    && browser.scheduledDate === snapshot.publishAt
    && browser.targetPublishAt === snapshot.publishAt
    && browser.visibility === 'public'
    && mediaMatches
    && coverMatches;
}

export function readyX3PacketIdentity(snapshot: LocalPublishSnapshot) {
  return sha256(stable({
    notionPageId: snapshot.notionPageId,
    headline: snapshot.headline,
    title: snapshot.title,
    caption: snapshot.caption,
    tags: snapshot.tags,
    platform: snapshot.platform,
    mediaType: snapshot.mediaType,
    mediaIndex: snapshot.mediaIndex,
    media: snapshotPublishMedia(snapshot),
    thumbnailUrl: snapshot.thumbnailUrl ?? null,
    expectedAccountId: snapshot.expectedAccountId ?? null,
  }));
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const CANDIDATE_SELECT = `
  SELECT attempt.id AS attempt_id, attempt.workspace_id,
    attempt.source_notion_page_id, attempt.source_local_publish_job_id,
    attempt.contract_revision, attempt.frozen_payload,
    attempt.payload_digest, attempt.payload_revision,
    attempt.target_publish_at, attempt.approved_at, attempt.requested_at,
    attempt.executor_type, attempt.executor_kind, attempt.executor_id,
    attempt.worker_run_id AS executor_worker_run_id,
    attempt.playwright_run_id AS executor_playwright_run_id,
    attempt.authorization_kind, attempt.late_fallback_policy,
    attempt.active AS attempt_active, attempt.terminal_outcome AS attempt_terminal_outcome,
    attempt.superseded_by_attempt_id AS attempt_superseded_by_attempt_id,
    attempt.claim_token AS attempt_claim_token,
    attempt.claim_expires_at AS attempt_claim_expires_at,
    attempt.dispatch_authorized_at AS attempt_dispatch_authorized_at,
    attempt.ready_x3_schedule_edit_hold_id AS attempt_ready_x3_schedule_edit_hold_id,
    job.id AS local_publish_job_id, job.notion_page_id, job.snapshot AS job_snapshot,
    job.status AS job_status, job.batch_item_id AS job_batch_item_id,
    job.claim_token AS job_claim_token, job.claim_expires_at AS job_claim_expires_at,
    job.dispatch_authorized_at AS job_dispatch_authorized_at,
    job.external_disposition_request_id AS job_external_disposition_request_id,
    job.ready_x3_schedule_edit_hold_id AS job_ready_x3_schedule_edit_hold_id
  FROM rednote_publish_attempts attempt
  JOIN local_publish_jobs job
    ON job.id=attempt.source_local_publish_job_id
   AND job.workspace_id=attempt.workspace_id
   AND job.notion_page_id=attempt.source_notion_page_id
`;

function candidateFromRow(
  row: CandidateRow,
  expectedHoldId: string | null = null,
): ReadyX3ScheduleEditCandidate {
  const snapshot = row.job_snapshot;
  const payload = row.frozen_payload;
  const fallback = row.late_fallback_policy;
  if (row.job_batch_item_id) {
    throw new LocalPublishJobError(
      'Schedule edits cannot inherit a bounded batch authorization.',
      'READY_X3_SCHEDULE_BATCH_EDIT_UNSUPPORTED',
      409,
    );
  }
  if (
    row.authorization_kind !== 'ready_x3'
    || !row.attempt_active
    || row.attempt_terminal_outcome !== null
    || row.attempt_superseded_by_attempt_id !== null
    || row.attempt_dispatch_authorized_at !== null
    || row.job_dispatch_authorized_at !== null
    || row.job_external_disposition_request_id !== null
    || row.job_status !== 'queued'
    || row.job_claim_token !== null
    || row.attempt_claim_token !== null
    || row.job_ready_x3_schedule_edit_hold_id !== expectedHoldId
    || row.attempt_ready_x3_schedule_edit_hold_id !== expectedHoldId
    || !fallback
    || !snapshot.publishAt
    || row.payload_revision !== snapshot.notionLastEditedTime
    || row.payload_digest !== payload.payloadDigest
    || row.contract_revision !== payload.contractRevision
    || frozenPayloadDigest(payload) !== row.payload_digest
    || payload.executor.type !== row.executor_type
    || payload.executor.kind !== row.executor_kind
    || payload.executor.id !== row.executor_id
    || (payload.executor.workerRunId ?? null) !== row.executor_worker_run_id
    || (payload.executor.playwrightRunId ?? null) !== row.executor_playwright_run_id
    || !sameSchedule(payload.requestedAt, iso(row.requested_at))
    || !frozenPayloadMatchesReadyX3Snapshot(payload, snapshot, row.local_publish_job_id)
    || iso(row.target_publish_at) !== new Date(snapshot.publishAt).toISOString()
  ) {
    throw new LocalPublishJobError(
      'The Ready x3 attempt is not an unchanged, unclaimed scheduled packet.',
      'READY_X3_SCHEDULE_EDIT_NOT_ELIGIBLE',
      409,
    );
  }
  return {
    workspaceId: row.workspace_id,
    sourceNotionPageId: row.source_notion_page_id,
    attemptId: row.attempt_id,
    localPublishJobId: row.local_publish_job_id,
    snapshot,
    packetIdentity: readyX3PacketIdentity(snapshot),
    frozenPayload: payload,
    lateFallbackPolicy: fallback,
    approvedAt: iso(row.approved_at)!,
  };
}

export async function getReadyX3ScheduleEditCandidate(
  workspaceId: string,
  sourceNotionPageId: string,
  expectedHoldId: string | null = null,
) {
  const result = await getPool().query<CandidateRow>(
    `${CANDIDATE_SELECT}
     WHERE attempt.workspace_id=$1 AND attempt.source_notion_page_id=$2
       AND attempt.authorization_kind='ready_x3'
       AND attempt.active AND attempt.approved_at IS NOT NULL
       AND attempt.terminal_outcome IS NULL
       AND attempt.superseded_by_attempt_id IS NULL
     ORDER BY attempt.created_at DESC LIMIT 1`,
    [workspaceId, sourceNotionPageId],
  );
  if (result.rows[0]) return candidateFromRow(result.rows[0], expectedHoldId);
  const unsupported = await getPool().query(
    `SELECT attempt.id FROM rednote_publish_attempts attempt
     WHERE attempt.workspace_id=$1 AND attempt.source_notion_page_id=$2
       AND attempt.active AND attempt.approved_at IS NOT NULL
       AND attempt.terminal_outcome IS NULL
       AND attempt.superseded_by_attempt_id IS NULL
       AND attempt.authorization_kind IS DISTINCT FROM 'ready_x3'
     LIMIT 1`,
    [workspaceId, sourceNotionPageId],
  );
  if (unsupported.rows[0]) {
    throw new LocalPublishJobError(
      'This source has a non-Ready x3 authorization; use its matching reconciliation protocol.',
      'SCHEDULE_EDIT_UNSUPPORTED_AUTHORIZATION',
      409,
    );
  }
  return null;
}

export async function getPendingReadyX3ScheduleEditOperation(
  workspaceId: string,
  sourceNotionPageId: string,
) {
  const result = await getPool().query<OperationRow>(
    `SELECT * FROM ready_x3_schedule_edit_operations
     WHERE workspace_id=$1 AND source_notion_page_id=$2 AND state='prepared'
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, sourceNotionPageId],
  );
  return result.rows[0] ? mapOperation(result.rows[0]) : null;
}

export async function getReadyX3ScheduleEditOperation(
  workspaceId: string,
  idempotencyKey: string,
) {
  const result = await getPool().query<OperationRow>(
    `SELECT * FROM ready_x3_schedule_edit_operations
     WHERE workspace_id=$1 AND idempotency_key=$2 LIMIT 1`,
    [workspaceId, idempotencyKey],
  );
  return result.rows[0] ? mapOperation(result.rows[0]) : null;
}

function assertIdempotentReplay(
  existing: OperationRow,
  input: {
    sourceNotionPageId: string;
    sourceRevisionBefore: string;
    publishAtBefore: string;
    scheduledDateAfter: string | null;
    packetIdentity: string;
    operationKind: 'retarget' | 'invalidate';
  },
) {
  if (
    existing.source_notion_page_id !== input.sourceNotionPageId
    || existing.source_revision_before !== input.sourceRevisionBefore
    || !sameSchedule(iso(existing.publish_at_before), input.publishAtBefore)
    || existing.scheduled_date_after !== input.scheduledDateAfter
    || existing.packet_identity !== input.packetIdentity
    || existing.operation_kind !== input.operationKind
  ) {
    throw new LocalPublishJobError(
      'Idempotency-Key was already used for a different Ready x3 schedule edit.',
      'IDEMPOTENCY_CONFLICT',
      409,
    );
  }
}

export async function prepareReadyX3ScheduleEditOperation(input: {
  workspaceId: string;
  sourceNotionPageId: string;
  idempotencyKey: string;
  sourceRevisionBefore: string;
  publishAtBefore: string;
  scheduledDateAfter: string | null;
  publishAtAfter: string | null;
  packetIdentity: string;
  operationKind: 'retarget' | 'invalidate';
  actorId: string;
}) {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.workspaceId}:${input.sourceNotionPageId}`,
    ]);
    const mutationSafety = await inspectReadyX3SourceMutation(client, input.workspaceId, input.sourceNotionPageId);
    if (mutationSafety.applicable && !mutationSafety.safe) {
      throw new LocalPublishJobError(
        'Publication truth no longer proves this source safe to reschedule.',
        'READY_X3_PUBLICATION_MAY_HAVE_STARTED', 409,
      );
    }
    const replay = await client.query<OperationRow>(
      `SELECT * FROM ready_x3_schedule_edit_operations
       WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [input.workspaceId, input.idempotencyKey],
    );
    if (replay.rows[0]) {
      assertIdempotentReplay(replay.rows[0], input);
      return mapOperation(replay.rows[0]);
    }
    const pending = await client.query(
      `SELECT id FROM ready_x3_schedule_edit_operations
       WHERE workspace_id=$1 AND source_notion_page_id=$2 AND state='prepared'
       LIMIT 1`,
      [input.workspaceId, input.sourceNotionPageId],
    );
    if (pending.rows[0]) {
      throw new LocalPublishJobError(
        'A previous Ready x3 schedule edit must be reconciled first.',
        'SCHEDULE_EDIT_RECONCILIATION_REQUIRED',
        409,
      );
    }

    const currentAttempt = await client.query<{ id: string }>(
      `SELECT id FROM rednote_publish_attempts
       WHERE workspace_id=$1 AND source_notion_page_id=$2
         AND authorization_kind='ready_x3' AND active
         AND approved_at IS NOT NULL AND terminal_outcome IS NULL
         AND superseded_by_attempt_id IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [input.workspaceId, input.sourceNotionPageId],
    );
    if (!currentAttempt.rows[0]) {
      throw new LocalPublishJobError(
        'No unclaimed Ready x3 schedule authorization is available for this source.',
        'READY_X3_SCHEDULE_EDIT_NOT_ELIGIBLE',
        409,
      );
    }
    const locked = await client.query<CandidateRow>(
      `${CANDIDATE_SELECT}
       WHERE attempt.workspace_id=$1 AND attempt.id=$2::uuid
         AND attempt.source_notion_page_id=$3
         AND attempt.approved_at IS NOT NULL
         AND attempt.terminal_outcome IS NULL
         AND attempt.superseded_by_attempt_id IS NULL
         AND attempt.dispatch_authorized_at IS NULL
       FOR UPDATE OF job, attempt`,
      [input.workspaceId, currentAttempt.rows[0].id, input.sourceNotionPageId],
    );
    if (!locked.rows[0]) {
      throw new LocalPublishJobError(
        'No unclaimed Ready x3 schedule authorization is available for this source.',
        'READY_X3_SCHEDULE_EDIT_NOT_ELIGIBLE',
        409,
      );
    }
    const candidate = candidateFromRow(locked.rows[0]);
    if (
      candidate.packetIdentity !== input.packetIdentity
      || candidate.snapshot.notionLastEditedTime !== input.sourceRevisionBefore
      || !sameSchedule(candidate.snapshot.publishAt, input.publishAtBefore)
      || candidate.lateFallbackPolicy.maxLateMinutes !== 30
    ) {
      throw new LocalPublishJobError(
        'The stored frozen packet changed before schedule-edit preparation.',
        'READY_X3_SCHEDULE_EDIT_NOT_ELIGIBLE',
        409,
      );
    }
    const operationId = deterministicUuid(`${input.workspaceId}:${input.idempotencyKey}`);
    const inserted = await client.query<OperationRow>(
      `INSERT INTO ready_x3_schedule_edit_operations (
         id,workspace_id,source_notion_page_id,idempotency_key,
         source_revision_before,publish_at_before,scheduled_date_after,
         publish_at_after,packet_identity,operation_kind,parent_attempt_id,
         parent_local_publish_job_id
       ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,$12::uuid)
       RETURNING *`,
      [
        operationId,
        input.workspaceId,
        input.sourceNotionPageId,
        input.idempotencyKey,
        input.sourceRevisionBefore,
        candidate.snapshot.publishAt,
        input.scheduledDateAfter,
        input.publishAtAfter,
        input.packetIdentity,
        input.operationKind,
        candidate.attemptId,
        candidate.localPublishJobId,
      ],
    );
    await client.query(
      `UPDATE local_publish_jobs
       SET ready_x3_schedule_edit_hold_id=$1::uuid
       WHERE workspace_id=$2 AND id=$3::uuid AND status='queued'
         AND claim_token IS NULL AND dispatch_authorized_at IS NULL
         AND ready_x3_schedule_edit_hold_id IS NULL`,
      [operationId, input.workspaceId, candidate.localPublishJobId],
    );
    await client.query(
      `UPDATE rednote_publish_attempts
       SET ready_x3_schedule_edit_hold_id=$1::uuid
       WHERE workspace_id=$2 AND id=$3::uuid AND active
         AND dispatch_authorized_at IS NULL AND claim_token IS NULL
         AND ready_x3_schedule_edit_hold_id IS NULL`,
      [operationId, input.workspaceId, candidate.attemptId],
    );
    const held = await client.query(
      `SELECT job.id FROM local_publish_jobs job
       JOIN rednote_publish_attempts attempt
         ON attempt.source_local_publish_job_id=job.id
        AND attempt.workspace_id=job.workspace_id
       WHERE job.workspace_id=$1 AND job.id=$2::uuid
         AND job.ready_x3_schedule_edit_hold_id=$3::uuid
         AND attempt.ready_x3_schedule_edit_hold_id=$3::uuid`,
      [input.workspaceId, candidate.localPublishJobId, operationId],
    );
    if (!held.rows[0]) {
      throw new LocalPublishJobError(
        'The schedule-edit dispatch hold could not be established.',
        'SCHEDULE_EDIT_HOLD_FAILED',
        409,
      );
    }
    await client.query(
      `INSERT INTO ready_x3_schedule_edit_operation_events
         (operation_id,event_type,actor_type,actor_id,evidence)
       VALUES ($1::uuid,'prepared','operator',$2,
         jsonb_build_object('operationKind',$3::text,'sourceRevisionBefore',$4::text))`,
      [operationId, input.actorId, input.operationKind, input.sourceRevisionBefore],
    );
    return mapOperation(inserted.rows[0]!);
  });
}

async function recordOperationEvent(
  client: PoolClient,
  operationId: string,
  eventType: 'retargeted' | 'consent_cleared' | 'aborted',
  actorId: string,
  evidence: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO ready_x3_schedule_edit_operation_events
       (operation_id,event_type,actor_type,actor_id,evidence)
     VALUES ($1::uuid,$2,'operator',$3,$4::jsonb)`,
    [operationId, eventType, actorId, JSON.stringify(evidence)],
  );
}

async function readOperationInTransaction(
  client: PoolClient,
  workspaceId: string,
  idempotencyKey: string,
) {
  const result = await client.query<OperationRow>(
    `SELECT * FROM ready_x3_schedule_edit_operations
     WHERE workspace_id=$1 AND idempotency_key=$2`,
    [workspaceId, idempotencyKey],
  );
  if (!result.rows[0]) {
    throw new LocalPublishJobError(
      'The Ready x3 schedule-edit result could not be read.',
      'SCHEDULE_EDIT_RESULT_MISSING',
      500,
    );
  }
  return mapOperation(result.rows[0]);
}

async function releaseOperationHold(
  client: PoolClient,
  operation: OperationRow,
  candidate: ReadyX3ScheduleEditCandidate,
) {
  await client.query(
    `UPDATE rednote_publish_attempts
     SET ready_x3_schedule_edit_hold_id=NULL
     WHERE workspace_id=$1 AND id=$2::uuid
       AND ready_x3_schedule_edit_hold_id=$3::uuid`,
    [operation.workspace_id, candidate.attemptId, operation.id],
  );
  await client.query(
    `UPDATE local_publish_jobs
     SET ready_x3_schedule_edit_hold_id=NULL
     WHERE workspace_id=$1 AND id=$2::uuid
       AND ready_x3_schedule_edit_hold_id=$3::uuid`,
    [operation.workspace_id, candidate.localPublishJobId, operation.id],
  );
}

async function clearReadyX3Consent(
  client: PoolClient,
  operation: OperationRow,
  candidate: ReadyX3ScheduleEditCandidate,
  actorId: string,
  reason: string,
  sourceRevisionAfter: string | null,
  evidence: Record<string, unknown>,
) {
  const attempt = await client.query(
    `UPDATE rednote_publish_attempts
     SET active=false, terminal_outcome='known_failed',
         terminal_at=CURRENT_TIMESTAMP,
         receipt_lookup_state='not_required',
         receipt_lookup_updated_at=CURRENT_TIMESTAMP,
         claim_expires_at=COALESCE(claim_expires_at,CURRENT_TIMESTAMP),
         ready_x3_schedule_edit_hold_id=NULL
     WHERE workspace_id=$1 AND id=$2::uuid AND active
       AND dispatch_authorized_at IS NULL
       AND ready_x3_schedule_edit_hold_id=$3::uuid`,
    [operation.workspace_id, candidate.attemptId, operation.id],
  );
  if (attempt.rowCount !== 1) {
    throw new LocalPublishJobError(
      'The Ready x3 authorization changed while its source edit was being reconciled.',
      'SCHEDULE_EDIT_PARENT_CHANGED',
      409,
    );
  }
  const job = await client.query(
    `UPDATE local_publish_jobs
     SET status='failed', completed_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP,
         error_code='READY_X3_SCHEDULE_EDIT_CLEARED',
         error_message=$4,
         ready_x3_schedule_edit_hold_id=NULL
     WHERE workspace_id=$1 AND id=$2::uuid AND status='queued'
       AND claim_token IS NULL AND dispatch_authorized_at IS NULL
       AND ready_x3_schedule_edit_hold_id=$3::uuid`,
    [operation.workspace_id, candidate.localPublishJobId, operation.id, reason],
  );
  if (job.rowCount !== 1) {
    throw new LocalPublishJobError(
      'The local Ready x3 job changed while its source edit was being reconciled.',
      'SCHEDULE_EDIT_PARENT_CHANGED',
      409,
    );
  }
  await client.query(
    `INSERT INTO rednote_publish_attempt_events
       (attempt_id,event_type,occurred_at,actor_type,actor_id)
     VALUES ($1::uuid,'administrative_recovery',CURRENT_TIMESTAMP,'operator',$2)`,
    [candidate.attemptId, actorId],
  );
  await client.query(
    `UPDATE ready_x3_schedule_edit_operations
     SET state='consent_cleared', source_revision_after=$2,
         completed_at=CURRENT_TIMESTAMP, state_reason=$3
     WHERE id=$1::uuid AND state='prepared'`,
    [operation.id, sourceRevisionAfter, reason],
  );
  await recordOperationEvent(client, operation.id, 'consent_cleared', actorId, {
    ...evidence,
    reason,
    sourceRevisionAfter,
  });
  return readOperationInTransaction(client, operation.workspace_id, operation.idempotency_key);
}

async function abortReadyX3ScheduleEdit(
  client: PoolClient,
  operation: OperationRow,
  candidate: ReadyX3ScheduleEditCandidate,
  actorId: string,
  reason: string,
  evidence: Record<string, unknown>,
) {
  await releaseOperationHold(client, operation, candidate);
  await client.query(
    `UPDATE ready_x3_schedule_edit_operations
     SET state='aborted', completed_at=CURRENT_TIMESTAMP, state_reason=$2
     WHERE id=$1::uuid AND state='prepared'`,
    [operation.id, reason],
  );
  await recordOperationEvent(client, operation.id, 'aborted', actorId, {
    ...evidence,
    reason,
  });
  return readOperationInTransaction(client, operation.workspace_id, operation.idempotency_key);
}

async function commitReadyX3ScheduleEdit(
  client: PoolClient,
  operation: OperationRow,
  candidate: ReadyX3ScheduleEditCandidate,
  observation: ReadyX3ScheduleEditObservation,
  actorId: string,
  publishAtAfter: string,
) {
  const newJobId = deterministicUuid(`${operation.id}:retargeted-job`);
  const newAttemptId = deterministicUuid(`${operation.id}:retargeted-attempt`);
  const newJobIdempotencyKey = deterministicUuid(`${operation.id}:retargeted-job-idempotency`);
  const newAttemptIdempotencyKey = deterministicUuid(`${operation.id}:retargeted-attempt-idempotency`);
  const newSnapshot: LocalPublishSnapshot = {
    ...candidate.snapshot,
    notionLastEditedTime: observation.sourceRevision,
    publishAt: publishAtAfter,
  };
  const payload: FrozenRednoteAttemptPayload = JSON.parse(
    JSON.stringify(candidate.frozenPayload),
  ) as FrozenRednoteAttemptPayload;
  payload.sourceLocalPublishJobId = newJobId;
  payload.payloadRevision = observation.sourceRevision;
  payload.requestedAt = new Date().toISOString();
  const browserPayload: FrozenRednoteBrowserPayload = {
    ...payload.browserPayload,
    scheduledDate: publishAtAfter,
    targetPublishAt: publishAtAfter,
  };
  payload.browserPayload = browserPayload;
  payload.payloadDigest = frozenPayloadDigest(payload);

  const retiredAttempt = await client.query(
    `UPDATE rednote_publish_attempts
     SET active=false, receipt_lookup_state='not_required',
         receipt_lookup_updated_at=CURRENT_TIMESTAMP,
         ready_x3_schedule_edit_hold_id=NULL
     WHERE workspace_id=$1 AND id=$2::uuid AND active
       AND terminal_outcome IS NULL AND dispatch_authorized_at IS NULL
       AND claim_token IS NULL
       AND ready_x3_schedule_edit_hold_id=$3::uuid`,
    [operation.workspace_id, candidate.attemptId, operation.id],
  );
  if (retiredAttempt.rowCount !== 1) {
    throw new LocalPublishJobError(
      'The Ready x3 authorization changed before it could be retargeted.',
      'SCHEDULE_EDIT_PARENT_CHANGED',
      409,
    );
  }
  const retiredJob = await client.query(
    `UPDATE local_publish_jobs
     SET status='failed', completed_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP,
         error_code='READY_X3_SCHEDULE_SUPERSEDED',
         error_message='Superseded by a reconciled future schedule edit.',
         ready_x3_schedule_edit_hold_id=NULL
     WHERE workspace_id=$1 AND id=$2::uuid AND status='queued'
       AND claim_token IS NULL AND dispatch_authorized_at IS NULL
       AND ready_x3_schedule_edit_hold_id=$3::uuid`,
    [operation.workspace_id, candidate.localPublishJobId, operation.id],
  );
  if (retiredJob.rowCount !== 1) {
    throw new LocalPublishJobError(
      'The local Ready x3 job changed before it could be retargeted.',
      'SCHEDULE_EDIT_PARENT_CHANGED',
      409,
    );
  }
  await client.query(
    `INSERT INTO local_publish_jobs (
       id,notion_page_id,snapshot,idempotency_key,workspace_id
     ) VALUES ($1::uuid,$2,$3::jsonb,$4::uuid,$5)`,
    [
      newJobId,
      operation.source_notion_page_id,
      JSON.stringify(newSnapshot),
      newJobIdempotencyKey,
      operation.workspace_id,
    ],
  );
  await client.query(
    `INSERT INTO rednote_publish_attempts (
       id,workspace_id,idempotency_key,contract_revision,
       source_notion_page_id,source_local_publish_job_id,
       frozen_payload,payload_digest,payload_revision,
       executor_type,executor_kind,executor_id,worker_run_id,playwright_run_id,
       target_publish_at,requested_at,approved_at,active,supersedes_attempt_id,
       authorization_kind,late_fallback_policy
     ) VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6::uuid,$7::jsonb,$8,$9,
        'worker',$10,$11,$12,$13,$14,$15,$16,true,$17::uuid,'ready_x3',$18::jsonb)`,
    [
      newAttemptId,
      operation.workspace_id,
      newAttemptIdempotencyKey,
      payload.contractRevision,
      operation.source_notion_page_id,
      newJobId,
      JSON.stringify(payload),
      payload.payloadDigest,
      payload.payloadRevision,
      payload.executor.kind,
      payload.executor.id,
      payload.executor.workerRunId ?? null,
      payload.executor.playwrightRunId ?? null,
      publishAtAfter,
      payload.requestedAt,
      candidate.approvedAt,
      candidate.attemptId,
      JSON.stringify(candidate.lateFallbackPolicy),
    ],
  );
  const superseded = await client.query(
    `UPDATE rednote_publish_attempts
     SET superseded_by_attempt_id=$1::uuid
     WHERE workspace_id=$2 AND id=$3::uuid AND superseded_by_attempt_id IS NULL`,
    [newAttemptId, operation.workspace_id, candidate.attemptId],
  );
  if (superseded.rowCount !== 1) {
    throw new LocalPublishJobError(
      'The Ready x3 parent could not be linked to its retargeted child attempt.',
      'SCHEDULE_EDIT_PARENT_CHANGED',
      409,
    );
  }
  await client.query(
    `INSERT INTO rednote_publish_attempt_events
       (attempt_id,event_type,occurred_at,actor_type,actor_id)
     VALUES ($1::uuid,'superseded',CURRENT_TIMESTAMP,'operator',$2),
       ($3::uuid,'attempt_created',CURRENT_TIMESTAMP,'operator',$2)`,
    [candidate.attemptId, 'ready_x3_schedule_edit', newAttemptId],
  );
  await client.query(
    `UPDATE ready_x3_schedule_edit_operations
     SET state='committed', source_revision_after=$2,
         retargeted_attempt_id=$3::uuid,
         retargeted_local_publish_job_id=$4::uuid,
         completed_at=CURRENT_TIMESTAMP,
         state_reason='The exact approved packet was preserved on an immutable child attempt.'
     WHERE id=$1::uuid AND state='prepared'`,
    [operation.id, observation.sourceRevision, newAttemptId, newJobId],
  );
  await recordOperationEvent(client, operation.id, 'retargeted', actorId, {
    sourceRevisionBefore: operation.source_revision_before,
    sourceRevisionAfter: observation.sourceRevision,
    publishAtBefore: iso(operation.publish_at_before),
    publishAtAfter,
    parentAttemptId: candidate.attemptId,
    retargetedAttemptId: newAttemptId,
  });
  return readOperationInTransaction(client, operation.workspace_id, operation.idempotency_key);
}

/**
 * Commits only after a caller has freshly read the canonical Notion source.
 * Unreadable or unknown source state must not call this function; the prepared
 * row-local holds intentionally remain in place until a later reconciliation.
 */
export async function reconcileReadyX3ScheduleEditOperation(input: {
  workspaceId: string;
  idempotencyKey: string;
  observation: ReadyX3ScheduleEditObservation;
  actorId: string;
  expectedSourceRevisionAfter?: string;
}) {
  const initial = await getReadyX3ScheduleEditOperation(
    input.workspaceId,
    input.idempotencyKey,
  );
  if (!initial) {
    throw new LocalPublishJobError(
      'The Ready x3 schedule-edit operation was not found.',
      'SCHEDULE_EDIT_NOT_FOUND',
      404,
    );
  }
  if (initial.state !== 'prepared') return initial;
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.workspaceId}:${initial.sourceNotionPageId}`,
    ]);
    const lockedOperation = await client.query<OperationRow>(
      `SELECT * FROM ready_x3_schedule_edit_operations
       WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [input.workspaceId, input.idempotencyKey],
    );
    const operation = lockedOperation.rows[0];
    if (!operation) {
      throw new LocalPublishJobError(
        'The Ready x3 schedule-edit operation was not found.',
        'SCHEDULE_EDIT_NOT_FOUND',
        404,
      );
    }
    if (operation.state !== 'prepared') return mapOperation(operation);
    if (
      input.expectedSourceRevisionAfter
      && input.observation.sourceRevision === operation.source_revision_before
      && input.expectedSourceRevisionAfter !== operation.source_revision_before
    ) {
      throw new LocalPublishJobError(
        'The source write is not yet observable; the dispatch hold remains pending.',
        'SCHEDULE_EDIT_SOURCE_PENDING',
        503,
      );
    }
    const parentRows = await client.query<CandidateRow>(
      `${CANDIDATE_SELECT}
       WHERE attempt.workspace_id=$1 AND attempt.id=$2::uuid
         AND attempt.source_notion_page_id=$3
         AND attempt.approved_at IS NOT NULL
         AND attempt.terminal_outcome IS NULL
         AND attempt.superseded_by_attempt_id IS NULL
         AND attempt.dispatch_authorized_at IS NULL
       FOR UPDATE OF job, attempt`,
      [input.workspaceId, operation.parent_attempt_id, operation.source_notion_page_id],
    );
    if (!parentRows.rows[0]) {
      throw new LocalPublishJobError(
        'The pending schedule edit lost its immutable parent authorization.',
        'SCHEDULE_EDIT_PARENT_CHANGED',
        409,
      );
    }
    const candidate = candidateFromRow(parentRows.rows[0], operation.id);
    if (
      candidate.localPublishJobId !== operation.parent_local_publish_job_id
      || candidate.packetIdentity !== operation.packet_identity
      || !sameSchedule(candidate.snapshot.publishAt, iso(operation.publish_at_before))
    ) {
      throw new LocalPublishJobError(
        'The stored authorization no longer matches the prepared schedule edit.',
        'SCHEDULE_EDIT_PARENT_CHANGED',
        409,
      );
    }
    if (
      input.expectedSourceRevisionAfter
      && input.observation.sourceRevision !== operation.source_revision_before
      && input.observation.sourceRevision !== input.expectedSourceRevisionAfter
    ) {
      return clearReadyX3Consent(
        client,
        operation,
        candidate,
        input.actorId,
        'The observed source revision does not match the expected schedule-edit write.',
        input.observation.sourceRevision,
        {
          expectedSourceRevisionAfter: input.expectedSourceRevisionAfter,
          observedSourceRevision: input.observation.sourceRevision,
          scheduledDate: input.observation.scheduledDate,
        },
      );
    }
    const beforeMillis = timestamp(iso(operation.publish_at_before));
    const afterMillis = timestamp(input.observation.scheduledDate);
    const sourceUnchanged = input.observation.sourceRevision === operation.source_revision_before
      && sameSchedule(input.observation.scheduledDate, iso(operation.publish_at_before))
      && input.observation.packetIdentity === operation.packet_identity;
    if (sourceUnchanged) {
      if (beforeMillis !== null && beforeMillis > Date.now()) {
        return abortReadyX3ScheduleEdit(
          client,
          operation,
          candidate,
          input.actorId,
          'The canonical source still has the original future schedule.',
          {
            sourceRevision: input.observation.sourceRevision,
            scheduledDate: input.observation.scheduledDate,
          },
        );
      }
      return clearReadyX3Consent(
        client,
        operation,
        candidate,
        input.actorId,
        'The original scheduled slot passed before the source edit was observed.',
        input.observation.sourceRevision,
        {
          sourceRevision: input.observation.sourceRevision,
          scheduledDate: input.observation.scheduledDate,
        },
      );
    }
    const publishAtAfter = afterMillis === null
      ? null
      : new Date(afterMillis).toISOString();
    const canRetarget = operation.operation_kind === 'retarget'
      && beforeMillis !== null
      && beforeMillis > Date.now()
      && afterMillis !== null
      && afterMillis > Date.now()
      && afterMillis !== beforeMillis
      && input.observation.sourceRevision !== operation.source_revision_before
      && input.observation.packetIdentity === operation.packet_identity
      && sameSchedule(input.observation.scheduledDate, operation.scheduled_date_after);
    if (canRetarget && publishAtAfter) {
      return commitReadyX3ScheduleEdit(
        client,
        operation,
        candidate,
        input.observation,
        input.actorId,
        publishAtAfter,
      );
    }
    return clearReadyX3Consent(
      client,
      operation,
      candidate,
      input.actorId,
      'The source edit was not an exact future-to-future move of the approved packet.',
      input.observation.sourceRevision === operation.source_revision_before
        ? null
        : input.observation.sourceRevision,
      {
        sourceRevision: input.observation.sourceRevision,
        scheduledDate: input.observation.scheduledDate,
        packetIdentityMatches: input.observation.packetIdentity === operation.packet_identity,
      },
    );
  });
}