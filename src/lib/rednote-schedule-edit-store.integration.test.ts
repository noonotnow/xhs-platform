import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let database: PGlite;

const mocks = vi.hoisted(() => ({
  getManualPost: vi.fn(),
}));

function queryResult(result: Awaited<ReturnType<PGlite['query']>>) {
  return {
    ...result,
    rowCount: result.affectedRows ?? result.rows.length,
  };
}

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: async () => ({
      query: async (statement: string, params?: unknown[]) => {
        if (statement.includes('pg_advisory_xact_lock')) {
          return { rows: [], rowCount: 0 };
        }
        return queryResult(await database.query(statement, params));
      },
      release: () => undefined,
    }),
    query: async (statement: string, params?: unknown[]) =>
      queryResult(await database.query(statement, params)),
  }),
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (query, part, index) => query + (index > 0 ? `$${index}` : '') + part,
      '',
    );
    return queryResult(await database.query(text, values));
  },
}));

vi.mock('@/lib/notion-posts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notion-posts')>()),
  getXhsPostForManualHandling: mocks.getManualPost,
}));

import { rednotePublishMedia } from '@/lib/rednote-publish-authorization';
import type { FrozenRednoteAttemptPayload } from '@/lib/rednote-publishing-contract-v1';
import {
  claimNextStoredLocalPublishJob,
} from '@/lib/local-publish-job-store';
import {
  claimRednotePublishAttempt,
  consumeLinkedReadyX3DispatchAuthorization,
  fenceReadyX3SourceMutation,
  frozenPayloadDigest,
  readRednotePublishingOperational,
} from '@/lib/rednote-publishing-attempt-store';
import {
  getPendingReadyX3ScheduleEditOperation,
  getReadyX3ScheduleEditCandidate,
  getReadyX3ScheduleEditOperation,
  prepareReadyX3ScheduleEditOperation,
  reconcileReadyX3ScheduleEditOperation,
  readyX3PacketIdentity,
} from '@/lib/rednote-schedule-edit-store';
import { reconcileReadyX3ScheduleEdit } from '@/lib/ready-x3-schedule-edits';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

const workspaceId = 'schedule-edit-integration';
const beforeRevision = '2026-08-05T12:00:00.000Z';
const beforeSchedule = '2099-08-05T15:00:00.000Z';
const afterSchedule = '2099-08-06T15:00:00.000Z';
const imageUrl = 'https://images.xhs.justlikekatie.com/ready-x3-schedule.png';

