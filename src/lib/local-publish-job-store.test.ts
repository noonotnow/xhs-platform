import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ sql: mocks.sql }));

import {
  claimNextStoredLocalPublishJob,
  completeStoredLocalPublishReconciliation,
  consumeStoredDispatchAuthorization,
  deferStoredLocalPublishVerification,
  failStoredLocalPublishJob,
  insertLocalPublishJob,
  listLocalPublishJobs,
  normalizeStoredLocalPublishSnapshot,
  prepareStoredLocalPublishVerification,
  recordStoredLocalPublishDispatch,
  stageStoredLocalPublishJob,
} from '@/lib/local-publish-job-store';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

const snapshot: LocalPublishSnapshot = {
  notionPageId: '11111111-1111-4111-8111-111111111111',
  headline: 'Headline',
  title: 'Title',
  caption: 'Caption',
  tags: ['Tag'],
  platform: 'RedNote',
  mediaType: 'video',
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
  notionLastEditedTime: '2026-08-01T12:00:00.000Z',
};

function claimedRow() {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    notion_page_id: snapshot.notionPageId,
    snapshot,
    status: 'claimed',
    idempotency_key: '33333333-3333-4333-8333-333333333333',
    claim_token: '44444444-4444-4444-8444-444444444444',
    claim_attempts: 2,
    claimed_at: '2026-08-01T12:00:00.000Z',
    claim_expires_at: '2026-08-01T14:00:00.000Z',
    verification_attempts: 0,
    next_verification_at: null,
    error_code: null,
    error_message: null,
    note_id: null,
    share_url: null,
    staged_at: null,
    dispatched_at: null,
    verified_at: null,
    reconciled_at: null,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T12:00:00.000Z',
    completed_at: null,
  };
}

function verificationRow(
  status: 'submitted' | 'scheduled' | 'verification_pending' | 'verified' | 'reconciled',
) {
  return {
    ...claimedRow(),
    snapshot: {
      ...snapshot,
      publishAt: '2026-08-04T13:30:00.000Z',
    },
    status,
    verification_attempts: status === 'verification_pending' ? 2 : 0,
    next_verification_at:
      status === 'submitted' || status === 'scheduled' || status === 'verification_pending'
        ? '2026-08-01T13:00:00.000Z'
        : null,
    error_code: status === 'verification_pending' ? 'REDNOTE_300031' : null,
    error_message: status === 'verification_pending' ? 'Still processing' : null,
    note_id: 'note_123',
    share_url: 'https://www.rednote.com/explore/note_123',
    staged_at: '2026-08-01T12:05:00.000Z',
    dispatched_at: '2026-08-01T12:10:00.000Z',
    verified_at:
      status === 'verified' || status === 'reconciled'
        ? '2026-08-01T13:30:00.000Z'
        : null,
    reconciled_at: status === 'reconciled' ? '2026-08-01T13:35:00.000Z' : null,
    completed_at: status === 'reconciled' ? '2026-08-01T13:35:00.000Z' : null,
  };
}

function queuedRow() {
  return {
    ...claimedRow(),
    status: 'queued',
    claim_token: null,
    claim_attempts: 0,
    claimed_at: null,
    claim_expires_at: null,
  };
}

