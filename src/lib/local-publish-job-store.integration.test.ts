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
} from '@/lib/local-publish-job-store';

const scheduledJobId = '11111111-1111-4111-8111-111111111111';
const attestedJobId = '22222222-2222-4222-8222-222222222222';
const ineligibleJobId = '33333333-3333-4333-8333-333333333333';
const attestationId = '44444444-4444-4444-8444-444444444444';
const claimToken = '55555555-5555-4555-8555-555555555555';

const snapshot = {
  notionPageId: '66666666-6666-4666-8666-666666666666',
  headline: 'Headline',
  title: 'Title',
  caption: 'Caption',
  tags: ['Tag'],
  platform: 'RedNote',
  mediaType: 'image',
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/post.png',
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
}) {
  await database.query(
    `INSERT INTO local_publish_jobs (
       id, notion_page_id, snapshot, status, idempotency_key, claim_token,
       claimed_at, claim_expires_at, next_verification_at, note_id, share_url,
       success_attestation_id, created_at, updated_at
     ) VALUES (
       $1::uuid, $2, $3::jsonb, $4, gen_random_uuid(), $5::uuid,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE CURRENT_TIMESTAMP + INTERVAL '1 hour' END,
       CURRENT_TIMESTAMP + $6::interval, $7, $8, $9::uuid,
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
    ],
  );
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
        external_disposition_request_id uuid
      );
      CREATE TABLE manual_reconciliation_requests (
        request_kind text NOT NULL,
        source_local_job_id uuid
      );
      CREATE TABLE local_publish_job_success_attestation_release_acks (
        success_attestation_id uuid PRIMARY KEY
      );
    `);
  });

  beforeEach(async () => {
    mocks.loadAttestation.mockReset();
    mocks.acknowledgeRelease.mockReset();
    await database.exec(`
      TRUNCATE local_publish_jobs;
      TRUNCATE manual_reconciliation_requests;
      TRUNCATE local_publish_job_success_attestation_release_acks;
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it('claims an exact unacknowledged attested release ahead of older verification work', async () => {
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
    mocks.loadAttestation.mockResolvedValue({
      id: attestationId,
      jobId: attestedJobId,
      releaseRequired: true,
      contractRevision: 'operator-success-attestation/v1',
    });

    const claimed = await claimNextStoredLocalPublishJob(
      7_200,
      'verification',
      attestedJobId,
    );

    expect(claimed).toMatchObject({
      id: attestedJobId,
      status: 'operator_attested',
      successAttestation: {
        jobId: attestedJobId,
        releaseRequired: true,
        contractRevision: 'operator-success-attestation/v1',
      },
    });
    expect((await claimState()).rows).toEqual([
      { id: scheduledJobId, claim_attempts: 0, claim_token: null },
      expect.objectContaining({ id: attestedJobId, claim_attempts: 1 }),
    ]);
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
});
