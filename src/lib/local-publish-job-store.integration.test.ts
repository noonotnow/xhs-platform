import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let database: PGlite;

vi.mock('@/lib/db', () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (query, part, index) => query + (index > 0 ? `$${index}` : '') + part,
      '',
    );
    return database.query(text, values);
  },
}));

const mocks = vi.hoisted(() => ({
  loadAttestation: vi.fn(),
  acknowledgeRelease: vi.fn(),
}));

vi.mock('@/lib/operator-success-attestation-store', () => ({
  loadOperatorSuccessAttestation: mocks.loadAttestation,
  acknowledgeOperatorSuccessAttestationRelease: mocks.acknowledgeRelease,
}));

import {
  claimNextStoredLocalPublishJob,
  deferStoredLocalPublishVerification,
  deferStoredOperatorAttestedVerification,
  listLocalPublishJobs,
  recordLateStoredWorkerTerminalResult,
  releaseExpiredStoredLocalPublishClaims,
} from '@/lib/local-publish-job-store';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';

const scheduledJobId = '11111111-1111-4111-8111-111111111111';
const attestedJobId = '22222222-2222-4222-8222-222222222222';
const ineligibleJobId = '33333333-3333-4333-8333-333333333333';
const attestationId = '44444444-4444-4444-8444-444444444444';
const claimToken = '55555555-5555-4555-8555-555555555555';
const batchId = '77777777-7777-4777-8777-777777777777';
const batchItemId = '88888888-8888-4888-8888-888888888888';
const attemptId = '99999999-9999-4999-8999-999999999999';
const manifestHash = 'a'.repeat(64);
const itemHash = 'b'.repeat(64);

const media = [
  {
    type: 'image' as const,
    url: 'https://images.xhs.justlikekatie.com/post.png',
  },
  {
    type: 'image' as const,
    url: 'https://images.xhs.justlikekatie.com/post-2.png',
  },
].map((item) => ({ ...item, identity: rednoteMediaIdentity(item) }));

const snapshot = {
  expectedAccountId: 'creator-account-1',
  notionPageId: '66666666-6666-4666-8666-666666666666',
  headline: 'Headline',
  title: 'Title',
  caption: 'Caption',
  tags: ['Tag'],
  platform: 'RedNote',
  mediaType: 'image',
  mediaIndex: 0,
  mediaUrl: media[0].url,
  media,
  publishAt: '2026-08-05T15:00:00.000Z',
  notionLastEditedTime: '2026-08-05T12:00:00.000Z',
};

async function insertJob(input: {
  id: string;
  status: string;
  dueOffset: string;
  successAttestationId?: string;
  claimed?: boolean;
  noteId?: string;
  shareUrl?: string;
  batchItemId?: string;
}) {
  await database.query(
    `INSERT INTO local_publish_jobs (
       id, notion_page_id, snapshot, status, idempotency_key, claim_token,
       claimed_at, claim_expires_at, next_verification_at, note_id, share_url,
       success_attestation_id, batch_item_id, created_at, updated_at
     ) VALUES (
       $1::uuid, $2, $3::jsonb, $4, gen_random_uuid(), $5::uuid,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE CURRENT_TIMESTAMP + INTERVAL '1 hour' END,
       CURRENT_TIMESTAMP + $6::interval, $7, $8, $9::uuid, $10::uuid,
       CURRENT_TIMESTAMP + $6::interval, CURRENT_TIMESTAMP
     )`,
    [
      input.id,
      snapshot.notionPageId,
      JSON.stringify(snapshot),
      input.status,
      input.claimed ? claimToken : null,
      input.dueOffset,
      input.noteId ?? null,
      input.shareUrl ?? null,
      input.successAttestationId ?? null,
      input.batchItemId ?? null,
    ],
  );
  if (input.successAttestationId) {
    await database.query(
      `INSERT INTO local_publish_job_success_attestations (id, provenance)
       VALUES ($1::uuid, 'worker_ambiguous')
       ON CONFLICT (id) DO NOTHING`,
      [input.successAttestationId],
    );
  }
}

async function insertAttestedBatchAuthorization(input: {
  state?: string;
  storedManifestHash?: string;
}) {
  await database.query(
    `INSERT INTO rednote_publish_batches (
       id, manifest_hash, approved_at
     ) VALUES ($1::uuid, $2, CURRENT_TIMESTAMP)`,
    [batchId, input.storedManifestHash ?? manifestHash],
  );
  await database.query(
    `INSERT INTO rednote_publish_batch_items (
       id, batch_id, notion_page_id, snapshot, item_hash, state, dispatch_mode,
       local_publish_job_id
     ) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, 'scheduled', NULL)`,
    [
      batchItemId,
      batchId,
      snapshot.notionPageId,
      JSON.stringify(snapshot),
      itemHash,
      input.state ?? 'operator_attested',
    ],
  );
}

