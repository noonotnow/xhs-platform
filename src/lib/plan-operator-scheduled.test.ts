import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPost: vi.fn(),
  replay: vi.fn(),
  insert: vi.fn(),
  markAwaitingReceipt: vi.fn(),
}));

vi.mock('@/lib/notion-posts', () => ({
  getReadyXhsPost: mocks.getPost,
  markXhsPostAwaitingReceipt: mocks.markAwaitingReceipt,
}));
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
    status: 'Ready',
    publishPacketReady: true,
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
    expect(mocks.insert).toHaveBeenCalledWith(
      input,
      idempotencyKey,
      expectedNotionVersion,
    );
    expect(mocks.markAwaitingReceipt).toHaveBeenCalledWith(notionPageId);
  });

  it('treats the client revision as context but still protects the exact schedule', async () => {
    const currentRevision = '2026-08-06T16:01:00.000Z';
    mocks.getPost.mockResolvedValueOnce(post({
      lastEditedTime: currentRevision,
    }));
    await expect(markPlanOperatorScheduled(input, idempotencyKey)).resolves.toMatchObject({
      created: true,
    });
    expect(mocks.insert).toHaveBeenLastCalledWith(
      input,
      idempotencyKey,
      currentRevision,
    );

    mocks.insert.mockClear();
    mocks.getPost.mockResolvedValueOnce(post({
      publishAt: '2026-08-07T14:31:00.000Z',
    }));
    await expect(markPlanOperatorScheduled(input, idempotencyKey)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_STALE_SCHEDULE',
      status: 409,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('requires the canonical post to be clearly Ready and packet-ready', async () => {
    mocks.getPost.mockResolvedValue(post({ status: 'In progress' }));
    await expect(markPlanOperatorScheduled(input, idempotencyKey)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_NOT_READY',
      status: 409,
    });
    mocks.getPost.mockResolvedValue(post({ publishPacketReady: false }));
    await expect(markPlanOperatorScheduled(input, idempotencyKey)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_NOT_READY',
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
    expect(mocks.markAwaitingReceipt).toHaveBeenCalledWith(notionPageId);
  });
});
