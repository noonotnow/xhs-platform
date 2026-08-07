import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  insert: vi.fn(),
  getPost: vi.fn(),
}));

vi.mock('@/lib/manual-post-handling-store', () => ({
  findManualPostHandlingByIdempotencyKey: mocks.find,
  insertManualPostHandling: mocks.insert,
  listManualPostHandlings: vi.fn(),
}));
vi.mock('@/lib/notion-posts', () => ({
  getXhsPostForManualHandling: mocks.getPost,
}));

import { markManualPostHandled } from '@/lib/manual-post-handlings';

const key = '11111111-1111-4111-8111-111111111111';
const revision = '2026-08-06T16:00:00.000Z';
const input = {
  notionPageId: '22222222-2222-4222-8222-222222222222',
  expectedLastEditedTime: revision,
  mode: 'scheduled',
};
const post = {
  id: input.notionPageId,
  status: 'Approved',
  lastEditedTime: revision,
  publishAt: '2026-08-07T14:30:00.000Z',
  manualWarnings: [
    'Publish packet is not ready',
    'Needs media is still checked',
    'MOV media requires the CapCut compatibility workflow',
  ],
};

describe('manual post handling service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.find.mockResolvedValue(null);
    mocks.getPost.mockResolvedValue(post);
    mocks.insert.mockResolvedValue({
      created: true,
      handling: { id: 'handling', warnings: post.manualWarnings },
    });
  });

  it('records exact Approved operator truth while preserving automation warnings', async () => {
    await expect(markManualPostHandled(input, key)).resolves.toMatchObject({
      created: true,
    });
    expect(mocks.insert).toHaveBeenCalledWith({
      notionPageId: input.notionPageId,
      notionVersion: revision,
      mode: 'scheduled',
      scheduledAt: post.publishAt,
      warnings: post.manualWarnings,
      recordedBy: 'admin',
      idempotencyKey: key,
    });
  });

  it.each([
    ['Draft', revision, 'POST_NOT_APPROVED'],
    ['Published', revision, 'POST_ALREADY_PUBLISHED'],
    ['Approved', '2026-08-06T16:01:00.000Z', 'NOTION_REVISION_CONFLICT'],
  ])('rejects status or revision drift: %s', async (status, lastEditedTime, code) => {
    mocks.getPost.mockResolvedValue({ ...post, status, lastEditedTime });
    await expect(markManualPostHandled(input, key)).rejects.toMatchObject({
      code,
      status: 409,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('returns an exact replay without re-reading Notion', async () => {
    mocks.find.mockResolvedValue({
      notionPageId: input.notionPageId,
      notionVersion: revision,
      mode: 'scheduled',
      recordedBy: 'admin',
    });
    await expect(markManualPostHandled(input, key)).resolves.toMatchObject({
      created: false,
    });
    expect(mocks.getPost).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
