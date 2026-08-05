import { beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestHash } from '@/lib/rednote-publish-batches';
import {
  MANUAL_SCHEDULING_ATTESTATION_CONTRACT_REVISION,
} from '@/lib/operator-success-attestation-contract';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  load: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));
vi.mock('@/lib/operator-success-attestation-store', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/operator-success-attestation-store')
  >();
  return { ...original, loadOperatorSuccessAttestation: mocks.load };
});

import {
  insertManualSchedulingAttestation,
  loadManualSchedulingAttestationReplay,
} from '@/lib/manual-scheduling-attestation-store';

const snapshot = {
  notionPageId: '44444444-4444-4444-8444-444444444444',
  headline: 'Day 6',
  title: 'Day 6',
  caption: 'Frozen caption',
  tags: ['day6'],
  platform: 'RedNote' as const,
  mediaType: 'image' as const,
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/day6.png',
  publishAt: '2026-08-06T14:30:00.000Z',
  notionLastEditedTime: '2026-08-04T13:12:00.000Z',
};
const input = {
  notionPageId: snapshot.notionPageId,
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  itemHash: manifestHash(snapshot),
  snapshotRevision: snapshot.notionLastEditedTime,
  requestedPublishAt: snapshot.publishAt,
};
const key = '33333333-3333-4333-8333-333333333333';
const jobId = '55555555-5555-4555-8555-555555555555';
const attestationId = '66666666-6666-4666-8666-666666666666';

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    batch_id: input.batchId,
    batch_status: 'approved',
    manifest_hash: input.manifestHash,
    approved_at: '2026-08-04T15:00:00.000Z',
    item_id: input.itemId,
    notion_page_id: snapshot.notionPageId,
    snapshot,
    item_hash: input.itemHash,
    item_state: 'approved',
    dispatch_mode: 'scheduled',
    local_publish_job_id: null,
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    notion_page_id: snapshot.notionPageId,
    snapshot,
    status: 'queued',
    claim_token: null,
    claimed_at: null,
    staged_at: null,
    dispatch_authorized_at: null,
    dispatched_at: null,
    note_id: null,
    share_url: null,
    verified_at: null,
    reconciled_at: null,
    completed_at: null,
    external_disposition_request_id: null,
    success_attestation_id: null,
    batch_item_id: input.itemId,
    ...overrides,
  };
}

function receipt() {
  return {
    id: attestationId,
    idempotency_key: key,
    local_publish_job_id: jobId,
    notion_page_id: snapshot.notionPageId,
    batch_id: input.batchId,
    batch_item_id: input.itemId,
    manifest_hash: input.manifestHash,
    item_hash: input.itemHash,
    snapshot_revision: input.snapshotRevision,
    snapshot_digest: input.itemHash,
    provenance: 'manual_scheduled',
    contract_revision: MANUAL_SCHEDULING_ATTESTATION_CONTRACT_REVISION,
    prior_claim_token_digest: null,
    expected_outcome: 'Successfully scheduled',
    requested_publish_at: input.requestedPublishAt,
    attested_by: 'operator@example.com',
    attested_at: '2026-08-05T12:30:00.000Z',
  };
}

describe('manual scheduling attestation store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.load.mockResolvedValue({
      id: attestationId,
      provenance: 'manual_scheduled',
      releaseRequired: false,
    });
  });

  it('transactionally creates receipt-pending lifecycle without a pre-existing worker job', async () => {
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([candidate()]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{ conflict: false }]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([job()]))
      .mockResolvedValueOnce(result([{ id: attestationId }]))
      .mockResolvedValueOnce(result([{ id: jobId }], 1))
      .mockResolvedValueOnce(result());

    await expect(insertManualSchedulingAttestation(
      input,
      key,
      'operator@example.com',
    )).resolves.toMatchObject({
      created: true,
      attestation: { provenance: 'manual_scheduled', releaseRequired: false },
    });

    const statements = mocks.query.mock.calls.map(([text]) => String(text));
    expect(statements.some((text) =>
      text.includes('INSERT INTO local_publish_jobs'))).toBe(true);
    expect(statements.some((text) =>
      text.includes("status = 'operator_attested'") &&
      text.includes('next_verification_at = NULL'))).toBe(true);
    expect(statements.some((text) =>
      text.includes("'manual_scheduled'"))).toBe(true);
    expect(statements.filter((text) =>
      text.includes('UPDATE local_publish_jobs'))).toHaveLength(1);
  });

  it('converts only the exact unclaimed queued job and rejects a worker collision', async () => {
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([candidate({
        item_state: 'queued',
        local_publish_job_id: jobId,
      })]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([job({ status: 'claimed', claim_token: key })]))
      .mockResolvedValueOnce(result());

    await expect(insertManualSchedulingAttestation(
      input,
      key,
      'operator@example.com',
    )).rejects.toMatchObject({ code: 'MANUAL_SCHEDULING_JOB_COLLISION' });
    expect(mocks.query.mock.calls.map(([text]) => String(text))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('INSERT INTO local_publish_job_success')]),
    );
  });

  it('replays the exact immutable event and rejects reconciled ownership', async () => {
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([receipt()]))
      .mockResolvedValueOnce(result());
    await expect(insertManualSchedulingAttestation(
      input,
      key,
      'operator@example.com',
    )).resolves.toMatchObject({ created: false });

    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([candidate()]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{ conflict: true }]))
      .mockResolvedValueOnce(result());
    await expect(insertManualSchedulingAttestation(
      input,
      key,
      'operator@example.com',
    )).rejects.toMatchObject({ code: 'MANUAL_SCHEDULING_DURABLE_CONFLICT' });
  });

  it('loads an exact durable replay before live eligibility validation', async () => {
    mocks.query.mockResolvedValueOnce(result([receipt()]));

    await expect(loadManualSchedulingAttestationReplay(
      input,
      key,
      'operator@example.com',
    )).resolves.toMatchObject({ created: false });
    expect(mocks.load).toHaveBeenCalledWith(attestationId);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
