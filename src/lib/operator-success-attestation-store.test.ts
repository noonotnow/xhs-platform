import { beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestHash } from '@/lib/rednote-publish-batches';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({ connect: mocks.connect }),
  sql: mocks.sql,
}));

import {
  acknowledgeOperatorSuccessAttestationRelease,
  insertOperatorSuccessAttestation,
  expectedScheduledOutcome,
  listOperatorSuccessAttestationEvidence,
  type OperatorSuccessAttestationRow,
  validateExactOperatorSuccessAttestationReplay,
  validateOperatorSuccessCandidate,
} from '@/lib/operator-success-attestation-store';
import {
  claimTokenDigest,
  OPERATOR_SUCCESS_ATTESTATION_CONTRACT_REVISION,
} from '@/lib/operator-success-attestation-contract';

const snapshot = {
  notionPageId: '44444444-4444-4444-8444-444444444444',
  headline: 'Day 5',
  title: 'Day 5',
  caption: 'Frozen caption',
  tags: ['day5'],
  platform: 'RedNote' as const,
  mediaType: 'image' as const,
  mediaIndex: 0,
  mediaUrl: 'https://cdn.example/day5.png',
  publishAt: '2026-08-06T14:30:00.000Z',
  notionLastEditedTime: '2026-08-04T13:12:00.000Z',
};

const input = {
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  itemHash: manifestHash(snapshot),
  snapshotRevision: snapshot.notionLastEditedTime,
  requestedPublishAt: snapshot.publishAt,
};

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    job_id: input.jobId,
    notion_page_id: snapshot.notionPageId,
    job_snapshot: snapshot,
    job_status: 'staged',
    claim_token: '55555555-5555-4555-8555-555555555555',
    claim_expires_at: '2026-08-05T12:00:00.000Z',
    claim_expired: true,
    claim_attempts: 2,
    error_code: null,
    error_message: null,
    staged_at: '2026-08-05T12:00:00.000Z',
    dispatch_authorized_at: '2026-08-05T12:05:00.000Z',
    dispatched_at: null,
    note_id: null,
    share_url: null,
    verified_at: null,
    reconciled_at: null,
    completed_at: null,
    external_disposition_request_id: null,
    success_attestation_id: null,
    batch_id: input.batchId,
    batch_status: 'approved',
    manifest_hash: input.manifestHash,
    approved_at: '2026-08-04T15:00:00.000Z',
    item_id: input.itemId,
    item_notion_page_id: snapshot.notionPageId,
    item_snapshot: snapshot,
    item_hash: input.itemHash,
    item_state: 'staged',
    dispatch_mode: 'scheduled',
    item_local_publish_job_id: input.jobId,
    ...overrides,
  };
}

