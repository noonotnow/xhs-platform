import { afterEach, describe, expect, it, vi } from 'vitest';

describe('publishVideoUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses the authenticated remote-video contract', async () => {
    vi.stubEnv('XHS_MICROSERVICE_URL', 'https://microservice.example');
    vi.stubEnv('XHS_API_KEY', 'server-secret');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'success',
      note_id: 'note-123',
      share_url: 'https://www.xiaohongshu.com/explore/note-123',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { publishVideoUrl } = await import('@/lib/xhs-microservice');

    await publishVideoUrl({
      video_url: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
      title: 'Post',
      caption: 'Caption',
      tags: ['BTS'],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://microservice.example/publish-video-url',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'X-Api-Key': 'server-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          video_url: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
          title: 'Post',
          caption: 'Caption',
          tags: ['BTS'],
        }),
      }),
    );
  });

  it('surfaces non-2xx microservice failures', async () => {
    vi.stubEnv('XHS_MICROSERVICE_URL', 'https://microservice.example');
    vi.stubEnv('XHS_API_KEY', 'server-secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('not logged in', { status: 409 }),
    ));
    const { publishVideoUrl } = await import('@/lib/xhs-microservice');

    await expect(publishVideoUrl({
      video_url: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
      title: 'Post',
      caption: 'Caption',
    })).rejects.toThrow('Microservice error 409: not logged in');
  });
});
