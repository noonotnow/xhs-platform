import { describe, expect, it, vi } from 'vitest';
import {
  createBatchLinkedRednotePublishAttempt,
} from '@/lib/rednote-publishing-attempt-store';
import { rednoteMediaIdentity } from '@/lib/rednote-publish-authorization';

describe('bounded batch publishing attempts', () => {
  it('creates an approved worker attempt without Ready x3 authorization', async () => {
    const mediaUrl = 'https://images.xhs.justlikekatie.com/post.png';
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: { id: 'attempt-1' },
      created: true,
    });

    await createBatchLinkedRednotePublishAttempt(
      {
        notionPageId: '11111111-1111-4111-8111-111111111111',
        headline: 'Day 16',
        title: 'Day 16',
        caption: 'Caption',
        tags: ['Tag'],
        platform: 'RedNote',
        mediaType: 'image',
        mediaIndex: 0,
        mediaUrl,
        media: [{
          type: 'image',
          url: mediaUrl,
          identity: rednoteMediaIdentity({ type: 'image', url: mediaUrl }),
        }],
        publishAt: '2099-08-16T13:30:00.000Z',
        notionLastEditedTime: '2099-08-16T12:00:00.000Z',
        expectedAccountId: '678ba3b5000000000a03ecd2',
      },
      '22222222-2222-4222-8222-222222222222',
      'legacy-local-publish',
      '22222222-2222-4222-8222-222222222222',
      'schedule',
      createAttempt,
    );

    expect(createAttempt).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'legacy-local-publish',
      approve: true,
      readyX3: false,
      payload: expect.objectContaining({
        sourceLocalPublishJobId: '22222222-2222-4222-8222-222222222222',
        browserPayload: expect.objectContaining({
          sourcePostId: '11111111-1111-4111-8111-111111111111',
          expectedAccountId: '678ba3b5000000000a03ecd2',
          timingMode: 'scheduled',
        }),
      }),
    }));
  });
});
