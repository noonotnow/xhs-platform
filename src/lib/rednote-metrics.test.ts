import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/db', () => ({ sql: mocks.sql }));

import {
  claimDueRednoteMetricPosts,
  parseMetricBatchLimit,
  parseMetricObservations,
  recordRednoteMetricObservations,
} from '@/lib/rednote-metrics';

const claim = {
  notion_page_id: 'post-page-id',
  note_id: 'note_123',
  share_url: 'https://www.rednote.com/explore/note_123',
  published_at: '2026-08-01T12:00:00.000Z',
  claim_token: '11111111-1111-4111-8111-111111111111',
  claim_expires_at: '2026-08-02T12:30:00.000Z',
  latest_metrics: { views: 10, likes: 2, comments: 1, saves: 1, shares: 0 },
  last_observed_at: '2026-08-02T06:00:00.000Z',
};

const observation = {
  notionPageId: claim.notion_page_id,
  claimToken: claim.claim_token,
  observedAt: '2026-08-02T12:00:00.000Z',
  metrics: { views: 12, likes: 3, comments: 1, saves: 1, shares: 0 },
};

describe('RedNote metric work storage', () => {
  beforeEach(() => mocks.sql.mockReset());

  it('defaults and caps bounded metrics batches at 20', () => {
    expect(parseMetricBatchLimit(null)).toBe(20);
    expect(parseMetricBatchLimit('1')).toBe(1);
    expect(() => parseMetricBatchLimit('21')).toThrowError(/between 1 and 20/);
  });

  it('claims only reconciled due posts and excludes posts older than 90 days by default', async () => {
    mocks.sql.mockResolvedValue({ rows: [claim], rowCount: 1 });
    await expect(claimDueRednoteMetricPosts(20, false)).resolves.toEqual([{
      notionPageId: claim.notion_page_id,
      noteId: claim.note_id,
      shareUrl: claim.share_url,
      publishedAt: claim.published_at,
      claimToken: claim.claim_token,
      claimExpiresAt: claim.claim_expires_at,
      previousMetrics: claim.latest_metrics,
      lastObservedAt: claim.last_observed_at,
    }]);
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain("status = 'reconciled'");
    expect(query).toContain("INTERVAL '90 days'");
    expect(query).toContain('state.last_observed_at IS NULL');
    expect(query).toContain('state.next_due_at <= CURRENT_TIMESTAMP');
    expect(query).toContain("snapshot->>'publishAt'");
    expect(query).toContain("snapshot->>'scheduledDate'");
    expect(query).toContain('FOR UPDATE OF job SKIP LOCKED');
    expect(query).toContain('LIMIT ?');
    expect(query).toContain('gen_random_uuid()');
    expect(mocks.sql.mock.calls[0]).toContain(20);
    expect(mocks.sql.mock.calls[0]).toContain(false);
  });

  it('allows explicit on-demand collection for older posts', async () => {
    mocks.sql.mockResolvedValue({ rows: [], rowCount: 0 });
    await claimDueRednoteMetricPosts(5, true);
    expect(mocks.sql.mock.calls[0]).toContain(true);
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('OR state.next_due_at <= CURRENT_TIMESTAMP');
  });

  it('accepts exactly one consolidated metric object per post', () => {
    expect(parseMetricObservations({ observations: [observation] })).toEqual([observation]);
    expect(() => parseMetricObservations({
      observations: [{ ...observation, metrics: { ...observation.metrics, reach: 99 } }],
    })).toThrowError(/only views, likes, comments, saves, and shares/);
  });

  it('coalesces observations into snapshots only for changes or due checkpoints', async () => {
    mocks.sql.mockResolvedValue({ rows: [{ snapshots_written: 1 }], rowCount: 1 });
    await expect(recordRednoteMetricObservations([observation])).resolves.toEqual({
      claimed: 0,
      verified: 0,
      measured: 1,
      snapshotsWritten: 1,
      failures: 0,
    });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('latest_metrics IS DISTINCT FROM');
    expect(query).toContain('next_due_at <=');
    expect(query).toContain("THEN 'changed'");
    expect(query).toContain("ELSE 'checkpoint'");
    expect(query).toContain("INTERVAL '6 hours'");
    expect(query).toContain("INTERVAL '1 day'");
    expect(query).toContain("INTERVAL '7 days'");
    expect(query).toContain('ELSE NULL');
  });

  it('reports an idempotent no-op retry without inserting or updating', async () => {
    mocks.sql.mockResolvedValue({ rows: [{ snapshots_written: 0 }], rowCount: 1 });
    await expect(recordRednoteMetricObservations([observation])).resolves.toMatchObject({
      measured: 1,
      snapshotsWritten: 0,
      failures: 0,
    });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('last_observed_at IS DISTINCT FROM');
    expect(query).toContain('OR EXISTS (SELECT 1 FROM inserted)');
  });

  it('coalesces stale item failures into the run summary', async () => {
    mocks.sql.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(recordRednoteMetricObservations([observation])).resolves.toMatchObject({
      measured: 0,
      snapshotsWritten: 0,
      failures: 1,
    });
  });

  it('commits current items while coalescing stale items into one partial-failure summary', async () => {
    mocks.sql
      .mockResolvedValueOnce({ rows: [{ snapshots_written: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(recordRednoteMetricObservations([
      observation,
      { ...observation, notionPageId: 'stale-post' },
    ])).resolves.toEqual({
      claimed: 0,
      verified: 0,
      measured: 1,
      snapshotsWritten: 1,
      failures: 1,
    });
  });
});
