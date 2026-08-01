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

  it('extracts only sanitized JSON detail for browser-facing errors', async () => {
    const { XhsMicroserviceHttpError } = await import('@/lib/xhs-microservice');
    const error = new XhsMicroserviceHttpError(503, JSON.stringify({
      detail: 'Normal-account QR login is temporarily unavailable',
      internal: 'do not expose',
    }));

    expect(error.detail)
      .toBe('Normal-account QR login is temporarily unavailable');
  });

  it('allowlists the structured creator-session failure contract', async () => {
    const { XhsMicroserviceHttpError } = await import('@/lib/xhs-microservice');
    const error = new XhsMicroserviceHttpError(401, JSON.stringify({
      valid: false,
      session_type: 'rednote_creator',
      validation: {
        method: 'creator_profile',
        host: 'creator.rednote.com',
        path: '/api/galaxy/creator/home/personal_info',
      },
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'The creator session is invalid',
      },
      cookie: 'must-not-leak',
      internal: 'must-not-leak',
    }));

    expect(error.safeBody).toEqual({
      valid: false,
      session_type: 'rednote_creator',
      validation: {
        method: 'creator_profile',
        host: 'creator.rednote.com',
        path: '/api/galaxy/creator/home/personal_info',
      },
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'The creator session is invalid',
      },
    });
    expect(JSON.stringify(error.safeBody)).not.toContain('must-not-leak');
  });
});
