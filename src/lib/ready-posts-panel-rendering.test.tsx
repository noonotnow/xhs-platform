// @vitest-environment jsdom

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReadyPostsPanel from '@/app/admin/ReadyPostsPanel';
import type { ReadyXhsPost } from '@/types/ready-post';

vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) =>
    createElement('img', props),
}));

const readyPost: ReadyXhsPost = {
  id: 'available-notion-page',
  pageUrl: 'https://www.notion.so/available-notion-page',
  headline: 'Available post',
  caption: 'Caption',
  status: 'Approved',
  publishPacketReady: true,
  hasVideo: false,
  needsMedia: false,
  needsCaption: false,
  mediaUrls: [],
  imageUrls: ['https://images.xhs.justlikekatie.com/uploads/available.jpg'],
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

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('ReadyPostsPanel handoff notice', () => {
  it('keeps a missing requested record visible and passive after ready posts load', async () => {
    const responses: Record<string, unknown> = {
      '/admin/api/ready-posts': { posts: [readyPost], warnings: [] },
      '/admin/api/local-publish-jobs': {
        jobs: [],
        successAttestationCandidates: [],
      },
      '/admin/api/external-post-reconciliations': { reconciliations: [] },
      '/admin/api/manual-reconciliations': { reconciliations: [] },
      '/admin/api/publish-batches': { batches: [] },
    };
    const requestSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input, init) => {
        const path = String(input);
        if (!(path in responses)) {
          throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
        }
        return new Response(JSON.stringify(responses[path]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(ReadyPostsPanel, {
        workspaceId: 'workspace-test',
        initialNotionPageId: 'missing-browser-safe-id',
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const notice = container.querySelector('[role="status"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain('missing-browser-safe-id');
    expect(notice!.textContent).toContain(
      'Showing the current available selection instead; no action was started.',
    );
    expect(container.textContent).toContain('Available post');

    expect(requestSpy).toHaveBeenCalledTimes(5);
    const mutationRequests = requestSpy.mock.calls.filter(([, init]) =>
      (init?.method ?? 'GET') !== 'GET',
    );
    expect(mutationRequests).toEqual([]);
  });
});