async function insertExpiredWorkerAttempt(input: {
  authorized?: boolean;
  batchState?: string;
}) {
  await insertAttestedBatchAuthorization({
    state: input.batchState ?? 'staged',
  });
  await insertJob({
    id: scheduledJobId,
    status: 'staged',
    dueOffset: '-1 day',
    claimed: true,
    batchItemId,
  });
  await database.query(
    `UPDATE local_publish_jobs
     SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
     WHERE id = $1::uuid`,
    [scheduledJobId],
  );
  await database.query(
    `UPDATE rednote_publish_batch_items
     SET local_publish_job_id = $1::uuid
     WHERE id = $2::uuid`,
    [scheduledJobId, batchItemId],
  );
  await database.query(
    `INSERT INTO rednote_publish_attempts(
       id, workspace_id, source_local_publish_job_id, executor_type,
       executor_id, active, approved_at, dispatch_authorized_at,
       claim_token, claim_expires_at, target_publish_at, frozen_payload
     ) VALUES (
       $1::uuid, 'legacy-local-publish', $2::uuid, 'worker',
       'worker-test', true, CURRENT_TIMESTAMP,
       CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP - INTERVAL '2 minutes'
         ELSE NULL END,
       $3::uuid, CURRENT_TIMESTAMP - INTERVAL '1 minute',
       ($5::jsonb->'browserPayload'->>'targetPublishAt')::timestamptz,
       $5::jsonb
     )`,
    [
      attemptId,
      scheduledJobId,
      claimToken,
      input.authorized ?? true,
      JSON.stringify({
        browserPayload: {
          timingMode: 'scheduled',
          targetPublishAt: snapshot.publishAt,
          expectedAccountId: snapshot.expectedAccountId,
        },
      }),
    ],
  );
}

function successAttestation(overrides: Record<string, unknown> = {}) {
  const requestedPublishAt = snapshot.publishAt;
  return {
    id: attestationId,
    notionPageId: snapshot.notionPageId,
    contractRevision: 'operator-success-attestation/v1',
    provenance: 'worker_ambiguous',
    batchId,
    manifestHash,
    itemId: batchItemId,
    jobId: attestedJobId,
    itemHash,
    snapshotRevision: snapshot.notionLastEditedTime,
    snapshotDigest: itemHash,
    priorClaimTokenDigest: 'c'.repeat(64),
    releaseRequired: true,
    localReleaseIdentity: {
      jobId: attestedJobId,
      notionPageId: snapshot.notionPageId,
      priorClaimTokenDigest: 'c'.repeat(64),
      batchId,
      manifestHash,
      itemHash,
      snapshotRevision: snapshot.notionLastEditedTime,
      requestedPublishAt,
      publishMode: 'scheduled',
    },
    requestedPublishAt,
    expectedOutcome: {
      kind: 'scheduled',
      publishAt: requestedPublishAt,
      timeZone: 'America/New_York',
      text: 'Successfully scheduled for August 5, 2026 at 11:00 AM ET',
    },
    attestedBy: 'operator@example.com',
    attestedAt: '2026-08-05T15:30:00.000Z',
    ...overrides,
  };
}

async function claimState() {
  return database.query<{
    id: string;
    claim_attempts: number;
    claim_token: string | null;
  }>(
    `SELECT id, claim_attempts, claim_token
     FROM local_publish_jobs
     ORDER BY id`,
  );
}

