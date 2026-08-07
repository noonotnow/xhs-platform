import { afterEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  advance: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/rednote-publishing-auth', () => ({
  requireRednoteAdmin: dependencies.requireAdmin,
}));

vi.mock('@/lib/rednote-publishing', () => ({
  advanceRednoteReceiptLookup: dependencies.advance,
}));

import { POST } from './route';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

describe('Rednote admin receipt lookup route', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('binds lookup evidence to the authenticated operator', async () => {
    const principal = {
      requester: 'admin' as const,
      actorId: 'operator@example.com',
    };
    dependencies.requireAdmin.mockResolvedValue(principal);
    dependencies.advance.mockResolvedValue({
      attempt: { id: ATTEMPT_ID, receiptLookupState: 'found' },
      event: { type: 'receipt_lookup_found' },
    });
    const request = new Request(
      `https://xhs.example/admin/api/rednote-publishing/attempts/${ATTEMPT_ID}/receipt-lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: 'found',
          occurredAt: '2026-08-07T16:00:00.000Z',
          evidence: [],
        }),
      },
    );

    const response = await POST(request, { params: { id: ATTEMPT_ID } });

    expect(response.status).toBe(200);
    expect(dependencies.advance).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      state: 'found',
      occurredAt: '2026-08-07T16:00:00.000Z',
      evidence: [],
      principal,
    });
  });
});
