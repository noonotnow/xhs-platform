import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import {
  parseRednoteAttemptTransactionRequest,
  rednoteStableDigest,
} from '@/lib/rednote-publishing-input';
import {
  advanceStoredRednoteReceiptLookup,
  appendStoredRednoteAttemptEvent,
  captureStoredRednoteReceipt,
  completeRednotePostMutation,
  createStoredRednoteAttempt,
  finalizeRednoteWorkerClaim,
  prepareRednoteWorkerClaim,
  recordStoredRednoteTerminalOutcome,
  replayStoredRednoteReceipt,
  replayStoredRednoteWorkerClaim,
  supersedeStoredRednoteAttempt,
  transferStoredRednoteOperatorResolution,
  verifyRednotePostMutation,
  type RednoteDatabasePool,
} from '@/lib/rednote-publishing-store';

const migrationsDir = join(process.cwd(), 'migrations');
const REVISION = '2026-08-07T15:00:00.000Z';
const REQUESTED_AT = '2026-08-07T16:00:00.000Z';
const PAGE_ID = '11111111-1111-4111-8111-111111111111';

async function migratedPool() {
  const db = new PGlite();
  for (const filename of readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await db.exec(readFileSync(join(migrationsDir, filename), 'utf8'));
  }
  const pool: RednoteDatabasePool = {
    connect: async () => ({
      query: ((text: string, values?: unknown[]) =>
        db.query(text, values)) as never,
      release: () => undefined,
    }),
  };
  return { db, pool };
}

function rawRequest(input: {
  requester?: 'create' | 'plan' | 'admin';
  idempotencyKey: string;
  pageId?: string;
  executor?: 'worker' | 'operator';
  executorKind?: 'playwright' | 'microservice';
}) {
  const requester = input.requester ?? 'create';
  const executor = input.executor ?? 'worker';
  const pageId = input.pageId ?? PAGE_ID;
  const payload = {
    contractRevision: 'rednote-publishing/v1',
    sourceNotionPageId: pageId,
    payloadRevision: 'rednote-browser-payload/v1',
    sourcePostRevision: REVISION,
    requestedAt: REQUESTED_AT,
    executor: executor === 'worker'
      ? {
          type: 'worker',
          kind: input.executorKind ?? 'playwright',
          id: 'worker-1',
        }
      : { type: 'operator', kind: 'operator', id: 'operator@example.com' },
    browserPayload: {
      sourcePostId: pageId,
      title: 'Frozen title',
      caption: 'Frozen caption',
      tags: ['frozen'],
      scheduledDate: null,
      targetPublishAt: REQUESTED_AT,
      timingMode: 'post_now',
      visibility: 'public',
      publishMode: 'image',
      mediaAssets: [{
        assetId: 'uploads/post.png',
        deliveryUrl:
          'https://images.xhs.justlikekatie.com/uploads/post.png',
        sha256: 'a'.repeat(64),
        mimeType: 'image/png',
        mediaType: 'image',
        role: 'content',
      }],
    },
  };
  return {
    requestedBy: requester,
    idempotencyKey: input.idempotencyKey,
    payload: { ...payload, payloadDigest: rednoteStableDigest(payload) },
  };
}

function request(input: Parameters<typeof rawRequest>[0]) {
  const raw = rawRequest(input);
  return {
    raw,
    parsed: parseRednoteAttemptTransactionRequest(raw),
    rawRequestDigest: rednoteStableDigest(raw),
  };
}

const readyPost = {
  activeAttemptId: null,
  sourcePostRevision: REVISION,
  status: 'Ready' as const,
  nextAction: 'Ready for publication' as const,
  publishExecution: 'Not attempted' as const,
  packetAuthorized: true,
};

function claimContext(attemptId = 'attempt') {
  return {
    workerRunId: `worker-run-${attemptId}`,
    playwrightRunId: `playwright-run-${attemptId}`,
    occurredAt: '2026-08-07T16:05:00.000Z',
    actorId: 'worker-1',
  };
}

async function createWorker(
  pool: RednoteDatabasePool,
  idempotencyKey: string,
) {
  const input = request({ idempotencyKey });
  return createStoredRednoteAttempt({
    request: input.parsed,
    rawRequestDigest: input.rawRequestDigest,
    validateNew: async () => undefined,
    pool,
  });
}

