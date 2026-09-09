import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    query: mocks.query,
    connect: vi.fn().mockResolvedValue({
      query: mocks.query,
      release: mocks.release,
    }),
  }),
}));

import {
  createRednotePublishAttempt,
  diagnoseExpiredMisclassifiedBatchClaim,
  diagnoseTerminalExpiredMisclassifiedBatchClaim,
  frozenPayloadDigest,
  recordLinkedAttemptOutcome,
  requeueExpiredMisclassifiedBatchClaim,
  requeueMisclassifiedBatchInvalidClaimFailure,
  requeueReadyX3InvalidClaimFailure,
  requeueReadyX3NotLoggedInFailure,
  requeueReadyX3ScheduleReadbackMismatch,
  requeueReadyX3StaleBrowserFrameFailure,
  requeueTerminalExpiredMisclassifiedBatchClaim,
  supersedeUnclaimedReadyX3Schedule,
  withReadyX3SourceLock,
} from '@/lib/rednote-publishing-attempt-store';
import {
  REDNOTE_PUBLISHING_CONTRACT_REVISION,
  type FrozenRednoteAttemptPayload,
} from '@/lib/rednote-publishing-contract-v1';
import { storedManifestHash } from '@/lib/rednote-publish-batch-store';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';

const input = {
  workspaceId: 'legacy-local-publish',
  jobId: 'a6cdfa8a-e840-4e48-9776-044a8cd2b093',
  attemptId: 'ef4a1d51-01eb-4499-a596-4aefefb59de8',
  sourceNotionPageId: '432411de-071a-498e-9833-ff7b6c238374',
  revision: '2026-09-08T16:37:00.000Z',
};

