import { expect, test, type Page } from '@playwright/test';

const firstPostId = 'notion-ready-first';
const secondPostId = 'notion-ready-second';

function readyPost(id: string, headline: string) {
  return {
    id,
    pageUrl: `https://www.notion.so/${id}`,
    headline,
    caption: `${headline} caption`,
    status: 'Approved',
    publishPacketReady: true,
    hasVideo: false,
    needsMedia: false,
    needsCaption: false,
    mediaUrls: [],
    imageUrls: [],
    videoUrls: [],
    compatibilityTrialVideoUrls: [],
    thumbnailUrl: '',
    tags: ['ready'],
    tagsSource: 'final-tags',
    scheduledDate: null,
    lastEditedTime: '2026-09-12T12:00:00.000Z',
    automationBlockers: [],
    manualWarnings: [],
    publishBlockers: [],
    candidateKind: 'packet_ready',
  };
}

async function mockAdminReads(page: Page) {
  const responses: Record<string, unknown> = {
    '/admin/api/ready-posts': {
      posts: [
        readyPost(firstPostId, 'First ready post'),
        readyPost(secondPostId, 'Second ready post'),
      ],
      warnings: [],
    },
    '/admin/api/local-publish-jobs': {
      jobs: [],
      successAttestationCandidates: [],
    },
    '/admin/api/external-post-reconciliations': { reconciliations: [] },
    '/admin/api/manual-reconciliations': { reconciliations: [] },
    '/admin/api/publish-batches': { batches: [] },
  };

  await page.route('**/admin/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const body = responses[pathname];

    if (request.method() !== 'GET' || body === undefined) {
      await route.abort('failed');
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

function expectBrowserSafeSelectionUrl(urlString: string, selectedId: string) {
  const url = new URL(urlString);

  expect(url.pathname).toBe('/admin');
  expect(url.hash).toBe('#ready-posts-heading');
  expect(Array.from(url.searchParams.entries())).toEqual([
    ['view', 'ready'],
    ['campaign', 'fall-launch'],
    ['notionPageId', selectedId],
  ]);

  const forbiddenUrlMaterial = [
    'token',
    'authorization',
    'credential',
    'secret',
    'cookie',
    'workspace',
    'database',
    'server',
  ];
  const serializedUrl = `${url.search}${url.hash}`.toLowerCase();
  for (const forbidden of forbiddenUrlMaterial) {
    expect(serializedUrl).not.toContain(forbidden);
  }
}

test('copied Admin selection links preserve safe URL state and restore after reload', async ({
  page,
}) => {
  await page.context().addCookies([{
    name: '__xhs_browser_test',
    value: 'local-playwright-admin',
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  }]);
  await mockAdminReads(page);

  await page.goto(
    `/admin?view=ready&campaign=fall-launch&notionPageId=${firstPostId}#ready-posts-heading`,
  );

  const detailHeading = page.locator('article').getByRole('heading', { level: 3 });
  await expect(detailHeading).toHaveText('First ready post');
  expectBrowserSafeSelectionUrl(page.url(), firstPostId);

  await page.getByRole('button', { name: /Second ready post/ }).click();

  await expect(detailHeading).toHaveText('Second ready post');
  expectBrowserSafeSelectionUrl(page.url(), secondPostId);

  await page.reload();

  await expect(detailHeading).toHaveText('Second ready post');
  expectBrowserSafeSelectionUrl(page.url(), secondPostId);
});