async function claimWorker(
  _db: PGlite,
  pool: RednoteDatabasePool,
  attemptId: string,
) {
  const prepared = await prepareRednoteWorkerClaim({
    attemptId,
    expectedActiveAttemptId: null,
    observedPost: readyPost,
    ...claimContext(attemptId),
    pool,
  });
  await verifyRednotePostMutation({
    mutationId: prepared.mutation.id,
    verifiedAt: '2026-08-07T16:05:01.000Z',
    pool,
  });
  const completed = await completeRednotePostMutation({
    mutationId: prepared.mutation.id,
    appliedAt: '2026-08-07T16:05:01.000Z',
    pool,
  });
  return { attempt: completed.attempt, prepared };
}

describe('Rednote publishing store', () => {
  it('checks exact requester replay before external validation', async () => {
    const { db, pool } = await migratedPool();
    try {
      const input = request({
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      });
      const validateNew = vi.fn(async () => undefined);
      const created = await createStoredRednoteAttempt({
        request: input.parsed,
        rawRequestDigest: input.rawRequestDigest,
        validateNew,
        pool,
      });
      const replay = await createStoredRednoteAttempt({
        request: input.parsed,
        rawRequestDigest: input.rawRequestDigest,
        validateNew,
        pool,
      });
      expect(created.created).toBe(true);
      expect(replay).toMatchObject({
        created: false,
        attempt: { id: created.attempt.id },
      });
      expect(validateNew).toHaveBeenCalledTimes(1);
      await expect(createStoredRednoteAttempt({
        request: input.parsed,
        rawRequestDigest: 'f'.repeat(64),
        validateNew,
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_IDEMPOTENCY_CONFLICT' });
      expect(validateNew).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });

  it('activates only after an applied claim and freezes Ready authorization', async () => {
    const { db, pool } = await migratedPool();
    try {
      const created = await createWorker(
        pool,
        '33333333-3333-4333-8333-333333333333',
      );
      const prepared = await prepareRednoteWorkerClaim({
        attemptId: created.attempt.id,
        expectedActiveAttemptId: null,
        observedPost: readyPost,
        ...claimContext(created.attempt.id),
        pool,
      });
      await expect(finalizeRednoteWorkerClaim({
        mutationId: prepared.mutation.id,
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_CLAIM_NOT_VERIFIED' });
      await expect(completeRednotePostMutation({
        mutationId: prepared.mutation.id,
        appliedAt: '2026-08-07T16:05:01.000Z',
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_MUTATION_NOT_VERIFIED' });
      await verifyRednotePostMutation({
        mutationId: prepared.mutation.id,
        verifiedAt: '2026-08-07T16:05:01.000Z',
        pool,
      });
      const claimed = await finalizeRednoteWorkerClaim({
        mutationId: prepared.mutation.id,
        pool,
      });
      expect(claimed).toMatchObject({
        active: true,
        claimSourceStatus: 'Ready',
        claimSourcePostRevision: REVISION,
      });
      expect(claimed.claimPacketAuthorizedAt).toBeTruthy();
      await expect(replayStoredRednoteWorkerClaim({
        attemptId: claimed.id,
        expectedActiveAttemptId: null,
        ...claimContext(claimed.id),
        pool,
      })).resolves.toMatchObject({ id: claimed.id, active: true });
      await expect(replayStoredRednoteWorkerClaim({
        attemptId: claimed.id,
        expectedActiveAttemptId: null,
        ...claimContext(claimed.id),
        workerRunId: 'different-run',
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_CLAIM_REPLAY_CONFLICT' });
      await expect(prepareRednoteWorkerClaim({
        attemptId: claimed.id,
        expectedActiveAttemptId: null,
        observedPost: readyPost,
        ...claimContext(claimed.id),
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_CLAIM_INELIGIBLE' });
    } finally {
      await db.close();
    }
  });

  it('rejects claim attempts outside the canonical Ready tuple', async () => {
    const { db, pool } = await migratedPool();
    try {
      const created = await createWorker(
        pool,
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      );
      const microserviceInput = request({
        idempotencyKey: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        executorKind: 'microservice',
      });
      const microservice = await createStoredRednoteAttempt({
        request: microserviceInput.parsed,
        rawRequestDigest: microserviceInput.rawRequestDigest,
        validateNew: async () => undefined,
        pool,
      });
      await expect(prepareRednoteWorkerClaim({
        attemptId: created.attempt.id,
        expectedActiveAttemptId: null,
        observedPost: {
          ...readyPost,
          nextAction: 'Blocked',
        },
        ...claimContext(created.attempt.id),
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_CLAIM_CAS_CONFLICT' });
      await expect(prepareRednoteWorkerClaim({
        attemptId: created.attempt.id,
        expectedActiveAttemptId: null,
        observedPost: {
          ...readyPost,
          packetAuthorized: false,
        },
        ...claimContext(created.attempt.id),
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_CLAIM_CAS_CONFLICT' });
      await expect(prepareRednoteWorkerClaim({
        attemptId: microservice.attempt.id,
        expectedActiveAttemptId: null,
        observedPost: readyPost,
        workerRunId: 'worker-run-microservice',
        playwrightRunId: 'playwright-run-incompatible',
        occurredAt: '2026-08-07T16:05:00.000Z',
        actorId: 'worker-1',
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_RUN_IDENTITY_CONFLICT' });
    } finally {
      await db.close();
    }
  });

  it('keeps stale callbacks as evidence without setting terminal state', async () => {
    const { db, pool } = await migratedPool();
    try {
      const created = await createWorker(
        pool,
        '44444444-4444-4444-8444-444444444444',
      );
      const { attempt } = await claimWorker(db, pool, created.attempt.id);
      const result = await recordStoredRednoteTerminalOutcome({
        attemptId: attempt.id,
        outcome: 'accepted',
        occurredAt: '2026-08-07T16:10:00.000Z',
        actor: { type: 'worker', id: 'worker-1' },
        workerRunId: `worker-run-${attempt.id}`,
        playwrightRunId: `playwright-run-${attempt.id}`,
        observedPost: {
          ...readyPost,
          activeAttemptId: '55555555-5555-4555-8555-555555555555',
        },
        pool,
      });
      expect(result).toMatchObject({
        stale: true,
        attempt: { active: true },
      });
      expect(result.attempt).not.toHaveProperty('terminalOutcome');
      const events = await db.query<{ diagnostics: { staleResult?: boolean } }>(
        `SELECT diagnostics FROM rednote_publish_attempt_events
         WHERE attempt_id = $1 AND event_type = 'execution_evidence'`,
        [attempt.id],
      );
      expect(events.rows[0]?.diagnostics.staleResult).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('quarantines known failure instead of promoting divergent lifecycle state', async () => {
    const { db, pool } = await migratedPool();
    try {
      const created = await createWorker(
        pool,
        '66666666-6666-4666-8666-666666666666',
      );
      const { attempt } = await claimWorker(db, pool, created.attempt.id);
      const result = await recordStoredRednoteTerminalOutcome({
        attemptId: attempt.id,
        outcome: 'known_failed',
        occurredAt: '2026-08-07T16:10:00.000Z',
        actor: { type: 'worker', id: 'worker-1' },
        workerRunId: `worker-run-${attempt.id}`,
        playwrightRunId: `playwright-run-${attempt.id}`,
        observedPost: {
          activeAttemptId: attempt.id,
          sourcePostRevision: '2026-08-07T16:08:00.000Z',
          status: 'Draft',
          nextAction: 'Develop packet',
          publishExecution: 'Worker claimed',
        },
        pool,
      });
      expect(result).toMatchObject({
        stale: false,
        attempt: {
          terminalOutcome: 'known_failed',
          active: false,
          receiptLookupState: 'not_required',
        },
        mutation: {
          state: 'conflict',
          expected: { status: 'Ready' },
          desired: { status: 'Ready' },
        },
      });
      const mutation = await db.query<{
        state: string;
        diagnostics: { code: string };
      }>(
        `SELECT state, diagnostics FROM rednote_publish_post_mutations
         WHERE attempt_id = $1 AND mutation_kind = 'known_failed'`,
        [attempt.id],
      );
      expect(mutation.rows[0]).toMatchObject({
        state: 'conflict',
        diagnostics: {
          code: 'REDNOTE_KNOWN_FAILURE_LIFECYCLE_DIVERGED',
        },
      });

      await db.query(
        `UPDATE rednote_publish_post_mutations
         SET state = 'verified', conflict_at = NULL
         WHERE id = $1`,
        [result.mutation!.id],
      );
      await db.query(
        `UPDATE rednote_publish_post_mutations
         SET state = 'applied', applied_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [result.mutation!.id],
      );
      const editedPacket = await createWorker(
        pool,
        '67676767-6767-4767-8767-676767676767',
      );
      const editedClaim = await claimWorker(db, pool, editedPacket.attempt.id);
      const settled = await recordStoredRednoteTerminalOutcome({
        attemptId: editedClaim.attempt.id,
        outcome: 'known_failed',
        occurredAt: '2026-08-07T16:15:00.000Z',
        actor: { type: 'worker', id: 'worker-1' },
        workerRunId: `worker-run-${editedClaim.attempt.id}`,
        playwrightRunId: `playwright-run-${editedClaim.attempt.id}`,
        observedPost: {
          activeAttemptId: editedClaim.attempt.id,
          sourcePostRevision: '2026-08-07T16:14:00.000Z',
          status: 'Ready',
          nextAction: 'Resolve attempt',
          publishExecution: 'Worker claimed',
        },
        pool,
      });
      expect(settled.mutation).toMatchObject({
        state: 'pending',
        expected: {
          sourcePostRevision: '2026-08-07T16:14:00.000Z',
          status: 'Ready',
        },
        desired: { status: 'Ready' },
      });
    } finally {
      await db.close();
    }
  });

  it('makes execution_started replay exact and run IDs null-to-non-null once', async () => {
    const { db, pool } = await migratedPool();
    try {
      const created = await createWorker(
        pool,
        '77777777-7777-4777-8777-777777777777',
      );
      await claimWorker(db, pool, created.attempt.id);
      const workerRunId = `worker-run-${created.attempt.id}`;
      const playwrightRunId = `playwright-run-${created.attempt.id}`;
      const event = {
        type: 'execution_started' as const,
        occurredAt: '2026-08-07T16:06:00.000Z',
        actor: { type: 'worker' as const, id: 'worker-1' },
        evidence: [],
        diagnostics: { run: 'one' },
      };
      const first = await appendStoredRednoteAttemptEvent({
        attemptId: created.attempt.id,
        event,
        workerRunId,
        playwrightRunId,
        pool,
      });
      const replay = await appendStoredRednoteAttemptEvent({
        attemptId: created.attempt.id,
        event,
        workerRunId,
        playwrightRunId,
        pool,
      });
      expect(replay.created).toBe(false);
      expect(replay.event.id).toBe(first.event.id);
      await expect(appendStoredRednoteAttemptEvent({
        attemptId: created.attempt.id,
        event: { ...event, occurredAt: '2026-08-07T16:07:00.000Z' },
        workerRunId,
        playwrightRunId,
        pool,
      })).rejects.toMatchObject({
        code: 'REDNOTE_EXECUTION_STARTED_CONFLICT',
      });
      await expect(appendStoredRednoteAttemptEvent({
        attemptId: created.attempt.id,
        event: { ...event, type: 'execution_evidence' },
        workerRunId: 'worker-run-2',
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_RUN_IDENTITY_CONFLICT' });

      const unclaimed = await createWorker(
        pool,
        '78787878-7878-4878-8878-787878787878',
      );
      const stale = await appendStoredRednoteAttemptEvent({
        attemptId: unclaimed.attempt.id,
        event: {
          ...event,
          type: 'execution_evidence',
          occurredAt: '2026-08-07T16:08:00.000Z',
        },
        workerRunId: 'stale-worker-run',
        playwrightRunId: 'stale-playwright-run',
        pool,
      });
      expect(stale.event).toMatchObject({
        event_type: 'execution_evidence',
        diagnostics: {
          staleCallback: true,
          requestedEventType: 'execution_evidence',
        },
      });
      const unbound = await db.query<{
        worker_run_id: string | null;
        playwright_run_id: string | null;
      }>(
        `SELECT worker_run_id, playwright_run_id
         FROM rednote_publish_attempts WHERE id = $1`,
        [unclaimed.attempt.id],
      );
      expect(unbound.rows[0]).toEqual({
        worker_run_id: null,
        playwright_run_id: null,
      });
      await expect(appendStoredRednoteAttemptEvent({
        attemptId: created.attempt.id,
        event: { ...event, type: 'execution_evidence' },
        workerRunId,
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_RUN_IDENTITY_CONFLICT' });
    } finally {
      await db.close();
    }
  });

  it('retains operator ownership through found evidence and receipt insertion', async () => {
    const { db, pool } = await migratedPool();
    try {
      const created = await createWorker(
        pool,
        '88888888-8888-4888-8888-888888888888',
      );
      const { attempt } = await claimWorker(db, pool, created.attempt.id);
      const operatorInput = request({
        requester: 'admin',
        idempotencyKey: '99999999-9999-4999-8999-999999999999',
        executor: 'operator',
      });
      const superseded = await supersedeStoredRednoteAttempt({
        priorAttemptId: attempt.id,
        request: operatorInput.parsed,
        rawRequestDigest: operatorInput.rawRequestDigest,
        expectedActiveAttemptId: attempt.id,
        validateNew: async () => ({
          ...readyPost,
          activeAttemptId: attempt.id,
          nextAction: 'Resolve attempt',
          publishExecution: 'Worker claimed',
        }),
        occurredAt: '2026-08-07T16:20:00.000Z',
        actorId: 'operator@example.com',
        pool,
      });
      expect(superseded).toMatchObject({
        created: true,
        priorAttempt: {
          active: false,
          supersededByAttemptId: superseded.operatorAttempt.id,
        },
        operatorAttempt: {
          active: false,
          terminalOutcome: 'accepted',
          supersedesAttemptId: attempt.id,
        },
        mutation: {
          desired: {
            activeAttemptId: null,
            nextAction: 'Backfill receipt',
            publishExecution: 'Operator scheduled',
          },
        },
      });
      expect(superseded.mutation).toBeDefined();
      await expect(supersedeStoredRednoteAttempt({
        priorAttemptId: attempt.id,
        request: operatorInput.parsed,
        rawRequestDigest: operatorInput.rawRequestDigest,
        expectedActiveAttemptId: attempt.id,
        occurredAt: '2026-08-07T16:20:00.000Z',
        actorId: 'operator@example.com',
        validateNew: async () => {
          throw new Error('replay must not re-read Posts');
        },
        pool,
      })).resolves.toMatchObject({
        created: false,
        operatorAttempt: { id: superseded.operatorAttempt.id },
      });
      const conflictingValidation = vi.fn();
      await expect(supersedeStoredRednoteAttempt({
        priorAttemptId: attempt.id,
        request: operatorInput.parsed,
        rawRequestDigest: '0'.repeat(64),
        expectedActiveAttemptId: attempt.id,
        occurredAt: '2026-08-07T16:20:00.000Z',
        actorId: 'operator@example.com',
        validateNew: conflictingValidation,
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_IDEMPOTENCY_CONFLICT' });
      expect(conflictingValidation).not.toHaveBeenCalled();

      const invalidOperatorInput = request({
        requester: 'admin',
        idempotencyKey: '98989898-9898-4898-8898-989898989898',
        executor: 'operator',
      });
      await expect(supersedeStoredRednoteAttempt({
        priorAttemptId: attempt.id,
        request: invalidOperatorInput.parsed,
        rawRequestDigest: invalidOperatorInput.rawRequestDigest,
        expectedActiveAttemptId: attempt.id,
        occurredAt: '2026-08-07T16:21:00.000Z',
        actorId: 'operator@example.com',
        validateNew: async () => {
          throw new Error('authoritative packet validation failed');
        },
        pool,
      })).rejects.toThrow(/authoritative packet validation failed/);
      const attemptCount = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM rednote_publish_attempts
         WHERE source_notion_page_id = $1`,
        [PAGE_ID],
      );
      expect(attemptCount.rows[0]?.count).toBe(2);
      await verifyRednotePostMutation({
        mutationId: superseded.mutation!.id,
        verifiedAt: '2026-08-07T16:20:01.000Z',
        pool,
      });
      await completeRednotePostMutation({
        mutationId: superseded.mutation!.id,
        appliedAt: '2026-08-07T16:20:01.000Z',
        pool,
      });
      await expect(advanceStoredRednoteReceiptLookup({
        attemptId: superseded.operatorAttempt.id,
        state: 'found',
        occurredAt: '2026-08-07T16:24:00.000Z',
        actor: { type: 'admin', id: 'other@example.com' },
        pool,
      })).rejects.toMatchObject({
        code: 'REDNOTE_OPERATOR_OWNERSHIP_CONFLICT',
        status: 403,
      });
      await expect(advanceStoredRednoteReceiptLookup({
        attemptId: superseded.operatorAttempt.id,
        state: 'not_required',
        occurredAt: '2026-08-07T16:24:00.000Z',
        actor: { type: 'admin', id: 'operator@example.com' },
        pool,
      })).rejects.toMatchObject({
        code: 'REDNOTE_RECEIPT_LOOKUP_CONFLICT',
      });
      const found = await advanceStoredRednoteReceiptLookup({
        attemptId: superseded.operatorAttempt.id,
        state: 'found',
        occurredAt: '2026-08-07T16:25:00.000Z',
        actor: { type: 'admin', id: 'operator@example.com' },
        pool,
      });
      expect(found.attempt).toMatchObject({
        receiptLookupState: 'found',
        active: false,
      });
      expect(found.attempt).not.toHaveProperty('operatorResolutionCompletedAt');
      const beforeCapture = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM rednote_publish_post_mutations
         WHERE attempt_id = $1 AND mutation_kind = 'receipt_capture'`,
        [superseded.operatorAttempt.id],
      );
      expect(beforeCapture.rows[0]?.count).toBe(0);
      await expect(captureStoredRednoteReceipt({
        receipt: {
          attemptId: superseded.operatorAttempt.id,
          rednoteUrl: 'https://www.xiaohongshu.com/explore/note-1',
          rednoteNoteId: 'note-1',
          platformPublishTime: '2026-08-07T16:18:00.000Z',
          capturedAt: '2026-08-07T16:26:00.000Z',
          provenance: { source: 'operator_lookup' },
        },
        actor: { type: 'admin', id: 'other@example.com' },
        observedPost: {
          activeAttemptId: null,
          sourcePostRevision: '2026-08-07T16:20:01.000Z',
          status: 'Ready',
          nextAction: 'Backfill receipt',
          publishExecution: 'Operator scheduled',
        },
        pool,
      })).rejects.toMatchObject({
        code: 'REDNOTE_OPERATOR_OWNERSHIP_CONFLICT',
        status: 403,
      });
      const captured = await captureStoredRednoteReceipt({
        receipt: {
          attemptId: superseded.operatorAttempt.id,
          rednoteUrl: 'https://www.xiaohongshu.com/explore/note-1',
          rednoteNoteId: 'note-1',
          platformPublishTime: '2026-08-07T16:18:00.000Z',
          capturedAt: '2026-08-07T16:26:00.000Z',
          provenance: { source: 'operator_lookup' },
        },
        actor: { type: 'admin', id: 'operator@example.com' },
        observedPost: {
          activeAttemptId: null,
          sourcePostRevision: '2026-08-07T16:20:01.000Z',
          status: 'Ready',
          nextAction: 'Backfill receipt',
          publishExecution: 'Operator scheduled',
        },
        pool,
      });
      expect(captured).toMatchObject({
        created: true,
        stale: false,
        mutation: {
          state: 'pending',
          desired: {
            activeAttemptId: null,
            status: 'Published',
            nextAction: 'Backfill metrics',
          },
        },
      });
      await expect(replayStoredRednoteReceipt({
        receipt: {
          attemptId: superseded.operatorAttempt.id,
          rednoteUrl: 'https://www.xiaohongshu.com/explore/note-1',
          rednoteNoteId: 'note-1',
          platformPublishTime: '2026-08-07T16:18:00.000Z',
          capturedAt: '2026-08-07T16:26:00.000Z',
          provenance: { source: 'operator_lookup' },
        },
        actor: { type: 'admin', id: 'operator@example.com' },
        pool,
      })).resolves.toMatchObject({
        created: false,
        receipt: { rednoteNoteId: 'note-1' },
      });
      const owner = await db.query<{
        operator_resolution_started_at: string;
        operator_resolution_completed_at: string | null;
      }>(
        `SELECT operator_resolution_started_at,
                operator_resolution_completed_at
         FROM rednote_publish_attempts WHERE id = $1`,
        [superseded.operatorAttempt.id],
      );
      expect(owner.rows[0]?.operator_resolution_started_at).toBeTruthy();
      expect(owner.rows[0]?.operator_resolution_completed_at).toBeNull();
      await expect(completeRednotePostMutation({
        mutationId: captured.mutation!.id,
        appliedAt: '2026-08-07T16:27:00.000Z',
        pool,
      })).rejects.toMatchObject({ code: 'REDNOTE_MUTATION_NOT_VERIFIED' });
      await verifyRednotePostMutation({
        mutationId: captured.mutation!.id,
        verifiedAt: '2026-08-07T16:27:00.000Z',
        pool,
      });
      const finalized = await completeRednotePostMutation({
        mutationId: captured.mutation!.id,
        appliedAt: '2026-08-07T16:27:00.000Z',
        pool,
      });
      expect(finalized).toMatchObject({
        mutation: { state: 'applied' },
        attempt: {
          operatorResolutionCompletedAt: '2026-08-07T16:27:00.000Z',
        },
      });
    } finally {
      await db.close();
    }
  });

  it('permits explicit operator repair transfer without locking editorial fields', async () => {
    const { db, pool } = await migratedPool();
    try {
      const created = await createWorker(
        pool,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      const { attempt } = await claimWorker(db, pool, created.attempt.id);
      const firstOperator = request({
        requester: 'admin',
        idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        executor: 'operator',
      });
      const superseded = await supersedeStoredRednoteAttempt({
        priorAttemptId: attempt.id,
        request: firstOperator.parsed,
        rawRequestDigest: firstOperator.rawRequestDigest,
        expectedActiveAttemptId: attempt.id,
        validateNew: async () => ({
          ...readyPost,
          activeAttemptId: attempt.id,
          nextAction: 'Resolve attempt',
          publishExecution: 'Worker claimed',
        }),
        occurredAt: '2026-08-07T16:20:00.000Z',
        actorId: 'operator@example.com',
        pool,
      });
      const replacementInput = request({
        requester: 'admin',
        idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        executor: 'operator',
      });
      const transferred = await transferStoredRednoteOperatorResolution({
        priorOperatorAttemptId: superseded.operatorAttempt.id,
        request: replacementInput.parsed,
        rawRequestDigest: replacementInput.rawRequestDigest,
        validateNew: async () => ({
          activeAttemptId: null,
          sourcePostRevision: '2026-08-07T16:20:01.000Z',
          status: 'Ready',
          nextAction: 'Backfill receipt',
          publishExecution: 'Operator scheduled',
        }),
        occurredAt: '2026-08-07T16:30:00.000Z',
        actorId: 'repair@example.com',
        reason: 'Transfer receipt reconciliation to the on-call operator',
        pool,
      });
      expect(transferred).toMatchObject({
        created: true,
        priorOperatorAttempt: {
          supersededByAttemptId: transferred.operatorAttempt.id,
        },
        operatorAttempt: {
          supersedesAttemptId: superseded.operatorAttempt.id,
          terminalOutcome: 'accepted',
          active: false,
        },
      });
      expect(
        transferred.priorOperatorAttempt.operatorResolutionCompletedAt,
      ).toBeTruthy();
      expect(
        transferred.operatorAttempt.operatorResolutionStartedAt,
      ).toBeTruthy();
      expect(
        transferred.operatorAttempt,
      ).not.toHaveProperty('operatorResolutionCompletedAt');
      await expect(transferStoredRednoteOperatorResolution({
        priorOperatorAttemptId: superseded.operatorAttempt.id,
        request: replacementInput.parsed,
        rawRequestDigest: replacementInput.rawRequestDigest,
        occurredAt: '2026-08-07T16:30:00.000Z',
        actorId: 'repair@example.com',
        reason: 'Transfer receipt reconciliation to the on-call operator',
        validateNew: async () => {
          throw new Error('replay must not re-read Posts');
        },
        pool,
      })).resolves.toMatchObject({
        created: false,
        operatorAttempt: { id: transferred.operatorAttempt.id },
      });
      const history = await db.query<{
        evidence: Array<{ kind: string; reference: string }>;
      }>(
        `SELECT evidence FROM rednote_publish_attempt_events
         WHERE attempt_id = $1 AND event_type = 'superseded'`,
        [superseded.operatorAttempt.id],
      );
      expect(history.rows[0]?.evidence[0]).toMatchObject({
        kind: 'operator_resolution_transfer',
        reference: transferred.operatorAttempt.id,
      });
      const repaired = await db.query<{
        state: string;
        diagnostics: { explicitOperatorRepair?: boolean };
      }>(
        `SELECT state, diagnostics FROM rednote_publish_post_mutations
         WHERE id = $1`,
        [superseded.mutation!.id],
      );
      expect(repaired.rows[0]).toMatchObject({
        state: 'applied',
        diagnostics: { explicitOperatorRepair: true },
      });
    } finally {
      await db.close();
    }
  });
});
