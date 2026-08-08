import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  dueSweepKinds: vi.fn(),
  releaseExpiredClaims: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ sql: mocks.sql }));
vi.mock('@/lib/rednote-publish-batches', () => ({
  createPublishBatch: vi.fn(),
  dueSweepKinds: mocks.dueSweepKinds,
}));
vi.mock('@/lib/local-publish-job-store', () => ({
  releaseExpiredStoredLocalPublishClaims: mocks.releaseExpiredClaims,
}));
vi.mock('@/lib/manual-reconciliations', () => ({
  createManualReconciliation: vi.fn(),
}));

import { runDueRednoteSweeps } from '@/lib/rednote-sweeps';

describe('RedNote maintenance sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dueSweepKinds.mockReturnValue([]);
    mocks.releaseExpiredClaims.mockResolvedValue(['stale-job']);
  });

  it('releases expired worker claims on every hourly invocation', async () => {
    await expect(runDueRednoteSweeps(new Date('2026-08-08T18:00:00.000Z')))
      .resolves.toEqual([]);

    expect(mocks.releaseExpiredClaims).toHaveBeenCalledOnce();
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