async function insertReadyX3Source(options: {
  scheduledAt?: string;
  sourceRevision?: string;
  notionPageId?: string;
} = {}) {
  const sourceWorkspaceId = `${workspaceId}-${randomUUID()}`;
  const notionPageId = options.notionPageId ?? randomUUID();
  const localJobId = randomUUID();
  const attemptId = randomUUID();
  const revision = options.sourceRevision ?? beforeRevision;
  const publishAt = options.scheduledAt ?? beforeSchedule;
  const snapshot: LocalPublishSnapshot = {
    notionPageId,
    headline: 'Canonical headline',
    title: 'Reviewed title',
    caption: 'Reviewed caption',
    tags: ['reviewed'],
    platform: 'RedNote',
    mediaType: 'image',
    mediaIndex: 0,
    mediaUrl: imageUrl,
    media: [rednotePublishMedia('image', imageUrl)],
    publishAt,
    notionLastEditedTime: revision,
    expectedAccountId: 'creator-account-1',
  };
  const requestedAt = new Date().toISOString();
  const payload: FrozenRednoteAttemptPayload = {
    contractRevision: 'rednote-publishing/v1' as const,
    sourceNotionPageId: notionPageId,
    sourceLocalPublishJobId: localJobId,
    payloadRevision: revision,
    payloadDigest: '',
    requestedAt,
    executor: {
      type: 'worker' as const,
      kind: 'playwright' as const,
      id: 'schedule-edit-test-worker',
    },
    browserPayload: {
      sourcePostId: notionPageId,
      expectedAccountId: 'creator-account-1',
      title: 'Reviewed title',
      caption: 'Reviewed caption',
      tags: ['reviewed'],
      scheduledDate: publishAt,
      targetPublishAt: publishAt,
      timingMode: 'scheduled' as const,
      visibility: 'public' as const,
      publishMode: 'image' as const,
      mediaAssets: [{
        assetId: 'image-0',
        deliveryUrl: imageUrl,
        sha256: createHash('sha256').update(imageUrl).digest('hex'),
        mediaType: 'image' as const,
        role: 'content' as const,
      }],
    },
  };
  payload.payloadDigest = frozenPayloadDigest(payload);
  await database.query(
    `INSERT INTO local_publish_jobs (
       id,notion_page_id,snapshot,idempotency_key,workspace_id
     ) VALUES ($1::uuid,$2,$3::jsonb,$4::uuid,$5)`,
    [localJobId, notionPageId, JSON.stringify(snapshot), randomUUID(), sourceWorkspaceId],
  );
  await database.query(
    `INSERT INTO rednote_publish_attempts (
       id,workspace_id,idempotency_key,contract_revision,
       source_notion_page_id,source_local_publish_job_id,
       frozen_payload,payload_digest,payload_revision,
       executor_type,executor_kind,executor_id,target_publish_at,
       requested_at,approved_at,active,authorization_kind,late_fallback_policy
     ) VALUES (
       $1::uuid,$2,$3::uuid,$4,$5,$6::uuid,$7::jsonb,$8,$9,
       'worker','playwright','schedule-edit-test-worker',$10,
       $11,CURRENT_TIMESTAMP,true,'ready_x3',$12::jsonb
     )`,
    [
      attemptId,
      sourceWorkspaceId,
      randomUUID(),
      payload.contractRevision,
      notionPageId,
      localJobId,
      JSON.stringify(payload),
      payload.payloadDigest,
      revision,
      publishAt,
      requestedAt,
      JSON.stringify({ action: 'post_now', maxLateMinutes: 30 }),
    ],
  );
  return {
    workspaceId: sourceWorkspaceId,
    notionPageId,
    localJobId,
    attemptId,
    snapshot,
    payload,
  };
}

async function prepare(source: Awaited<ReturnType<typeof insertReadyX3Source>>, after = afterSchedule) {
  const candidate = await getReadyX3ScheduleEditCandidate(source.workspaceId, source.notionPageId);
  if (!candidate) throw new Error('Expected a Ready x3 schedule candidate');
  const beforeMillis = Date.parse(source.snapshot.publishAt!);
  const afterMillis = Date.parse(after);
  const operation = await prepareReadyX3ScheduleEditOperation({
    workspaceId: source.workspaceId,
    sourceNotionPageId: source.notionPageId,
    idempotencyKey: `schedule-edit-${randomUUID()}`,
    sourceRevisionBefore: source.snapshot.notionLastEditedTime,
    publishAtBefore: source.snapshot.publishAt!,
    scheduledDateAfter: after,
    publishAtAfter: Number.isFinite(Date.parse(after)) ? new Date(after).toISOString() : null,
    packetIdentity: readyX3PacketIdentity(source.snapshot),
    operationKind: Number.isFinite(beforeMillis)
      && beforeMillis > Date.now()
      && Number.isFinite(afterMillis)
      && afterMillis > Date.now()
      && afterMillis !== beforeMillis
      ? 'retarget'
      : 'invalidate',
    actorId: 'integration-test',
  });
  return { operation, candidate };
}