describe('local publish atomic claim storage', () => {
  beforeEach(() => mocks.sql.mockReset());

  it('uses one locking statement for queued work and stale lease recovery', async () => {
    mocks.sql.mockResolvedValue({ rows: [claimedRow()], rowCount: 1 });

    const claimed = await claimNextStoredLocalPublishJob(7_200, 'dispatch');
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');

    expect(query).toContain("status = 'queued'");
    expect(query).toContain("status = 'claimed' AND claim_expires_at <= CURRENT_TIMESTAMP");
    expect(query).toContain("status = 'staged'");
    expect(query).toContain('dispatch_authorized_at IS NULL');
    expect(query).toContain("status IN ('submitted', 'scheduled', 'verification_pending')");
    expect(query).toContain('claim_expires_at IS NULL');
    expect(query).toContain('FOR UPDATE SKIP LOCKED');
    expect(query).toContain('claim_token = gen_random_uuid()');
    expect(query).toContain('claim_attempts = claim_attempts + 1');
    expect(mocks.sql.mock.calls[0]).toContain('dispatch');
    expect(claimed).toMatchObject({
      id: claimedRow().id,
      claimToken: claimedRow().claim_token,
      claimExpiresAt: '2026-08-01T14:00:00.000Z',
      mediaUrl: snapshot.mediaUrl,
      snapshotRevision: snapshot.notionLastEditedTime,
    });
    expect(claimed).not.toHaveProperty('notionLastEditedTime');
  });

  it('durably consumes a staged dispatch permit before the publish click', async () => {
    mocks.sql.mockResolvedValue({
      rows: [{
        ...claimedRow(),
        status: 'staged',
        dispatch_authorized_at: '2026-08-01T12:06:00.000Z',
      }],
      rowCount: 1,
    });

    await expect(consumeStoredDispatchAuthorization(
      claimedRow().id,
      claimedRow().claim_token,
    )).resolves.toMatchObject({ id: claimedRow().id, status: 'staged' });

    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('dispatch_authorized_at = COALESCE');
    expect(query).toContain("status = 'staged'");
    expect(query).toContain('claim_expires_at > CURRENT_TIMESTAMP');
  });

  it('preserves post-dispatch state and returns verification-only work', async () => {
    mocks.sql.mockResolvedValue({
      rows: [verificationRow('verification_pending')],
      rowCount: 1,
    });

    await expect(claimNextStoredLocalPublishJob(7_200, 'verification')).resolves.toMatchObject({
      status: 'verification_pending',
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
      verificationAttempts: 2,
      nextVerificationAt: '2026-08-01T13:00:00.000Z',
    });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain("WHEN candidate.status IN ('queued', 'claimed') THEN 'claimed'");
    expect(mocks.sql.mock.calls[0]).toContain('verification');
  });

  it('returns verified jobs only for idempotent Notion reconciliation', async () => {
    mocks.sql.mockResolvedValue({
      rows: [verificationRow('verified')],
      rowCount: 1,
    });

    await expect(claimNextStoredLocalPublishJob(7_200)).resolves.toMatchObject({
      status: 'verified',
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
      verificationAttempts: 0,
    });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain("status = 'verified'");
  });

  it('claims at most one row and returns null when the locking query finds none', async () => {
    mocks.sql.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(claimNextStoredLocalPublishJob(7_200)).resolves.toBeNull();
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy combined lane as the default', async () => {
    mocks.sql.mockResolvedValue({ rows: [], rowCount: 0 });
    await claimNextStoredLocalPublishJob(7_200);
    expect(mocks.sql.mock.calls[0]).toContain('all');
  });

  it('returns the immutable MOV trial marker to the worker', async () => {
    mocks.sql.mockResolvedValue({
      rows: [{
        ...claimedRow(),
        snapshot: {
          ...snapshot,
          compatibilityTrial: 'unverified_mov',
          thumbnailUrl: 'https://images.xhs.justlikekatie.com/uploads/thumb.jpg',
        },
      }],
      rowCount: 1,
    });

    await expect(claimNextStoredLocalPublishJob(7_200)).resolves.toMatchObject({
      compatibilityTrial: 'unverified_mov',
      mediaUrl: snapshot.mediaUrl,
      thumbnailUrl: 'https://images.xhs.justlikekatie.com/uploads/thumb.jpg',
    });
  });

  it('normalizes legacy scheduledDate snapshots to the publishAt worker contract', async () => {
    const legacySnapshot = {
      ...snapshot,
      scheduledDate: '2026-08-04T09:30:00-04:00',
    };
    expect(normalizeStoredLocalPublishSnapshot(legacySnapshot)).toEqual({
      ...snapshot,
      publishAt: '2026-08-04T13:30:00.000Z',
    });
    mocks.sql.mockResolvedValue({
      rows: [{ ...claimedRow(), snapshot: legacySnapshot }],
      rowCount: 1,
    });

    const claimed = await claimNextStoredLocalPublishJob(7_200);
    expect(claimed).toMatchObject({ publishAt: '2026-08-04T13:30:00.000Z' });
    expect(claimed).not.toHaveProperty('scheduledDate');
  });

  it('returns the original job for an identical idempotency key', async () => {
    const reorderedSnapshot = {
      notionLastEditedTime: snapshot.notionLastEditedTime,
      mediaUrl: snapshot.mediaUrl,
      mediaIndex: snapshot.mediaIndex,
      mediaType: snapshot.mediaType,
      platform: snapshot.platform,
      tags: snapshot.tags,
      caption: snapshot.caption,
      title: snapshot.title,
      headline: snapshot.headline,
      notionPageId: snapshot.notionPageId,
    };
    mocks.sql
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ ...queuedRow(), snapshot: reorderedSnapshot }],
        rowCount: 1,
      });

    await expect(insertLocalPublishJob(
      snapshot,
      queuedRow().idempotency_key,
    )).resolves.toMatchObject({
      created: false,
      job: { id: queuedRow().id, status: 'queued' },
    });
    expect(mocks.sql).toHaveBeenCalledTimes(2);
  });

  it('prevents a second active job for the same Notion page', async () => {
    mocks.sql
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [claimedRow()], rowCount: 1 });

    await expect(insertLocalPublishJob(
      snapshot,
      '55555555-5555-4555-8555-555555555555',
    )).rejects.toMatchObject({ code: 'ACTIVE_JOB_EXISTS', status: 409 });
  });

  it('persists staged state before any Creator dispatch', async () => {
    mocks.sql.mockResolvedValue({
      rows: [{ ...claimedRow(), status: 'staged', staged_at: '2026-08-01T12:05:00.000Z' }],
      rowCount: 1,
    });

    await expect(stageStoredLocalPublishJob(
      claimedRow().id,
      claimedRow().claim_token,
    )).resolves.toMatchObject({
      status: 'staged',
      stagedAt: '2026-08-01T12:05:00.000Z',
    });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain("AND status = 'claimed'");
  });

  it('anchors scheduled verification after the frozen publishAt', async () => {
    mocks.sql.mockResolvedValue({
      rows: [verificationRow('scheduled')],
      rowCount: 1,
    });

    await expect(recordStoredLocalPublishDispatch(
      claimedRow().id,
      claimedRow().claim_token,
      'scheduled',
      'note_123',
      'https://www.rednote.com/explore/note_123',
      900,
    )).resolves.toMatchObject({ status: 'scheduled', noteId: 'note_123' });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('GREATEST');
    expect(query).toContain("snapshot->>'publishAt'");
    expect(query).toContain("snapshot->>'scheduledDate'");
    expect(query).toContain('claim_expires_at = CURRENT_TIMESTAMP');
  });

  it('advances pending verification only once per claimed retry window', async () => {
    mocks.sql.mockResolvedValue({
      rows: [verificationRow('verification_pending')],
      rowCount: 1,
    });

    await expect(deferStoredLocalPublishVerification(
      claimedRow().id,
      claimedRow().claim_token,
      'note_123',
      'https://www.rednote.com/explore/note_123',
      'REDNOTE_300031',
      'Still processing',
      [900, 3_600, 21_600, 86_400],
    )).resolves.toMatchObject({
      status: 'verification_pending',
      verificationAttempts: 2,
    });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('verification_attempts = verification_attempts + 1');
    expect(query).toContain('next_verification_at <= claimed_at');
    expect(query).toContain('claim_expires_at = CURRENT_TIMESTAMP');
    expect(mocks.sql.mock.calls[0]).toEqual(expect.arrayContaining([
      3_600,
      21_600,
      86_400,
    ]));
  });

  it('rejects terminal failure after Creator dispatch', async () => {
    mocks.sql
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [verificationRow('submitted')], rowCount: 1 });

    await expect(failStoredLocalPublishJob(
      claimedRow().id,
      claimedRow().claim_token,
      'PUBLIC_LOOKUP_DELAY',
      'Public lookup is not ready',
    )).rejects.toMatchObject({ code: 'INVALID_JOB_TRANSITION', status: 409 });
  });

  it('persists verified state before reconciliation completion', async () => {
    mocks.sql
      .mockResolvedValueOnce({ rows: [verificationRow('verified')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [verificationRow('reconciled')], rowCount: 1 });

    const verified = await prepareStoredLocalPublishVerification(
      claimedRow().id,
      claimedRow().claim_token,
      'note_123',
      'https://www.rednote.com/explore/note_123',
    );
    expect(verified).toMatchObject({ status: 'verified' });
    expect(verified).not.toHaveProperty('reconciledAt');
    const verificationQuery =
      (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(verificationQuery).toContain('note_id = COALESCE(note_id');
    expect(verificationQuery).toContain("status IN ('submitted', 'scheduled', 'verification_pending')");

    await expect(completeStoredLocalPublishReconciliation(
      claimedRow().id,
      claimedRow().claim_token,
      'note_123',
      'https://www.rednote.com/explore/note_123',
    )).resolves.toMatchObject({
      status: 'reconciled',
      reconciledAt: '2026-08-01T13:35:00.000Z',
    });
  });

  it('cannot replace stable post identity during verification', async () => {
    mocks.sql
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [verificationRow('submitted')], rowCount: 1 });

    await expect(prepareStoredLocalPublishVerification(
      claimedRow().id,
      claimedRow().claim_token,
      'different_note',
      'https://www.rednote.com/explore/different_note',
    )).rejects.toMatchObject({ code: 'INVALID_JOB_TRANSITION', status: 409 });
  });

  it('keeps legacy terminal rows readable under canonical lifecycle states', async () => {
    mocks.sql.mockResolvedValue({
      rows: [
        { ...verificationRow('verified'), status: 'ambiguous' },
        { ...verificationRow('reconciled'), status: 'succeeded' },
      ],
      rowCount: 2,
    });

    await expect(listLocalPublishJobs()).resolves.toEqual([
      expect.objectContaining({ status: 'verified' }),
      expect.objectContaining({ status: 'reconciled' }),
    ]);
  });
});
