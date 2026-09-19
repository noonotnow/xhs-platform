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
  it('prepares a Ready packet for mobile without mutating publication state', async () => {
    const mobileReadyPost = {
      ...readyPost,
      status: 'Ready',
      imageUrls: [
        'https://images.xhs.justlikekatie.com/uploads/first.jpg',
        'https://images.xhs.justlikekatie.com/uploads/second.jpg',
      ],
    };
    const existingAttempt = {
      id: 'existing-attempt',
      notionPageId: mobileReadyPost.id,
      status: 'queued',
      createdAt: '2026-09-12T12:01:00.000Z',
      updatedAt: '2026-09-12T12:01:00.000Z',
      verificationAttempts: 0,
    };
    const attemptBatch = {
      id: 'attempt-batch',
      workspaceId: 'workspace-test',
      kind: 'on_demand',
      status: 'approved',
      manifestHash: 'exact-manifest',
      createdAt: '2026-09-12T12:01:00.000Z',
      items: [{
        id: 'attempt-item',
        notionPageId: mobileReadyPost.id,
        localPublishJobId: existingAttempt.id,
        snapshot: {
          notionPageId: mobileReadyPost.id,
          headline: mobileReadyPost.headline,
          title: 'Frozen title',
          caption: mobileReadyPost.caption,
          tags: mobileReadyPost.tags,
          platform: 'RedNote',
          mediaType: 'image',
          mediaIndex: 0,
          mediaUrl: mobileReadyPost.imageUrls[0],
          media: mobileReadyPost.imageUrls.map((url, index) => ({
            identity: `image:${index}`,
            type: 'image',
            url,
          })),
          notionLastEditedTime: mobileReadyPost.lastEditedTime,
        },
        itemHash: 'exact-item',
        state: 'queued',
        dispatchMode: 'post_now',
        lateBySeconds: 0,
      }],
      blockedCandidates: [],
    };
    const responses: Record<string, unknown> = {
      '/admin/api/ready-posts': { posts: [mobileReadyPost], warnings: [] },
      '/admin/api/local-publish-jobs': {
        jobs: [existingAttempt],
        successAttestationCandidates: [],
        attempts: [{
          id: 'durable-attempt',
          sourceLocalPublishJobId: existingAttempt.id,
          payloadDigest: 'frozen-payload-digest',
          payloadRevision: mobileReadyPost.lastEditedTime,
          active: true,
          approvedAt: '2026-09-12T12:01:00.000Z',
          supersededByAttemptId: null,
          terminalOutcome: null,
        }],
      },
      '/admin/api/external-post-reconciliations': { reconciliations: [] },
      '/admin/api/manual-reconciliations': { reconciliations: [] },
      '/admin/api/publish-batches': { batches: [attemptBatch] },
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
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(ReadyPostsPanel, {
        workspaceId: 'workspace-test',
        initialNotionPageId: mobileReadyPost.id,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const sendButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Send to Rednote');
    const handledButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Mark handled manually');
    expect(sendButton).toBeDefined();
    expect(handledButton).toBeDefined();
    expect(handledButton?.disabled).toBe(false);
    expect(Array.from(container.querySelectorAll('a[download]')).map((link) =>
      link.getAttribute('download'))).toEqual([
      'available-post-01.jpg',
      'available-post-02.jpg',
    ]);

    await act(async () => {
      sendButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('Caption\n\n#ready');
    expect(container.textContent).toContain(
      'This browser could not share every media file together',
    );
    expect(requestSpy.mock.calls.filter(([, init]) =>
      (init?.method ?? 'GET') !== 'GET')).toEqual([]);
  });

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

  it('prepares only the selected Post and leaves approval as a separate action', async () => {
    const scheduledPost = {
      ...readyPost,
      scheduledDate: '2099-09-12T14:00:00.000Z',
      publishAt: '2099-09-12T14:00:00.000Z',
    };
    const preparedBatch = {
      id: 'prepared-batch',
      workspaceId: 'workspace-test',
      kind: 'on_demand',
      status: 'pending_approval',
      manifestHash: 'manifest-on-demand-1',
      createdAt: '2099-09-12T12:00:00.000Z',
      items: [{
        id: 'prepared-item',
        notionPageId: readyPost.id,
        snapshot: {
          notionPageId: readyPost.id,
          headline: readyPost.headline,
          title: readyPost.headline,
          caption: readyPost.caption,
          tags: readyPost.tags,
          platform: 'RedNote',
          mediaType: 'image',
          mediaIndex: 0,
          mediaUrl: 'https://example.com/image.jpg',
          publishAt: scheduledPost.publishAt,
          notionLastEditedTime: '2099-09-11T12:00:00.000Z',
          expectedAccountId: 'account-1',
        },
        itemHash: 'item-on-demand-1',
        state: 'needs_approval',
        dispatchMode: 'scheduled',
        lateBySeconds: 0,
      }],
      blockedCandidates: [],
    };
    const responses: Record<string, unknown> = {
      '/admin/api/ready-posts': { posts: [scheduledPost], warnings: [] },
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
        if (init?.method === 'POST' && path === '/admin/api/publish-batches') {
          responses['/admin/api/publish-batches'] = { batches: [preparedBatch] };
          return new Response(JSON.stringify({
            batch: preparedBatch,
          }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
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
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const prepareButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Prepare selected review candidate');
    expect(prepareButton).toBeDefined();
    await act(async () => {
      prepareButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mutationRequests = requestSpy.mock.calls.filter(([, init]) =>
      init?.method === 'POST',
    );
    expect(mutationRequests).toHaveLength(1);
    expect(JSON.parse(String(mutationRequests[0][1]?.body))).toEqual({
      action: 'prepare',
      notionPageId: readyPost.id,
    });
    expect(container.textContent).toContain('manifest-on-demand-1');
    expect(container.textContent).toContain('Approve this exact manifest');
    expect(container.textContent).toContain(
      'Preparing the selected Post only creates a review candidate',
    );
    expect(container.textContent).toContain(
      'Bootstrap is a separate recovery/setup workflow',
    );
  });

  it('keeps the approved bootstrap ledger visible when another Post is selected', async () => {
    const otherPost = {
      ...readyPost,
      id: 'other-notion-page',
      headline: 'Other post',
    };
    const approvedBootstrapBatch = {
      id: 'approved-bootstrap-batch',
      workspaceId: 'workspace-test',
      kind: 'bootstrap',
      status: 'approved',
      manifestHash: 'approved-bootstrap-manifest',
      createdAt: '2099-09-12T12:00:00.000Z',
      approvedAt: '2099-09-12T12:05:00.000Z',
      approvedBy: 'operator@example.com',
      items: [{
        id: 'approved-bootstrap-item',
        notionPageId: readyPost.id,
        snapshot: {
          notionPageId: readyPost.id,
          headline: readyPost.headline,
          title: readyPost.headline,
          caption: readyPost.caption,
          tags: readyPost.tags,
          platform: 'RedNote',
          mediaType: 'image',
          mediaIndex: 0,
          mediaUrl: 'https://example.com/image.jpg',
          publishAt: '2099-09-12T14:00:00.000Z',
          notionLastEditedTime: readyPost.lastEditedTime,
          expectedAccountId: 'account-1',
        },
        itemHash: 'approved-bootstrap-item-hash',
        state: 'scheduled',
        dispatchMode: 'scheduled',
        lateBySeconds: 0,
      }],
      blockedCandidates: [],
    };
    const responses: Record<string, unknown> = {
      '/admin/api/ready-posts': { posts: [readyPost, otherPost], warnings: [] },
      '/admin/api/local-publish-jobs': {
        jobs: [],
        successAttestationCandidates: [],
      },
      '/admin/api/external-post-reconciliations': { reconciliations: [] },
      '/admin/api/manual-reconciliations': { reconciliations: [] },
      '/admin/api/publish-batches': { batches: [approvedBootstrapBatch] },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = String(input);
      if (!(path in responses)) {
        throw new Error(`Unexpected request: GET ${path}`);
      }
      return new Response(JSON.stringify(responses[path]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(ReadyPostsPanel, {
        workspaceId: 'workspace-test',
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Active scheduled batch');
    const otherPostButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes(otherPost.headline));
    expect(otherPostButton).toBeDefined();

    await act(async () => {
      otherPostButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Active scheduled batch');
    expect(container.textContent).toContain('approved-boo');
  });
});