describe('Ready x3 schedule-edit protocol against the canonical migration chain', () => {
  beforeAll(async () => {
    database = new PGlite();
    const files = (await readdir(path.join(process.cwd(), 'migrations')))
      .filter((file) => /^\d{3}_.*\.sql$/.test(file) && file !== '001_initial.sql')
      .sort((left, right) => left.localeCompare(right));
    for (const file of files) {
      await database.exec(
        await readFile(path.join(process.cwd(), 'migrations', file), 'utf8'),
      );
    }
  });

  afterAll(async () => {
    await database.close();
  });

  it('holds both claim lanes and the final consume point until source reconciliation', async () => {
    const source = await insertReadyX3Source();
    const { operation } = await prepare(source);
    expect(operation.state).toBe('prepared');
    expect(await getPendingReadyX3ScheduleEditOperation(source.workspaceId, source.notionPageId))
      .toMatchObject({ id: operation.id, state: 'prepared' });

    expect(await claimRednotePublishAttempt(source.workspaceId, 60)).toBeNull();
    expect(await claimNextStoredLocalPublishJob(
      60,
      'dispatch',
      undefined,
      source.workspaceId,
      randomUUID(),
    )).toBeNull();

    const claimToken = randomUUID();
    await database.query(
      `UPDATE local_publish_jobs
       SET status='staged',claim_token=$2::uuid,claim_attempts=1,
           claimed_at=CURRENT_TIMESTAMP,claim_expires_at=CURRENT_TIMESTAMP + INTERVAL '1 hour'
       WHERE id=$1::uuid`,
      [source.localJobId, claimToken],
    );
    await database.query(
      `UPDATE rednote_publish_attempts
       SET claim_token=$2::uuid,claim_expires_at=CURRENT_TIMESTAMP + INTERVAL '1 hour'
       WHERE id=$1::uuid`,
      [source.attemptId, claimToken],
    );
    await expect(consumeLinkedReadyX3DispatchAuthorization(
      source.workspaceId,
      source.localJobId,
      claimToken,
    )).rejects.toMatchObject({ code: 'DISPATCH_NOT_AUTHORIZED', status: 409 });
    const persisted = await database.query<{
      dispatch_authorized_at: Date | string | null;
    }>(
      'SELECT dispatch_authorized_at FROM rednote_publish_attempts WHERE id=$1::uuid',
      [source.attemptId],
    );
    expect(persisted.rows[0]?.dispatch_authorized_at).toBeNull();
  });

  it('creates an immutable child attempt only for an exact future-to-future packet move', async () => {
    const source = await insertReadyX3Source();
    const { operation, candidate } = await prepare(source);
    const committed = await reconcileReadyX3ScheduleEditOperation({
      workspaceId: source.workspaceId,
      idempotencyKey: operation.idempotencyKey,
      actorId: 'integration-test',
      observation: {
        sourceRevision: '2026-08-05T13:00:00.000Z',
        scheduledDate: afterSchedule,
        packetIdentity: candidate.packetIdentity,
      },
    });
    expect(committed).toMatchObject({
      state: 'committed',
      parentAttemptId: source.attemptId,
      scheduledDateAfter: afterSchedule,
    });
    expect(committed?.retargetedAttemptId).toBeTruthy();
    const children = await database.query<{
      id: string;
      active: boolean;
      supersedes_attempt_id: string | null;
      payload_revision: string;
      target_publish_at: Date | string;
      late_fallback_policy: { action: string; maxLateMinutes: number };
      frozen_payload: { browserPayload: { scheduledDate: string } };
    }>(
      `SELECT id,active,supersedes_attempt_id,payload_revision,
              target_publish_at,late_fallback_policy,frozen_payload
       FROM rednote_publish_attempts
       WHERE source_notion_page_id=$1 AND id<>$2::uuid`,
      [source.notionPageId, source.attemptId],
    );
    expect(children.rows).toHaveLength(1);
    expect(children.rows[0]).toMatchObject({
      id: committed?.retargetedAttemptId,
      active: true,
      supersedes_attempt_id: source.attemptId,
      payload_revision: '2026-08-05T13:00:00.000Z',
      late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
      frozen_payload: { browserPayload: { scheduledDate: afterSchedule } },
    });
    expect(new Date(children.rows[0]!.target_publish_at).toISOString()).toBe(afterSchedule);
    const pending = await getPendingReadyX3ScheduleEditOperation(source.workspaceId, source.notionPageId);
    expect(pending).toBeNull();
  });

  it('clears consent when content identity changes rather than inheriting the approval', async () => {
    const source = await insertReadyX3Source();
    const { operation, candidate } = await prepare(source);
    const result = await reconcileReadyX3ScheduleEditOperation({
      workspaceId: source.workspaceId,
      idempotencyKey: operation.idempotencyKey,
      actorId: 'integration-test',
      observation: {
        sourceRevision: '2026-08-05T14:00:00.000Z',
        scheduledDate: afterSchedule,
        packetIdentity: 'f'.repeat(64),
      },
    });
    expect(result?.state).toBe('consent_cleared');
    expect(candidate.packetIdentity).not.toBe('f'.repeat(64));
    const attempts = await database.query<{
      active: boolean;
      terminal_outcome: string | null;
    }>(
      'SELECT active,terminal_outcome FROM rednote_publish_attempts WHERE id=$1::uuid',
      [source.attemptId],
    );
    expect(attempts.rows[0]).toEqual({
      active: false,
      terminal_outcome: 'known_failed',
    });
    const jobs = await database.query<{ status: string }>(
      'SELECT status FROM local_publish_jobs WHERE id=$1::uuid',
      [source.localJobId],
    );
    expect(jobs.rows[0]?.status).toBe('failed');
  });

  it('does not inherit a missed slot when it is moved back into the future', async () => {
    const source = await insertReadyX3Source({ scheduledAt: '2000-01-01T12:00:00.000Z' });
    const { operation, candidate } = await prepare(source);
    const result = await reconcileReadyX3ScheduleEditOperation({
      workspaceId: source.workspaceId,
      idempotencyKey: operation.idempotencyKey,
      actorId: 'integration-test',
      observation: {
        sourceRevision: '2026-08-05T15:00:00.000Z',
        scheduledDate: afterSchedule,
        packetIdentity: candidate.packetIdentity,
      },
    });
    expect(result?.state).toBe('consent_cleared');
    expect(result?.retargetedAttemptId).toBeNull();
  });

  it('leaves a pending hold intact when the canonical source outcome is unknown', async () => {
    const source = await insertReadyX3Source();
    const { operation } = await prepare(source);
    mocks.getManualPost.mockRejectedValueOnce(new Error('Notion timeout'));
    await expect(reconcileReadyX3ScheduleEdit({
      workspaceId: source.workspaceId,
      sourceNotionPageId: source.notionPageId,
      idempotencyKey: operation.idempotencyKey,
      actorId: 'integration-test',
    })).rejects.toMatchObject({
      code: 'SCHEDULE_EDIT_SOURCE_UNAVAILABLE',
      status: 503,
    });
    expect(await getReadyX3ScheduleEditOperation(source.workspaceId, operation.idempotencyKey))
      .toMatchObject({ state: 'prepared', id: operation.id });
    const operational = await readRednotePublishingOperational(source.workspaceId);
    expect(operational.queue.find(
      (item) => item.workbenchPostId === source.notionPageId,
    )?.readyX3ScheduleEdit).toMatchObject({
      id: operation.id,
      state: 'prepared',
      holdsCleared: false,
      stateReason: null,
    });
    const held = await database.query<{
      job_hold: string | null;
      attempt_hold: string | null;
    }>(
      `SELECT job.ready_x3_schedule_edit_hold_id AS job_hold,
              attempt.ready_x3_schedule_edit_hold_id AS attempt_hold
       FROM local_publish_jobs job
       JOIN rednote_publish_attempts attempt
         ON attempt.source_local_publish_job_id=job.id
       WHERE job.id=$1::uuid`,
      [source.localJobId],
    );
    expect(held.rows[0]).toEqual({ job_hold: operation.id, attempt_hold: operation.id });
  });

  it('projects prepared and absent edits with workspace-scoped hold certainty', async () => {
    const source = await insertReadyX3Source();
    const { operation } = await prepare(source);

    const operational = await readRednotePublishingOperational(source.workspaceId);
    const prepared = operational.queue.find(
      (item) => item.workbenchPostId === source.notionPageId,
    );
    expect(prepared?.readyX3ScheduleEdit).toEqual({
      id: operation.id,
      state: 'prepared',
      operationKind: 'retarget',
      holdsCleared: false,
      stateReason: null,
      retargetedAttemptId: null,
      retargetedLocalPublishJobId: null,
    });

    await reconcileReadyX3ScheduleEditOperation({
      workspaceId: source.workspaceId,
      idempotencyKey: operation.idempotencyKey,
      actorId: 'integration-test',
      observation: {
        sourceRevision: source.snapshot.notionLastEditedTime,
        scheduledDate: source.snapshot.publishAt!,
        packetIdentity: readyX3PacketIdentity(source.snapshot),
      },
    });
    await database.query(
      `UPDATE local_publish_jobs SET status='failed',completed_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND id=$2::uuid`,
      [source.workspaceId, source.localJobId],
    );
    const otherWorkspace = await insertReadyX3Source({
      notionPageId: source.notionPageId,
    });
    const otherWorkspaceStatus = await readRednotePublishingOperational(
      otherWorkspace.workspaceId,
    );
    const noEdit = otherWorkspaceStatus.queue.find(
      (item) => item.workbenchPostId === source.notionPageId,
    );
    expect(noEdit?.readyX3ScheduleEdit).toBeNull();
    expect(noEdit?.readyX3ScheduleEdit).not.toEqual(prepared?.readyX3ScheduleEdit);
    expect(JSON.stringify(operational)).not.toContain('packetIdentity');
    expect(JSON.stringify(operational)).not.toContain('"evidence":');
  });

  it('projects committed, consent-cleared, and aborted history without inferring publication', async () => {
    const committedSource = await insertReadyX3Source();
    const { operation: committedOperation, candidate } = await prepare(committedSource);
    const committed = await reconcileReadyX3ScheduleEditOperation({
      workspaceId: committedSource.workspaceId,
      idempotencyKey: committedOperation.idempotencyKey,
      actorId: 'integration-test',
      observation: {
        sourceRevision: '2026-08-05T13:00:00.000Z',
        scheduledDate: afterSchedule,
        packetIdentity: candidate.packetIdentity,
      },
    });
    const committedStatus = await readRednotePublishingOperational(
      committedSource.workspaceId,
    );
    const committedChild = committedStatus.queue.find(
      (item) => item.id === committed?.retargetedLocalPublishJobId,
    );
    expect(committedChild).toMatchObject({
      state: 'queued',
      activeAttempt: true,
      receipt: { verifiedAt: null },
      readyX3ScheduleEdit: {
        id: committedOperation.id,
        state: 'committed',
        operationKind: 'retarget',
        holdsCleared: true,
        stateReason: 'The exact approved packet was preserved on an immutable child attempt.',
        retargetedAttemptId: committed?.retargetedAttemptId,
        retargetedLocalPublishJobId: committed?.retargetedLocalPublishJobId,
      },
    });
    const historicalParent = committedStatus.attempts.find(
      (item) => item.id === committedSource.attemptId,
    );
    expect(historicalParent).toMatchObject({
      activeAttempt: false,
      readyX3ScheduleEdit: {
        state: 'committed',
        retargetedAttemptId: committed?.retargetedAttemptId,
      },
    });
    await database.query(
      `UPDATE rednote_publish_attempts
       SET active=false,terminal_outcome='known_failed',terminal_at=CURRENT_TIMESTAMP,
           receipt_lookup_state='not_required',
           receipt_lookup_updated_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND id=$2::uuid`,
      [committedSource.workspaceId, committed?.retargetedAttemptId],
    );
    await database.query(
      `UPDATE local_publish_jobs SET status='failed',completed_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1 AND id=$2::uuid`,
      [committedSource.workspaceId, committed?.retargetedLocalPublishJobId],
    );
    const historicalChildStatus = await readRednotePublishingOperational(
      committedSource.workspaceId,
    );
    expect(historicalChildStatus.attempts.find(
      (item) => item.id === committed?.retargetedAttemptId,
    )).toMatchObject({
      state: 'failed',
      activeAttempt: false,
      receipt: { verifiedAt: null },
      readyX3ScheduleEdit: {
        state: 'committed',
        retargetedAttemptId: committed?.retargetedAttemptId,
        retargetedLocalPublishJobId: committed?.retargetedLocalPublishJobId,
      },
    });

    const clearedSource = await insertReadyX3Source();
    const { operation: clearedOperation, candidate: clearedCandidate } =
      await prepare(clearedSource);
    await reconcileReadyX3ScheduleEditOperation({
      workspaceId: clearedSource.workspaceId,
      idempotencyKey: clearedOperation.idempotencyKey,
      actorId: 'integration-test',
      observation: {
        sourceRevision: '2026-08-05T14:00:00.000Z',
        scheduledDate: afterSchedule,
        packetIdentity: 'f'.repeat(64),
      },
    });
    expect(clearedCandidate.packetIdentity).not.toBe('f'.repeat(64));
    const clearedStatus = await readRednotePublishingOperational(
      clearedSource.workspaceId,
    );
    const cleared = clearedStatus.attempts.find(
      (item) => item.id === clearedSource.attemptId,
    );
    expect(cleared?.readyX3ScheduleEdit).toMatchObject({
      id: clearedOperation.id,
      state: 'consent_cleared',
      holdsCleared: true,
      stateReason: 'The source edit was not an exact future-to-future move of the approved packet.',
      retargetedAttemptId: null,
      retargetedLocalPublishJobId: null,
    });

    const abortedSource = await insertReadyX3Source();
    const { operation: abortedOperation } = await prepare(abortedSource);
    await reconcileReadyX3ScheduleEditOperation({
      workspaceId: abortedSource.workspaceId,
      idempotencyKey: abortedOperation.idempotencyKey,
      actorId: 'integration-test',
      observation: {
        sourceRevision: abortedSource.snapshot.notionLastEditedTime,
        scheduledDate: abortedSource.snapshot.publishAt!,
        packetIdentity: readyX3PacketIdentity(abortedSource.snapshot),
      },
    });
    const abortedStatus = await readRednotePublishingOperational(
      abortedSource.workspaceId,
    );
    const aborted = abortedStatus.queue.find(
      (item) => item.workbenchPostId === abortedSource.notionPageId,
    );
    expect(aborted?.readyX3ScheduleEdit).toMatchObject({
      id: abortedOperation.id,
      state: 'aborted',
      holdsCleared: true,
      stateReason: 'The canonical source still has the original future schedule.',
      retargetedAttemptId: null,
      retargetedLocalPublishJobId: null,
    });
  });

  it('clears a pending operation before a separate fenced content mutation proceeds', async () => {
    const source = await insertReadyX3Source();
    const { operation } = await prepare(source);
    const fence = await fenceReadyX3SourceMutation(
      source.workspaceId,
      source.notionPageId,
      '2026-08-05T16:00:00.000Z',
    );
    expect(fence.publicationMayHaveStarted).toBe(false);
    if (!fence.publicationMayHaveStarted) {
      expect(fence.clearedScheduleEditOperationIds).toContain(operation.id);
    }
    expect(await getReadyX3ScheduleEditOperation(source.workspaceId, operation.idempotencyKey))
      .toMatchObject({ state: 'consent_cleared' });
  });

  it('refuses preparation if a worker job claim won before the schedule-edit lock', async () => {
    const source = await insertReadyX3Source();
    const claim = await claimNextStoredLocalPublishJob(
      60,
      'dispatch',
      undefined,
      source.workspaceId,
      randomUUID(),
    );
    expect(claim?.id).toBe(source.localJobId);
    await expect(getReadyX3ScheduleEditCandidate(source.workspaceId, source.notionPageId))
      .rejects.toMatchObject({ code: 'READY_X3_SCHEDULE_EDIT_NOT_ELIGIBLE', status: 409 });
  });
});