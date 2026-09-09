import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminApiFetch,
  parseAdminLocalJobsResponse,
} from '@/lib/admin-api-client';
import { LEGACY_LOCAL_PUBLISH_WORKSPACE_ID } from '@/lib/workspace-id';

describe('adminApiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes the selected admin workspace without dropping request headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await adminApiFetch(
      LEGACY_LOCAL_PUBLISH_WORKSPACE_ID,
      '/admin/api/publish-batches',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          kind: 'bootstrap',
          notionPageIds: ['day-16-page-id'],
        }),
      },
    );

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('X-Workspace-Id')).toBe(LEGACY_LOCAL_PUBLISH_WORKSPACE_ID);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('rejects the operational-only response that previously crashed the admin render', () => {
    expect(() => parseAdminLocalJobsResponse({
      contractVersion: 'publishing-v1',
      queue: [],
      attempts: [],
      worker: { state: 'offline', online: false },
    })).toThrow('Local publish jobs response is missing the jobs array');
  });
});
