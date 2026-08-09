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
    handling_mode: 'scheduled',
    receipt_status: 'pending',
    warnings: [],
    manual_reconciliation_id: null,
    note_id: null,
    share_url: null,
    published_at: null,
    recorded_at: '2026-08-06T16:05:00.000Z',
    updated_at: '2026-08-06T16:05:00.000Z',
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
    claim_expires_at: null,
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
    mocks.query.mockImplementation(async (text: string) => {
      if (text.includes('FROM local_publish_jobs')) return result(jobs);
      if (text.includes('FROM xhs_publish_receipts')) return result();
      if (text.includes('FROM rednote_publish_batch_items')) return result();
      if (text.includes('INSERT INTO plan_operator_scheduled_posts')) {
        return result([marker()]);
      }
      return result();
    });

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
      expect.stringContaining('UPDATE local_publish_jobs'),
      expect.stringContaining("SET state = 'invalidated'"),
      expect.stringContaining('INSERT INTO plan_operator_scheduled_posts'),
      'COMMIT',
    ]));
    expect(mocks.query.mock.calls.some((call) =>
      Array.isArray(call[1]) && call[1].includes('OPERATOR_SCHEDULED_BY_PLAN')
    )).toBe(true);
  });

  it('fails closed when a worker already claimed or acted on the page', async () => {
    mocks.query.mockImplementation(async (text: string) => {
      if (text.includes('FROM local_publish_jobs')) {
        return result([{
        ...pristineJob(),
        status: 'claimed',
        claim_token: key,
        claim_attempts: 1,
        claimed_at: '2026-08-06T16:01:00.000Z',
        claim_expires_at: '2099-08-06T16:31:00.000Z',
        }]);
      }
      return result();
    });

    await expect(insertPlanOperatorScheduledState(input, key)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_ACTIVE_WORKER_CONFLICT',
      status: 409,
    });
    expect(mocks.query.mock.calls.map(([text]) => String(text))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('INSERT INTO plan_operator_scheduled_posts')]),
    );
  });

  it.each([
    ['UTC Z versus +00:00', '2026-08-07T14:30:00.000+00:00'],
    ['offset-equivalent -04:00 versus Z', '2026-08-07T10:30:00.000-04:00'],
  ])('accepts scheduled timestamp replay by instant: %s', async (_label, scheduledAt) => {
    mocks.sql.mockResolvedValueOnce(result([marker()]));
    await expect(loadPlanOperatorScheduledReplay({
      ...input,
      expectedScheduledAt: scheduledAt,
    }, key)).resolves.toMatchObject({
      notionPageId: input.notionPageId,
      scheduledAt: input.expectedScheduledAt,
    });
  });

  it.each([
    ['different instant', marker({ scheduled_at: '2026-08-07T14:31:00.000Z' }), input, key],
    ['malformed stored timestamp', marker({ scheduled_at: 'not-a-timestamp' }), input, key],
    ['different page', marker({ notion_page_id: 'different-page' }), input, key],
    [
      'equivalent but non-exact revision',
      marker({ notion_last_edited_time: '2026-08-06T16:00:00.000+00:00' }),
      input,
      key,
    ],
    ['different idempotency key', marker({ idempotency_key: 'different-key' }), input, key],
    ['different mode', marker({ handling_mode: 'published' }), input, key],
    ['different provenance', marker({ recorded_by: 'admin' }), input, key],
    ['different warnings', marker({ warnings: ['unexpected warning'] }), input, key],
  ])('rejects replay identity mismatch: %s', async (
    _label,
    stored,
    requestedInput,
    requestedKey,
  ) => {
    mocks.sql.mockResolvedValueOnce(result([stored]));
    await expect(
      loadPlanOperatorScheduledReplay(requestedInput, requestedKey),
    ).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_REPLAY_MISMATCH',
      status: 409,
    });
  });

  it('rejects when the page and idempotency key resolve to different rows', async () => {
    mocks.sql.mockResolvedValueOnce(result([
      marker(),
      marker({
        id: '55555555-5555-4555-8555-555555555555',
        notion_page_id: 'different-page',
      }),
    ]));
    await expect(loadPlanOperatorScheduledReplay(input, key)).rejects.toMatchObject({
      code: 'PLAN_OPERATOR_SCHEDULED_REPLAY_MISMATCH',
      status: 409,
    });
  });

  it('canonicalizes scheduled timestamps before the timestamptz insert', async () => {
    mocks.query.mockImplementation(async (text: string) => {
      if (text.includes('INSERT INTO plan_operator_scheduled_posts')) {
        return result([marker()]);
      }
      return result();
    });
    await insertPlanOperatorScheduledState({
      ...input,
      expectedScheduledAt: '2026-08-07T10:30:00.000-04:00',
    }, key);
    const insertCall = mocks.query.mock.calls.find(([text]) =>
      String(text).includes('INSERT INTO plan_operator_scheduled_posts'));
    expect(insertCall?.[1]).toContain('2026-08-07T14:30:00.000Z');
  });
});