function stableDigest(value: unknown): string {
  const stable = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(stable).join(',')}]`;
    if (item && typeof item === 'object') {
      return `{${Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
        .join(',')}}`;
    }
    return JSON.stringify(item);
  };
  return createHash('sha256').update(stable(value)).digest('hex');
}

function mockEligibleRecovery(eligible: boolean) {
  mocks.query.mockImplementation(async (statement: string) => {
    if (statement.includes('UPDATE local_publish_jobs job')) {
      return { rows: eligible ? [{ id: input.jobId }] : [] };
    }
    return { rows: [], rowCount: 1 };
  });
}

describe('Ready x3 pre-provider failure recovery', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
  });

  describe('misclassified bounded-batch authorization recovery', () => {
    const mediaUrl = 'https://images.xhs.justlikekatie.com/day-16.png';
    const batchSnapshot = {
      notionPageId: input.sourceNotionPageId,
      headline: 'Day 16',
      title: 'Day 16',
      caption: 'Caption',
      tags: ['Tag'],
      platform: 'RedNote' as const,
      mediaType: 'image' as const,
      mediaIndex: 0,
      mediaUrl,
      media: [{
        type: 'image' as const,
        url: mediaUrl,
        identity: rednoteMediaIdentity({ type: 'image', url: mediaUrl }),
      }],
      publishAt: '2026-09-08T23:20:00.000Z',
      notionLastEditedTime: input.revision,
      expectedAccountId: '678ba3b5000000000a03ecd2',
    };

    function recoveryPayload() {
      const payload: FrozenRednoteAttemptPayload = {
        contractRevision: REDNOTE_PUBLISHING_CONTRACT_REVISION,
        sourceNotionPageId: input.sourceNotionPageId,
        sourceLocalPublishJobId: input.jobId,
        payloadRevision: input.revision,
        payloadDigest: '',
        requestedAt: '2026-09-08T17:08:23.346Z',
        executor: {
          type: 'worker',
          kind: 'playwright',
          id: 'local-publish-worker',
        },
        browserPayload: {
          sourcePostId: input.sourceNotionPageId,
          expectedAccountId: batchSnapshot.expectedAccountId,
          title: batchSnapshot.title,
          caption: batchSnapshot.caption,
          tags: batchSnapshot.tags,
          scheduledDate: batchSnapshot.publishAt,
          targetPublishAt: batchSnapshot.publishAt,
          timingMode: 'scheduled',
          visibility: 'public',
          publishMode: 'image',
          mediaAssets: [{
            assetId: 'image-0',
            deliveryUrl: mediaUrl,
            sha256: 'a'.repeat(64),
            mediaType: 'image',
            role: 'content',
          }],
        },
      };
      payload.payloadDigest = frozenPayloadDigest(payload);
      return payload;
    }

    function terminalExpiredCandidate(
      overrides: Record<string, unknown> = {},
    ) {
      const payload = recoveryPayload();
      const itemHash = stableDigest(batchSnapshot);
      const batchManifest = [{
        notionPageId: input.sourceNotionPageId,
        itemHash,
        dispatchMode: 'scheduled' as const,
        lateBySeconds: 0,
      }];
      return {
        id: input.attemptId,
        claim_token: '33333333-3333-4333-8333-333333333333',
        claim_expires_at: '2026-09-08T20:19:53.817Z',
        terminal_at: '2026-09-08T20:19:53.817Z',
        payload_digest: payload.payloadDigest,
        payload_revision: input.revision,
        frozen_payload: payload,
        approved_at: '2026-09-08T17:08:23.346Z',
        late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
        job_snapshot: batchSnapshot,
        batch_snapshot: batchSnapshot,
        dispatch_mode: 'scheduled',
        item_hash: itemHash,
        manifest_hash: storedManifestHash(batchManifest),
        batch_manifest: batchManifest,
        ...overrides,
      };
    }

    beforeEach(() => {
      mocks.query.mockReset();
      mocks.release.mockReset();
    });

    it('reclassifies and requeues the same approved batch attempt without a new job', async () => {
      const payload = recoveryPayload();
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT attempt.id,attempt.payload_digest')) {
          return {
            rows: [{
              id: input.attemptId,
              payload_digest: payload.payloadDigest,
              payload_revision: input.revision,
              frozen_payload: payload,
              approved_at: '2026-08-31T14:00:00.000Z',
              late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
              job_snapshot: batchSnapshot,
              batch_snapshot: batchSnapshot,
              dispatch_mode: 'scheduled',
            }],
          };
        }
        if (statement.includes('UPDATE rednote_publish_attempts')) {
          return { rows: [{ id: input.attemptId }] };
        }
        if (statement.includes('UPDATE local_publish_jobs')) {
          return { rows: [{ id: input.jobId }] };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueMisclassifiedBatchInvalidClaimFailure(input)).resolves.toEqual({
        requeued: true,
        reclassifiedAuthorization: 'batch',
        jobId: input.jobId,
        attemptId: input.attemptId,
        publicationMayHaveStarted: false,
      });

      const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
      expect(statements).toContain(
        "SELECT set_config('app.batch_authorization_reclassification', 'on', true)",
      );
      expect(statements.some((statement) =>
        statement.includes('SET authorization_kind=NULL,late_fallback_policy=NULL'))).toBe(true);
      expect(statements.some((statement) =>
        statement.includes("SET status='queued'"))).toBe(true);
      expect(statements.some((statement) =>
        statement.includes('INSERT INTO local_publish_jobs'))).toBe(false);
      expect(statements.some((statement) =>
        statement.includes("'batch_authorization_reclassified'"))).toBe(true);
    });

    it('fails closed before requeue when a competing newer lifecycle owns the page', async () => {
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('rednote_publish_revision_blockers')) {
          return {
            rows: [{
              lifecycle_id: 'newer-batch-item',
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueMisclassifiedBatchInvalidClaimFailure(input))
        .rejects.toMatchObject({
          code: 'PUBLISH_LIFECYCLE_RECOVERY_CONFLICT',
          status: 409,
        });
      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT COALESCE(job.batch_item_id, item.id)'),
        [
          input.workspaceId,
          input.sourceNotionPageId,
          input.revision,
          input.jobId,
          input.attemptId,
        ],
      );
      expect(mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes('UPDATE rednote_publish_attempts'))).toBe(false);
      expect(mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes('UPDATE local_publish_jobs'))).toBe(false);
    });

    it('fails closed when the frozen attempt differs from the approved batch packet', async () => {
      const payload = recoveryPayload();
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT attempt.id,attempt.payload_digest')) {
          return {
            rows: [{
              id: input.attemptId,
              payload_digest: payload.payloadDigest,
              payload_revision: input.revision,
              frozen_payload: payload,
              approved_at: '2026-08-31T14:00:00.000Z',
              late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
              job_snapshot: batchSnapshot,
              batch_snapshot: { ...batchSnapshot, title: 'Changed title' },
              dispatch_mode: 'scheduled',
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueMisclassifiedBatchInvalidClaimFailure(input))
        .rejects.toMatchObject({
          code: 'BATCH_AUTHORIZATION_REPAIR_UNSAFE',
          status: 409,
        });
      expect(mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes('SET authorization_kind=NULL'))).toBe(false);
    });

    it('reclassifies and requeues the same expired pre-validation batch claim', async () => {
      const payload = recoveryPayload();
      const itemHash = stableDigest(batchSnapshot);
      const batchManifest = [{
        notionPageId: input.sourceNotionPageId,
        itemHash,
        dispatchMode: 'scheduled' as const,
        lateBySeconds: 0,
      }];
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT attempt.id,attempt.claim_token')) {
          return {
            rows: [{
              id: input.attemptId,
              claim_token: '33333333-3333-4333-8333-333333333333',
              claim_expires_at: '2026-08-31T15:10:00.000Z',
              payload_digest: payload.payloadDigest,
              payload_revision: input.revision,
              frozen_payload: payload,
              approved_at: '2026-08-31T14:00:00.000Z',
              late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
              job_snapshot: batchSnapshot,
              batch_snapshot: batchSnapshot,
              dispatch_mode: 'scheduled',
              item_hash: itemHash,
              manifest_hash: storedManifestHash(batchManifest),
              batch_manifest: batchManifest,
            }],
          };
        }
        if (statement.includes('UPDATE rednote_publish_attempts')) {
          return { rows: [{ id: input.attemptId }] };
        }
        if (statement.includes('UPDATE local_publish_jobs')) {
          return { rows: [{ id: input.jobId }] };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueExpiredMisclassifiedBatchClaim(input)).resolves.toEqual({
        requeued: true,
        reclassifiedAuthorization: 'batch',
        jobId: input.jobId,
        attemptId: input.attemptId,
        publicationMayHaveStarted: false,
      });

      const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
      expect(statements).toContain(
        "SELECT set_config('app.expired_batch_claim_reclassification', 'on', true)",
      );
      expect(statements.some((statement) =>
        statement.includes('SET authorization_kind=NULL,late_fallback_policy=NULL'))).toBe(true);
      expect(statements.some((statement) =>
        statement.includes("SET status='queued'"))).toBe(true);
      expect(statements.some((statement) =>
        statement.includes('INSERT INTO local_publish_jobs'))).toBe(false);
      expect(statements.some((statement) =>
        statement.includes("'expired_batch_claim_authorization_reclassified'"))).toBe(true);
      const lockCall = mocks.query.mock.calls.find(([statement]) =>
        String(statement).includes('SELECT attempt.id,attempt.claim_token'));
      expect(String(lockCall?.[0])).toContain("item.dispatch_mode='scheduled'");
      expect(String(lockCall?.[0])).toContain('attempt.late_fallback_policy=$6::jsonb');
      expect(lockCall?.[1]?.[5]).toBe(
        JSON.stringify({ action: 'post_now', maxLateMinutes: 30 }),
      );
    });

    it('reports the exact queued batch-item mismatch without mutating state or exposing payloads', async () => {
      const payload = recoveryPayload();
      const itemHash = stableDigest(batchSnapshot);
      const batchManifest = [{
        notionPageId: input.sourceNotionPageId,
        itemHash,
        dispatchMode: 'scheduled' as const,
        lateBySeconds: 0,
      }];
      mocks.query.mockResolvedValue({
        rows: [{
          id: input.attemptId,
          claim_token: '33333333-3333-4333-8333-333333333333',
          claim_expires_at: '2026-08-31T15:10:00.000Z',
          payload_digest: payload.payloadDigest,
          payload_revision: input.revision,
          frozen_payload: payload,
          approved_at: '2026-08-31T14:00:00.000Z',
          late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
          job_snapshot: batchSnapshot,
          batch_snapshot: batchSnapshot,
          dispatch_mode: 'scheduled',
          item_hash: itemHash,
          manifest_hash: storedManifestHash(batchManifest),
          batch_manifest: batchManifest,
          sql_checks: { batchItemClaimed: false },
        }],
      });

      const result = await diagnoseExpiredMisclassifiedBatchClaim(input);

      expect(result.eligible).toBe(false);
      expect(result.failedChecks).toEqual(['batchItemClaimed']);
      expect(result.checks.batchItemClaimed).toBe(false);
      expect(result.checks.frozenPayloadDigestValid).toBe(true);
      expect(Object.keys(result.checks)).toHaveLength(73);
      expect(Object.values(result.checks).every((value) => typeof value === 'boolean'))
        .toBe(true);
      const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain('LEFT JOIN rednote_publish_batch_items');
      expect(statements[0]).toContain("'batchItemClaimed'");
      expect(statements[0]).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
      expect(JSON.stringify(result)).not.toContain('claim_token');
      expect(JSON.stringify(result)).not.toContain(mediaUrl);
      expect(JSON.stringify(result)).not.toContain(batchSnapshot.caption);
    });

    it.each([
      ['changed action', { action: 'schedule', maxLateMinutes: 30 }],
      ['changed timeout', { action: 'post_now', maxLateMinutes: 31 }],
      ['extra field', { action: 'post_now', maxLateMinutes: 30, revision: input.revision }],
    ])('fails closed for a legacy fallback with a %s', async (_, lateFallbackPolicy) => {
      const payload = recoveryPayload();
      const itemHash = stableDigest(batchSnapshot);
      const batchManifest = [{
        notionPageId: input.sourceNotionPageId,
        itemHash,
        dispatchMode: 'scheduled' as const,
        lateBySeconds: 0,
      }];
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT attempt.id,attempt.claim_token')) {
          return {
            rows: [{
              id: input.attemptId,
              claim_token: '33333333-3333-4333-8333-333333333333',
              claim_expires_at: '2026-08-31T15:10:00.000Z',
              payload_digest: payload.payloadDigest,
              payload_revision: input.revision,
              frozen_payload: payload,
              approved_at: '2026-08-31T14:00:00.000Z',
              late_fallback_policy: lateFallbackPolicy,
              job_snapshot: batchSnapshot,
              batch_snapshot: batchSnapshot,
              dispatch_mode: 'scheduled',
              item_hash: itemHash,
              manifest_hash: storedManifestHash(batchManifest),
              batch_manifest: batchManifest,
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueExpiredMisclassifiedBatchClaim(input))
        .rejects.toMatchObject({
          code: 'EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
          status: 409,
        });
      expect(mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes('SET authorization_kind=NULL'))).toBe(false);
    });

    it('fails closed when the frozen Ready x3 action is not scheduled', async () => {
      const payload = recoveryPayload();
      payload.browserPayload.timingMode = 'post_now';
      payload.payloadDigest = frozenPayloadDigest(payload);
      const itemHash = stableDigest(batchSnapshot);
      const batchManifest = [{
        notionPageId: input.sourceNotionPageId,
        itemHash,
        dispatchMode: 'scheduled' as const,
        lateBySeconds: 0,
      }];
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT attempt.id,attempt.claim_token')) {
          return {
            rows: [{
              id: input.attemptId,
              claim_token: '33333333-3333-4333-8333-333333333333',
              claim_expires_at: '2026-08-31T15:10:00.000Z',
              payload_digest: payload.payloadDigest,
              payload_revision: input.revision,
              frozen_payload: payload,
              approved_at: '2026-08-31T14:00:00.000Z',
              late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
              job_snapshot: batchSnapshot,
              batch_snapshot: batchSnapshot,
              dispatch_mode: 'scheduled',
              item_hash: itemHash,
              manifest_hash: storedManifestHash(batchManifest),
              batch_manifest: batchManifest,
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueExpiredMisclassifiedBatchClaim(input))
        .rejects.toMatchObject({
          code: 'EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
          status: 409,
        });
    });

    it('rejects an unexpired claim and every pre-browser evidence barrier', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await expect(requeueExpiredMisclassifiedBatchClaim(input))
        .rejects.toMatchObject({
          code: 'EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
          status: 409,
        });

      const lockSql = String(mocks.query.mock.calls.find(([statement]) =>
        String(statement).includes('SELECT attempt.id,attempt.claim_token'))?.[0]);
      for (const guard of [
        'job.claim_expires_at<=CURRENT_TIMESTAMP',
        'attempt.claim_expires_at<=CURRENT_TIMESTAMP',
        'job.staged_at IS NULL',
        'job.dispatch_authorized_at IS NULL',
        'job.dispatched_at IS NULL',
        'job.note_id IS NULL',
        'job.share_url IS NULL',
        'job.success_attestation_id IS NULL',
        'job.external_disposition_request_id IS NULL',
        "event.event_type='execution_started'",
        'FROM rednote_publish_attempt_receipts receipt',
        'FROM rednote_publication_evidence evidence',
      ]) {
        expect(lockSql).toContain(guard);
      }
      expect(mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes('SET authorization_kind=NULL'))).toBe(false);
    });

    it('fails closed when the expired claim digest does not match its frozen packet', async () => {
      const payload = recoveryPayload();
      const itemHash = stableDigest(batchSnapshot);
      const batchManifest = [{
        notionPageId: input.sourceNotionPageId,
        itemHash,
        dispatchMode: 'scheduled' as const,
        lateBySeconds: 0,
      }];
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT attempt.id,attempt.claim_token')) {
          return {
            rows: [{
              id: input.attemptId,
              claim_token: '33333333-3333-4333-8333-333333333333',
              claim_expires_at: '2026-08-31T15:10:00.000Z',
              payload_digest: 'f'.repeat(64),
              payload_revision: input.revision,
              frozen_payload: payload,
              approved_at: '2026-08-31T14:00:00.000Z',
              late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
              job_snapshot: batchSnapshot,
              batch_snapshot: batchSnapshot,
              dispatch_mode: 'scheduled',
              item_hash: itemHash,
              manifest_hash: storedManifestHash(batchManifest),
              batch_manifest: batchManifest,
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueExpiredMisclassifiedBatchClaim(input))
        .rejects.toMatchObject({
          code: 'EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
          status: 409,
        });
      expect(mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes('SET authorization_kind=NULL'))).toBe(false);
    });

    it.each(['item', 'manifest'] as const)(
      'fails closed when the stored batch %s digest is invalid',
      async (invalidDigest) => {
        const payload = recoveryPayload();
        const itemHash = stableDigest(batchSnapshot);
        const batchManifest = [{
          notionPageId: input.sourceNotionPageId,
          itemHash,
          dispatchMode: 'scheduled' as const,
          lateBySeconds: 0,
        }];
        mocks.query.mockImplementation(async (statement: string) => {
          if (statement.includes('SELECT attempt.id,attempt.claim_token')) {
            return {
              rows: [{
                id: input.attemptId,
                claim_token: '33333333-3333-4333-8333-333333333333',
                claim_expires_at: '2026-08-31T15:10:00.000Z',
                payload_digest: payload.payloadDigest,
                payload_revision: input.revision,
                frozen_payload: payload,
                approved_at: '2026-08-31T14:00:00.000Z',
                late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
                job_snapshot: batchSnapshot,
                batch_snapshot: batchSnapshot,
                dispatch_mode: 'scheduled',
                item_hash: invalidDigest === 'item' ? 'f'.repeat(64) : itemHash,
                manifest_hash: invalidDigest === 'manifest'
                  ? 'f'.repeat(64)
                  : storedManifestHash(batchManifest),
                batch_manifest: batchManifest,
              }],
            };
          }
          return { rows: [], rowCount: 1 };
        });

        await expect(requeueExpiredMisclassifiedBatchClaim(input))
          .rejects.toMatchObject({
            code: 'EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
            status: 409,
          });
      },
    );

    it('rejects a multi-item batch because its persisted insertion order cannot be reconstructed', async () => {
      const payload = recoveryPayload();
      const itemHash = stableDigest(batchSnapshot);
      const batchManifest = [
        {
          notionPageId: input.sourceNotionPageId,
          itemHash,
          dispatchMode: 'scheduled' as const,
          lateBySeconds: 0,
        },
        {
          notionPageId: 'another-page',
          itemHash: 'e'.repeat(64),
          dispatchMode: 'scheduled' as const,
          lateBySeconds: 0,
        },
      ];
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT attempt.id,attempt.claim_token')) {
          return {
            rows: [{
              id: input.attemptId,
              claim_token: '33333333-3333-4333-8333-333333333333',
              claim_expires_at: '2026-08-31T15:10:00.000Z',
              payload_digest: payload.payloadDigest,
              payload_revision: input.revision,
              frozen_payload: payload,
              approved_at: '2026-08-31T14:00:00.000Z',
              late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
              job_snapshot: batchSnapshot,
              batch_snapshot: batchSnapshot,
              dispatch_mode: 'scheduled',
              item_hash: itemHash,
              manifest_hash: storedManifestHash(batchManifest),
              batch_manifest: batchManifest,
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueExpiredMisclassifiedBatchClaim(input))
        .rejects.toMatchObject({
          code: 'EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
          status: 409,
        });
    });

    it('rejects a batch snapshot revision that differs from the attempt and request', async () => {
      const payload = recoveryPayload();
      const mismatchedSnapshot = {
        ...batchSnapshot,
        notionLastEditedTime: '2026-08-31T13:59:59.000Z',
      };
      const itemHash = stableDigest(mismatchedSnapshot);
      const batchManifest = [{
        notionPageId: input.sourceNotionPageId,
        itemHash,
        dispatchMode: 'scheduled' as const,
        lateBySeconds: 0,
      }];
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT attempt.id,attempt.claim_token')) {
          return {
            rows: [{
              id: input.attemptId,
              claim_token: '33333333-3333-4333-8333-333333333333',
              claim_expires_at: '2026-08-31T15:10:00.000Z',
              payload_digest: payload.payloadDigest,
              payload_revision: input.revision,
              frozen_payload: payload,
              approved_at: '2026-08-31T14:00:00.000Z',
              late_fallback_policy: { action: 'post_now', maxLateMinutes: 30 },
              job_snapshot: mismatchedSnapshot,
              batch_snapshot: mismatchedSnapshot,
              dispatch_mode: 'scheduled',
              item_hash: itemHash,
              manifest_hash: storedManifestHash(batchManifest),
              batch_manifest: batchManifest,
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueExpiredMisclassifiedBatchClaim(input))
        .rejects.toMatchObject({
          code: 'EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
          status: 409,
        });
    });

    it('reactivates and requeues the exact terminal lease-expiry incident in place', async () => {
      const candidate = terminalExpiredCandidate();
      mocks.query.mockImplementation(async (statement: string) => {
        if (
          statement.includes('SELECT attempt.id,attempt.claim_token') &&
          statement.includes('attempt.terminal_at')
        ) {
          return { rows: [candidate] };
        }
        if (statement.includes('UPDATE rednote_publish_attempts')) {
          return {
            rows: [{
              id: input.attemptId,
              approved_at: candidate.approved_at,
            }],
          };
        }
        if (statement.includes('UPDATE local_publish_jobs')) {
          return { rows: [{ id: input.jobId }] };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueTerminalExpiredMisclassifiedBatchClaim(input))
        .resolves.toEqual({
          requeued: true,
          reclassifiedAuthorization: 'batch',
          jobId: input.jobId,
          attemptId: input.attemptId,
          publicationMayHaveStarted: false,
        });

      const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
      expect(statements).toContain(
        "SELECT set_config('app.ready_x3_invalid_claim_recovery', 'on', true)",
      );
      expect(statements).toContain(
        "SELECT set_config('app.terminal_expired_batch_claim_reclassification', 'on', true)",
      );
      expect(statements.some((statement) =>
        statement.includes('SET authorization_kind=NULL,late_fallback_policy=NULL')))
        .toBe(true);
      expect(statements.some((statement) =>
        statement.includes("active=true,terminal_outcome=NULL,terminal_at=NULL")))
        .toBe(true);
      expect(statements.some((statement) =>
        statement.includes("SET status='queued',claim_token=NULL,claimed_at=NULL")))
        .toBe(true);
      expect(statements.some((statement) =>
        statement.includes("'terminal_expired_batch_claim_recovery'"))).toBe(true);
      expect(statements.some((statement) =>
        statement.includes('INSERT INTO local_publish_jobs'))).toBe(false);
      expect(statements.some((statement) =>
        statement.includes('INSERT INTO rednote_publish_attempts'))).toBe(false);
    });

    it('diagnoses the terminal incident with boolean checks and no mutation', async () => {
      mocks.query.mockResolvedValue({
        rows: [terminalExpiredCandidate({
          sql_checks: { operatorScheduleAbsent: false },
        })],
      });

      const result = await diagnoseTerminalExpiredMisclassifiedBatchClaim(input);

      expect(result.eligible).toBe(false);
      expect(result.failedChecks).toEqual(['operatorScheduleAbsent']);
      expect(Object.values(result.checks).every((value) => typeof value === 'boolean'))
        .toBe(true);
      expect(mocks.query).toHaveBeenCalledTimes(1);
      const statement = String(mocks.query.mock.calls[0][0]);
      expect(statement).toContain('LEFT JOIN rednote_publish_batch_items');
      expect(statement).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
      expect(JSON.stringify(result)).not.toContain('claim_token');
      expect(JSON.stringify(result)).not.toContain(mediaUrl);
    });

    it.each([
      'batchItemPageMatchesAttempt',
      'frozenContractRevisionMatchesAttempt',
      'browserExpectedAccountMatchesSnapshot',
      'browserScheduledDateMatchesSnapshot',
      'browserTargetPublishAtMatchesSnapshot',
    ])('reports the exact app/trigger parity failure for %s', async (checkName) => {
      mocks.query.mockResolvedValue({
        rows: [terminalExpiredCandidate({
          sql_checks: { [checkName]: false },
        })],
      });

      const result = await diagnoseTerminalExpiredMisclassifiedBatchClaim(input);

      expect(result.eligible).toBe(false);
      expect(result.failedChecks).toContain(checkName);
      expect(result.checks[checkName]).toBe(false);
    });

    it.each([
      [
        'missing expected account on both packet sides',
        'batchExpectedAccountPresent',
        () => {
          const candidate = terminalExpiredCandidate();
          return {
            ...candidate,
            job_snapshot: { ...candidate.job_snapshot, expectedAccountId: undefined },
            batch_snapshot: { ...candidate.batch_snapshot, expectedAccountId: undefined },
            frozen_payload: {
              ...candidate.frozen_payload,
              browserPayload: {
                ...candidate.frozen_payload.browserPayload,
                expectedAccountId: undefined,
              },
            },
          };
        },
      ],
      [
        'missing publish time on both packet sides',
        'batchPublishAtPresent',
        () => {
          const candidate = terminalExpiredCandidate();
          return {
            ...candidate,
            job_snapshot: { ...candidate.job_snapshot, publishAt: undefined },
            batch_snapshot: { ...candidate.batch_snapshot, publishAt: undefined },
            frozen_payload: {
              ...candidate.frozen_payload,
              browserPayload: {
                ...candidate.frozen_payload.browserPayload,
                scheduledDate: null,
                targetPublishAt: undefined,
              },
            },
          };
        },
      ],
    ])('rejects terminal diagnosis with %s', async (
      _,
      expectedFailedCheck,
      candidate,
    ) => {
      mocks.query.mockResolvedValue({ rows: [candidate()] });

      const result = await diagnoseTerminalExpiredMisclassifiedBatchClaim(input);

      expect(result.eligible).toBe(false);
      expect(result.failedChecks).toContain(expectedFailedCheck);
    });

    it.each([
      ['action', { action: 'schedule', maxLateMinutes: 30 }],
      ['timeout', { action: 'post_now', maxLateMinutes: 31 }],
      ['extra field', { action: 'post_now', maxLateMinutes: 30, extra: true }],
    ])('rejects terminal recovery with an altered legacy fallback %s', async (
      _,
      lateFallbackPolicy,
    ) => {
      mocks.query.mockImplementation(async (statement: string) => {
        if (
          statement.includes('SELECT attempt.id,attempt.claim_token') &&
          statement.includes('attempt.terminal_at')
        ) {
          return {
            rows: [terminalExpiredCandidate({
              late_fallback_policy: lateFallbackPolicy,
            })],
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(requeueTerminalExpiredMisclassifiedBatchClaim(input))
        .rejects.toMatchObject({
          code: 'TERMINAL_EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
          status: 409,
        });
      expect(mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes('UPDATE rednote_publish_attempts'))).toBe(false);
    });

    it('fails closed on every terminal timestamp and evidence barrier', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await expect(requeueTerminalExpiredMisclassifiedBatchClaim(input))
        .rejects.toMatchObject({
          code: 'TERMINAL_EXPIRED_BATCH_CLAIM_RECOVERY_UNSAFE',
          status: 409,
        });

      const lockSql = String(mocks.query.mock.calls.find(([statement]) =>
        String(statement).includes('attempt.terminal_at'))?.[0]);
      for (const guard of [
        "job.error_code='CLAIM_LEASE_EXPIRED'",
        'job.error_message=$7',
        'job.claim_expires_at<=CURRENT_TIMESTAMP',
        'job.completed_at=job.claim_expires_at',
        'attempt.terminal_at=job.claim_expires_at',
        'attempt.receipt_lookup_updated_at=job.claim_expires_at',
        'attempt.claim_expires_at=job.claim_expires_at',
        "item.state='queued'",
        'item.notion_page_id=attempt.source_notion_page_id',
        "attempt.frozen_payload->>'contractRevision'=attempt.contract_revision",
        "attempt.frozen_payload->'browserPayload'->>'expectedAccountId'=",
        "attempt.frozen_payload->'browserPayload'->>'scheduledDate'=",
        "attempt.frozen_payload->'browserPayload'->>'targetPublishAt'=",
        '(SELECT count(*) FROM rednote_publish_attempt_events event',
        "event.actor_id='local_publish_lease_recovery'",
        "event.event_type='execution_started'",
        'FROM rednote_publish_attempt_receipts receipt',
        'FROM rednote_publication_evidence evidence',
        'FROM local_publish_job_success_attestations attestation',
        'FROM local_publish_job_success_attestation_release_acks acknowledgement',
        'FROM manual_reconciliation_requests reconciliation',
        'FROM external_post_reconciliations reconciliation',
        'FROM plan_operator_scheduled_posts operator_post',
        'FROM rednote_publish_job_recoveries recovery',
        'FROM local_publish_queue_quarantine_items quarantine',
        'FROM local_publish_jobs other_job',
      ]) {
        expect(lockSql).toContain(guard);
      }
      expect(mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes('UPDATE rednote_publish_attempts'))).toBe(false);
    });
  });

  it('requeues the same attempt after a guarded NOT_LOGGED_IN failure', async () => {
    mockEligibleRecovery(true);

    await expect(requeueReadyX3NotLoggedInFailure(input)).resolves.toEqual({
      requeued: true,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false,
    });

    const eligibleCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs job'));
    expect(eligibleCall?.[1]).toEqual([
      input.workspaceId,
      input.jobId,
      input.attemptId,
      input.sourceNotionPageId,
      input.revision,
      'NOT_LOGGED_IN',
      null,
    ]);

    const eligibleSql = String(eligibleCall?.[0]);
    expect(eligibleSql).toContain("job.status='failed'");
    expect(eligibleSql).toContain('job.staged_at IS NULL');
    expect(eligibleSql).toContain('job.dispatch_authorized_at IS NULL');
    expect(eligibleSql).toContain('job.dispatched_at IS NULL');
    expect(eligibleSql).toContain('job.note_id IS NULL');
    expect(eligibleSql).toContain('job.share_url IS NULL');
    expect(eligibleSql).toContain('job.success_attestation_id IS NULL');
    expect(eligibleSql).toContain('job.external_disposition_request_id IS NULL');
    expect(eligibleSql).toContain('attempt.dispatch_authorized_at IS NULL');
    expect(eligibleSql).toContain("event.event_type='execution_started'");
    expect(eligibleSql).toContain('FROM rednote_publish_attempt_receipts receipt');

    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) =>
      statement.includes('INSERT INTO local_publish_jobs'))).toBe(false);
    expect(statements.some((statement) =>
      statement.includes("'not_logged_in_failure_requeued'"))).toBe(false);
    expect(mocks.query.mock.calls.some(([, params]) =>
      Array.isArray(params) &&
      params.includes('not_logged_in_failure_requeued'))).toBe(true);
  });

  it('fails closed when any eligibility guard rejects the login recovery', async () => {
    mockEligibleRecovery(false);

    await expect(requeueReadyX3NotLoggedInFailure(input)).rejects.toMatchObject({
      code: 'READY_X3_NOT_LOGGED_IN_RECOVERY_UNSAFE',
      status: 409,
    });
    expect(mocks.query.mock.calls.some(([statement]) =>
      String(statement) === 'ROLLBACK')).toBe(true);
  });

  it('preserves the existing INVALID_CLAIM recovery predicate', async () => {
    mockEligibleRecovery(true);

    await requeueReadyX3InvalidClaimFailure(input);

    const eligibleCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs job'));
    expect(eligibleCall?.[1]?.[5]).toBe('INVALID_CLAIM');
  });

  it('requires the exact pre-provider stale browser frame failure', async () => {
    mockEligibleRecovery(true);

    await expect(requeueReadyX3StaleBrowserFrameFailure(input)).resolves.toMatchObject({
      requeued: true,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false,
    });

    const eligibleCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs job'));
    expect(eligibleCall?.[1]?.[5]).toBe('INTERNAL_ERROR');
    expect(eligibleCall?.[1]?.[6]).toBe(
      'page.goto: Protocol error (Page.navigate): No frame with given id found%',
    );
    expect(String(eligibleCall?.[0])).toContain(
      '($7::text IS NULL OR job.error_message LIKE $7)',
    );
  });

  it('requires the exact pre-provider schedule readback failure', async () => {
    mockEligibleRecovery(true);

    await expect(requeueReadyX3ScheduleReadbackMismatch(input)).resolves.toMatchObject({
      requeued: true,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false,
    });

    const eligibleCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs job'));
    expect(eligibleCall?.[1]?.[5]).toBe('SCHEDULE_READBACK_MISMATCH');
    expect(eligibleCall?.[1]?.[6]).toBe(
      'Creator date-picker did not retain the scheduled time (got %',
    );
  });
});

describe('Ready x3 source serialization', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
  });

  describe('linked attempt receipt reconciliation', () => {
    beforeEach(() => {
      mocks.query.mockReset();
      mocks.release.mockReset();
    });

    it('attaches a Note ID receipt to the existing scheduled attempt under a new verification claim', async () => {
      const attempt = {
        id: input.attemptId,
        workspace_id: input.workspaceId,
        source_notion_page_id: input.sourceNotionPageId,
        source_local_publish_job_id: input.jobId,
        payload_digest: 'a'.repeat(64),
        payload_revision: input.revision,
        executor_type: 'worker',
        executor_kind: 'playwright',
        executor_id: 'worker-1',
        requested_at: '2026-08-31T15:00:00.000Z',
        created_at: '2026-08-31T15:00:00.000Z',
        approved_at: '2026-08-31T15:01:00.000Z',
        terminal_outcome: 'accepted',
        terminal_at: '2026-08-31T15:02:00.000Z',
        receipt_lookup_state: 'identity_pending',
        receipt_lookup_updated_at: '2026-08-31T15:02:00.000Z',
        active: false,
        supersedes_attempt_id: null,
        superseded_by_attempt_id: null,
        authorization_kind: null,
      };
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT rednote_url, rednote_note_id')) {
          return {
            rows: [{ rednote_url: null, rednote_note_id: 'note_123' }],
            rowCount: 1,
          };
        }
        if (statement.includes('SELECT * FROM rednote_publish_attempts')) {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes('JOIN local_publish_jobs job')) {
          return { rows: [attempt], rowCount: 1 };
        }
        if (statement.includes('UPDATE rednote_publish_attempts SET receipt_lookup_state')) {
          return {
            rows: [{ ...attempt, receipt_lookup_state: 'found' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(recordLinkedAttemptOutcome({
        workspaceId: input.workspaceId,
        localJobId: input.jobId,
        claimToken: '33333333-3333-4333-8333-333333333333',
        outcome: 'accepted',
        receipt: {
          rednoteNoteId: 'note_123',
          platformPublishTime: '2026-08-31T15:10:00.000Z',
          provenance: { kind: 'rednote_worker_result_v2' },
        },
      })).resolves.toMatchObject({
        id: input.attemptId,
        terminalOutcome: 'accepted',
        receiptLookupState: 'found',
      });

      const event = mocks.query.mock.calls.find(([statement]) =>
        String(statement).includes("'receipt_lookup'"));
      expect(event?.[1]).toEqual([input.attemptId, 'worker', 'worker-1']);
      expect(mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes('INSERT INTO rednote_publish_attempt_receipts'))).toBe(true);
    });

    it('rejects a replay that conflicts with the immutable receipt identity', async () => {
      const attempt = {
        id: input.attemptId,
        workspace_id: input.workspaceId,
        source_notion_page_id: input.sourceNotionPageId,
        source_local_publish_job_id: input.jobId,
        payload_digest: 'a'.repeat(64),
        payload_revision: input.revision,
        executor_type: 'worker',
        executor_kind: 'playwright',
        executor_id: 'worker-1',
        requested_at: '2026-08-31T15:00:00.000Z',
        created_at: '2026-08-31T15:00:00.000Z',
        approved_at: '2026-08-31T15:01:00.000Z',
        terminal_outcome: 'accepted',
        terminal_at: '2026-08-31T15:02:00.000Z',
        receipt_lookup_state: 'found',
        receipt_lookup_updated_at: '2026-08-31T15:02:00.000Z',
        active: false,
        supersedes_attempt_id: null,
        superseded_by_attempt_id: null,
        authorization_kind: null,
      };
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement.includes('SELECT * FROM rednote_publish_attempts')) {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes('JOIN local_publish_jobs job')) {
          return { rows: [attempt], rowCount: 1 };
        }
        if (statement.includes('SELECT rednote_url, rednote_note_id')) {
          return {
            rows: [{
              rednote_url: 'https://www.rednote.com/explore/note_original',
              rednote_note_id: 'note_original',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(recordLinkedAttemptOutcome({
        workspaceId: input.workspaceId,
        localJobId: input.jobId,
        claimToken: '33333333-3333-4333-8333-333333333333',
        outcome: 'accepted',
        receipt: {
          rednoteNoteId: 'note_different',
          platformPublishTime: '2026-08-31T15:10:00.000Z',
          provenance: { kind: 'rednote_worker_result_v2' },
        },
      })).rejects.toMatchObject({
        code: 'ATTEMPT_RECEIPT_CONFLICT',
        status: 409,
      });
    });
  });

  it('holds one transaction-scoped advisory lock for the source operation', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const operation = vi.fn().mockResolvedValue('created');

    await expect(withReadyX3SourceLock(
      'workspace-1',
      'notion-page-1',
      operation,
    )).resolves.toBe('created');

    const lock = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('pg_advisory_xact_lock'));
    expect(lock?.[1]).toEqual(['workspace-1:notion-page-1']);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not reacquire the same source lock while creating the linked attempt', async () => {
    const requestedAt = '2026-08-31T18:00:00.000Z';
    const payload: FrozenRednoteAttemptPayload = {
      contractRevision: REDNOTE_PUBLISHING_CONTRACT_REVISION,
      sourceNotionPageId: 'notion-page-1',
      sourceLocalPublishJobId: '11111111-1111-4111-8111-111111111111',
      payloadRevision: '2026-08-31T17:00:00.000Z',
      payloadDigest: '',
      requestedAt,
      executor: { type: 'worker' as const, kind: 'playwright' as const, id: 'worker-1' },
      browserPayload: {
        sourcePostId: 'notion-page-1',
        expectedAccountId: 'creator-account-1',
        title: 'Title',
        caption: 'Caption',
        tags: ['Tag'],
        scheduledDate: '2026-08-31T18:15:00.000Z',
        targetPublishAt: requestedAt,
        timingMode: 'post_now' as const,
        visibility: 'public' as const,
        publishMode: 'image' as const,
        mediaAssets: [{
          assetId: 'image-0',
          deliveryUrl: 'https://images.xhs.justlikekatie.com/post.jpg',
          sha256: 'a'.repeat(64),
          mediaType: 'image' as const,
          role: 'content' as const,
        }],
      },
    };
    payload.payloadDigest = frozenPayloadDigest(payload);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT * FROM rednote_publish_attempts')) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes('INSERT INTO rednote_publish_attempts')) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            workspace_id: 'workspace-1',
            source_notion_page_id: 'notion-page-1',
            source_local_publish_job_id: payload.sourceLocalPublishJobId,
            frozen_payload: payload,
            payload_digest: payload.payloadDigest,
            payload_revision: payload.payloadRevision,
            executor_type: 'worker',
            executor_kind: 'playwright',
            executor_id: 'worker-1',
            requested_at: requestedAt,
            created_at: requestedAt,
            approved_at: null,
            terminal_outcome: null,
            terminal_at: null,
            receipt_lookup_state: 'not_required',
            receipt_lookup_updated_at: null,
            active: true,
            supersedes_attempt_id: null,
            superseded_by_attempt_id: null,
            authorization_kind: 'ready_x3',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await withReadyX3SourceLock('workspace-1', 'notion-page-1', () =>
      createRednotePublishAttempt({
        workspaceId: 'workspace-1',
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        payload,
        readyX3: true,
      }));

    const lockCalls = mocks.query.mock.calls.filter(([statement]) =>
      String(statement).includes('pg_advisory_xact_lock'));
    expect(lockCalls).toHaveLength(1);
  });

  it('supersedes the same frozen packet across schedule and Post now actions', async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT job.id AS job_id')) {
        return {
          rows: [{
            job_id: '11111111-1111-4111-8111-111111111111',
            attempt_id: '22222222-2222-4222-8222-222222222222',
            job_status: 'queued',
            job_claim_token: null,
            job_dispatch_authorized_at: null,
            attempt_claim_token: null,
            attempt_dispatch_authorized_at: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(supersedeUnclaimedReadyX3Schedule(
      'workspace-1',
      {
        notionPageId: 'notion-page-1',
        headline: 'Headline',
        title: 'Title',
        caption: 'Caption',
        tags: ['Tag'],
        platform: 'RedNote',
        mediaType: 'video',
        mediaIndex: 0,
        mediaUrl: 'https://images.xhs.justlikekatie.com/post.mp4',
        thumbnailUrl: 'https://images.xhs.justlikekatie.com/cover.jpg',
        publishAt: '2020-08-31T18:00:00.000Z',
        notionLastEditedTime: '2020-08-31T17:00:00.000Z',
      },
      'post_now',
    )).resolves.toBe(true);

    const select = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('SELECT job.id AS job_id'));
    expect(String(select?.[0])).not.toContain('frozen_payload');
    expect(select?.[1]).toEqual(['workspace-1', 'notion-page-1']);
  });

  it('blocks replacement after the existing authorization enters worker execution', async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT job.id AS job_id')) {
        return {
          rows: [{
            job_id: '11111111-1111-4111-8111-111111111111',
            attempt_id: '22222222-2222-4222-8222-222222222222',
            job_status: 'staged',
            job_claim_token: '33333333-3333-4333-8333-333333333333',
            job_dispatch_authorized_at: null,
            attempt_claim_token: '33333333-3333-4333-8333-333333333333',
            attempt_dispatch_authorized_at: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(supersedeUnclaimedReadyX3Schedule(
      'workspace-1',
      {
        notionPageId: 'notion-page-1',
        headline: 'Headline',
        title: 'Title',
        caption: 'Caption',
        tags: ['Tag'],
        platform: 'RedNote',
        mediaType: 'image',
        mediaIndex: 0,
        mediaUrl: 'https://images.xhs.justlikekatie.com/post.jpg',
        publishAt: '2099-08-31T18:00:00.000Z',
        notionLastEditedTime: '2099-08-31T17:00:00.000Z',
      },
      'post_now',
    )).rejects.toMatchObject({
      code: 'READY_X3_ATTEMPT_IN_PROGRESS',
      status: 409,
    });
    expect(mocks.query.mock.calls.some(([statement]) =>
      String(statement).includes('UPDATE rednote_publish_attempts'))).toBe(false);
  });
});