import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ construct: vi.fn(), on: vi.fn(), query: vi.fn() }));
vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) { mocks.construct(options); }
    on = mocks.on;
    query = mocks.query;
  },
}));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('XHS_DATABASE_URL', ''); vi.stubEnv('XHS_DATABASE_POSTGRES_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture.invalid/test');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('bounds connection and statements without changing pool capacity', async () => {
  const { getPool } = await import('./db');
  const pool = getPool(); expect(getPool()).toBe(pool);
  expect(mocks.construct).toHaveBeenCalledOnce();
  expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({
    connectionTimeoutMillis: 5000, statement_timeout: 4000,
    query_timeout: 5000, idleTimeoutMillis: 1000, allowExitOnIdle: true,
  }));
  expect(mocks.construct.mock.calls[0][0]).not.toHaveProperty('max');
});
it('handles idle errors without logging their raw data', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { getPool } = await import('./db'); getPool();
  expect(mocks.on).toHaveBeenCalledWith('error', expect.any(Function));
  mocks.on.mock.calls[0][1](new Error('fixture confidential URL'));
  expect(log).toHaveBeenCalledWith('XHS database idle connection closed');
});