describe('operator success attestation store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_PUBLISH_WORKER_ATTESTATION_CONTRACT_REVISION =
      OPERATOR_SUCCESS_ATTESTATION_CONTRACT_REVISION;
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  });

  it('derives Day 5 expected outcome in Eastern Time', () => {
    expect(expectedScheduledOutcome('2026-08-06T14:30:00.000Z')).toEqual({
      kind: 'scheduled',
      publishAt: '2026-08-06T14:30:00.000Z',
      timeZone: 'America/New_York',
      text: 'Successfully scheduled for August 6, 2026 at 10:30 AM ET',
    });
  });

  it('uses the raw prior claim token bytes as the attempt identity', () => {
    expect(claimTokenDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('skips an invalid candidate without hiding valid admin actions', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.sql.mockResolvedValue({
      rows: [
        candidate({ job_snapshot: { ...snapshot, publishAt: undefined } }),
        candidate(),
      ],
    });

    const evidence = await listOperatorSuccessAttestationEvidence();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject(input);
    expect(warning).toHaveBeenCalledWith(
      'Ignoring invalid operator success attestation candidate',
      expect.objectContaining({ jobId: input.jobId, itemId: input.itemId }),
    );
    warning.mockRestore();
  });

  it('requires exact schedule and rejects definitive failures', () => {
    expect(() => validateOperatorSuccessCandidate(
      candidate(),
      { ...input, requestedPublishAt: '2026-08-06T15:30:00.000Z' },
    )).toThrow(/schedule changed/);
    expect(() => validateOperatorSuccessCandidate(candidate({
      job_status: 'failed',
      error_code: 'UPLOAD_REJECTED',
      completed_at: '2026-08-05T12:10:00.000Z',
    }), input)).toThrow(/ambiguous Creator/);
  });

  it('accepts exact receipt replay and rejects changed ownership', () => {
    const receipt: OperatorSuccessAttestationRow = {
      id: '66666666-6666-4666-8666-666666666666',
      idempotency_key: '77777777-7777-4777-8777-777777777777',
      local_publish_job_id: input.jobId,
      notion_page_id: snapshot.notionPageId,
      batch_id: input.batchId,
      batch_item_id: input.itemId,
      manifest_hash: input.manifestHash,
      item_hash: input.itemHash,
      snapshot_revision: input.snapshotRevision,
      snapshot_digest: input.itemHash,
      contract_revision: OPERATOR_SUCCESS_ATTESTATION_CONTRACT_REVISION,
      prior_claim_token_digest: claimTokenDigest(candidate().claim_token),
      expected_outcome: 'Successfully scheduled for August 6, 2026 at 10:30 AM ET',
      requested_publish_at: input.requestedPublishAt,
      attested_by: 'operator@example.com',
      attested_at: '2026-08-05T12:30:00.000Z',
    };
    expect(() => validateExactOperatorSuccessAttestationReplay(
      receipt,
      input,
      receipt.idempotency_key,
      receipt.attested_by,
    )).not.toThrow();
    expect(() => validateExactOperatorSuccessAttestationReplay(
      receipt,
      { ...input, itemHash: 'f'.repeat(64) },
      receipt.idempotency_key,
      receipt.attested_by,
    )).toThrow(/different attestation/);
  });

  it('atomically revokes the slot and quarantines job and batch item', async () => {
    const row = candidate();
    const receipt = {
      id: '66666666-6666-4666-8666-666666666666',
      idempotency_key: '77777777-7777-4777-8777-777777777777',
      local_publish_job_id: input.jobId,
      notion_page_id: snapshot.notionPageId,
      batch_id: input.batchId,
      batch_item_id: input.itemId,
      manifest_hash: input.manifestHash,
      item_hash: input.itemHash,
      snapshot_revision: input.snapshotRevision,
      snapshot_digest: input.itemHash,
      contract_revision: OPERATOR_SUCCESS_ATTESTATION_CONTRACT_REVISION,
      prior_claim_token_digest: claimTokenDigest(row.claim_token),
      expected_outcome: 'Successfully scheduled for August 6, 2026 at 10:30 AM ET',
      requested_publish_at: input.requestedPublishAt,
      attested_by: 'operator@example.com',
      attested_at: '2026-08-05T12:30:00.000Z',
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ conflict: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [receipt] })
      .mockResolvedValueOnce({ rows: [{ id: input.jobId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: input.itemId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const result = await insertOperatorSuccessAttestation(
      input,
      receipt.idempotency_key,
      receipt.attested_by,
    );
    expect(result.created).toBe(true);
    expect(result.attestation.itemId).not.toBe(result.attestation.jobId);
    expect(result.attestation.localReleaseIdentity).toEqual({
      jobId: input.jobId,
      notionPageId: snapshot.notionPageId,
      priorClaimTokenDigest: claimTokenDigest(row.claim_token),
      batchId: input.batchId,
      manifestHash: input.manifestHash,
      itemHash: input.itemHash,
      snapshotRevision: input.snapshotRevision,
      requestedPublishAt: input.requestedPublishAt,
      publishMode: 'scheduled',
    });
    const statements = mocks.query.mock.calls.map(([statement]) => statement);
    expect(statements.some((statement) =>
      statement.includes("status = 'operator_attested'") &&
      statement.includes('claim_token = NULL') &&
      statement.includes('next_verification_at = CURRENT_TIMESTAMP')
    )).toBe(true);
    expect(statements.filter((statement) =>
      statement.includes("state = 'operator_attested'")
    )).toHaveLength(1);
  });

  it('atomically acknowledges only the exact release claim and schedules receipt lookup', async () => {
    const verificationClaim = '88888888-8888-4888-8888-888888888888';
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          job_status: 'operator_attested',
          claim_token: verificationClaim,
          claim_expires_at: '2099-08-05T13:00:00.000Z',
          attestation_id: '66666666-6666-4666-8666-666666666666',
          requested_publish_at: input.requestedPublishAt,
          acknowledgement_claim_token_digest: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: input.jobId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    await expect(acknowledgeOperatorSuccessAttestationRelease(
      input.jobId,
      verificationClaim,
    )).resolves.toEqual({ replayed: false });
    const statements = mocks.query.mock.calls.map(([statement]) => statement);
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'local_publish_job_success_attestation_release_acks',
      ),
      expect.stringContaining(
        "$1::timestamptz + INTERVAL '15 minutes'",
      ),
    ]));
  });
});
