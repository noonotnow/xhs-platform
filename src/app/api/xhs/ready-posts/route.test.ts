import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  listPosts: vi.fn(),
  getPost: vi.fn(),
  loadHandlings: vi.fn(),
}));
vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));
vi.mock('@/lib/notion-posts', () => ({
  listReadyXhsPosts: mocks.listPosts,
  getXhsPostForManualHandling: mocks.getPost,
  normalizeNotionPostsError: (error: Error) => ({
    message: error.message,
    code: 'NOTION_ERROR',
    status: 503,
  }),
}));
vi.mock('@/lib/manual-post-handling-store', () => ({
  listManualPostHandlings: mocks.loadHandlings,
}));

import { GET } from '@/app/api/xhs/ready-posts/route';

describe('ready posts route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOperator.mockResolvedValue(null);
    mocks.listPosts.mockResolvedValue({
      posts: [{
        id: 'post',
        candidateKind: 'active_unpublished',
        automationBlockers: ['Publish packet is not ready'],
        manualWarnings: ['Publish packet is not ready'],
        publishBlockers: ['Publish packet is not ready'],
      }],
      warnings: [],
    });
    mocks.loadHandlings.mockResolvedValue([{
      id: 'handling',
      notionPageId: 'post',
      receiptStatus: 'pending',
    }]);
    mocks.getPost.mockResolvedValue({
      id: 'reconciled-post',
      candidateKind: 'active_unpublished',
    });
  });

  it('keeps handled receipt-pending posts visible with durable state', async () => {
    const response = await GET(new NextRequest(
      'https://xhs.justlikekatie.com/api/xhs/ready-posts',
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      posts: [{
        id: 'post',
        manualHandling: {
          id: 'handling',
          receiptStatus: 'pending',
        },
        automationBlockers: ['Publish packet is not ready'],
        manualWarnings: ['Publish packet is not ready'],
      }],
    });
    expect(mocks.loadHandlings).toHaveBeenCalledWith();
    expect(mocks.getPost).not.toHaveBeenCalled();
  });

  it('keeps a reconciled manual receipt visible after Notion becomes Published', async () => {
    mocks.loadHandlings.mockResolvedValue([{
      id: 'handling',
      notionPageId: 'reconciled-post',
      receiptStatus: 'reconciled',
      noteId: 'note-1',
    }]);

    const response = await GET(new NextRequest(
      'https://xhs.justlikekatie.com/api/xhs/ready-posts',
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      posts: [
        { id: 'post' },
        {
          id: 'reconciled-post',
          manualHandling: {
            receiptStatus: 'reconciled',
            noteId: 'note-1',
          },
        },
      ],
    });
    expect(mocks.getPost).toHaveBeenCalledWith('reconciled-post');
  });
});
