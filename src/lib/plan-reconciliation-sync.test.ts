import { describe, expect, it, vi } from 'vitest';
    import { syncReconciledPlanProvenance } from '@/lib/plan-reconciliation-sync';

    const pageId = '11111111-1111-4111-8111-111111111111';
    const token = 'plan-token-that-is-at-least-32-characters';
    const callbackUrl = 'https://plan.example.com/api/posts/operator-scheduled';

    describe('PLAN reconciliation provenance sync', () => {
    it('fails closed when the callback is not configured', async () => {
      const fetchImpl = vi.fn();
      await expect(syncReconciledPlanProvenance(pageId, {
        env: { PLAN_INTEGRATION_TOKEN: token },
        fetchImpl,
      })).resolves.toMatchObject({
        status: 'not-configured',
        code: 'PLAN_RECONCILIATION_SYNC_URL_MISSING',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('PATCHes only the page ID and returns the PLAN enrichment outcome', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(Response.json({
        enrichment: { enriched: true, property: 'Publish Provenance' },
      }));
      await expect(syncReconciledPlanProvenance(pageId, {
        env: {
          PLAN_INTEGRATION_TOKEN: token,
          PLAN_RECONCILIATION_CALLBACK_URL: callbackUrl,
        },
        fetchImpl,
      })).resolves.toEqual({
        status: 'synced',
        enrichment: { enriched: true, property: 'Publish Provenance' },
      });
      expect(fetchImpl).toHaveBeenCalledWith(callbackUrl, expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ notionPageId: pageId }),
        headers: expect.objectContaining({
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        }),
      }));
    });

    it('reports a rejected callback without exposing the upstream response body', async () => {
      await expect(syncReconciledPlanProvenance(pageId, {
        env: {
          PLAN_INTEGRATION_TOKEN: token,
          PLAN_RECONCILIATION_CALLBACK_URL: callbackUrl,
        },
        fetchImpl: vi.fn().mockResolvedValue(Response.json({
          code: 'PLAN_RECONCILIATION_SYNC_FORBIDDEN',
          error: 'internal response is not relayed',
        }, { status: 403 })),
      })).resolves.toEqual({
        status: 'failed',
        code: 'PLAN_RECONCILIATION_SYNC_FORBIDDEN',
        message: 'PLAN rejected the reconciliation provenance sync.',
        httpStatus: 403,
      });
    });
    });
    