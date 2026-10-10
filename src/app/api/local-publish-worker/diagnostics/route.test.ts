import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), query: vi.fn(), operational: vi.fn(), jobs: vi.fn(), attestation: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock('@/lib/local-publish-worker-auth', () => ({ requireLocalPublishWorker: mocks.auth }));
vi.mock('@/lib/rednote-publishing-attempt-store', () => ({ readRednotePublishingOperational: mocks.operational }));
vi.mock('@/lib/local-publish-jobs', () => ({ getLocalPublishJobSummaries: mocks.jobs }));
vi.mock('@/lib/operator-success-attestation-store', () => ({ listOperatorSuccessAttestationEvidence: mocks.attestation }));
const workspace = 'phone-packets-publish-test-20261003';
function request(scope = workspace) {
  return new NextRequest('https://fixture.invalid/api/local-publish-worker/diagnostics', {
    headers: { authorization: 'Bearer fixture', 'x-workspace-id': scope },
  });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('VERCEL_ENV', 'preview');
  mocks.auth.mockImplementation(() => {});
  mocks.query.mockResolvedValue({ rows: [{ diagnostic_connection: 1 }] });
  mocks.operational.mockResolvedValue({ queue: [], attempts: [], worker: { online: false }, polling: { active: false } });
  mocks.jobs.mockResolvedValue([]); mocks.attestation.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());
it('is absent in Production', async () => {
  vi.stubEnv('VERCEL_ENV', 'production');
  expect((await GET(request())).status).toBe(404);
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
});
it('rejects an unrelated workspace before database work', async () => {
  expect((await GET(request('other'))).status).toBe(404);
  expect(mocks.query).not.toHaveBeenCalled();
});
it('requires the real worker credential', async () => {
  mocks.auth.mockImplementation(() => { throw new Error('no access'); });
  expect((await GET(request())).status).toBe(401);
  expect(mocks.query).not.toHaveBeenCalled();
});
it('runs only a connection SELECT plus the three canonical status readers', async () => {
  const response = await GET(request()); const json = await response.json();
  expect(json.publicationApprovalRequested).toBe(false);
  expect(mocks.query).toHaveBeenCalledOnce();
  expect(mocks.query).toHaveBeenCalledWith('SELECT 1 AS diagnostic_connection');
  for (const read of [mocks.operational, mocks.jobs, mocks.attestation]) expect(read).toHaveBeenCalledWith(workspace);
  expect(json.steps).toHaveLength(4);
  expect(json.steps.every((step: { ok: boolean }) => step.ok)).toBe(true);
  expect(response.headers.get('cache-control')).toContain('no-store');
});
it('reports database failure without disclosing its message or reading further', async () => {
  mocks.query.mockRejectedValue(Object.assign(new Error('fixture confidential connection'), { code: '08006' }));
  const body = await (await GET(request())).text();
  expect(body).toContain('08006'); expect(body).not.toContain('confidential');
  expect(mocks.operational).not.toHaveBeenCalled();
});
