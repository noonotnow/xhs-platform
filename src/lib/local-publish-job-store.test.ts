import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ sql: mocks.sql }));

import {
  claimNextStoredLocalPublishJob,
  insertLocalPublishJob,
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
    error_code: null,
    error_message: null,
    note_id: null,
    share_url: null,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T12:00:00.000Z',
    completed_at: null,
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
  beforeEach(() => vi.clearAllMocks());

  it('uses one locking statement for queued work and stale lease recovery', async () => {
    mocks.sql.mockResolvedValue({ rows: [claimedRow()], rowCount: 1 });

    const claimed = await claimNextStoredLocalPublishJob(7_200);
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');

    expect(query).toContain("status = 'queued'");
    expect(query).toContain("status = 'claimed' AND claim_expires_at <= CURRENT_TIMESTAMP");
    expect(query).toContain('FOR UPDATE SKIP LOCKED');
    expect(query).toContain('claim_token = gen_random_uuid()');
    expect(query).toContain('claim_attempts = claim_attempts + 1');
    expect(claimed).toMatchObject({
      id: claimedRow().id,
      claimToken: claimedRow().claim_token,
      claimExpiresAt: '2026-08-01T14:00:00.000Z',
      mediaUrl: snapshot.mediaUrl,
    });
    expect(claimed).not.toHaveProperty('notionLastEditedTime');
  });

  it('claims at most one row and returns null when the locking query finds none', async () => {
    mocks.sql.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(claimNextStoredLocalPublishJob(7_200)).resolves.toBeNull();
    expect(mocks.sql).toHaveBeenCalledTimes(1);
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
});