describe('local publish job PostgreSQL execution', () => {
  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE local_publish_jobs (
        id uuid PRIMARY KEY,
        workspace_id text NOT NULL DEFAULT 'legacy-local-publish',
        notion_page_id text NOT NULL,
        snapshot jsonb NOT NULL,
        status text NOT NULL,
        idempotency_key uuid NOT NULL UNIQUE,
        claim_token uuid,
        claim_attempts integer NOT NULL DEFAULT 0,
        claimed_at timestamptz,
        claim_expires_at timestamptz,
        verification_attempts integer NOT NULL DEFAULT 0,
        next_verification_at timestamptz,
        staged_at timestamptz,
        dispatched_at timestamptz,
        verified_at timestamptz,
        reconciled_at timestamptz,
        error_code text,
        error_message text,
        note_id text,
        share_url text,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at timestamptz,
        batch_item_id uuid,
        dispatch_authorized_at timestamptz,
        success_attestation_id uuid,
        external_disposition_request_id uuid,
        receipt_contract_version text,
        receipt_outcome text,
        receipt_acknowledged_at timestamptz,
        authenticated_account_id text,
        authenticated_account_at timestamptz,
        xsec_accessible_at timestamptz,
        public_index_status text,
        public_index_checked_at timestamptz,
        provider_restriction_status text,
        provider_restriction_reported_at timestamptz
      );
      CREATE TABLE rednote_publish_batches (
         id uuid PRIMARY KEY,
         manifest_hash text NOT NULL,
         approved_at timestamptz
      );
      CREATE TABLE rednote_publish_batch_items (
         id uuid PRIMARY KEY,
         batch_id uuid NOT NULL REFERENCES rednote_publish_batches(id),
         notion_page_id text NOT NULL,
         snapshot jsonb NOT NULL,
         item_hash text NOT NULL,
         state text NOT NULL,
         dispatch_mode text NOT NULL,
         local_publish_job_id uuid,
         updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE manual_reconciliation_requests (
        workspace_id text NOT NULL DEFAULT 'legacy-local-publish',
        request_kind text NOT NULL,
        source_local_job_id uuid
      );
      CREATE TABLE plan_operator_scheduled_posts (
        workspace_id text NOT NULL DEFAULT 'legacy-local-publish',
        notion_page_id text NOT NULL,
        PRIMARY KEY (workspace_id, notion_page_id),
        reconciled_at timestamptz
      );
      CREATE TABLE local_publish_job_success_attestations (
        id uuid PRIMARY KEY,
        provenance text NOT NULL
      );
      CREATE TABLE local_publish_job_success_attestation_release_acks (
        success_attestation_id uuid PRIMARY KEY
      );
      CREATE TABLE rednote_publish_attempts (
        id uuid PRIMARY KEY,
        workspace_id text NOT NULL DEFAULT 'legacy-local-publish',
        source_local_publish_job_id uuid,
        executor_type text,
        executor_id text NOT NULL DEFAULT 'worker-test',
        active boolean NOT NULL DEFAULT false,
        approved_at timestamptz,
        terminal_outcome text,
        terminal_at timestamptz,
        receipt_lookup_state text NOT NULL DEFAULT 'pending',
        receipt_lookup_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        dispatch_authorized_at timestamptz,
        superseded_by_attempt_id uuid,
        claim_token uuid,
        claim_expires_at timestamptz,
        target_publish_at timestamptz,
        authorization_kind text,
        frozen_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE rednote_publish_attempt_receipts (
        attempt_id uuid PRIMARY KEY REFERENCES rednote_publish_attempts(id),
        rednote_url text,
        rednote_note_id text NOT NULL,
        platform_publish_time timestamptz NOT NULL,
        provenance jsonb NOT NULL
      );
      CREATE TABLE rednote_publish_attempt_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        attempt_id uuid NOT NULL REFERENCES rednote_publish_attempts(id),
        event_type text NOT NULL,
        occurred_at timestamptz NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE rednote_publication_evidence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id text NOT NULL,
        local_publish_job_id uuid NOT NULL,
        attempt_id uuid,
        note_id text,
        evidence_kind text NOT NULL,
        captured_at timestamptz NOT NULL,
        account_id text,
        evidence_status text NOT NULL,
        public_url text,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE FUNCTION guard_test_terminal_refinement()
      RETURNS trigger AS $$
      DECLARE
        allowed boolean;
      BEGIN
        allowed :=
          OLD.terminal_outcome = 'outcome_unknown'
          AND NEW.terminal_outcome IN ('accepted', 'known_failed')
          AND NOT OLD.active
          AND NOT NEW.active
          AND OLD.claim_token IS NOT NULL
          AND NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token
          AND OLD.claim_expires_at <= CURRENT_TIMESTAMP
          AND NEW.terminal_at IS NOT DISTINCT FROM OLD.terminal_at
          AND OLD.receipt_lookup_state = 'identity_pending'
          AND (
            (NEW.terminal_outcome = 'accepted'
             AND OLD.dispatch_authorized_at IS NOT NULL
             AND OLD.target_publish_at IS NOT NULL
             AND NEW.receipt_lookup_state IN ('identity_pending', 'found'))
            OR
            (NEW.terminal_outcome = 'known_failed'
             AND NEW.receipt_lookup_state = 'not_required')
          )
          AND EXISTS (
            SELECT 1 FROM local_publish_jobs AS job
            WHERE job.id = OLD.source_local_publish_job_id
              AND job.status = 'verification_pending'
              AND job.claim_token IS NULL
              AND job.claim_expires_at <= CURRENT_TIMESTAMP
              AND job.receipt_outcome IS NULL
          );
        IF OLD.terminal_outcome IS NOT NULL
           AND (
             NEW.terminal_outcome IS DISTINCT FROM OLD.terminal_outcome
             OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at
           )
           AND NOT allowed THEN
          RAISE EXCEPTION
            'rednote publish attempt terminal outcome is immutable once set';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER rednote_publish_attempts_guard_test_terminal
      BEFORE UPDATE ON rednote_publish_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_test_terminal_refinement();
    `);
  });

  beforeEach(async () => {
    mocks.loadAttestation.mockReset();
    mocks.acknowledgeRelease.mockReset();
    await database.exec(`
      TRUNCATE local_publish_jobs CASCADE;
      TRUNCATE manual_reconciliation_requests;
      TRUNCATE plan_operator_scheduled_posts;
      TRUNCATE local_publish_job_success_attestations;
      TRUNCATE local_publish_job_success_attestation_release_acks;
      TRUNCATE rednote_publish_batch_items;
      TRUNCATE rednote_publish_batches CASCADE;
      TRUNCATE rednote_publish_attempts CASCADE;
      TRUNCATE rednote_publication_evidence;
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it('claims an exact unacknowledged attested release ahead of older verification work', async () => {
    await insertAttestedBatchAuthorization({});
    await insertJob({
      id: scheduledJobId,
      status: 'scheduled',
      dueOffset: '-2 days',
      noteId: 'note_older',
      shareUrl: 'https://www.rednote.com/explore/note_older',
    });

    await insertJob({
      id: attestedJobId,
      status: 'operator_attested',
      dueOffset: '-1 day',
      successAttestationId: attestationId,
      batchItemId,
    });
    await database.query(
      `UPDATE rednote_publish_batch_items
       SET local_publish_job_id = $1::uuid
       WHERE id = $2::uuid`,
      [attestedJobId, batchItemId],
    );
    mocks.loadAttestation.mockResolvedValue(successAttestation());

    const claimed = await claimNextStoredLocalPublishJob(
      7_200,
      'verification',
      attestedJobId,
    );

    expect(JSON.parse(JSON.stringify(claimed))).toStrictEqual({
      id: attestedJobId,
      status: 'operator_attested',
      notionPageId: snapshot.notionPageId,
      headline: snapshot.headline,
      title: snapshot.title,
      caption: snapshot.caption,
      tags: snapshot.tags,
      platform: snapshot.platform,
      mediaType: snapshot.mediaType,
      mediaIndex: snapshot.mediaIndex,
      mediaUrl: snapshot.mediaUrl,
      media,
      expectedAccountId: snapshot.expectedAccountId,
      publishAt: snapshot.publishAt,
      notionLastEditedTime: snapshot.notionLastEditedTime,
      claimToken: expect.any(String),
      claimExpiresAt: expect.any(String),
      verificationAttempts: 0,
      nextVerificationAt: expect.any(String),
      batchAuthorization: {
        batchId,
        manifestHash,
        itemHash,
        snapshotRevision: snapshot.notionLastEditedTime,
        approvedState: 'approved',
        approvedAt: expect.any(String),
        media,
        publishAt: snapshot.publishAt,
        lateAction: 'schedule',
      },
      successAttestation: successAttestation(),
    });
    if (!claimed || claimed.status !== 'operator_attested') {
      throw new Error('Expected an operator-attested claim');
    }
    expect(claimed.batchAuthorization).toMatchObject({
      batchId: claimed.successAttestation.batchId,
      manifestHash: claimed.successAttestation.manifestHash,
      itemHash: claimed.successAttestation.itemHash,
      snapshotRevision: claimed.successAttestation.snapshotRevision,
      publishAt: claimed.successAttestation.requestedPublishAt,
      lateAction: 'schedule',
    });
    expect((await claimState()).rows).toEqual([
      { id: scheduledJobId, claim_attempts: 0, claim_token: null },
      expect.objectContaining({ id: attestedJobId, claim_attempts: 1 }),
    ]);
  });

  it('terminalizes an expired claim and its linked batch item in one statement', async () => {
    await insertAttestedBatchAuthorization({ state: 'claimed' });
    await insertJob({
      id: scheduledJobId,
      status: 'claimed',
      dueOffset: '-1 day',
      claimed: true,
      batchItemId,
    });
    await database.query(
      `UPDATE local_publish_jobs
       SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
       WHERE id = $1::uuid`,
      [scheduledJobId],
    );
    await database.query(
      `UPDATE rednote_publish_batch_items
       SET local_publish_job_id = $1::uuid
       WHERE id = $2::uuid`,
      [scheduledJobId, batchItemId],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, source_local_publish_job_id, executor_type,
         active, approved_at, claim_token, claim_expires_at
       ) VALUES (
         $1::uuid, 'legacy-local-publish', $2::uuid, 'worker',
         true, CURRENT_TIMESTAMP, $3::uuid, CURRENT_TIMESTAMP - INTERVAL '1 minute'
       )`,
      [attemptId, scheduledJobId, claimToken],
    );

    await expect(releaseExpiredStoredLocalPublishClaims())
      .resolves.toEqual([scheduledJobId]);

    await expect(database.query<{
      status: string;
      claim_token: string | null;
      error_code: string;
    }>(
      `SELECT status, claim_token, error_code
       FROM local_publish_jobs
       WHERE id = $1::uuid`,
      [scheduledJobId],
    )).resolves.toMatchObject({
      rows: [{
        status: 'failed',
        claim_token: null,
        error_code: 'CLAIM_LEASE_EXPIRED',
      }],
    });
    await expect(database.query<{ state: string }>(
      `SELECT state
       FROM rednote_publish_batch_items
       WHERE id = $1::uuid`,
      [batchItemId],
    )).resolves.toMatchObject({ rows: [{ state: 'failed' }] });
    await expect(database.query<{
      active: boolean;
      terminal_outcome: string;
      receipt_lookup_state: string;
    }>(
      `SELECT active, terminal_outcome, receipt_lookup_state
       FROM rednote_publish_attempts
       WHERE id = $1::uuid`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        active: false,
        terminal_outcome: 'known_failed',
        receipt_lookup_state: 'not_required',
      }],
    });
  });

  it('recovers a split-write authorized stage as verify-only and never redispatches it', async () => {
    await insertAttestedBatchAuthorization({ state: 'staged' });
    await insertJob({
      id: scheduledJobId,
      status: 'staged',
      dueOffset: '-1 day',
      claimed: true,
      batchItemId,
    });
    await database.query(
      `UPDATE local_publish_jobs
       SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
       WHERE id = $1::uuid`,
      [scheduledJobId],
    );
    await database.query(
      `UPDATE rednote_publish_batch_items
       SET local_publish_job_id = $1::uuid
       WHERE id = $2::uuid`,
      [scheduledJobId, batchItemId],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, source_local_publish_job_id, executor_type,
         active, approved_at, dispatch_authorized_at, claim_token, claim_expires_at
       ) VALUES (
         $1::uuid, 'legacy-local-publish', $2::uuid, 'worker',
         true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '2 minutes',
         $3::uuid, CURRENT_TIMESTAMP - INTERVAL '1 minute'
       )`,
      [attemptId, scheduledJobId, claimToken],
    );

    await expect(releaseExpiredStoredLocalPublishClaims())
      .resolves.toEqual([scheduledJobId]);

    await expect(database.query<{
      status: string;
      claim_token: string | null;
      error_code: string;
    }>(
      `SELECT status, claim_token, error_code
       FROM local_publish_jobs
       WHERE id = $1::uuid`,
      [scheduledJobId],
    )).resolves.toMatchObject({
      rows: [{
        status: 'verification_pending',
        claim_token: null,
        error_code: 'PUBLISH_ATTEMPT_OUTCOME_UNKNOWN',
      }],
    });
    await expect(database.query<{ state: string }>(
      `SELECT state
       FROM rednote_publish_batch_items
       WHERE id = $1::uuid`,
      [batchItemId],
    )).resolves.toMatchObject({ rows: [{ state: 'verification_pending' }] });
    await expect(database.query<{
      active: boolean;
      terminal_outcome: string;
      receipt_lookup_state: string;
    }>(
      `SELECT active, terminal_outcome, receipt_lookup_state
       FROM rednote_publish_attempts
       WHERE id = $1::uuid`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        active: false,
        terminal_outcome: 'outcome_unknown',
        receipt_lookup_state: 'identity_pending',
      }],
    });
    await expect(claimNextStoredLocalPublishJob(7_200, 'dispatch'))
      .resolves.toBeNull();
  });

  it('accepts and idempotently replays an exact late scheduled receipt without redispatch', async () => {
    await insertExpiredWorkerAttempt({});
    await releaseExpiredStoredLocalPublishClaims();
    const result = {
      contractVersion: 'rednote-worker-result/v2' as const,
      outcome: 'scheduled' as const,
      acknowledgedAt: '2026-08-05T12:30:00.000Z',
      scheduledFor: snapshot.publishAt,
      authenticatedAccount: {
        accountId: snapshot.expectedAccountId,
        capturedAt: '2026-08-05T12:29:59.000Z',
        ownership: 'owned' as const,
      },
      noteId: 'scheduled_note_123',
    };

    await expect(recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      claimToken,
      result,
    )).resolves.toMatchObject({
      status: 'scheduled',
      receiptOutcome: 'scheduled',
      noteId: 'scheduled_note_123',
    });
    await expect(recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      claimToken,
      result,
    )).resolves.toMatchObject({ status: 'scheduled' });

    await expect(database.query<{
      terminal_outcome: string;
      receipt_lookup_state: string;
    }>(
      `SELECT terminal_outcome, receipt_lookup_state
       FROM rednote_publish_attempts WHERE id = $1::uuid`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        terminal_outcome: 'accepted',
        receipt_lookup_state: 'found',
      }],
    });
    await expect(database.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM rednote_publish_attempt_events
       WHERE attempt_id = $1::uuid
         AND diagnostics->>'kind' = 'late_terminal_result_accepted'`,
      [attemptId],
    )).resolves.toMatchObject({ rows: [{ count: '1' }] });
    await expect(database.query<{ state: string }>(
      `SELECT state FROM rednote_publish_batch_items WHERE id = $1::uuid`,
      [batchItemId],
    )).resolves.toMatchObject({ rows: [{ state: 'scheduled' }] });
    await expect(database.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM rednote_publication_evidence
       WHERE local_publish_job_id = $1::uuid`,
      [scheduledJobId],
    )).resolves.toMatchObject({ rows: [{ count: '1' }] });
    await expect(claimNextStoredLocalPublishJob(7_200, 'dispatch'))
      .resolves.toBeNull();
  });

  it('accepts a late definitive rejection only without dispatch evidence', async () => {
    await insertExpiredWorkerAttempt({});
    await releaseExpiredStoredLocalPublishClaims();

    await expect(recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      claimToken,
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: 'rejected',
        occurredAt: '2026-08-05T12:30:00.000Z',
        code: 'SCHEDULE_CONTROL_REJECTED',
        message: 'Creator rejected the native schedule before Publish',
      },
    )).resolves.toMatchObject({
      status: 'failed',
      receiptOutcome: 'rejected',
      errorCode: 'SCHEDULE_CONTROL_REJECTED',
    });
    await expect(database.query<{
      terminal_outcome: string;
      receipt_lookup_state: string;
    }>(
      `SELECT terminal_outcome, receipt_lookup_state
       FROM rednote_publish_attempts WHERE id = $1::uuid`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{
        terminal_outcome: 'known_failed',
        receipt_lookup_state: 'not_required',
      }],
    });
    await expect(database.query<{ state: string }>(
      `SELECT state FROM rednote_publish_batch_items WHERE id = $1::uuid`,
      [batchItemId],
    )).resolves.toMatchObject({ rows: [{ state: 'failed' }] });
  });

  it('keeps a late ambiguous result verify-only after expiry outcome_unknown', async () => {
    await insertExpiredWorkerAttempt({});
    await releaseExpiredStoredLocalPublishClaims();

    await expect(recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      claimToken,
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: 'ambiguous',
        occurredAt: '2026-08-05T12:30:00.000Z',
        code: 'POST_CLICK_TIMEOUT',
        message: 'Creator did not return a definitive submission result',
      },
    )).resolves.toMatchObject({
      status: 'verification_pending',
      receiptOutcome: 'ambiguous',
      errorCode: 'POST_CLICK_TIMEOUT',
    });
    await expect(database.query<{
      terminal_outcome: string;
      active: boolean;
    }>(
      `SELECT terminal_outcome, active
       FROM rednote_publish_attempts WHERE id = $1::uuid`,
      [attemptId],
    )).resolves.toMatchObject({
      rows: [{ terminal_outcome: 'outcome_unknown', active: false }],
    });
    await expect(claimNextStoredLocalPublishJob(7_200, 'dispatch'))
      .resolves.toBeNull();
  });

  it('rejects fresh tokens and conflicting terminal replays', async () => {
    await insertExpiredWorkerAttempt({});
    await releaseExpiredStoredLocalPublishClaims();
    const scheduled = {
      contractVersion: 'rednote-worker-result/v2' as const,
      outcome: 'scheduled' as const,
      acknowledgedAt: '2026-08-05T12:30:00.000Z',
      scheduledFor: snapshot.publishAt,
      authenticatedAccount: {
        accountId: snapshot.expectedAccountId,
        capturedAt: '2026-08-05T12:29:59.000Z',
        ownership: 'owned' as const,
      },
    };

    await expect(recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      scheduled,
    )).rejects.toMatchObject({ code: 'STALE_CLAIM' });
    await recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      claimToken,
      scheduled,
    );
    await expect(recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      claimToken,
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: 'ambiguous',
        occurredAt: '2026-08-05T12:31:00.000Z',
        code: 'POST_CLICK_TIMEOUT',
        message: 'Conflicting terminal result',
      },
    )).rejects.toMatchObject({ code: 'LATE_RESULT_CONFLICT' });
  });

  it('rejects a digestless replay with conflicting account ownership', async () => {
    await insertExpiredWorkerAttempt({});
    await releaseExpiredStoredLocalPublishClaims();
    const scheduled = {
      contractVersion: 'rednote-worker-result/v2' as const,
      outcome: 'scheduled' as const,
      acknowledgedAt: '2026-08-05T12:30:00.000Z',
      scheduledFor: snapshot.publishAt,
      authenticatedAccount: {
        accountId: snapshot.expectedAccountId,
        capturedAt: '2026-08-05T12:29:59.000Z',
        ownership: 'owned' as const,
      },
    };
    await recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      claimToken,
      scheduled,
    );
    await database.query(
      `DELETE FROM rednote_publish_attempt_events
       WHERE attempt_id = $1::uuid
         AND diagnostics->>'kind' = 'late_terminal_result_accepted'`,
      [attemptId],
    );

    await expect(recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      claimToken,
      {
        ...scheduled,
        authenticatedAccount: {
          ...scheduled.authenticatedAccount,
          ownership: 'account_mismatch',
        },
      },
    )).rejects.toMatchObject({ code: 'LATE_RESULT_CONFLICT' });
  });

  it('rejects a late pre-click failure when durable dispatch evidence exists', async () => {
    await insertExpiredWorkerAttempt({});
    await releaseExpiredStoredLocalPublishClaims();
    await database.query(
      `UPDATE local_publish_jobs
       SET dispatched_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid`,
      [scheduledJobId],
    );

    await expect(recordLateStoredWorkerTerminalResult(
      scheduledJobId,
      claimToken,
      {
        contractVersion: 'rednote-worker-result/v2',
        outcome: 'rejected',
        occurredAt: '2026-08-05T12:30:00.000Z',
        code: 'PRE_CLICK_REJECTED',
        message: 'Conflicting rejection',
      },
    )).rejects.toMatchObject({ code: 'LATE_RESULT_CONFLICT' });
  });

  it('rejects a targeted attested release with missing authorization without fallback', async () => {
    await insertJob({
      id: scheduledJobId,
      status: 'scheduled',
      dueOffset: '-2 days',
      noteId: 'note_older',
      shareUrl: 'https://www.rednote.com/explore/note_older',
    });
    await insertJob({
      id: attestedJobId,
      status: 'operator_attested',
      dueOffset: '-1 day',
      successAttestationId: attestationId,
      batchItemId,
    });
    mocks.loadAttestation.mockResolvedValue(successAttestation());

    await expect(claimNextStoredLocalPublishJob(
      7_200,
      'verification',
      attestedJobId,
    )).rejects.toMatchObject({
      code: 'INVALID_BATCH_AUTHORIZATION',
      status: 409,
    });
    expect((await claimState()).rows).toEqual([
      { id: scheduledJobId, claim_attempts: 0, claim_token: null },
      expect.objectContaining({ id: attestedJobId, claim_attempts: 1 }),
    ]);
    expect(mocks.loadAttestation).not.toHaveBeenCalled();
  });

  it('rejects mismatched attestation authorization without fallback', async () => {
    await insertAttestedBatchAuthorization({});
    await insertJob({
      id: scheduledJobId,
      status: 'scheduled',
      dueOffset: '-2 days',
      noteId: 'note_older',
      shareUrl: 'https://www.rednote.com/explore/note_older',
    });
    await insertJob({
      id: attestedJobId,
      status: 'operator_attested',
      dueOffset: '-1 day',
      successAttestationId: attestationId,
      batchItemId,
    });
    mocks.loadAttestation.mockResolvedValue(successAttestation({
      manifestHash: 'd'.repeat(64),
    }));

    await expect(claimNextStoredLocalPublishJob(
      7_200,
      'verification',
      attestedJobId,
    )).rejects.toMatchObject({
      code: 'INVALID_OPERATOR_ATTESTED_JOB',
      status: 500,
    });
    expect((await claimState()).rows).toEqual([
      { id: scheduledJobId, claim_attempts: 0, claim_token: null },
      expect.objectContaining({ id: attestedJobId, claim_attempts: 1 }),
    ]);
  });

  it('rejects an attested claim whose batch item is not operator-attested', async () => {
    await insertAttestedBatchAuthorization({ state: 'scheduled' });
    await insertJob({
      id: scheduledJobId,
      status: 'scheduled',
      dueOffset: '-2 days',
      noteId: 'note_older',
      shareUrl: 'https://www.rednote.com/explore/note_older',
    });
    await insertJob({
      id: attestedJobId,
      status: 'operator_attested',
      dueOffset: '-1 day',
      successAttestationId: attestationId,
      batchItemId,
    });
    mocks.loadAttestation.mockResolvedValue(successAttestation());

    await expect(claimNextStoredLocalPublishJob(
      7_200,
      'verification',
      attestedJobId,
    )).rejects.toMatchObject({
      code: 'INVALID_BATCH_AUTHORIZATION',
      status: 409,
    });
    expect((await claimState()).rows).toEqual([
      { id: scheduledJobId, claim_attempts: 0, claim_token: null },
      expect.objectContaining({ id: attestedJobId, claim_attempts: 1 }),
    ]);
    expect(mocks.loadAttestation).not.toHaveBeenCalled();
  });

  it('retains oldest-due ordering for an untargeted verification claim', async () => {
    await insertJob({
      id: scheduledJobId,
      status: 'scheduled',
      dueOffset: '-2 days',
      noteId: 'note_older',
      shareUrl: 'https://www.rednote.com/explore/note_older',
    });
    await insertJob({
      id: attestedJobId,
      status: 'operator_attested',
      dueOffset: '-1 day',
      successAttestationId: attestationId,
    });

    const claimed = await claimNextStoredLocalPublishJob(7_200, 'verification');

    expect(claimed).toMatchObject({ id: scheduledJobId, status: 'scheduled' });
    expect((await claimState()).rows).toEqual([
      expect.objectContaining({ id: scheduledJobId, claim_attempts: 1 }),
      { id: attestedJobId, claim_attempts: 0, claim_token: null },
    ]);
  });

  it('does not mutate any row when the expected job is absent', async () => {
    await insertJob({
      id: scheduledJobId,
      status: 'scheduled',
      dueOffset: '-2 days',
      noteId: 'note_older',
      shareUrl: 'https://www.rednote.com/explore/note_older',
    });
    const before = (await claimState()).rows;

    await expect(claimNextStoredLocalPublishJob(
      7_200,
      'verification',
      attestedJobId,
    )).resolves.toBeNull();

    expect((await claimState()).rows).toEqual(before);
  });

  it('does not fall back or mutate when the expected job is ineligible', async () => {
    await insertJob({
      id: scheduledJobId,
      status: 'scheduled',
      dueOffset: '-2 days',
      noteId: 'note_older',
      shareUrl: 'https://www.rednote.com/explore/note_older',
    });
    await insertJob({
      id: ineligibleJobId,
      status: 'queued',
      dueOffset: '-1 day',
    });
    const before = (await claimState()).rows;

    await expect(claimNextStoredLocalPublishJob(
      7_200,
      'verification',
      ineligibleJobId,
    )).resolves.toBeNull();

    expect((await claimState()).rows).toEqual(before);
  });

  it('does not target ordinary verification work even when it is due', async () => {
    await insertJob({
      id: scheduledJobId,
      status: 'scheduled',
      dueOffset: '-2 days',
      noteId: 'note_older',
      shareUrl: 'https://www.rednote.com/explore/note_older',
    });
    const before = (await claimState()).rows;

    await expect(claimNextStoredLocalPublishJob(
      7_200,
      'verification',
      scheduledJobId,
    )).resolves.toBeNull();

    expect((await claimState()).rows).toEqual(before);
  });

  it('does not target an operator-attested job whose release is acknowledged', async () => {
    await insertJob({
      id: attestedJobId,
      status: 'operator_attested',
      dueOffset: '-1 day',
      successAttestationId: attestationId,
    });
    await database.query(
      `INSERT INTO local_publish_job_success_attestation_release_acks
       (success_attestation_id) VALUES ($1::uuid)`,
      [attestationId],
    );
    const before = (await claimState()).rows;

    await expect(claimNextStoredLocalPublishJob(
      7_200,
      'verification',
      attestedJobId,
    )).resolves.toBeNull();

    expect((await claimState()).rows).toEqual(before);
  });

  it('hydrates release acknowledgement for listed operator-attested jobs', async () => {
    await insertJob({
      id: attestedJobId,
      status: 'operator_attested',
      dueOffset: '-1 day',
      successAttestationId: attestationId,
    });
    mocks.loadAttestation.mockResolvedValue(successAttestation({
      releaseRequired: false,
    }));

    await expect(listLocalPublishJobs()).resolves.toEqual([
      expect.objectContaining({
        id: attestedJobId,
        status: 'operator_attested',
        successAttestation: expect.objectContaining({
          id: attestationId,
          releaseRequired: false,
        }),
      }),
    ]);
    expect(mocks.loadAttestation).toHaveBeenCalledWith(attestationId);
  });

  it('executes the cast post-dispatch verification backoff update', async () => {
    await insertJob({
      id: scheduledJobId,
      status: 'scheduled',
      dueOffset: '-1 day',
      claimed: true,
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
    });

    const result = await deferStoredLocalPublishVerification(
      scheduledJobId,
      claimToken,
      'note_123',
      'https://www.rednote.com/explore/note_123',
      'PUBLIC_NOTE_NOT_FOUND',
      'The public note is not ready',
      [900, 3_600, 21_600, 86_400],
    );

    expect(result).toMatchObject({
      status: 'verification_pending',
      verificationAttempts: 1,
      errorCode: 'PUBLIC_NOTE_NOT_FOUND',
    });
    expect(new Date(result.nextVerificationAt!).getTime()).toBeGreaterThan(
      Date.now() + 3_500_000,
    );
  });

  it('executes the cast operator-attested verification backoff update', async () => {
    await insertJob({
      id: attestedJobId,
      status: 'operator_attested',
      dueOffset: '-1 day',
      successAttestationId: attestationId,
      claimed: true,
    });
    await database.query(
      `INSERT INTO local_publish_job_success_attestation_release_acks
       (success_attestation_id) VALUES ($1::uuid)`,
      [attestationId],
    );

    const result = await deferStoredOperatorAttestedVerification(
      attestedJobId,
      claimToken,
      'PUBLIC_NOTE_NOT_FOUND',
      'The public note is not ready',
      [900, 3_600, 21_600, 86_400],
    );

    expect(result).toMatchObject({
      status: 'operator_attested',
      verificationAttempts: 1,
      errorCode: 'PUBLIC_NOTE_NOT_FOUND',
    });
    expect(new Date(result.nextVerificationAt!).getTime()).toBeGreaterThan(
      Date.now() + 3_500_000,
    );
  });

  it('recovers an expired claim with a durable receipt into verification', async () => {
    await insertJob({
      id: scheduledJobId,
      status: 'staged',
      dueOffset: '-1 day',
      claimed: true,
    });
    await database.query(
      `UPDATE local_publish_jobs
       SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
       WHERE id = $1::uuid`,
      [scheduledJobId],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempts(
         id, workspace_id, source_local_publish_job_id, executor_type,
         terminal_outcome, receipt_lookup_state
       ) VALUES (
         $1::uuid, 'legacy-local-publish', $2::uuid, 'worker',
         'accepted', 'found'
       )`,
      [attemptId, scheduledJobId],
    );
    await database.query(
      `INSERT INTO rednote_publish_attempt_receipts(
         attempt_id, rednote_note_id, platform_publish_time, provenance
       ) VALUES (
         $1::uuid, 'note_receipt_recovery', CURRENT_TIMESTAMP, '{}'::jsonb
       )`,
      [attemptId],
    );

    await expect(releaseExpiredStoredLocalPublishClaims())
      .resolves.toEqual([scheduledJobId]);
    await expect(database.query<{
      status: string;
      claim_token: string | null;
      error_code: string;
    }>(
      `SELECT status, claim_token, error_code
       FROM local_publish_jobs
       WHERE id = $1::uuid`,
      [scheduledJobId],
    )).resolves.toMatchObject({
      rows: [{
        status: 'verification_pending',
        claim_token: null,
        error_code: 'RECEIPT_RECONCILIATION_REQUIRED',
      }],
    });
  });
});
