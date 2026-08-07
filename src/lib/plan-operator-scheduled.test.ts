import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPost: vi.fn(),
  replay: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('@/lib/notion-posts', () => ({ getReadyXhsPost: mocks.getPost }));
vi.mock('@/lib/plan-operator-scheduled-store', () => ({
  loadPlanOperatorScheduledReplay: mocks.replay,
  insertPlanOperatorScheduledState: mocks.insert,
}));

import { markPlanOperatorScheduled } from '@/lib/plan-operator-scheduled';

const notionPageId = '11111111-1111-4111-8111-111111111111';
const idempotencyKey = '22222222-2222-4222-8222-222222222222';
const expectedNotionVersion = '2026-08-06T16:00:00.000Z';
const expectedScheduledAt = '2026-08-07T14:30:00.000Z';
const input = { notionPageId, expectedNotionVersion, expectedScheduledAt };

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: notionPageId,
    status: 'Approved',
    lastEditedTime: expectedNotionVersion,
    publishAt: expectedScheduledAt,
    ...overrides,
  };
}

describe('PLAN operator-scheduled orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replay.mockResolvedValue(null);
    mocks.getPost.mockResolvedValue(post());
    mocks.insert.mockResolvedValue({
      created: true,
      execution: { notionPageId, state: 'operator_scheduled_receipt_pending' },
    });
  });

  it('derives the current Notion revision and schedule before persisting', async () => {
    await expect(markPlanOperatorScheduled(input, idempotencyKey)).resolves.toMatchObject({
      created: true,
      execution: { state: 'operator_scheduled_receipt_pending' },
    });
    expect(mocks.getPost).toHaveBeenCalledWith(notionPageId);
    expect(mocks.insert).toHaveBeenCalledWith(input, idempotencyKey);
  });

  it('rejects stale Notion revisions and schedules with named conflicts', async () => {
    mocks.getPost.mockResolvedValueOnce(post({
      lastEditedTime: '2026-08-06T16:01:00.000Z',
    }));
    await expect(markPlanOperatorScheduled(input, idempotencyKey)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_STALE_REVISION',
      status: 409,
    });

    mocks.getPost.mockResolvedValueOnce(post({
      publishAt: '2026-08-07T14:31:00.000Z',
    }));
    await expect(markPlanOperatorScheduled(input, idempotencyKey)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_STALE_SCHEDULE',
      status: 409,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('accepts an offset-equivalent canonical Notion schedule', async () => {
    const offsetInput = {
      ...input,
      expectedScheduledAt: '2026-08-07T10:30:00.000-04:00',
    };
    await expect(markPlanOperatorScheduled(offsetInput, idempotencyKey)).resolves.toMatchObject({
      created: true,
    });
    expect(mocks.insert).toHaveBeenCalledWith(offsetInput, idempotencyKey);
  });

  it('keeps the canonical Notion revision gate exact', async () => {
    const equivalentRevision = {
      ...input,
      expectedNotionVersion: '2026-08-06T16:00:00.000+00:00',
    };
    await expect(
      markPlanOperatorScheduled(equivalentRevision, idempotencyKey),
    ).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_STALE_REVISION',
      status: 409,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['expectedScheduledAt', 'not-a-timestamp'],
    ['expectedNotionVersion', 'not-a-timestamp'],
  ])('rejects malformed %s before replay or canonical re-read', async (field, value) => {
    await expect(markPlanOperatorScheduled({
      ...input,
      [field]: value,
    }, idempotencyKey)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(mocks.replay).not.toHaveBeenCalled();
    expect(mocks.getPost).not.toHaveBeenCalled();
  });

  it('requires the canonical post to remain Approved', async () => {
    mocks.getPost.mockResolvedValue(post({ status: 'Published' }));
    await expect(markPlanOperatorScheduled(input, idempotencyKey)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_STATUS_CONFLICT',
      status: 409,
    });
  });

  it('returns an exact durable replay without re-reading Notion', async () => {
    mocks.replay.mockResolvedValue({
      notionPageId,
      state: 'operator_scheduled_receipt_pending',
      scheduledAt: expectedScheduledAt,
    });
    await expect(markPlanOperatorScheduled(input, idempotencyKey)).resolves.toMatchObject({
      created: false,
    });
    expect(mocks.getPost).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
