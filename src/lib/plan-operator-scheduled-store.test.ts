import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: vi.fn().mockResolvedValue({
      query: mocks.query,
      release: mocks.release,
    }),
  }),
  sql: mocks.sql,
}));

import {
  insertPlanOperatorScheduledState,
  loadPlanOperatorScheduledReplay,
} from '@/lib/plan-operator-scheduled-store';

const input = {
  notionPageId: '11111111-1111-4111-8111-111111111111',
  expectedNotionVersion: '2026-08-06T16:00:00.000Z',
  expectedScheduledAt: '2026-08-07T14:30:00.000Z',
};
const key = '22222222-2222-4222-8222-222222222222';

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function marker(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    notion_page_id: input.notionPageId,
    idempotency_key: key,
    notion_last_edited_time: input.expectedNotionVersion,
    scheduled_at: input.expectedScheduledAt,
    recorded_by: 'plan',
    recorded_at: '2026-08-06T16:05:00.000Z',
    reconciled_at: null,
    ...overrides,
  };
}

function pristineJob() {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    status: 'queued',
    claim_token: null,
    claim_attempts: 0,
    claimed_at: null,
    staged_at: null,
    dispatch_authorized_at: null,
    dispatched_at: null,
    note_id: null,
    share_url: null,
    verified_at: null,
    reconciled_at: null,
    completed_at: null,
    success_attestation_id: null,
    external_disposition_request_id: null,
  };
}

describe('PLAN operator-scheduled store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['without an existing job', []],
    ['while closing an untouched queued job', [pristineJob()]],
  ])('persists durable page state %s', async (_label, jobs) => {
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result(jobs))
      .mockResolvedValueOnce(result([{
        id: '55555555-5555-4555-8555-555555555555',
        state: 'queued',
        local_publish_job_id: jobs.length ? pristineJob().id : null,
      }].filter(() => jobs.length > 0)))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{ conflict: false }]))
      .mockResolvedValueOnce(result([], jobs.length))
      .mockResolvedValueOnce(result([], jobs.length))
      .mockResolvedValueOnce(result([marker()]))
      .mockResolvedValueOnce(result());

    await expect(insertPlanOperatorScheduledState(input, key)).resolves.toMatchObject({
      created: true,
      execution: {
        notionPageId: input.notionPageId,
        state: 'operator_scheduled_receipt_pending',
        scheduledAt: input.expectedScheduledAt,
      },
    });
    const statements = mocks.query.mock.calls.map(([text]) => String(text));
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining("error_code = 'OPERATOR_SCHEDULED_BY_PLAN'"),
      expect.stringContaining("SET state = 'invalidated'"),
      expect.stringContaining('INSERT INTO plan_operator_scheduled_posts'),
      'COMMIT',
    ]));
  });

  it('fails closed when a worker already claimed or acted on the page', async () => {
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{
        ...pristineJob(),
        status: 'claimed',
        claim_token: key,
        claim_attempts: 1,
        claimed_at: '2026-08-06T16:01:00.000Z',
      }]))
      .mockResolvedValueOnce(result());

    await expect(insertPlanOperatorScheduledState(input, key)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_ACTIVE_WORKER_CONFLICT',
      status: 409,
    });
    expect(mocks.query.mock.calls.map(([text]) => String(text))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('INSERT INTO plan_operator_scheduled_posts')]),
    );
  });

  it('accepts exact replay and rejects a mismatched replay with a named 409', async () => {
    mocks.sql.mockResolvedValueOnce(result([marker()]));
    await expect(loadPlanOperatorScheduledReplay(input, key)).resolves.toMatchObject({
      notionPageId: input.notionPageId,
      scheduledAt: input.expectedScheduledAt,
    });

    mocks.sql.mockResolvedValueOnce(result([marker({
      scheduled_at: '2026-08-07T14:31:00.000Z',
    })]));
    await expect(loadPlanOperatorScheduledReplay(input, key)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_REPLAY_MISMATCH',
      status: 409,
    });
  });
});
