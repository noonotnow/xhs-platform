import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  Pool: vi.fn(function Pool() {
    return { query: vi.fn() };
  }),
}));

vi.mock('pg', () => ({ Pool: mocks.Pool }));

async function createPoolWith(env: {
  XHS_DATABASE_URL?: string;
  XHS_DATABASE_POSTGRES_URL?: string;
  DATABASE_URL?: string;
  POSTGRES_URL?: string;
}) {
  vi.stubEnv('XHS_DATABASE_URL', env.XHS_DATABASE_URL ?? '');
  vi.stubEnv(
    'XHS_DATABASE_POSTGRES_URL',
    env.XHS_DATABASE_POSTGRES_URL ?? '',
  );
  vi.stubEnv('DATABASE_URL', env.DATABASE_URL ?? '');
  vi.stubEnv('POSTGRES_URL', env.POSTGRES_URL ?? '');

  const { getPool } = await import('@/lib/db');
  getPool();

  return mocks.Pool.mock.calls[0]?.[0];
}

describe('database connection selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('prefers XHS_DATABASE_URL over managed Neon', async () => {
    const options = await createPoolWith({
      XHS_DATABASE_URL: 'postgresql://xhs',
      XHS_DATABASE_POSTGRES_URL: 'postgresql://managed-neon',
      DATABASE_URL: 'postgresql://managed',
      POSTGRES_URL: 'postgresql://legacy',
    });

    expect(options).toMatchObject({ connectionString: 'postgresql://xhs' });
  });

  it('prefers managed Neon over legacy fallbacks', async () => {
    const options = await createPoolWith({
      XHS_DATABASE_POSTGRES_URL: 'postgresql://managed-neon',
      DATABASE_URL: 'postgresql://managed',
      POSTGRES_URL: 'postgresql://legacy',
    });

    expect(options).toMatchObject({
      connectionString: 'postgresql://managed-neon',
    });
  });

  it('falls back to DATABASE_URL', async () => {
    const options = await createPoolWith({
      DATABASE_URL: 'postgresql://managed',
      POSTGRES_URL: 'postgresql://legacy',
    });

    expect(options).toMatchObject({ connectionString: 'postgresql://managed' });
  });

  it('falls back to POSTGRES_URL', async () => {
    const options = await createPoolWith({
      POSTGRES_URL: 'postgresql://legacy',
    });

    expect(options).toMatchObject({ connectionString: 'postgresql://legacy' });
  });
});
